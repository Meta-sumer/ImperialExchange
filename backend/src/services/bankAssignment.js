/**
 * Deposit bank-account assignment.
 *
 * The pool is models/BankAccount.js; the assignment is User.depositBankAccountId.
 * Two entry points keep the pool balanced:
 *   - lazily: `autoAssignIfMissing(user)` runs on every deposit-details read,
 *     so a brand-new customer (or one whose account was deactivated) picks up
 *     the least-loaded ACTIVE account the first time they open the deposit page;
 *   - in bulk: `distributeUnassigned()` from the admin panel assigns every
 *     customer still without a valid account, least-loaded first, keeping the
 *     running counts so a batch of N users spreads evenly.
 *
 * "Least loaded" = fewest assigned users, ties broken by the oldest account.
 */
const BankAccount = require('../models/BankAccount');
const User = require('../models/User');
const { ROLES, FINANCE_ROLES } = require('../config/constants');
const { AppError } = require('../utils/errors');

// Admin-console roles never get a deposit bank account — only customers do.
const STAFF_ROLES = new Set([ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.MANAGER, ...FINANCE_ROLES.ALL]);
const isStaffRole = (role) => STAFF_ROLES.has(role);
const CUSTOMER_FILTER = { role: { $nin: [...STAFF_ROLES] }, isActive: true };

/** Map<bankAccountId, assignedUsers> over active users (any role). */
async function assignedCounts() {
  const rows = await User.aggregate([
    { $match: { depositBankAccountId: { $ne: null }, isActive: true } },
    { $group: { _id: '$depositBankAccountId', n: { $sum: 1 } } },
  ]);
  const map = new Map();
  for (const r of rows) map.set(String(r._id), r.n);
  return map;
}

/**
 * Pure: the account with the fewest assigned users. `accounts` must already be
 * in tie-break order (oldest first); `counts` is Map<id, n>. Null when empty.
 */
function pickLeastLoadedFrom(accounts, counts) {
  let best = null;
  let bestN = Infinity;
  for (const a of accounts || []) {
    const n = (counts && counts.get(String(a._id))) || 0;
    if (n < bestN) { best = a; bestN = n; }
  }
  return best;
}

const activeAccounts = () => BankAccount.find({ isActive: true }).sort({ createdAt: 1, _id: 1 }).lean();

async function pickLeastLoaded() {
  const accounts = await activeAccounts();
  if (!accounts.length) return null;
  return pickLeastLoadedFrom(accounts, await assignedCounts());
}

/** Manual (un)assignment. `bankAccountId` null clears it. Returns the new id or null. */
async function assignUser(userId, bankAccountId) {
  let id = null;
  if (bankAccountId) {
    const acct = await BankAccount.findById(bankAccountId).lean();
    if (!acct) throw new AppError('Bank account not found', 404);
    if (!acct.isActive) throw new AppError('Bank account is inactive', 400);
    id = acct._id;
  }
  const r = await User.updateOne({ _id: userId }, { $set: { depositBankAccountId: id } });
  if (!r.matchedCount) throw new AppError('User not found', 404);
  return id;
}

/**
 * The bank account a user should see. If the user has none (or an inactive
 * one) and the pool has an active account, assign the least-loaded one and
 * persist it. Returns the BankAccount (lean) or null when the pool is empty.
 */
async function autoAssignIfMissing(user) {
  if (!user || !user._id) return null;
  if (user.depositBankAccountId) {
    const cur = await BankAccount.findById(user.depositBankAccountId).lean();
    if (cur && cur.isActive) return cur;
  }
  const pick = await pickLeastLoaded();
  if (!pick) return null;
  await User.updateOne({ _id: user._id }, { $set: { depositBankAccountId: pick._id } });
  return pick;
}

/** Customers with no assignment, or one pointing at a deactivated/deleted account. */
const unassignedFilter = (activeIds) => ({
  ...CUSTOMER_FILTER,
  $or: [{ depositBankAccountId: null }, { depositBankAccountId: { $nin: activeIds } }],
});

/** Bulk-assign every unassigned customer, least-loaded first. */
async function distributeUnassigned() {
  const accounts = await activeAccounts();
  if (!accounts.length) return { assigned: 0, perAccount: {} };
  const counts = await assignedCounts();
  const todo = await User.find(unassignedFilter(accounts.map((a) => a._id))).select('_id').lean();
  const perAccount = {};
  const ops = [];
  for (const u of todo) {
    const pick = pickLeastLoadedFrom(accounts, counts);
    const key = String(pick._id);
    counts.set(key, (counts.get(key) || 0) + 1);
    perAccount[key] = (perAccount[key] || 0) + 1;
    ops.push({ updateOne: { filter: { _id: u._id }, update: { $set: { depositBankAccountId: pick._id } } } });
  }
  if (ops.length) await User.bulkWrite(ops, { ordered: false });
  return { assigned: ops.length, perAccount };
}

/** Pool overview for the admin page. */
async function poolStats() {
  const accounts = await BankAccount.find({}).select('_id label isActive').sort({ isActive: -1, createdAt: 1 }).lean();
  const counts = await assignedCounts();
  const activeIds = accounts.filter((a) => a.isActive).map((a) => a._id);
  const [customers, unassignedUsers] = await Promise.all([
    User.countDocuments(CUSTOMER_FILTER),
    activeIds.length ? User.countDocuments(unassignedFilter(activeIds)) : User.countDocuments(CUSTOMER_FILTER),
  ]);
  const perAccount = accounts.map((a) => ({
    id: String(a._id), label: a.label, isActive: a.isActive, assignedUsers: counts.get(String(a._id)) || 0,
  }));
  const assignedUsers = perAccount.filter((p) => p.isActive).reduce((n, p) => n + p.assignedUsers, 0);
  return {
    accounts: accounts.length,
    activeAccounts: activeIds.length,
    customers,
    assignedUsers,
    unassignedUsers,
    perAccount,
  };
}

module.exports = {
  STAFF_ROLES,
  isStaffRole,
  assignedCounts,
  pickLeastLoadedFrom,
  pickLeastLoaded,
  assignUser,
  autoAssignIfMissing,
  distributeUnassigned,
  poolStats,
};
