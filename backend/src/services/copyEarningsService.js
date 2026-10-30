/**
 * copyEarningsService — Master Trader Earnings (performance fee).
 *
 * When a copied trade closes IN PROFIT, the master earns a configurable
 * percentage of the FOLLOWER'S realized profit:
 *
 *     masterFee        = realizedProfit × feePercent / 100
 *     followerNetProfit = realizedProfit − masterFee
 *
 * The follower already received the FULL realized profit via the unchanged
 * settlement engine, so per profitable close we move ONLY the fee:
 *
 *     follower trading account  −= masterFee                (account currency)
 *     box escrow (CopyBox)      += masterFee          (USD) ← ACCRUED, not paid
 *
 * followerNetProfit is not moved anywhere. It is already sitting in the
 * trading account from the close and stays there, so the follower keeps
 * trading it and compounding it. It is recorded on the earnings row for
 * reporting only.
 *
 * The master fee is NO LONGER paid per trade. It accrues in the box's escrow
 * (CopyBox.accruedFeeUsd) and is released to the master's Main Wallet only at
 * MONTH-END, and only if the box's source account was net-profitable that
 * month (else it carries forward — high-water). This protects followers: a
 * leader can't collect a fee on a month the strategy lost. See
 * settleMonthlyFees() below (driven by backgroundWorker's slow-tick).
 *
 * This is purely ADDITIVE — execution, settlement, margin, wallet engines
 * and followerAccountId selection are never touched. Existing copy trading
 * keeps working unchanged when the fee system is disabled or set to 0%.
 *
 * Safety guarantees:
 *   • No fee on losses or breakeven (realizedProfit must be > 0).
 *   • No double charging — one CopyTradeEarnings row per follower position
 *     (unique index) + dedupeKey on both the debit and the master credit.
 *   • Master is credited ONLY if the follower was successfully debited; if
 *     the credit then fails, the follower debit is refunded (no money lost).
 *   • Full audit trail (CopyTradeEarnings row + AuditLog entry).
 */
const mongoose          = require('mongoose');
const CopyTradeEarnings = require('../models/CopyTradeEarnings');
const CopyBox           = require('../models/CopyBox');
const TraderProfile     = require('../models/TraderProfile');
const Position          = require('../models/Position');
const { Wallet }        = require('../models/Wallet'); // module exports { Wallet, WalletLedger }
const { AuditLog }      = require('../models');
const walletService     = require('./walletService');
const bonusWalletService= require('./bonusWalletService');
const subscriptionWalletService = require('./subscriptionWalletService'); // "Main Wallet"
const currencyService   = require('./currencyService');
const systemSettings    = require('./systemSettings.service');
const { BASE_CURRENCY, WALLET_TX_TYPE, POSITION_STATUS } = require('../config/constants');
const { sub, mul, div, gt } = require('../utils/decimal');

const oid = (id) => mongoose.Types.ObjectId.createFromHexString(String(id));
const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const round2s = (x) => round2(x).toFixed(2);

/** Read the admin-configurable fee settings (cached in systemSettings). */
async function getFeeSettings() {
  const [enabled, def, min, max] = await Promise.all([
    systemSettings.getSetting('copyTrading.enabled'),
    systemSettings.getSetting('copyTrading.defaultPerformanceFee'),
    systemSettings.getSetting('copyTrading.minFee'),
    systemSettings.getSetting('copyTrading.maxFee'),
  ]);
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    enabled:    enabled !== false,
    defaultFee: num(def, 20),
    minFee:     num(min, 0),
    maxFee:     num(max, 50),
  };
}

/**
 * Effective fee percent, resolved in order of precedence:
 *   1. the BOX's own fee (per source account)         — when masterAccountId given
 *   2. the owner's TraderProfile fee                   — fallback
 *   3. the platform default
 * Always clamped to [minFee, maxFee]. Returns 0 when the system is disabled.
 */
async function resolveFeePercent(masterId, settings, masterAccountId) {
  const s = settings || (await getFeeSettings());
  if (!s.enabled) return 0;
  let pct = null;
  if (masterAccountId) {
    const box = await CopyBox.findOne({ accountId: masterAccountId }).select('performanceFeePercent').lean();
    if (box && box.performanceFeePercent != null) pct = Number(box.performanceFeePercent);
  }
  if (pct == null) {
    const profile = await TraderProfile.findOne({ userId: masterId }).select('performanceFeePercent').lean();
    pct = profile && profile.performanceFeePercent != null ? Number(profile.performanceFeePercent) : s.defaultFee;
  }
  if (!Number.isFinite(pct)) pct = s.defaultFee;
  return Math.max(s.minFee, Math.min(s.maxFee, pct));
}

/**
 * Settle a PROFITABLE copy-trade close.
 *
 * Settlement (untouched) already credited the follower's FULL realized P&L
 * to their trading account. For a profitable close we redistribute that
 * profit additively — without touching execution / sync / margin / routing:
 *
 *   follower trading account  −= realizedProfit       (remove profit; margin stays)
 *   master  Main Wallet       += masterFee   (USD)    (performance fee, if any)
 *   follower MAIN  Wallet      += followerNet (USD)    (realizedProfit − masterFee)
 *
 * So follower copy-trading PROFIT lands in the MAIN WALLET, not the trading
 * account. Losses / breakeven are left exactly as the engine settled them
 * (no fee, no movement — the loss stays applied to the trading account).
 *
 * Idempotent: the CopyTradeEarnings row (unique followerPositionId) is the
 * claim/lock — created BEFORE any money moves, removed if the move fails so
 * a later retry can re-settle. Never throws into the copy-close flow.
 *
 * @param {object} mirror  a CopyTrade document (master + follower + position ids)
 * @returns {Promise<CopyTradeEarnings|null>}
 */
async function settleCopyTradeProfit(mirror) {
  try {
    if (!mirror || !mirror.followerPositionId) return null;

    // ── Idempotency fast-path: settle each follower position once. ──
    const already = await CopyTradeEarnings
      .findOne({ followerPositionId: mirror.followerPositionId })
      .select('_id').lean();
    if (already) return null;

    // Need a fully-settled follower position with a known realized PnL.
    const pos = await Position.findById(mirror.followerPositionId).lean();
    if (!pos || pos.status !== POSITION_STATUS.CLOSED) return null;

    const realized = Number(pos.realizedPnl);
    if (!Number.isFinite(realized) || realized <= 0) return null; // LOSS/breakeven → untouched

    // ── Compute the split (follower account currency). Fee may be 0. ──
    const settings = await getFeeSettings();
    const feePercent = settings.enabled ? await resolveFeePercent(mirror.masterId, settings, mirror.masterAccountId) : 0;

    const realizedStr = String(pos.realizedPnl);
    const feeAmount = feePercent > 0 ? round2s(mul(realizedStr, div(String(feePercent), '100'))) : '0.00';
    const netAmount = round2s(sub(realizedStr, feeAmount)); // follower net (account ccy)

    const wallet = await Wallet
      .findOne({ userId: mirror.followerId, accountId: pos.accountId })
      .select('currency').lean();
    const currency = (wallet && wallet.currency) || BASE_CURRENCY;

    // ── Convert each leg to USD (Bonus Wallet + Main Wallet are USD). ──
    const feeConv = gt(feeAmount, '0') ? await currencyService.toBase(currency, Number(feeAmount)) : { baseAmount: 0, rate: 1 };
    const netConv = await currencyService.toBase(currency, Number(netAmount));
    const feeUsd = round2(feeConv.baseAmount);
    const netUsd = round2(netConv.baseAmount);
    const fxRate = Number(netConv.rate || feeConv.rate) || 1;

    // ONLY the master's fee leaves the trading account.
    //
    // This used to sweep fee + net — the WHOLE realized profit — and
    // re-credit the net to the follower's Main Wallet. Nothing was lost, but
    // a winning copy trade made the trading balance FALL (100 → 110.56 on
    // the close → 95.73 after the sweep), the follower could not compound
    // the profit their own account had just made, and the equity curve
    // stopped agreeing with the trade history. A performance fee takes its
    // percentage and nothing more.
    //
    // The net needs no movement at all: the close already credited it to
    // this account. netAmount / netUsd are still recorded on the earnings
    // row so reporting can show the split.
    const debitAcct = feeUsd > 0 ? feeAmount : '0';  // sub-cent fee dust stays put

    const posId = String(mirror.followerPositionId);

    // ── Claim the settlement (unique index = no double settle). ──
    let claim;
    try {
      claim = await CopyTradeEarnings.create({
        masterId:           mirror.masterId,
        followerId:         mirror.followerId,
        relationId:         mirror.relationId,
        copyTradeId:        mirror._id,
        masterPositionId:   mirror.masterPositionId,
        followerPositionId: mirror.followerPositionId,
        symbol:             pos.symbol,
        currency,
        realizedProfit:     realizedStr,
        feePercent,
        feeAmount,
        feeAmountUsd:       feeUsd,
        followerNetProfit:  netAmount,
        followerNetUsd:     netUsd,
        fxRate,
      });
    } catch (err) {
      if (err && (err.code === 11000 || err.code === 11001)) return null; // already settled
      throw err;
    }

    // ── 1) Take the master's fee out of the follower's trading account. ──
    // Their net profit is not touched — it is already there from the close.
    // A 0% fee (or sub-cent dust) moves nothing, but the earnings row is
    // still written so the close is accounted for.
    let feeDebited = false;
    if (gt(debitAcct, '0')) {
      try {
        await walletService.debit({
          userId:        mirror.followerId,
          accountId:     pos.accountId,
          currency,
          amount:        debitAcct,
          type:          WALLET_TX_TYPE.FEE,
          referenceType: 'copy_profit_settlement',
          referenceId:   mirror._id,
          dedupeKey:     `copysettle:${posId}`,
          note:          `Copy performance fee ${feePercent}% · ${pos.symbol}`,
        });
        feeDebited = true;
      } catch (err) {
        // Could not collect the fee — unclaim so a retry can try again.
        console.error('[copyEarnings] copy fee debit failed:', err.message);
        await CopyTradeEarnings.deleteOne({ _id: claim._id }).catch(() => {});
        return null;
      }
    }

    // ── 2) ACCRUE master fee into the box escrow + credit follower net. ──
    //
    // The master's performance fee is accrued in the box (released monthly,
    // gated on the box's source-account net profit) instead of being paid now.
    // The follower's kept profit still lands in their Main Wallet immediately.
    let masterAccruedToBox = false;
    let masterCreditedDirect = false;
    try {
      if (feeUsd > 0) {
        // Atomic string-decimal add into the box escrow (single-doc pipeline
        // update → no read-modify-write race across concurrent closes).
        const res = await CopyBox.updateOne(
          { accountId: mirror.masterAccountId },
          [{ $set: {
            accruedFeeUsd:         { $toString: { $round: [{ $add: [{ $toDouble: { $ifNull: ['$accruedFeeUsd', '0'] } }, feeUsd] }, 2] } },
            lifetimeFeeAccruedUsd: { $toString: { $round: [{ $add: [{ $toDouble: { $ifNull: ['$lifetimeFeeAccruedUsd', '0'] } }, feeUsd] }, 2] } },
          } }],
        );
        if (res.matchedCount > 0) {
          masterAccruedToBox = true;
        } else {
          // No box for this source account (shouldn't happen — a follower can
          // only copy an existing box). Fall back to an immediate credit so the
          // fee is never lost.
          await subscriptionWalletService.credit({
            userId:     mirror.masterId,
            amount:     round2s(feeUsd),
            reason:     'COPY_PERFORMANCE_FEE',
            note:       `Copy earnings ${feePercent}% · ${pos.symbol}`,
            paymentRef: `copyfee:${posId}`,
          });
          masterCreditedDirect = true;
        }
      }
      // The follower's net profit is deliberately NOT credited anywhere: it
      // never left their trading account, which is where they want it.
    } catch (err) {
      // Compensate so nothing is lost, then unclaim for a possible retry.
      console.error('[copyEarnings] settlement failed — compensating:', err.message);
      if (masterAccruedToBox) {
        // Reverse the escrow accrual (floor at 0).
        try {
          await CopyBox.updateOne(
            { accountId: mirror.masterAccountId },
            [{ $set: {
              accruedFeeUsd:         { $toString: { $max: [0, { $round: [{ $subtract: [{ $toDouble: { $ifNull: ['$accruedFeeUsd', '0'] } }, feeUsd] }, 2] }] } },
              lifetimeFeeAccruedUsd: { $toString: { $max: [0, { $round: [{ $subtract: [{ $toDouble: { $ifNull: ['$lifetimeFeeAccruedUsd', '0'] } }, feeUsd] }, 2] }] } },
            } }],
          );
        } catch (_) {}
      }
      if (masterCreditedDirect) {
        try { await subscriptionWalletService.debit({ userId: mirror.masterId, amount: round2s(feeUsd), reason: 'ADMIN_DEBIT', note: 'Reverse copy fee (settlement failed)' }); } catch (_) {}
      }
      if (feeDebited) {
        try {
          await walletService.credit({
            userId: mirror.followerId, accountId: pos.accountId, currency,
            amount: debitAcct, type: WALLET_TX_TYPE.FEE,
            referenceType: 'copy_profit_settlement_refund', referenceId: mirror._id,
            dedupeKey: `copysettle:${posId}:refund`, note: `Refund — settlement failed · ${pos.symbol}`,
          });
        } catch (_) {}
      }
      await CopyTradeEarnings.deleteOne({ _id: claim._id }).catch(() => {});
      return null;
    }

    // ── 3) Audit + notify (best-effort). ──
    try {
      await AuditLog.create({
        actorId:    mirror.followerId,
        actorRole:  'SYSTEM',
        action:     'COPY_PROFIT_SETTLEMENT',
        targetType: 'COPY_EARNINGS',
        targetId:   String(claim._id),
        metadata: {
          masterId:          String(mirror.masterId),
          symbol:            pos.symbol,
          currency,
          realizedProfit:    realizedStr,
          feePercent,
          feeAmount,         feeAmountUsd: feeUsd,
          followerNetProfit: netAmount, followerNetUsd: netUsd,
          destination:       'TRADING_ACCOUNT', // follower net never leaves it
          masterFeeDestination: masterAccruedToBox ? 'BOX_ESCROW' : (masterCreditedDirect ? 'MAIN_WALLET' : 'NONE'),
        },
      });
    } catch (_) {}
    try {
      const wsServer = require('../websocket/server');
      // Master fee is accrued (pending monthly release), not paid now.
      if (feeUsd > 0) wsServer.notifyUser(String(mirror.masterId), 'copytrading', { event: masterAccruedToBox ? 'EARNINGS_ACCRUED' : 'EARNINGS', symbol: pos.symbol, feeUsd, feePercent, pending: masterAccruedToBox });
      wsServer.notifyUser(String(mirror.followerId), 'copytrading', { event: 'PROFIT_CREDITED', symbol: pos.symbol, amountUsd: netUsd, wallet: 'TRADING' });
    } catch (_) {}

    return claim;
  } catch (err) {
    console.error('[copyEarnings] settleCopyTradeProfit error:', err.message);
    return null; // never let settlement routing break the copy-close flow
  }
}

/**
 * What a follower would pay on a hypothetical profit — used for the
 * pre-copy disclosure ("on a $100 profit: master earns $X, you keep $Y").
 */
async function previewFee(masterId, sampleProfit = 100) {
  const feePercent = await resolveFeePercent(masterId);
  const profit = Number(sampleProfit) || 0;
  const masterFee = round2(profit * feePercent / 100);
  return {
    feePercent,
    sampleProfit: round2(profit),
    masterFee,
    followerNet: round2(profit - masterFee),
  };
}

/** Earnings rollup for a master dashboard (USD). */
async function getMasterEarnings(masterId) {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const [earningsAgg, boxes, monthlyPnl] = await Promise.all([
    CopyTradeEarnings.aggregate([
      { $match: { masterId: oid(masterId), feeAmountUsd: { $gt: 0 } } },
      { $group: {
          _id:   null,
          total: { $sum: '$feeAmountUsd' },
          today: { $sum: { $cond: [{ $gte: ['$createdAt', startToday] }, '$feeAmountUsd', 0] } },
          month: { $sum: { $cond: [{ $gte: ['$createdAt', startMonth] }, '$feeAmountUsd', 0] } },
          count: { $sum: 1 },
          avgFeePercent: { $avg: '$feePercent' },
      } },
    ]),
    CopyBox.find({ userId: masterId }).select('accruedFeeUsd lifetimeFeeAccruedUsd lifetimeFeeReleasedUsd lifetimeBlockedSince lastLifetimeNetPnlUsd').lean(),
    // LIVE, not the `lastLifetimeNetPnlUsd` stamp: that field is only written by
    // the month-end sweep and by a transfer, so before either has ever run it is
    // absent — and `Number(undefined ?? null)` is 0, which the dashboard showed
    // as a confident "+0.00". It is also the value the transfer gate actually
    // tests, so reading a stale copy let the button disagree with the API.
    //
    // THIS MONTH, not lifetime — same window the transfer gate uses.
    userMonthlyNetPnl(masterId),
  ]);
  const t = earningsAgg[0] || {};
  const totalAccrued = boxes.reduce((s, b) => s + Number(b.accruedFeeUsd || 0), 0);
  // transferCommission() refuses unless lifetime net P&L is strictly > 0, and it
  // then moves EVERY box's escrow. So "blocked" is all-or-nothing on that one
  // gate — deriving it per box from the lifetimeBlockedSince stamp under-reported
  // it for any box the monthly sweep had not stamped yet.
  const canRelease = Number(monthlyPnl) > 0;
  const accruedBlocked = canRelease ? 0 : totalAccrued;
  const lifetimeAccrued = boxes.reduce((s, b) => s + Number(b.lifetimeFeeAccruedUsd || 0), 0);
  const lifetimeReleased = boxes.reduce((s, b) => s + Number(b.lifetimeFeeReleasedUsd || 0), 0);
  return {
    total: round2(t.total || 0),
    today: round2(t.today || 0),
    month: round2(t.month || 0),
    count: t.count || 0,
    avgFeePercent: round2(t.avgFeePercent || 0),
    accruedPending: round2(totalAccrued),
    accruedBlocked: round2(accruedBlocked),
    // What "Transfer Commission" would actually move right now.
    withdrawable: round2(totalAccrued - accruedBlocked),
    // The figure the gate is actually decided on.
    monthlyPnlUsd: round2(monthlyPnl),
    lifetimeAccruedUsd: round2(lifetimeAccrued),
    lifetimeReleasedUsd: round2(lifetimeReleased),
    transferBlockedReason: totalAccrued > 0 && !canRelease ? 'MONTHLY_PNL_NEGATIVE' : null,
  };
}

/** Recent earning events for a master (audit/history view). */
async function getMasterEarningsHistory(masterId, { limit = 50 } = {}) {
  return CopyTradeEarnings.find({ masterId })
    .sort({ createdAt: -1 })
    .limit(Math.min(200, Math.max(1, Number(limit) || 50)))
    .lean();
}

/** Top earning masters (platform analytics). */
async function topEarners({ limit = 20 } = {}) {
  const rows = await CopyTradeEarnings.aggregate([
    { $match: { feeAmountUsd: { $gt: 0 } } },
    { $group: { _id: '$masterId', total: { $sum: '$feeAmountUsd' }, trades: { $sum: 1 } } },
    { $sort: { total: -1 } },
    { $limit: Math.min(100, Math.max(1, Number(limit) || 20)) },
  ]);
  const profiles = await TraderProfile
    .find({ userId: { $in: rows.map((r) => r._id) } })
    .select('userId displayName avatarUrl').lean();
  const byId = new Map(profiles.map((p) => [String(p.userId), p]));
  return rows.map((r) => ({
    masterId:    String(r._id),
    displayName: byId.get(String(r._id))?.displayName || '',
    avatarUrl:   byId.get(String(r._id))?.avatarUrl || '',
    totalEarnings: round2(r.total),
    trades:      r.trades,
  }));
}

/** Platform-wide performance-fee revenue (admin analytics). */
async function platformRevenue() {
  const rows = await CopyTradeEarnings.aggregate([
    { $match: { feeAmountUsd: { $gt: 0 } } },
    { $group: { _id: null, total: { $sum: '$feeAmountUsd' }, count: { $sum: 1 } } },
  ]);
  const t = rows[0] || {};
  return { totalRevenue: round2(t.total || 0), feeEvents: t.count || 0 };
}

/**
 * Manual transfer of the master's ACCRUED (pending) commission from box
 * escrow to their Main Wallet.
 *
 * Called when the master clicks "Transfer Commission" on the dashboard.
 * Gated on lifetime P&L > 0 (checked again here + on the withdraw side).
 *
 * Moves the SUM of all boxes' accruedFeeUsd → subscription wallet credit,
 * resets each box's accruedFeeUsd to 0, and stamps lastFeeReleasedAt.
 */
async function transferCommission(masterId) {
  // Hard gate: THIS MONTH's net P&L must be positive.
  const monthlyNet = await userMonthlyNetPnl(masterId);
  if (!gt(monthlyNet, 0)) {
    throw new Error(`MONTHLY_PNL_NEGATIVE: net P&L this month is ${round2(monthlyNet)} — transfer blocked until this month is profitable.`);
  }

  const boxes = await CopyBox.find({ userId: masterId, accruedFeeUsd: { $gt: '0' } }).lean();
  if (!boxes.length) {
    return { transferred: 0, boxes: 0 };
  }

  const totalUsd = round2(boxes.reduce((s, b) => s + Number(b.accruedFeeUsd || 0), 0));
  if (totalUsd <= 0) {
    return { transferred: 0, boxes: 0 };
  }

  // Credit the master's Main Wallet (subscription wallet = USD).
  const payRef = `copytransfer:${masterId}:${Date.now()}`;
  await subscriptionWalletService.credit({
    userId:     masterId,
    amount:     round2s(totalUsd),
    reason:     'COPY_PERFORMANCE_FEE',
    note:       `Manual commission transfer · ${new Date().toISOString().slice(0, 7)}`,
    paymentRef: payRef,
  });

  // Reset escrow on all boxes and stamp release.
  const boxIds = boxes.map(b => b._id);
  const now = new Date();
  await CopyBox.updateMany(
    { _id: { $in: boxIds } },
    { $set: {
      accruedFeeUsd:         '0',
      lastFeeReleasedAt:     now,
      // Legacy field name — it now holds the MONTHLY gate figure.
      lastLifetimeNetPnlUsd: String(monthlyNet),
    } }
  );

  // Audit.
  try {
    await AuditLog.create({
      actorId:    masterId,
      actorRole:  'USER',
      action:     'COPY_COMMISSION_TRANSFER',
      targetType: 'COPY_BOX',
      targetId:   String(boxIds[0]),
      metadata: {
        boxes:          boxIds.length,
        totalUsd,
        monthlyPnlUsd: monthlyNet,
        paymentRef:     payRef,
      },
    });
  } catch (_) {}

  return { transferred: totalUsd, boxes: boxIds.length };
}

/**
 * Net realized P&L (account currency) for one account over [start, end).
 * Net = Σ realizedPnl − Σ commission − Σ swap across CLOSED positions whose
 * closedAt falls in the window. Used only as a SIGN gate (profit vs not) for
 * the monthly fee release, so the account-vs-USD currency mismatch is fine.
 */
async function accountMonthlyNetPnl(accountId, start, end) {
  const rows = await Position.aggregate([
    { $match: { accountId: oid(accountId), status: POSITION_STATUS.CLOSED, closedAt: { $gte: start, $lt: end } } },
    { $group: {
        _id:  null,
        pnl:  { $sum: { $toDouble: { $ifNull: ['$realizedPnl', '0'] } } },
        comm: { $sum: { $toDouble: { $ifNull: ['$commission', '0'] } } },
        swap: { $sum: { $toDouble: { $ifNull: ['$swap', '0'] } } },
    } },
  ]);
  const t = rows[0] || {};
  return String(round2((t.pnl || 0) - (t.comm || 0) - (t.swap || 0)));
}

/**
 * Net P&L across ALL of a user's accounts — realized P&L minus commissions
 * minus swaps on closed positions. With a window, only positions CLOSED inside
 * it count; without one, the whole trading history.
 *
 * Returns a positive number (profitable) or negative (net loss).
 */
async function userNetPnl(userId, start, end) {
  const match = { userId: oid(userId), status: POSITION_STATUS.CLOSED };
  if (start && end) match.closedAt = { $gte: start, $lt: end };
  const rows = await Position.aggregate([
    { $match: match },
    { $group: {
        _id:  null,
        pnl:  { $sum: { $toDouble: { $ifNull: ['$realizedPnl', '0'] } } },
        comm: { $sum: { $toDouble: { $ifNull: ['$commission', '0'] } } },
        swap: { $sum: { $toDouble: { $ifNull: ['$swap', '0'] } } },
    } },
  ]);
  const t = rows[0] || {};
  return round2((t.pnl || 0) - (t.comm || 0) - (t.swap || 0));
}

/** Whole-history net P&L. Kept for analytics; it is no longer the fee gate. */
const userLifetimeNetPnl = (userId) => userNetPnl(userId);

/** [start, end) of the calendar month containing `now` (server-local). */
function monthWindow(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  return { start, end };
}

/**
 * THE FEE GATE: the master's own net P&L for a calendar month.
 *
 * Was lifetime. A master who is profitable this month should be able to take
 * this month's commission, rather than being held against every trade they have
 * ever placed — a single bad stretch early on would otherwise lock earnings
 * indefinitely, no matter how well they traded since.
 */
async function userMonthlyNetPnl(userId, now = new Date()) {
  const { start, end } = monthWindow(now);
  return userNetPnl(userId, start, end);
}

/**
 * Month-end performance-fee settlement.
 *
 * For every box with a PENDING accrued fee:
 *   1. Compute the source account's net P&L for the just-ended calendar month.
 *   2. Compute the master's LIFETIME net P&L (Σ all closed positions ever).
 *   3. If BOTH are positive → RELEASE the accrued escrow to the master's Main
 *      Wallet (the earned balance remains withdrawable).
 *   4. Otherwise CARRY FORWARD (high-water) — escrow waits for both gates to
 *      flip green in a future month. The accrued amount is still VISIBLE on
 *      the master dashboard (so they know what they're owed), but it cannot
 *      be withdrawn until lifetime P&L is net positive.
 *
 * This protects followers: a leader can't withdraw performance fees while
 * their own trading history is net-unprofitable — preventing skilled
 * "bad trader" trading patterns where a master profits purely from copy fees
 * while losing their own money.
 *
 * Idempotent per box+month:
 *   • `lastFeeSettlementMonth === monthK` → box already processed → skip.
 *   • a matching `paymentRef` on the Main-Wallet ledger → credit already done
 *     (a retry after a partial failure won't double-pay).
 * Never throws per-box — one bad box can't abort the sweep. Money-critical.
 *
 * @param {Date} now  settles the calendar month BEFORE this instant.
 */
async function settleMonthlyFees(now = new Date()) {
  const { SubscriptionTransaction } = require('../models/SubscriptionWallet');
  // Just-ended month = the calendar month before `now` (server-local, matching
  // the rest of the codebase's month math — e.g. getMasterEarnings above).
  const start  = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
  const end    = new Date(now.getFullYear(), now.getMonth(),     1, 0, 0, 0, 0); // exclusive
  const monthK = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;

  const boxes = await CopyBox
    .find({ lastFeeSettlementMonth: { $ne: monthK }, accruedFeeUsd: { $gt: '0' } })
    .select('_id userId accountId accruedFeeUsd')
    .lean();

  let released = 0, carried = 0, lifetimeBlocked = 0, releasedUsd = 0;
  for (const box of boxes) {
    const accrued = box.accruedFeeUsd || '0';
    if (!gt(accrued, '0')) continue; // nothing pending → re-evaluate next month
    try {
      const monthlyNet = await accountMonthlyNetPnl(box.accountId, start, end);
      if (!gt(monthlyNet, '0')) {
        // ── GATE 1 FAIL — source account lost/broke-even this month. Carry forward. ──
        await CopyBox.updateOne({ _id: box._id }, { $set: { lastFeeSettlementMonth: monthK } });
        carried++;
        continue;
      }
      // GATE 1 passed. Now the master's OWN net P&L for the same month.
      // (Was lifetime — see userMonthlyNetPnl for why it moved.)
      const masterNet = await userNetPnl(box.userId, start, end);
      if (!gt(masterNet, 0)) {
        // ── GATE 2 FAIL — master was not net-profitable that month. ──
        // Accrued fees carry forward. The master can SEE the balance (they
        // earned it) but cannot take it out of a month they lost money in.
        await CopyBox.updateOne({ _id: box._id }, { $set: {
          lastFeeSettlementMonth: monthK,
          // Legacy field names; they now hold the MONTHLY gate state.
          lifetimeBlockedSince: now,
          lastLifetimeNetPnlUsd: String(masterNet),
        } });
        lifetimeBlocked++;
        try {
          require('../websocket/server').notifyUser(String(box.userId), 'copytrading', {
            event: 'FEE_RELEASE_BLOCKED', boxId: String(box._id), amountUsd: round2(Number(accrued)),
            month: monthK, reason: 'MONTHLY_NEGATIVE_PNL', monthlyPnlUsd: masterNet,
          });
        } catch (_) {}
        continue;
      }
      // ── Both gates passed: RELEASE the escrow. ──
      const payRef = `copyrelease:${box._id}:${monthK}`;
      const dup = await SubscriptionTransaction.findOne({ paymentRef: payRef }).select('_id').lean();
      if (!dup) {
        await subscriptionWalletService.credit({
          userId:     box.userId,
          amount:     round2s(Number(accrued)),
          reason:     'COPY_PERFORMANCE_FEE',
          note:       `Copy performance fee · ${monthK} (net +${masterNet} that month)`,
          paymentRef: payRef,
        });
      }
      await CopyBox.updateOne({ _id: box._id }, [{ $set: {
        lifetimeFeeReleasedUsd: { $toString: { $round: [{ $add: [{ $toDouble: { $ifNull: ['$lifetimeFeeReleasedUsd', '0'] } }, Number(accrued)] }, 2] } },
        accruedFeeUsd:          '0',
        lastFeeSettlementMonth: monthK,
        lastFeeReleasedAt:      now,
        lifetimeBlockedSince:   null,
        lastLifetimeNetPnlUsd:  String(masterNet),
      } }]);
      released++;
      releasedUsd += Number(accrued);
      try {
        require('../websocket/server').notifyUser(String(box.userId), 'copytrading',
          { event: 'FEE_RELEASED', boxId: String(box._id), amountUsd: round2(Number(accrued)), month: monthK, monthlyPnlUsd: masterNet });
      } catch (_) {}
    } catch (e) {
      // Leave this box UNSTAMPED so it's retried on the next sweep (safe: the
      // escrow is untouched, so a retry can't lose or double-pay).
      console.error(`[copyEarnings] month-end settle failed for box ${box._id}:`, e.message);
    }
  }
  if (released || carried || lifetimeBlocked) {
    console.log(`[copyEarnings] month-end ${monthK}: released ${released} box(es) ($${round2(releasedUsd)}), monthly-blocked ${carried}, lifetime-blocked ${lifetimeBlocked}`);
  }
  return { month: monthK, released, carried, lifetimeBlocked, releasedUsd: round2(releasedUsd) };
}

module.exports = {
  getFeeSettings,
  resolveFeePercent,
  settleCopyTradeProfit,
  settleMonthlyFees,
  accountMonthlyNetPnl,
  userNetPnl,
  userMonthlyNetPnl,
  monthWindow,
  userLifetimeNetPnl,
  // Back-compat alias — the copy engine's close hook calls this name; it now
  // performs the full profit settlement (fee + profit → Main Wallet).
  applyPerformanceFee: settleCopyTradeProfit,
  previewFee,
  getMasterEarnings,
  getMasterEarningsHistory,
  topEarners,
  platformRevenue,
  transferCommission,
};
