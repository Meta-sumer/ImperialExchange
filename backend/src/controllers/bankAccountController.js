/**
 * Deposit bank-account pool — Super Admin management.
 *
 * Mounted at /api/admin/bank-accounts behind authenticate + requireAdmin +
 * requireRole(SUPER_ADMIN) (routes/admin.js). Customers never call these;
 * they only ever see their own assigned account through
 * walletController.depositDetails.
 */
const mongoose = require('mongoose');
const BankAccount = require('../models/BankAccount');
const User = require('../models/User');
const { AuditLog } = require('../models/index');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const bankAssignment = require('../services/bankAssignment');

const { QR_MAX } = BankAccount;
const isObjectId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));
const STR = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const last4 = (n) => String(n || '').slice(-4);

const audit = (req, action, targetId, metadata = {}) => AuditLog.create({
  actorId: req.userId,
  actorRole: req.user.role,
  action,
  targetType: 'BANK_ACCOUNT',
  targetId: targetId ? String(targetId) : undefined,
  metadata,
  ip: req.ip,
  userAgent: req.headers['user-agent'],
});

// Whitelist + trim + cap every field; the schema maxlengths are the backstop.
const sanitize = (body) => {
  const out = {
    label: STR(body.label, 60),
    bankName: STR(body.bankName, 120),
    accountName: STR(body.accountName, 120),
    accountNumber: STR(body.accountNumber, 40).replace(/\s+/g, ''),
    ifsc: STR(body.ifsc, 20).toUpperCase(),
    branch: STR(body.branch, 120),
    upiId: STR(body.upiId, 80),
    note: STR(body.note, 500),
    qr: String(body.qr == null ? '' : body.qr).trim(),
  };
  if (!out.label) throw new AppError('Label is required', 400);
  if (!out.accountNumber && !out.upiId) throw new AppError('Enter an account number or a UPI ID', 400);
  if (out.qr && !(out.qr.startsWith('data:image/') || /^https?:\/\//i.test(out.qr))) {
    throw new AppError('QR must be an image URL or a data:image URI', 400);
  }
  if (out.qr.length > QR_MAX) throw new AppError('QR image is too large (max ~300 KB)', 400);
  return out;
};

// One account number can be ACTIVE once; a deactivated duplicate may linger.
const assertUniqueAccountNumber = async (accountNumber, excludeId) => {
  if (!accountNumber) return;
  const filter = { accountNumber, isActive: true };
  if (excludeId) filter._id = { $ne: excludeId };
  const clash = await BankAccount.findOne(filter).select('_id label').lean();
  if (clash) throw new AppError(`Account number already used by "${clash.label}"`, 409, 'DUPLICATE_ACCOUNT');
};

const withCounts = async (accounts) => {
  const counts = await bankAssignment.assignedCounts();
  return accounts.map((a) => ({ ...a, assignedUsers: counts.get(String(a._id)) || 0 }));
};

const loadOr404 = async (id) => {
  if (!isObjectId(id)) throw new AppError('Invalid bank account id', 400);
  const doc = await BankAccount.findById(id);
  if (!doc) throw new AppError('Bank account not found', 404);
  return doc;
};

// GET / — every account (active first) with its assigned-user count.
const list = asyncHandler(async (req, res) => {
  const accounts = await BankAccount.find({}).sort({ isActive: -1, createdAt: 1 }).lean();
  sendSuccess(res, await withCounts(accounts));
});

// GET /stats — pool overview (counts per account + unassigned customers).
const stats = asyncHandler(async (req, res) => {
  sendSuccess(res, await bankAssignment.poolStats());
});

// POST / — add an account to the pool.
const create = asyncHandler(async (req, res) => {
  const data = sanitize(req.body || {});
  await assertUniqueAccountNumber(data.accountNumber);
  const doc = await BankAccount.create({ ...data, createdBy: req.userId });
  await audit(req, 'BANK_ACCOUNT_CREATED', doc._id, { label: doc.label, last4: last4(doc.accountNumber), bankName: doc.bankName });
  sendSuccess(res, { ...doc.toObject(), assignedUsers: 0 });
});

// PUT /:id — edit details. Missing body fields keep their current value.
const update = asyncHandler(async (req, res) => {
  const doc = await loadOr404(req.params.id);
  const data = sanitize({ ...doc.toObject(), ...(req.body || {}) });
  await assertUniqueAccountNumber(data.accountNumber, doc._id);
  const snap = (d) => ({ label: d.label, last4: last4(d.accountNumber), ifsc: d.ifsc, bankName: d.bankName, upiId: d.upiId });
  const before = snap(doc);
  Object.assign(doc, data);
  await doc.save();
  await audit(req, 'BANK_ACCOUNT_UPDATED', doc._id, { before, after: snap(doc) });
  const [out] = await withCounts([doc.toObject()]);
  sendSuccess(res, out);
});

// POST /:id/deactivate | /:id/activate — an inactive account receives no new
// assignments; users still on it are moved by autoAssignIfMissing/distribute.
const setActive = (flag) => asyncHandler(async (req, res) => {
  const doc = await loadOr404(req.params.id);
  if (flag) await assertUniqueAccountNumber(doc.accountNumber, doc._id);
  doc.isActive = flag;
  await doc.save();
  await audit(req, flag ? 'BANK_ACCOUNT_ACTIVATED' : 'BANK_ACCOUNT_DEACTIVATED', doc._id, { label: doc.label });
  const [out] = await withCounts([doc.toObject()]);
  sendSuccess(res, out);
});

// GET /:id/users — who is assigned to this account (newest first, max 200).
// Optional ?search= over email / name / UID. Special characters are dropped
// rather than escaped, so no regex can be injected and nothing needs quoting.
const searchFilter = (q) => {
  const s = String(q || '').split(/[^A-Za-z0-9@._+ -]/).join('').trim();
  if (!s) return {};
  const rx = new RegExp(s, 'i');
  return { $or: [{ email: rx }, { firstName: rx }, { lastName: rx }, { userUid: rx }] };
};

const users = asyncHandler(async (req, res) => {
  const doc = await loadOr404(req.params.id);
  const rows = await User.find({ depositBankAccountId: doc._id, ...searchFilter(req.query.search) })
    .select('email firstName lastName userUid role isActive createdAt')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  sendSuccess(res, rows);
});

// POST /assign { userId, bankAccountId | null } — manual (un)assignment.
// Customers with no usable deposit account: none assigned, or assigned to an
// account that is inactive / gone. The rows the admin picks from when
// assigning by hand (the users modal's "Unassigned users" view).
const unassignedUsers = asyncHandler(async (req, res) => {
  const activeIds = (await BankAccount.find({ isActive: true }).select('_id').lean()).map((a) => a._id);
  const rows = await User.find({
    role: { $nin: [...bankAssignment.STAFF_ROLES] }, isActive: true,
    $and: [
      { $or: [{ depositBankAccountId: null }, { depositBankAccountId: { $nin: activeIds } }] },
      searchFilter(req.query.search),
    ],
  }).select('email firstName lastName userUid role isActive createdAt depositBankAccountId').sort({ createdAt: -1 }).limit(200).lean();
  sendSuccess(res, rows);
});

// Bulk: move many users to one account (or back to auto) in one request —
// the modal's select-all + "Move selected to". Staff rows are skipped.
const assignMany = asyncHandler(async (req, res) => {
  const { userIds, bankAccountId } = req.body || {};
  const ids = Array.isArray(userIds) ? [...new Set(userIds.map((v) => String(v)))].filter(isObjectId) : [];
  if (!ids.length) throw new AppError('userIds is required', 400);
  if (ids.length > 500) throw new AppError('Up to 500 users per request', 400);
  const wantsClear = bankAccountId == null || bankAccountId === '';
  if (!wantsClear && !isObjectId(bankAccountId)) throw new AppError('Invalid bankAccountId', 400);
  if (!wantsClear) await loadOr404(bankAccountId);
  const found = await User.find({ _id: { $in: ids } }).select('_id role depositBankAccountId').lean();
  let assigned = 0; let skipped = 0;
  for (const u of found) {
    if (bankAssignment.isStaffRole(u.role)) { skipped += 1; continue; }
    await bankAssignment.assignUser(u._id, wantsClear ? null : bankAccountId);
    assigned += 1;
  }
  await audit(req, 'BANK_ACCOUNT_ASSIGNED_MANY', wantsClear ? null : bankAccountId, {
    count: assigned, skipped, to: wantsClear ? null : String(bankAccountId),
  });
  sendSuccess(res, { assigned, skipped, bankAccountId: wantsClear ? null : String(bankAccountId) });
});

const assign = asyncHandler(async (req, res) => {
  const { userId, bankAccountId } = req.body || {};
  if (!isObjectId(userId)) throw new AppError('userId is required', 400);
  const wantsClear = bankAccountId == null || bankAccountId === '';
  if (!wantsClear && !isObjectId(bankAccountId)) throw new AppError('Invalid bankAccountId', 400);
  const user = await User.findById(userId).select('_id role depositBankAccountId').lean();
  if (!user) throw new AppError('User not found', 404);
  if (bankAssignment.isStaffRole(user.role)) {
    throw new AppError('Only customer accounts can be assigned a deposit bank account', 400);
  }
  const assigned = await bankAssignment.assignUser(user._id, wantsClear ? null : bankAccountId);
  await audit(req, 'BANK_ACCOUNT_ASSIGNED', assigned, {
    userId: String(user._id),
    from: user.depositBankAccountId ? String(user.depositBankAccountId) : null,
    to: assigned ? String(assigned) : null,
  });
  sendSuccess(res, { userId: String(user._id), bankAccountId: assigned ? String(assigned) : null });
});

// POST /distribute — assign every unassigned customer, least-loaded first.
const distribute = asyncHandler(async (req, res) => {
  const result = await bankAssignment.distributeUnassigned();
  await audit(req, 'BANK_ACCOUNT_DISTRIBUTED', null, result);
  sendSuccess(res, result);
});

module.exports = {
  unassignedUsers,
  assignMany,
  list,
  stats,
  create,
  update,
  deactivate: setActive(false),
  activate: setActive(true),
  users,
  assign,
  distribute,
};
