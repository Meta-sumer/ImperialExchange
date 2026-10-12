const { Wallet, WalletLedger } = require('../models/Wallet');
const { add, sub, gt, gte, D } = require('../utils/decimal');
const { AppError } = require('../utils/errors');
// The short ticket the user actually sees on the trade screen ("Order ID").
const { ticketShort } = require('../utils/ticket');

// Idempotency is now enforced at the data layer via WalletLedger's unique
// `dedupeKey` index + atomic Wallet.findOneAndUpdate with an aggregation
// pipeline. Mongo transactions are no longer required for correctness —
// the same code runs on standalone (dev/MVP) and replica set (prod).
const _isDuplicateKeyError = (err) =>
  err && (err.code === 11000 || /E11000/i.test(err.message || ''));

// Credit types that count as RE-FUNDING an account, and therefore lift a
// STOPPED_OUT guard.
//
// This used to be `type === 'DEPOSIT'` alone, which meant money arriving any
// other way left the account locked. Transferring from the Main Wallet into a
// stopped-out account credited the balance, showed the new figure in the UI,
// and still refused to trade — the user had to make an external deposit to get
// the same money recognised. From the account's point of view those are the
// same event: the balance went up.
//
// TRADE_CLOSE and FEE are deliberately absent. The stop-out flips the status
// BEFORE liquidating, so if settlement proceeds counted as funding, the
// liquidation would lift the very guard it had just set. They do not reach here
// today — releaseMargin and settleTrade write their ledger rows directly rather
// than through credit() — but naming the funding types explicitly keeps that
// true if either is ever routed through this function.
const { WALLET_TX_TYPE } = require('../config/constants');
const _FUNDING_TYPES = new Set([
  WALLET_TX_TYPE.DEPOSIT,
  WALLET_TX_TYPE.TRANSFER,               // wallet ↔ trading account
  WALLET_TX_TYPE.INTERNAL_TRANSFER_IN,   // received from another user
  WALLET_TX_TYPE.ADJUSTMENT,             // admin credit, bonus/subscription payout
  WALLET_TX_TYPE.DIVIDEND,               // corporate action cash
]);

const _assertPositive = (amount, label = 'amount') => {
  if (amount === undefined || amount === null || amount === '') {
    throw new AppError(`${label} required`, 400, 'INVALID_AMOUNT');
  }
  let d;
  try {
    d = D(amount);
  } catch (e) {
    throw new AppError(`${label} must be numeric`, 400, 'INVALID_AMOUNT');
  }
  if (!d.isFinite() || d.lte(0)) {
    throw new AppError(`${label} must be positive`, 400, 'INVALID_AMOUNT');
  }
  return d.toString();
};

// Push a live wallet update to the user's open sessions so balance / free
// margin / equity refresh in REAL TIME (the client re-fetches on this event).
// Best-effort — never throws, so a WS hiccup can't roll back a wallet mutation.
const _notifyWallet = (userId, accountId, reason) => {
  try {
    require('../websocket/server').notifyUser(String(userId), 'wallet', {
      action: reason || 'updated',
      accountId: accountId ? String(accountId) : undefined,
      ts: Date.now(),
    });
  } catch (_) { /* ws optional */ }
};

// Upsert-based getOrCreate is race-safe; two concurrent callers can't both
// insert because the unique index on (userId, accountId, currency) rejects
// the second insert and the upsert returns the existing doc.
const getOrCreateWallet = async (userId, accountId, currency) => {
  return Wallet.findOneAndUpdate(
    { userId, accountId, currency },
    { $setOnInsert: { userId, accountId, currency, balance: '0', locked: '0' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

const credit = async ({ userId, accountId, currency, amount, type, referenceType, referenceId, note, dedupeKey }) => {
  const amt = _assertPositive(amount, 'amount');
  const wallet = await getOrCreateWallet(userId, accountId, currency);
  const amtNum = Number(amt);
  const updated = await Wallet.findOneAndUpdate(
    { _id: wallet._id },
    [
      {
        $set: {
          balance: { $toString: { $add: [{ $toDouble: '$balance' }, amtNum] } },
        },
      },
    ],
    { new: true }
  );
  try {
    await WalletLedger.create({
      walletId: updated._id,
      userId,
      accountId,
      type,
      currency,
      amount: amt,
      balanceBefore: sub(updated.balance, amt), // before = after − credited amount
      balanceAfter: updated.balance,
      referenceType,
      referenceId,
      dedupeKey,
      note,
    });
  } catch (err) {
    if (_isDuplicateKeyError(err) && dedupeKey) {
      console.log(`[walletService] credit SKIPPED (duplicate) dedupeKey=${dedupeKey}`);
      return updated;
    }
    throw err;
  }
  _notifyWallet(userId, accountId, 'credit');
  // Re-funding a stopped-out account lifts the STOPPED_OUT guard so the user can
  // trade again. Lazy require avoids the walletService ↔ stopOutService import
  // cycle. Best-effort — failing to lift the guard must never fail the credit.
  if (accountId && _FUNDING_TYPES.has(type)) {
    try { await require('./stopOutService').clearIfFunded(userId, accountId); } catch (_) { /* non-fatal */ }
  }
  return updated;
};

const debit = async ({ userId, accountId, currency, amount, type, referenceType, referenceId, note, dedupeKey }) => {
  const amt = _assertPositive(amount, 'amount');
  const wallet = await getOrCreateWallet(userId, accountId, currency);
  const amtNum = Number(amt);
  // Atomic precondition: only debit if current balance >= amount. If not,
  // findOneAndUpdate returns null and we throw INSUFFICIENT_FUNDS.
  const updated = await Wallet.findOneAndUpdate(
    {
      _id: wallet._id,
      $expr: { $gte: [{ $toDouble: '$balance' }, amtNum] },
    },
    [
      {
        $set: {
          balance: { $toString: { $subtract: [{ $toDouble: '$balance' }, amtNum] } },
        },
      },
    ],
    { new: true }
  );
  if (!updated) {
    throw new AppError('Insufficient balance', 400, 'INSUFFICIENT_FUNDS');
  }
  try {
    await WalletLedger.create({
      walletId: updated._id,
      userId,
      accountId,
      type,
      currency,
      amount: '-' + amt,
      balanceBefore: add(updated.balance, amt), // before = after + debited amount
      balanceAfter: updated.balance,
      referenceType,
      referenceId,
      dedupeKey,
      note,
    });
  } catch (err) {
    if (_isDuplicateKeyError(err) && dedupeKey) {
      console.log(`[walletService] debit SKIPPED (duplicate) dedupeKey=${dedupeKey}`);
      return updated;
    }
    throw err;
  }
  _notifyWallet(userId, accountId, 'debit');
  return updated;
};

const lock = async ({ userId, accountId, currency, amount }) => {
  const amt = _assertPositive(amount, 'amount');
  const wallet = await getOrCreateWallet(userId, accountId, currency);
  const amtNum = Number(amt);
  const updated = await Wallet.findOneAndUpdate(
    {
      _id: wallet._id,
      $expr: {
        $gte: [
          { $subtract: [{ $toDouble: '$balance' }, { $toDouble: '$locked' }] },
          amtNum,
        ],
      },
    },
    [
      {
        $set: {
          locked: { $toString: { $add: [{ $toDouble: '$locked' }, amtNum] } },
        },
      },
    ],
    { new: true }
  );
  if (!updated) {
    throw new AppError('Insufficient free balance to lock', 400, 'INSUFFICIENT_FREE');
  }
  return updated;
};

const unlock = async ({ userId, accountId, currency, amount }) => {
  const amt = _assertPositive(amount, 'amount');
  const wallet = await getOrCreateWallet(userId, accountId, currency);
  const amtNum = Number(amt);
  // $max floors locked at 0 if the unlock would underflow (state drift).
  const updated = await Wallet.findOneAndUpdate(
    { _id: wallet._id },
    [
      {
        $set: {
          locked: {
            $toString: {
              $max: [0, { $subtract: [{ $toDouble: '$locked' }, amtNum] }],
            },
          },
        },
      },
    ],
    { new: true }
  );
  return updated;
};

const getBalances = async (userId, accountId) => {
  const filter = { userId };
  if (accountId) filter.accountId = accountId;
  return Wallet.find(filter).lean();
};

/**
 * Lock margin when an order opens or adds to a position.
 * Atomic: precondition checks free balance server-side, so two concurrent
 * order placements can't both pass the same check and over-lock.
 */
const lockMargin = async ({ userId, accountId, currency, amount, orderId, note }) => {
  if (!gt(amount, '0')) return null;
  const amt = _assertPositive(amount, 'amount');
  const wallet = await getOrCreateWallet(userId, accountId, currency);
  const amtNum = Number(amt);
  const updated = await Wallet.findOneAndUpdate(
    {
      _id: wallet._id,
      $expr: {
        $gte: [
          { $subtract: [{ $toDouble: '$balance' }, { $toDouble: '$locked' }] },
          amtNum,
        ],
      },
    },
    [
      {
        $set: {
          locked: { $toString: { $add: [{ $toDouble: '$locked' }, amtNum] } },
        },
      },
    ],
    { new: true }
  );
  if (!updated) {
    const free = sub(wallet.balance, wallet.locked);
    throw new AppError(
      `Insufficient free balance. Need ${amt} ${currency}, available ${free}`,
      400,
      'INSUFFICIENT_FREE'
    );
  }
  await WalletLedger.create({
    walletId: updated._id,
    userId,
    accountId,
    type: 'TRADE_OPEN',
    currency,
    amount: '0',
    // Opening only reserves margin (moves free→locked); the realized balance is
    // unchanged, so before == after. This is why an open never moves the ledger
    // balance — only a close/deposit/withdraw/fee does.
    balanceBefore: updated.balance,
    balanceAfter: updated.balance,
    referenceType: 'order',
    referenceId: orderId,
    note: note || `Margin locked: ${amt}`,
  });
  _notifyWallet(userId, accountId, 'margin_locked');
  return updated;
};

/**
 * Release locked margin without touching balance. Used on order cancel for
 * the unfilled portion, and from settleTradeClose when a position reduces.
 * Atomic: $max floors locked at 0 if the release would underflow on stale
 * state — same defensive pattern as unlock().
 */
const releaseMargin = async ({ userId, accountId, currency, amount, orderId, positionId, note }) => {
  if (!gt(amount, '0')) return null;
  const amt = _assertPositive(amount, 'amount');
  const wallet = await getOrCreateWallet(userId, accountId, currency);
  const amtNum = Number(amt);
  const updated = await Wallet.findOneAndUpdate(
    { _id: wallet._id },
    [
      {
        $set: {
          locked: {
            $toString: {
              $max: [0, { $subtract: [{ $toDouble: '$locked' }, amtNum] }],
            },
          },
        },
      },
    ],
    { new: true }
  );
  await WalletLedger.create({
    walletId: updated._id,
    userId,
    accountId,
    type: 'TRADE_CLOSE',
    currency,
    amount: '0',
    // Margin release touches `locked` only — realized balance is unchanged.
    balanceBefore: updated.balance,
    balanceAfter: updated.balance,
    referenceType: positionId ? 'position' : 'order',
    referenceId: positionId || orderId,
    note: note || `Margin released: ${amt}`,
  });
  _notifyWallet(userId, accountId, 'margin_released');
  return updated;
};

/**
 * Settle a position close — credit PnL, release margin, charge fee, write
 * a single audit ledger row. Idempotent and retry-safe.
 *
 * Idempotency contract:
 *   Caller MUST pass a stable `dedupeKey` (e.g. "TRADE_SETTLE:<tradeId>" or
 *   "POSITION_SETTLE:<positionId>"). The ledger row uses this key under a
 *   sparse unique index, so a duplicate insert is rejected with E11000 and
 *   we short-circuit BEFORE touching the wallet — guaranteeing PnL can't
 *   be double-credited even if two requests race.
 */
const settleTradeClose = async ({
  userId, accountId, currency, marginToRelease, pnl, fee, positionId, tradeId, dedupeKey, symbol,
}) => {
  if (!dedupeKey) {
    dedupeKey = `POSITION_SETTLE:${positionId}`;
  }

  const wallet = await getOrCreateWallet(userId, accountId, currency);
  const balanceBefore = wallet.balance;

  const pnlD = D(pnl);
  const feeD = D(fee || '0');
  const marginD = D(marginToRelease || '0');
  const settlementAmount = marginD.plus(pnlD).minus(feeD).toString();
  const balanceDelta = pnlD.minus(feeD).toString();

  // Negative-balance protection (default ON): a realized loss larger than the
  // balance must NOT drive the wallet below zero — floor at 0 and record how much
  // the broker absorbs. Fixes "balance went negative after a close / missed
  // stop-out". Disabled only when the account explicitly turns it off.
  let nbpOn = true;
  try {
    const TradingAccount = require('../models/TradingAccount');
    const acc = await TradingAccount.findById(accountId).select('negativeBalanceProtection').lean();
    if (acc && acc.negativeBalanceProtection === false) nbpOn = false;
  } catch (_) { /* default protected */ }
  const projected = D(wallet.balance).plus(balanceDelta);
  const willFloor = nbpOn && projected.isNegative();
  const absorbed = willFloor ? projected.abs().toString() : '0';

  const pnlDisplay =
    pnlD.equals(0) ? '0' :
    pnlD.isNegative() ? pnlD.toString() :
    '+' + pnlD.toString();

  const expectedBalanceAfter = willFloor ? '0' : projected.toString();

  // For a clean, continuous Before/After chain, the TRADE_CLOSE row shows the
  // balance AFTER PnL (before fee); the separate FEE row then steps it down to
  // the final. (The wallet balance itself still moves in a single step below —
  // these are display snapshots so each row's after == the next row's before.)
  const hasFee = gt(feeD.toString(), '0');
  const afterPnlD = D(balanceBefore).plus(pnlD);
  const afterPnlStr = (nbpOn && afterPnlD.isNegative()) ? '0' : afterPnlD.toString();
  const closeRowAfter = hasFee ? afterPnlStr : expectedBalanceAfter;

  try {
    await WalletLedger.create({
      walletId: wallet._id,
      userId,
      accountId,
      type: 'TRADE_CLOSE',
      currency,
      amount: pnlDisplay,
      balanceBefore,
      balanceAfter: closeRowAfter,
      referenceType: 'position',
      referenceId: positionId,
      dedupeKey,
      // The ticket goes FIRST. This note is the one line that says which trade
      // moved the balance, and it was the only money row in the history with no
      // id on it at all — the FEE row beneath it had one, so a close could not
      // be matched back to its position by eye. It leads rather than trails
      // because the rest of the line wraps to several rows in the table.
      note: `order ${ticketShort(positionId)} · PnL ${pnlD.toString()} · margin released ${marginD.toString()} · fee ${feeD.toString()} · settled ${settlementAmount}${willFloor ? ` · NBP: broker absorbed ${absorbed} (balance floored to 0)` : ''}`,
    });
  } catch (err) {
    if (_isDuplicateKeyError(err)) {
      console.log(`[walletService] settleTradeClose SKIPPED (already settled) dedupeKey=${dedupeKey}`);
      return wallet;
    }
    throw err;
  }

  const balanceDeltaNum = Number(balanceDelta);
  const marginNum = Number(marginD.toString());
  const finalUpdated = await Wallet.findOneAndUpdate(
    { _id: wallet._id },
    [
      {
        $set: {
          balance: {
            // Floor at 0 when negative-balance protection is on so a loss bigger
            // than the balance can never push the wallet negative.
            $toString: nbpOn
              ? { $max: [0, { $add: [{ $toDouble: '$balance' }, balanceDeltaNum] }] }
              : { $add: [{ $toDouble: '$balance' }, balanceDeltaNum] },
          },
          locked: {
            $toString: {
              $max: [
                0,
                { $subtract: [{ $toDouble: '$locked' }, marginNum] },
              ],
            },
          },
        },
      },
    ],
    { new: true }
  );

  if (gt(feeD.toString(), '0')) {
    try {
      await WalletLedger.create({
        walletId: wallet._id,
        userId,
        accountId,
        type: 'FEE',
        currency,
        amount: '-' + feeD.toString(),
        balanceBefore: afterPnlStr,          // steps down from the post-PnL balance
        balanceAfter: finalUpdated.balance,
        // Trace the fee to the exact position it was charged on — this FEE row
        // and its TRADE_CLOSE row share referenceId = positionId. tradeId can be
        // null on some worker/B-book settle paths, so positionId is primary.
        referenceType: 'position',
        referenceId: positionId || tradeId,
        dedupeKey: `${dedupeKey}:FEE`,
        // Same derivation as every other ticket in the app — kept, just routed
        // through the shared helper so the format cannot drift.
        note: `Trading fee${symbol ? ` · ${symbol}` : ''}${positionId ? ` · order ${ticketShort(positionId)}` : ''}`,
      });
    } catch (err) {
      if (!_isDuplicateKeyError(err)) {
        console.warn('[walletService] fee ledger insert failed:', err.message);
      }
    }
  }

  console.log(
    `[walletService] settleTradeClose acc=${accountId} ${currency} ` +
    `bal ${balanceBefore} -> ${finalUpdated.balance} locked ${wallet.locked} -> ${finalUpdated.locked} ` +
    `(pnl=${pnlD.toString()}, fee=${feeD.toString()}, marginReleased=${marginD.toString()}, ` +
    `settlementAmount=${settlementAmount}, dedupeKey=${dedupeKey})`
  );

  return finalUpdated;
};

module.exports = {
  getOrCreateWallet,
  credit,
  debit,
  lock,
  unlock,
  getBalances,
  lockMargin,
  releaseMargin,
  settleTradeClose,
};
