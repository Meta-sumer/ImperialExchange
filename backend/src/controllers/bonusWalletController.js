/**
 * Bonus Wallet controller — APIs for the standalone Bonus Wallet UX
 * (balance + earnings summary, history) and the admin tooling
 * (credit / debit / logs / balances list / export).
 *
 * The Bonus Wallet is WITHDRAW-ONLY for users. It is funded by referral and
 * partner earnings, credited by the platform — so the balance is a record of
 * what was EARNED. A user paying their own money in mixes deposits into that
 * record, and the reports built on it (partner commission, bonus-abuse
 * auditing) then count money that was never earned.
 *
 * Money leaves via /withdraw or an internal transfer OUT. Money enters only
 * through earnings or an explicit admin credit.
 *
 * The header above used to claim there was "intentionally NO deposit and NO
 * withdrawal endpoint" while /deposit, /manual-deposit and /withdraw all
 * existed directly below it. The deposit paths are now closed.
 */
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const { applyDateRange } = require('../utils/dateRange');
const bonusWalletService = require('../services/bonusWalletService');
const walletService = require('../services/walletService');

// Shared refusal for every user-initiated path that would move money INTO the
// Bonus Wallet. Same code and wording as walletController.internalTransfer, so
// the rule reads identically wherever a user meets it.
const _assertWithdrawOnly = () => {
  throw new AppError(
    'The Bonus Wallet cannot receive deposits — it is funded by referral and partner earnings only. You can withdraw from it or transfer out of it.',
    400,
    'BONUS_WALLET_WITHDRAW_ONLY'
  );
};
const TradingAccount = require('../models/TradingAccount');
const { Wallet } = require('../models/Wallet');
const { WALLET_TX_TYPE } = require('../config/constants');
const { Deposit, Withdrawal } = require('../models/index');
const { BonusWallet, BonusTransaction } = require('../models/BonusWallet');
const User = require('../models/User');

/* ── User-facing ────────────────────────────────────────────────── */

// GET /bonus-wallet
const getWallet = asyncHandler(async (req, res) => {
  const wallet = await bonusWalletService.getOrCreate(req.userId);
  const summary = await bonusWalletService.summary(req.userId);
  sendSuccess(res, {
    _id: wallet._id,
    userId: wallet.userId,
    walletType: wallet.walletType,
    balance: wallet.balance,
    currency: wallet.currency,
    autoRenew: wallet.autoRenew,
    gracePeriodDays: wallet.gracePeriodDays,
    lowBalanceThreshold: wallet.lowBalanceThreshold,
    isLowBalance: bonusWalletService.isLowBalance(wallet),
    updatedAt: wallet.updatedAt,
    ...summary,
  });
});

// POST /bonus-wallet/withdraw  { amount, method, + destination fields }
//
// Real Bonus-Wallet cash-out. Balance is DEBITED (held) up-front and a PENDING
// Withdrawal (source='BONUS') is created for the admin queue. Admin approve →
// external payout, balance stays debited. Admin reject → balance refunded
// (see adminController.rejectWithdrawal). KYC-gated like every withdrawal.
const requestWithdrawal = asyncHandler(async (req, res) => {
  const n = Number(req.body.amount);
  if (!Number.isFinite(n) || n <= 0) throw new AppError('amount must be a positive number', 400);
  // A saved, admin-verified method is resolved SERVER-SIDE — the raw
  // destination never travels in the request. The client only ever holds a
  // masked view of it, so it could not have sent the real one anyway.
  //
  // A typed destination is refused outright — see the else branch. That is
  // the core payout rule (WithdrawalMethod header), and these two wallets
  // used to be the exception to it.
  const savedId = req.body.withdrawalMethodId;
  let M; const dest = {};
  if (savedId) {
    const { resolveSavedMethod, assertNoConflictingDestination } = require('../utils/savedWithdrawalMethod');
    const resolved = await resolveSavedMethod(req.userId, savedId);
    M = resolved.type;
    Object.assign(dest, resolved.dest);
    assertNoConflictingDestination(req.body, M, dest);
  } else {
    // No saved method id means someone is typing a destination by hand. That
    // is exactly what the verified-destination rule exists to prevent, and
    // the trading wallet has always refused it. Refuse it here too.
    throw new AppError(
      'Select a saved, verified withdrawal method. Add one under Wallet → Withdrawal methods and wait for it to be verified.',
      400,
      'WITHDRAWAL_METHOD_REQUIRED'
    );
  }


  const user = await User.findById(req.userId).select('kycStatus').lean();
  if (!user || user.kycStatus !== 'APPROVED') {
    throw new AppError('KYC verification must be approved before withdrawing funds.', 403, 'KYC_REQUIRED');
  }

  const amtStr = String(n);

  // The admin's rail settings — enabled, per-method min/max, withdrawal fee.
  // The Bonus Wallet applied none of them; a payout here ignored every
  // payment-method rule configured in Settings.
  const { preparePayout } = require('../utils/paymentMethods');
  // `fee` / `net` are USD — what leaves the wallet. `payout*` is what the
  // user receives on the rail, in the rail's own currency.
  const {
    fee: wdFee, net: wdNet,
    payoutCurrency: payCcy, payoutAmount: payAmt,
    payoutFeeAmount: payFee, payoutNetAmount: payNet, fxRate: payRate,
  } = await preparePayout(M, n);

  // 1. Debit (hold) the Bonus Wallet — throws 402 if balance is short.
  let walletAfter;
  // Kept so the Withdrawal id can be stamped on it once it exists.
  let debitTx = null;
  try {
    const { wallet, tx } = await bonusWalletService.debit({
      userId: req.userId,
      amount: amtStr,
      reason: 'WITHDRAWAL',
      note: `Withdrawal request · ${M}`,
    });
    walletAfter = wallet;
    debitTx = tx;
  } catch (err) {
    if (err.code === 'INSUFFICIENT_BONUS_BALANCE') {
      throw new AppError(err.message, 402, 'INSUFFICIENT_BALANCE');
    }
    throw err;
  }

  // 2. Create PENDING withdrawal; refund the hold if the record can't be made.
  let wd;
  try {
    wd = await Withdrawal.create({
      userId: req.userId,
      source: 'BONUS',
      // What the admin actually sends, in the rail's own currency.
      currency: payCcy,
      amount: payAmt,
      // The USD that left the wallet. baseAmount stays the figure the user
      // typed, so the debit and the record can never disagree.
      baseCurrency: 'USD',
      baseAmount: amtStr,
      fxRateUsed: payRate,
      fee: wdFee,        // USD (base)
      // Display currency, per the schema — these are what the admin reads.
      feeAmount: payFee,
      netAmount: payNet,
      method: M,
      ...dest,
      status: 'PENDING',
    });
  } catch (createErr) {
    try {
      await bonusWalletService.credit({
        userId: req.userId, amount: amtStr, reason: 'REFUND',
        note: 'Refund: withdrawal request could not be created',
      });
    } catch (refundErr) {
      console.error('[bonusWallet.withdraw] CRITICAL: hold refund failed', refundErr.message);
    }
    throw createErr;
  }

  // Point the funding debit at the withdrawal it paid for. Best-effort:
  // the money has already moved correctly either way, and a missing link
  // costs a Balance Before/After column, not a wrong balance.
  if (debitTx) {
    try {
      debitTx.referenceId = wd._id;
      await debitTx.save();
    } catch (e) { console.error('[bonusWallet.withdraw] could not link debit to withdrawal:', e.message); }
  }

  sendSuccess(res, {
    withdrawalId: wd._id,
    status: wd.status,
    amount: wd.amount,
    currency: wd.currency,
    method: wd.method,
    balance: walletAfter.balance,
  }, 201);
});

// POST /bonus-wallet/auto-renew  { enabled }
const toggleAutoRenew = asyncHandler(async (req, res) => {
  const wallet = await bonusWalletService.setAutoRenew(req.userId, !!req.body.enabled);
  sendSuccess(res, { autoRenew: wallet.autoRenew });
});

// GET /bonus-wallet/summary
const getSummary = asyncHandler(async (req, res) => {
  sendSuccess(res, await bonusWalletService.summary(req.userId));
});

// GET /bonus-wallet/history?limit=&type=&reason=
const history = asyncHandler(async (req, res) => {
  const items = await bonusWalletService.history(req.userId, {
    limit: req.query.limit,
    type: req.query.type,
    reason: req.query.reason,
  });
  sendSuccess(res, items);
});

// POST /bonus-wallet/deposit  { amount, sourceAccountId? }
//
// Instant "Add Funds" from a trading account: debits the trading wallet
// and credits the Bonus Wallet in one step (mirrors the Main Wallet's
// instant deposit). Manual/external methods go through manualDeposit.
// WITHDRAW-ONLY. See _assertWithdrawOnly. The body below is left intact so the
// endpoint can be restored in one line if the rule ever changes.
const deposit = asyncHandler(async (req, res) => {
  _assertWithdrawOnly();
  const { amount, sourceAccountId, note } = req.body;
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new AppError('amount must be a positive number', 400);
  const amtStr = String(n);

  // Resolve the source account: caller-supplied or the user's primary
  // (oldest) real trading account.
  let account;
  if (sourceAccountId) {
    account = await TradingAccount.findOne({ _id: sourceAccountId, userId: req.userId, isActive: true });
    if (!account) throw new AppError('Source account not found', 404, 'ACCOUNT_NOT_FOUND');
  } else {
    account = await TradingAccount.findOne({
      userId: req.userId,
      accountType: { $nin: ['DEMO', 'VIRTUAL'] },
      isActive: true,
    }).sort({ createdAt: 1 });
    if (!account) throw new AppError('You need a real trading account to fund the Bonus Wallet.', 400, 'NO_REAL_ACCOUNT');
  }
  const ccy = account.baseCurrency || 'USD';

  // Debit trading wallet first. If short, INSUFFICIENT and bonus untouched.
  let ledger;
  try {
    ledger = await walletService.debit({
      userId: req.userId,
      accountId: account._id,
      currency: ccy,
      amount: amtStr,
      type: WALLET_TX_TYPE.ADJUSTMENT,
      referenceType: 'bonus_wallet_topup',
      note: note || 'Transfer to Bonus Wallet',
    });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_FUNDS') {
      const w = await Wallet.findOne({ userId: req.userId, accountId: account._id, currency: ccy }).lean();
      throw new AppError(
        `Insufficient balance in account ${account.accountNumber} (${ccy} ${w?.balance || '0'}). Top up your trading wallet first.`,
        402, 'INSUFFICIENT_TRADING_BALANCE',
        { accountId: account._id, accountNumber: account.accountNumber, available: w?.balance || '0', needed: amtStr, currency: ccy }
      );
    }
    throw err;
  }

  // Credit the Bonus Wallet — refund the trading wallet if it fails.
  try {
    const { wallet, tx } = await bonusWalletService.credit({
      userId: req.userId,
      amount: amtStr,
      reason: 'DEPOSIT',
      paymentRef: `topup:${ledger._id}`,
      sourceWallet: `trading:${account._id}`,
      note: note || `From trading account ${account.accountNumber}`,
    });
    return sendSuccess(res, { wallet, transaction: tx, source: { accountId: account._id, accountNumber: account.accountNumber, currency: ccy, ledgerId: ledger._id } }, 201);
  } catch (creditErr) {
    try {
      await walletService.credit({
        userId: req.userId,
        accountId: account._id,
        currency: ccy,
        amount: amtStr,
        type: WALLET_TX_TYPE.ADJUSTMENT,
        referenceType: 'bonus_wallet_topup_refund',
        note: 'Refund: bonus wallet credit failed',
      });
    } catch (refundErr) {
      console.error('[bonusWallet.deposit] CRITICAL: refund failed', refundErr.message);
    }
    throw creditErr;
  }
});

// POST /bonus-wallet/manual-deposit
// External deposit (UPI/Bank/Crypto/Skrill/Neteller) → creates a PENDING
// Deposit with targetWallet:'bonus'. Admin verification credits the Bonus
// Wallet (adminController.confirmDeposit routes by targetWallet).
const manualDeposit = asyncHandler(async (req, res) => {
  _assertWithdrawOnly();
  const {
    amount, currency = 'USD', method, txReference,
    senderName, senderUpiId, senderBankAccount, screenshot, screenshotMimeType, note,
  } = req.body;
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new AppError('amount must be a positive number', 400);
  if (!method) throw new AppError('Payment method is required', 400);
  if (!txReference || !String(txReference).trim()) throw new AppError('Transaction reference is required', 400);
  if (!screenshot) throw new AppError('Payment proof screenshot is required', 400);

  const dep = await Deposit.create({
    userId: req.userId,
    targetWallet: 'bonus',
    accountId: undefined,
    currency: String(currency).toUpperCase(),
    amount: String(amt),
    baseCurrency: 'USD',
    baseAmount: String(amt.toFixed(2)),
    fxRateUsed: 1,
    method,
    txReference: String(txReference).trim(),
    senderName,
    senderUpiId,
    senderBankAccount,
    screenshot,
    screenshotMimeType,
    note: note || 'Bonus wallet top-up',
    status: 'PENDING',
  });

  sendSuccess(res, { depositId: dep._id, status: dep.status, amount: dep.amount, currency: dep.currency, method: dep.method }, 201);
});

/* ── Admin ──────────────────────────────────────────────────────── */

// POST /bonus-wallet/admin/credit  { userId, amount, note? }
const adminCredit = asyncHandler(async (req, res) => {
  const { userId, amount, note } = req.body;
  if (!userId || !amount) throw new AppError('userId and amount required', 400);
  // Accepts a full ObjectId, the user UID, an email, or the id fragment the
  // admin tables print — and says which it was when none of them match,
  // instead of letting a CastError become a 500.
  const { resolveUserRef } = require('../utils/resolveUserRef');
  const resolvedUserId = await resolveUserRef(userId);
  const { wallet, tx } = await bonusWalletService.credit({
    userId: resolvedUserId,
    amount: String(amount),
    reason: 'ADMIN_CREDIT',
    note: note || 'Admin manual credit',
    adminUserId: req.userId,
  });
  await _audit(req, 'BONUS_WALLET_CREDIT', wallet._id, { userId, amount: String(amount), note });
  sendSuccess(res, { wallet, transaction: tx });
});

// POST /bonus-wallet/admin/debit  { userId, amount, note? }
const adminDebit = asyncHandler(async (req, res) => {
  const { userId, amount, note } = req.body;
  if (!userId || !amount) throw new AppError('userId and amount required', 400);
  // Accepts a full ObjectId, the user UID, an email, or the id fragment the
  // admin tables print — and says which it was when none of them match,
  // instead of letting a CastError become a 500.
  const { resolveUserRef } = require('../utils/resolveUserRef');
  const resolvedUserId = await resolveUserRef(userId);
  const { wallet, tx } = await bonusWalletService.debit({
    userId: resolvedUserId,
    amount: String(amount),
    reason: 'ADMIN_DEBIT',
    note: note || 'Admin manual debit',
    adminUserId: req.userId,
  });
  await _audit(req, 'BONUS_WALLET_DEBIT', wallet._id, { userId, amount: String(amount), note });
  sendSuccess(res, { wallet, transaction: tx });
});

// GET /bonus-wallet/admin/balances?search=&page=&limit=
// Paginated list of users' bonus-wallet balances (admin overview).
const adminBalances = asyncHandler(async (req, res) => {
  const { page = '1', limit = '50' } = req.query;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
  // Hierarchy scope — an ADMIN sees only their subtree's bonus wallets.
  const filter = {};
  if (req.user && req.user.role === 'ADMIN') {
    const ids = await require('../models/User').find({ adminId: req.user._id }).distinct('_id');
    filter.userId = { $in: ids };
  }
  const [wallets, total] = await Promise.all([
    BonusWallet.find(filter)
      .sort({ updatedAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .populate('userId', 'email firstName lastName')
      .lean(),
    BonusWallet.countDocuments(filter),
  ]);
  sendSuccess(res, { items: wallets, pagination: { page: p, limit: l, total, pages: Math.ceil(total / l) } });
});

// GET /bonus-wallet/admin/logs?userId=&reason=&from=&to=&page=&limit=
// Paginated transaction history across all users (filterable by referral/
// partner reason). Used for both the admin log view and CSV export.
const adminLogs = asyncHandler(async (req, res) => {
  const { userId, reason, from, to, page = '1', limit = '50' } = req.query;
  const q = {};
  if (userId) q.userId = userId;
  if (reason) q.reason = reason;
  // Inclusive of the whole `to` day (fixes From==To returning nothing).
  applyDateRange(q, 'createdAt', from, to);
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(1000, Math.max(1, parseInt(limit, 10) || 50));
  const [items, total] = await Promise.all([
    BonusTransaction.find(q)
      .sort({ createdAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .populate('userId', 'email firstName lastName')
      .lean(),
    BonusTransaction.countDocuments(q),
  ]);
  sendSuccess(res, { items, pagination: { page: p, limit: l, total, pages: Math.ceil(total / l) } });
});

// Best-effort audit log — never blocks the wallet op if logging fails.
async function _audit(req, action, targetId, metadata) {
  try {
    const { AuditLog } = require('../models');
    if (!AuditLog) return;
    await AuditLog.create({
      actorId: req.userId,
      actorRole: req.user?.role,
      action,
      targetType: 'BONUS_WALLET',
      targetId: String(targetId),
      metadata,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  } catch (_) { /* non-fatal */ }
}

module.exports = { getWallet, getSummary, history, requestWithdrawal, toggleAutoRenew, deposit, manualDeposit, adminCredit, adminDebit, adminBalances, adminLogs };
