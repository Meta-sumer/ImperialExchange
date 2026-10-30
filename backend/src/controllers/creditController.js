/**
 * Credit transactions — an admin processes a deposit or withdrawal "on
 * credit": the wallet moves immediately and the row tracks what is still
 * owed in the real world until the admin records the payment(s).
 *
 *   DEPOSIT on credit    → wallet credited now; the user owes the platform.
 *   WITHDRAWAL on credit → wallet debited now; the platform owes the user.
 *
 * Settlement never moves the wallet again (the money already moved); it only
 * records the external payment. Cancelling an untouched PENDING credit
 * reverses the original wallet movement with an ADJUSTMENT ledger row.
 *
 * Admin routes are mounted at /api/admin/credit (routes/credit.js); the
 * user's own view is GET /api/wallet/credit (listMine).
 */
const mongoose = require('mongoose');
const CreditTransaction = require('../models/CreditTransaction');
const { CREDIT_KIND, CREDIT_STATUS, OPEN_STATUSES } = CreditTransaction;
const User = require('../models/User');
const TradingAccount = require('../models/TradingAccount');
const { WalletLedger } = require('../models/Wallet');
const { AuditLog } = require('../models/index');
const walletService = require('../services/walletService');
const { outstandingOf, applySettlement, canCancel } = require('../services/creditMath');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const { BASE_CURRENCY, WALLET_TX_TYPE } = require('../config/constants');
const { gt, round } = require('../utils/decimal');

// ── helpers ─────────────────────────────────────────────────────────────

const audit = (req, action, id, metadata = {}) => AuditLog.create({
  actorId: req.userId,
  actorRole: req.user.role,
  action,
  targetType: 'CREDIT',
  targetId: String(id),
  metadata,
  ip: req.ip,
  userAgent: req.headers['user-agent'],
});

// An ADMIN only sees / touches users inside their own subtree; SUPER_ADMIN
// is unscoped. Same rule the deposit and withdrawal lists apply.
const scopeUserIds = async (req) => {
  if (!req.user || req.user.role !== 'ADMIN') return null;
  return User.find({ adminId: req.user._id }).distinct('_id');
};

const assertInScope = async (actor, userId) => {
  if (actor.role === 'SUPER_ADMIN') return;
  const u = await User.findById(userId).select('adminId').lean();
  if (!u) throw new AppError('User not found', 404);
  if (actor.role === 'ADMIN' && String(u.adminId) === String(actor._id)) return;
  throw new AppError('This user is not in your hierarchy', 403, 'OUT_OF_SCOPE');
};

const attachUserBadge = async (items) => {
  const ids = [...new Set(items.map((it) => String(it.userId)).filter(Boolean))];
  if (!ids.length) return items;
  const users = await User.find({ _id: { $in: ids } }).select('userUid email firstName lastName').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  for (const it of items) {
    const u = byId.get(String(it.userId));
    it.user = u
      ? { _id: u._id, userUid: u.userUid || null, email: u.email, firstName: u.firstName, lastName: u.lastName, name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email }
      : null;
  }
  return items;
};

const attachAccount = async (items) => {
  const ids = [...new Set(items.map((it) => String(it.accountId)).filter(Boolean))];
  if (!ids.length) return items;
  const accounts = await TradingAccount.find({ _id: { $in: ids } }).select('accountNumber accountType nickname').lean();
  const byId = new Map(accounts.map((a) => [String(a._id), a]));
  for (const it of items) {
    const a = byId.get(String(it.accountId));
    it.account = a ? { _id: a._id, accountNumber: a.accountNumber, accountType: a.accountType, nickname: a.nickname || null } : null;
  }
  return items;
};

const attachCreator = async (items) => {
  const ids = [...new Set(items.map((it) => String(it.createdBy || '')).filter(Boolean))];
  if (!ids.length) return items;
  const users = await User.find({ _id: { $in: ids } }).select('email firstName lastName').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  for (const it of items) {
    const u = byId.get(String(it.createdBy));
    it.creator = u ? { email: u.email, name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email } : null;
  }
  return items;
};

const withOutstanding = (it) => ({ ...it, outstanding: outstandingOf(it) });

const parseAmount = (v, label = 'amount') => {
  const s = String(v == null ? '' : v).trim();
  if (!s || !Number.isFinite(Number(s)) || !gt(s, '0')) throw new AppError(`${label} must be a positive number`, 400);
  return round(s, 2);
};

const oid = (v) => new mongoose.Types.ObjectId(String(v));

/** Outstanding totals over OPEN rows matching `match` (ObjectId values). */
const aggregateOutstanding = async (match) => {
  const rows = await CreditTransaction.aggregate([
    { $match: { ...match, status: { $in: OPEN_STATUSES } } },
    {
      $group: {
        _id: '$kind',
        outstanding: { $sum: { $subtract: [{ $toDouble: '$amount' }, { $toDouble: '$settledAmount' }] } },
        count: { $sum: 1 },
      },
    },
  ]);
  const by = new Map(rows.map((r) => [r._id, r]));
  const dep = by.get(CREDIT_KIND.DEPOSIT) || { outstanding: 0, count: 0 };
  const wd = by.get(CREDIT_KIND.WITHDRAWAL) || { outstanding: 0, count: 0 };
  return {
    receivableOutstanding: round(dep.outstanding, 2), // users owe the platform
    payableOutstanding: round(wd.outstanding, 2),     // platform owes users
    pendingCount: dep.count + wd.count,
  };
};

const notify = (userId, action, extra = {}) => {
  try {
    require('../websocket/server').notifyUser(String(userId), 'wallet', { action, ts: Date.now(), ...extra });
  } catch (_) { /* ws optional */ }
};

const isInsufficient = (err) =>
  err && (err.code === 'INSUFFICIENT_FUNDS' || /insufficient/i.test(String(err.message || '')));

const decorate = async (docs) => {
  const items = docs.map((d) => (typeof d.toObject === 'function' ? d.toObject() : d));
  await attachUserBadge(items);
  await attachAccount(items);
  await attachCreator(items);
  return items.map(withOutstanding);
};

// ── admin: create ───────────────────────────────────────────────────────
// POST /api/admin/credit { userId, accountId, kind, amount, remarks, dueDate? }
const create = asyncHandler(async (req, res) => {
  const { userId, accountId, kind, amount, remarks, dueDate } = req.body;
  if (!userId || !accountId) throw new AppError('userId and accountId are required', 400);
  if (!Object.values(CREDIT_KIND).includes(kind)) throw new AppError('kind must be DEPOSIT or WITHDRAWAL', 400);
  const amt = parseAmount(amount);
  const note = String(remarks || '').trim();
  if (!note) throw new AppError('remarks are required', 400);
  let due = null;
  if (dueDate) {
    due = new Date(dueDate);
    if (Number.isNaN(due.getTime())) throw new AppError('dueDate is not a valid date', 400);
  }

  await assertInScope(req.user, userId);
  const account = await TradingAccount.findOne({ _id: accountId, userId }).lean();
  if (!account) throw new AppError('Trading account not found for this user', 404);
  const currency = account.baseCurrency || BASE_CURRENCY;

  // Create the row first so the ledger entry can reference it; roll it back
  // if the wallet movement is refused (e.g. a withdrawal exceeding balance).
  const tx = await CreditTransaction.create({
    userId, accountId, kind, amount: amt, currency, remarks: note, dueDate: due, createdBy: req.userId,
  });
  try {
    const common = {
      userId, accountId, currency, amount: amt,
      referenceType: 'credit', referenceId: tx._id,
      note: `On credit — ${note}`,
      dedupeKey: `CREDIT_OPEN:${tx._id}`,
    };
    const wallet = kind === CREDIT_KIND.DEPOSIT
      ? await walletService.credit({ ...common, type: WALLET_TX_TYPE.DEPOSIT })
      : await walletService.debit({ ...common, type: WALLET_TX_TYPE.WITHDRAWAL });
    tx.walletId = wallet._id;
    const ledger = await WalletLedger.findOne({ referenceId: tx._id, type: kind === CREDIT_KIND.DEPOSIT ? WALLET_TX_TYPE.DEPOSIT : WALLET_TX_TYPE.WITHDRAWAL })
      .select('_id').lean();
    if (ledger) tx.ledgerId = ledger._id;
    await tx.save();
  } catch (err) {
    await CreditTransaction.deleteOne({ _id: tx._id });
    if (isInsufficient(err)) {
      throw new AppError('The user\'s balance is insufficient for a withdrawal on credit', 400, 'INSUFFICIENT_FUNDS');
    }
    throw err;
  }

  await audit(req, 'CREDIT_CREATED', tx._id, { userId, accountId, kind, amount: amt, currency, remarks: note, dueDate: due });
  const [row] = await decorate([tx]);
  sendSuccess(res, row, 201);
});

// ── admin: list ─────────────────────────────────────────────────────────
// GET /api/admin/credit?status=&kind=&userId=&from=&to=&page=&limit=
const list = asyncHandler(async (req, res) => {
  const { status, kind, userId, from, to } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

  const filter = {};
  if (status) {
    const wanted = String(status).split(',').map((s) => s.trim().toUpperCase()).filter((s) => Object.values(CREDIT_STATUS).includes(s));
    if (wanted.length) filter.status = { $in: wanted };
  }
  if (kind && Object.values(CREDIT_KIND).includes(String(kind).toUpperCase())) filter.kind = String(kind).toUpperCase();
  if (userId) {
    await assertInScope(req.user, userId);
    filter.userId = oid(userId);
  } else {
    const scope = await scopeUserIds(req);
    if (scope) filter.userId = { $in: scope };
  }
  if (from || to) {
    filter.createdAt = {};
    if (from) {
      const d = new Date(from);
      if (!Number.isNaN(d.getTime())) filter.createdAt.$gte = d;
    }
    if (to) {
      const d = new Date(to);
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(to))) d.setHours(23, 59, 59, 999);
      if (!Number.isNaN(d.getTime())) filter.createdAt.$lte = d;
    }
    if (!Object.keys(filter.createdAt).length) delete filter.createdAt;
  }

  const [docs, total] = await Promise.all([
    CreditTransaction.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    CreditTransaction.countDocuments(filter),
  ]);
  const items = await decorate(docs);
  // Totals ignore the status/kind/date filters: they describe what is open
  // right now for the same set of users.
  const totalsMatch = filter.userId ? { userId: filter.userId } : {};
  const totals = await aggregateOutstanding(totalsMatch);
  sendSuccess(res, { items, total, page, limit, totals });
});

// ── admin: per-user summary ─────────────────────────────────────────────
// GET /api/admin/credit/summary?userId=
const summary = asyncHandler(async (req, res) => {
  const { userId } = req.query;
  if (!userId) throw new AppError('userId is required', 400);
  await assertInScope(req.user, userId);
  const totals = await aggregateOutstanding({ userId: oid(userId) });
  sendSuccess(res, { userId, ...totals });
});

// ── admin: settle ───────────────────────────────────────────────────────
// POST /api/admin/credit/:id/settle { amount?, remarks? }
const settle = asyncHandler(async (req, res) => {
  const tx = await CreditTransaction.findById(req.params.id);
  if (!tx) throw new AppError('Credit transaction not found', 404);
  await assertInScope(req.user, tx.userId);
  if (!OPEN_STATUSES.includes(tx.status)) {
    throw new AppError('This credit transaction is already settled or cancelled', 400, 'NOT_OPEN');
  }
  const outstanding = outstandingOf(tx);
  const settleAmount = req.body.amount != null && String(req.body.amount).trim() !== ''
    ? parseAmount(req.body.amount)
    : outstanding;
  let result;
  try {
    result = applySettlement({ amount: tx.amount, settledAmount: tx.settledAmount, settleAmount });
  } catch (e) {
    if (e.message === 'EXCEEDS_OUTSTANDING') throw new AppError(`Amount exceeds the outstanding ${outstanding}`, 400, 'EXCEEDS_OUTSTANDING');
    throw new AppError('Invalid settlement amount', 400);
  }
  const remarks = String(req.body.remarks || '').trim();
  tx.settlements.push({ amount: settleAmount, at: new Date(), byId: req.userId, remarks });
  tx.settledAmount = result.settledAmount;
  tx.status = result.status;
  if (result.status === CREDIT_STATUS.SETTLED) tx.settledAt = new Date();
  await tx.save();

  await audit(req, 'CREDIT_SETTLED', tx._id, {
    userId: tx.userId, kind: tx.kind, amount: settleAmount, remarks, status: tx.status, outstanding: result.outstanding,
  });
  notify(tx.userId, 'credit-settled', { creditId: String(tx._id), status: tx.status });
  const [row] = await decorate([tx]);
  sendSuccess(res, row);
});

// ── admin: cancel ───────────────────────────────────────────────────────
// POST /api/admin/credit/:id/cancel { remarks? }
const cancel = asyncHandler(async (req, res) => {
  const tx = await CreditTransaction.findById(req.params.id);
  if (!tx) throw new AppError('Credit transaction not found', 404);
  await assertInScope(req.user, tx.userId);
  if (!canCancel(tx)) {
    throw new AppError('Only a PENDING credit with no settlement recorded can be cancelled', 400, 'NOT_CANCELLABLE');
  }
  const remarks = String(req.body.remarks || '').trim();
  const common = {
    userId: tx.userId, accountId: tx.accountId, currency: tx.currency, amount: tx.amount,
    type: WALLET_TX_TYPE.ADJUSTMENT, referenceType: 'credit', referenceId: tx._id,
    note: `Credit cancelled — ${remarks || 'no remarks'}`,
    dedupeKey: `CREDIT_CANCEL:${tx._id}`,
  };
  try {
    // Reverse the original movement: take back a credited deposit, return a
    // debited withdrawal.
    if (tx.kind === CREDIT_KIND.DEPOSIT) await walletService.debit(common);
    else await walletService.credit(common);
  } catch (err) {
    if (isInsufficient(err)) {
      throw new AppError('Cannot cancel: the user has already used the credited funds', 400, 'INSUFFICIENT_FUNDS');
    }
    throw err;
  }
  tx.status = CREDIT_STATUS.CANCELLED;
  tx.cancelledAt = new Date();
  tx.cancelledBy = req.userId;
  tx.cancelRemarks = remarks;
  await tx.save();

  await audit(req, 'CREDIT_CANCELLED', tx._id, { userId: tx.userId, kind: tx.kind, amount: tx.amount, remarks });
  const [row] = await decorate([tx]);
  sendSuccess(res, row);
});

// ── user: own credit transactions ───────────────────────────────────────
// GET /api/wallet/credit
const listMine = asyncHandler(async (req, res) => {
  const docs = await CreditTransaction.find({ userId: req.userId })
    .sort({ createdAt: -1 }).limit(100)
    .select('-settlements.byId -cancelledBy -createdBy')
    .lean();
  const items = docs.map(withOutstanding);
  const totals = await aggregateOutstanding({ userId: oid(req.userId) });
  sendSuccess(res, {
    items,
    summary: {
      outstandingReceivable: totals.receivableOutstanding, // the user still owes
      outstandingPayable: totals.payableOutstanding,       // due to the user
      pendingCount: totals.pendingCount,
    },
  });
});

module.exports = { create, list, summary, settle, cancel, listMine };
