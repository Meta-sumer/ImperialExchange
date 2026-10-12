/**
 * Withdrawal-methods CRUD (user-facing). Every route is scoped to the
 * authenticated user (req.userId) so a caller can only ever see / touch their
 * OWN methods — the ownership filter in each query is the IDOR guard.
 *
 * Add → PENDING; an admin later VERIFIES it (see adminController). A method can
 * only be used for a withdrawal once VERIFIED (enforced in requestWithdrawal).
 * Delete is a soft-archive so historical withdrawal snapshots are preserved.
 */
const WithdrawalMethod = require('../models/WithdrawalMethod');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const { AuditLog } = require('../models/index');

// Per-network crypto address validators — same rules the withdrawal path used,
// so a saved method is format-valid before it can ever be verified/used.
const NET_VALIDATORS = {
  ERC20: /^0x[a-fA-F0-9]{40}$/,
  BEP20: /^0x[a-fA-F0-9]{40}$/,
  TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  BTC: /^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,87}$/,
};

const audit = async (req, action, targetId, metadata = {}) => {
  try {
    if (!AuditLog) return;
    await AuditLog.create({
      actorId: req.userId,
      actorRole: req.user?.role,
      action,
      targetType: 'WITHDRAWAL_METHOD',
      targetId: String(targetId),
      metadata, // never contains raw account number / wallet address
      ip: req.ip,
      userAgent: req.headers?.['user-agent'],
    });
  } catch (_) { /* audit is best-effort — never block the action */ }
};

// GET /withdrawal-methods — the user's own (non-archived) methods, masked.
const listMethods = asyncHandler(async (req, res) => {
  const methods = await WithdrawalMethod.find({ userId: req.userId, archived: { $ne: true } }).sort({ createdAt: -1 });
  sendSuccess(res, methods.map((m) => m.toSafeJSON()));
});

// GET /withdrawal-methods/:id — own only (ownership filter = IDOR guard), masked.
const getMethod = asyncHandler(async (req, res) => {
  const m = await WithdrawalMethod.findOne({ _id: req.params.id, userId: req.userId });
  if (!m || m.archived) throw new AppError('Withdrawal method not found', 404, 'NOT_FOUND');
  sendSuccess(res, m.toSafeJSON());
});

// POST /withdrawal-methods — add a new destination (starts PENDING).
const addMethod = asyncHandler(async (req, res) => {
  const { type, label } = req.body;
  const t = String(type || '').toUpperCase();
  if (!WithdrawalMethod.TYPES.includes(t)) throw new AppError('Invalid method type. Use BANK, UPI, CRYPTO or CUSTOM.', 400, 'INVALID_TYPE');
  if (!label || String(label).trim().length < 2) throw new AppError('A label is required (e.g. "HDFC Salary").', 400);

  const doc = { userId: req.userId, type: t, label: String(label).trim().slice(0, 60), status: 'PENDING', isVerified: false };

  if (t === 'BANK') {
    const { accountHolderName, bankName, accountNumber, ifsc } = req.body;
    if (!accountHolderName || String(accountHolderName).trim().length < 2) throw new AppError('Account holder name required', 400);
    const acc = String(accountNumber || '').replace(/\s/g, '');
    if (acc.length < 5) throw new AppError('Valid bank account number required', 400);
    const ifscU = String(ifsc || '').toUpperCase().trim();
    if (ifscU.length !== 11) throw new AppError('Valid 11-character IFSC required', 400);
    Object.assign(doc, { accountHolderName: String(accountHolderName).trim(), bankName: String(bankName || '').trim(), accountNumber: acc, ifsc: ifscU });
  } else if (t === 'UPI') {
    const { upiId } = req.body;
    if (!upiId || !String(upiId).includes('@')) throw new AppError('Valid UPI ID required (e.g. name@bank)', 400);
    Object.assign(doc, { upiId: String(upiId).trim() });
  } else if (t === 'CRYPTO') {
    const { network, walletAddress } = req.body;
    const net = String(network || '').toUpperCase().trim();
    if (!NET_VALIDATORS[net]) throw new AppError('Unsupported network. Use ERC20 / BEP20 / TRC20 / BTC.', 400);
    const addr = String(walletAddress || '').trim();
    if (!NET_VALIDATORS[net].test(addr)) throw new AppError(`Invalid ${net} wallet address format`, 400);
    Object.assign(doc, { network: net, walletAddress: addr });
  } else if (t === 'CUSTOM') {
    // An admin-defined rail. The shape is whatever the admin published as
    // withdrawalFields — validated here against that live config, so a user
    // cannot invent keys or save a destination for a rail that is closed.
    const { methodKey, details } = req.body;
    const key = String(methodKey || '').trim();
    if (!key) throw new AppError('Choose a withdrawal method.', 400, 'METHOD_KEY_REQUIRED');
    const { getMethodConfig, railEnabled, withdrawalFieldKey, withdrawalSchema } = require('../utils/paymentMethods');
    const cfg = await getMethodConfig(key);
    if (!cfg) throw new AppError('That withdrawal method no longer exists.', 404, 'METHOD_NOT_FOUND');
    if (!railEnabled(cfg, 'withdrawal')) throw new AppError('That withdrawal method is not currently available.', 400, 'METHOD_DISABLED');
    // The admin schema, or the single default field when the rail has not
    // been described yet — the same rule the client drew the form from.
    const schema = withdrawalSchema(key, cfg);
    if (!schema) throw new AppError('Use the dedicated form for this method.', 400, 'NATIVE_RAIL');
    const given = details && typeof details === 'object' ? details : {};
    const out = {};
    const sensitiveKeys = [];
    for (const f of schema) {
      const fk = withdrawalFieldKey(f);
      if (!fk) continue;
      const val = String(given[fk] == null ? '' : given[fk]).trim();
      if (!val && f.required !== false) throw new AppError(`${f.label} is required`, 400, 'FIELD_REQUIRED');
      if (val) out[fk] = val.slice(0, 200);
      if (f.sensitive) sensitiveKeys.push(fk);
    }
    if (!Object.keys(out).length) throw new AppError('Fill in your withdrawal details.', 400);
    Object.assign(doc, { methodKey: key, details: out, sensitiveKeys });
  }

  // Dedupe — block saving the same destination twice (avoids duplicate PENDING rows).
  const dupe = { userId: req.userId, type: t, archived: { $ne: true } };
  if (t === 'BANK') { dupe.accountNumber = doc.accountNumber; dupe.ifsc = doc.ifsc; }
  else if (t === 'UPI') dupe.upiId = doc.upiId;
  else if (t === 'CRYPTO') { dupe.walletAddress = doc.walletAddress; dupe.network = doc.network; }
  else if (t === 'CUSTOM') {
    // Same rail + same values = the same destination. Compared field by
    // field so key ORDER cannot make one destination look like two.
    dupe.methodKey = doc.methodKey;
    for (const [k, v] of Object.entries(doc.details)) dupe[`details.${k}`] = v;
  }
  if (await WithdrawalMethod.findOne(dupe)) throw new AppError('You have already saved this destination.', 409, 'DUPLICATE_METHOD');

  const m = await WithdrawalMethod.create(doc);
  await audit(req, 'WITHDRAWAL_METHOD_ADDED', m._id, { type: t, label: m.label });
  sendSuccess(res, m.toSafeJSON(), 201);
});

// DELETE /withdrawal-methods/:id — soft-archive so past withdrawal snapshots stay intact.
const deleteMethod = asyncHandler(async (req, res) => {
  const m = await WithdrawalMethod.findOne({ _id: req.params.id, userId: req.userId });
  if (!m || m.archived) throw new AppError('Withdrawal method not found', 404, 'NOT_FOUND');
  m.archived = true;
  m.isVerified = false; // can never be used again, even if it was verified
  await m.save();
  await audit(req, 'WITHDRAWAL_METHOD_ARCHIVED', m._id, { type: m.type });
  sendSuccess(res, { id: String(m._id), archived: true });
});

module.exports = { listMethods, getMethod, addMethod, deleteMethod };
