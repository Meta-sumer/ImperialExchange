/**
 * Background worker that runs every few seconds to:
 *   1. Trigger STOP orders when their stopPrice is crossed
 *   2. Update unrealized PnL on open positions (for snapshots)
 *   3. Detect margin-call and stop-out conditions
 *   4. Auto-liquidate positions on stop-out (largest losing first)
 *   5. Auto-close positions when SL or TP is hit
 *
 * Single-process MVP. For production, run this as a separate worker process
 * with leader election if you scale the API horizontally.
 */
const Order = require('../models/Order');
const Position = require('../models/Position');
const Instrument = require('../models/Instrument');
const TradingAccount = require('../models/TradingAccount');
const Trade = require('../models/Trade');
const MarginCall = require('../models/MarginCall');
const { Notification } = require('../models/index');
const matchingEngine = require('../matching-engine/MatchingEngine');
const orderRouter = require('./orderRouter.service');
const riskService = require('./riskService');
const { createTickCache } = require('./workerTickCache');

// Worker-triggered orders (STOP fires, LIMIT fills, SL/TP closes, stop-out
// liquidations) should respect the per-account bookType just like manual
// orders. _submit() routes through orderRouter.
//
// Fallback policy: silent fallback to direct engine submit is ONLY safe for
// pure B-book accounts (which would have ended up there anyway). For A/HYBRID
// accounts a routing failure means we couldn't reach the LP — falling back
// to internal execution would mis-route the trade and stamp the wrong
// executionSource. In that case we mark the order REJECTED, leave the caller
// to roll back position state on the next tick, and propagate the error.
const _submit = async (order) => {
  try {
    const { settledOrder } = await orderRouter.routeOrder({ order, userId: order.userId });
    return settledOrder;
  } catch (err) {
    const TradingAccount = require('../models/TradingAccount');
    const { BOOK_TYPE } = require('../config/constants');
    const account = await TradingAccount.findById(order.accountId).lean();
    const bookType = account?.bookType || BOOK_TYPE.B_BOOK;
    if (bookType === BOOK_TYPE.B_BOOK) {
      console.warn(`[worker] orderRouter failed for B-book order ${order._id}: ${err.message} — falling back to engine`);
      return matchingEngine.submit(order);
    }
    console.error(`[worker] orderRouter failed for ${bookType} order ${order._id}: ${err.message} — refusing internal fallback`);
    order.status = ORDER_STATUS.REJECTED;
    order.rejectionReason = `Worker route failed: ${err.message}`;
    try { await order.save(); } catch (_) {}
    throw err;
  }
};
const { add, sub, mul, div, gt, lt, gte, lte, eq, D } = require('../utils/decimal');

// _submit for the cached stages. A fill writes the trade price into the
// traded instrument's lastPrice, so that instrument is dropped from the
// tick cache whatever the outcome — the next position judged against it
// re-reads it, as the per-position reads this cache replaced always did.
const _submitFor = async (cache, order) => {
  try {
    return await _submit(order);
  } finally {
    cache.invalidateInstrument(order.instrumentId);
  }
};
const { ORDER_STATUS, ORDER_TYPE, POSITION_STATUS, BASE_CURRENCY } = require('../config/constants');

let broadcaster = null;
let running = false;

const setBroadcaster = (b) => {
  broadcaster = b;
};

const notifyUser = (userId, channel, data) => {
  if (broadcaster) broadcaster.notifyUser(userId, channel, data);
};

/**
 * Check pending STOP orders. If the stopPrice has been crossed by lastPrice,
 * convert the order to MARKET and send it to the matching engine.
 */
const triggerStopOrders = async (cache = createTickCache()) => {
  // Only consider stops that haven't fired yet. triggeredAt=null is the gate.
  const stopOrders = await Order.find({
    type: ORDER_TYPE.STOP,
    status: ORDER_STATUS.PENDING,
    triggeredAt: null,
  }).limit(200);

  // One read for every instrument these orders need, instead of one each.
  await cache.ensureInstruments(stopOrders.map((o) => o.instrumentId));

  for (const order of stopOrders) {
    const inst = await cache.getInstrument(order.instrumentId);
    if (!inst || !inst.lastPrice) continue;
    // Staleness guard: a frozen feed can otherwise fire stops at an outdated
    // tick. 60s matches the slowest data feed cadence we run.
    if (inst.lastPriceUpdatedAt && Date.now() - new Date(inst.lastPriceUpdatedAt).getTime() > 60_000) continue;
    const lastPrice = inst.lastPrice;

    // For trigger evaluation we use the side-appropriate quote — a BUY
    // STOP fires when the ask reaches the trigger (that's what you'd pay),
    // and a SELL STOP fires when the bid reaches the trigger (that's what
    // you'd receive). lastPrice ≈ mid was an approximation that fired
    // stops slightly early/late depending on spread direction.
    const last = Number(lastPrice);
    const half = Number(inst.spreadValue || 0) / 2;
    const ask = inst.spreadType === 'PERCENTAGE' ? last * (1 + half) : last + half;
    const bid = inst.spreadType === 'PERCENTAGE' ? last * (1 - half) : last - half;

    // BUY STOP triggers when ask >= stopPrice (breakout up)
    // SELL STOP triggers when bid <= stopPrice (breakdown)
    const triggered =
      (order.side === 'BUY' && gte(String(ask), order.stopPrice)) ||
      (order.side === 'SELL' && lte(String(bid), order.stopPrice));

    if (triggered) {
      // Mark as fired BEFORE submitting so a concurrent tick can't double-submit.
      // Keep type=STOP for the audit trail; matching engine reads price/stopPrice
      // to decide STOP-MARKET vs STOP-LIMIT execution.
      cache.markTouched(order.accountId);
      order.triggeredAt = new Date();
      order.triggeredPrice = String(lastPrice);
      await order.save();
      try {
        await _submitFor(cache, order);
        notifyUser(String(order.userId), 'orders', {
          event: 'STOP_TRIGGERED',
          accountId: order.accountId ? String(order.accountId) : null,
          orderId: String(order._id),
          symbol: order.symbol,
          stopPrice: order.stopPrice,
          triggerPrice: lastPrice,
        });
      } catch (e) {
        // If the engine throws, clear triggeredAt so the next tick can retry —
        // pre-fix the stamped triggeredAt would permanently disqualify the
        // order from re-evaluation, leaving it stuck PENDING forever.
        try {
          await Order.updateOne(
            { _id: order._id, status: ORDER_STATUS.PENDING },
            { $set: { triggeredAt: null, triggeredPrice: null } }
          );
        } catch (_) { /* best-effort */ }
        console.error('[Worker] STOP trigger failed:', e.message);
      }
    }
  }
};

/**
 * Check pending LIMIT orders. If the market has crossed the limit price
 * (ask <= BUY limit, OR bid >= SELL limit), submit the order to the engine
 * which then fills at the favorable price.
 *
 * Pre-fix LIMIT orders went straight to the engine on placement, where the
 * B-book / external fallback paths filled them at last price regardless of
 * the limit constraint. Now placeOrder() saves LIMITs as PENDING and this
 * worker tick is the only path that submits them — guaranteeing the limit
 * condition is honored before a position is opened.
 */
const triggerLimitOrders = async (cache = createTickCache()) => {
  // PENDING + no triggeredAt yet = waiting for price to cross.
  const limitOrders = await Order.find({
    type: ORDER_TYPE.LIMIT,
    status: ORDER_STATUS.PENDING,
    triggeredAt: null,
  }).limit(200);

  if (!limitOrders.length) return;

  // Instruments come from the tick cache, which STOP triggers may already
  // have filled. It replaces the per-call cache this function used to keep.
  await cache.ensureInstruments(limitOrders.map((o) => o.instrumentId));

  for (const order of limitOrders) {
    const inst = await cache.getInstrument(order.instrumentId);
    if (!inst || !inst.lastPrice) continue;
    // Staleness guard — same 60s window the STOP trigger uses.
    if (inst.lastPriceUpdatedAt && Date.now() - new Date(inst.lastPriceUpdatedAt).getTime() > 60_000) continue;

    const last = Number(inst.lastPrice);
    const spread = Number(inst.spreadValue || 0);
    const half = spread / 2;
    const ask = inst.spreadType === 'PERCENTAGE' ? last * (1 + half) : last + half;
    const bid = inst.spreadType === 'PERCENTAGE' ? last * (1 - half) : last - half;
    const limitPx = Number(order.price);

    // BUY LIMIT triggers when ask drops to or below the limit (buyer's
    // entry condition met). SELL LIMIT triggers when bid rises to or
    // above the limit. Equality counts so on-the-dot prints fire too.
    const triggered =
      (order.side === 'BUY' && Number.isFinite(ask) && ask <= limitPx) ||
      (order.side === 'SELL' && Number.isFinite(bid) && bid >= limitPx);

    if (!triggered) continue;

    // Stamp triggeredAt BEFORE submitting so a concurrent tick can't
    // double-submit. Cleared on engine failure so the next tick can retry.
    cache.markTouched(order.accountId);
    order.triggeredAt = new Date();
    order.triggeredPrice = String(last);
    await order.save();
    try {
      await _submitFor(cache, order);
      notifyUser(String(order.userId), 'orders', {
        event: 'LIMIT_TRIGGERED',
        accountId: order.accountId ? String(order.accountId) : null,
        orderId: String(order._id),
        symbol: order.symbol,
        limitPrice: order.price,
        triggerPrice: last,
      });
    } catch (e) {
      try {
        await Order.updateOne(
          { _id: order._id, status: ORDER_STATUS.PENDING },
          { $set: { triggeredAt: null, triggeredPrice: null } }
        );
      } catch (_) { /* best-effort */ }
      console.error('[Worker] LIMIT trigger failed:', e.message);
    }
  }
};

/**
 * Check open positions for SL/TP hits using current lastPrice.
 * Closes the position via opposite-side market order.
 */
const checkSlTp = async (cache = createTickCache()) => {
  const positions = await Position.find({
    status: POSITION_STATUS.OPEN,
    $or: [{ stopLoss: { $ne: null } }, { takeProfit: { $ne: null } }],
  });

  // Same Instrument.lastPrice as before, read once for all positions rather
  // than once per position. If a close makes the tick run long, the cache
  // re-reads stale prices before the next position is judged.
  await cache.ensureInstruments(positions.map((p) => p.instrumentId));

  for (const pos of positions) {
    const inst = await cache.getInstrument(pos.instrumentId);
    if (!inst || !inst.lastPrice) continue;
    const price = inst.lastPrice;

    let shouldClose = false;
    let reason = null;

    if (pos.side === 'BUY') {
      if (pos.stopLoss && lte(price, pos.stopLoss)) (shouldClose = true), (reason = 'STOP_LOSS');
      else if (pos.takeProfit && gte(price, pos.takeProfit)) (shouldClose = true), (reason = 'TAKE_PROFIT');
    } else {
      if (pos.stopLoss && gte(price, pos.stopLoss)) (shouldClose = true), (reason = 'STOP_LOSS');
      else if (pos.takeProfit && lte(price, pos.takeProfit)) (shouldClose = true), (reason = 'TAKE_PROFIT');
    }

    if (shouldClose) {
      cache.markTouched(pos.accountId);
      // Atomic OPEN → CLOSING claim — same idempotency guard the manual
      // close controller uses. If two consecutive ticks evaluate the same
      // SL/TP at the same time, only one wins this update and proceeds.
      // Also stamps closeReason so the trade-history view shows the right
      // remark ("PROFIT TAKEN" vs "STOP LOSS HIT").
      const claimed = await Position.findOneAndUpdate(
        { _id: pos._id, status: POSITION_STATUS.OPEN, settled: { $ne: true } },
        { $set: { status: POSITION_STATUS.CLOSING, closeReason: reason } },
        { new: true }
      );
      if (!claimed) continue; // Another tick / manual close beat us — skip.

      // routing + executionSource stamped by orderRouter inside _submit().
      // Hedge mode: positionSide echoes the source so the close targets
      // the right bucket (LONG/SHORT) and doesn't accidentally hit the
      // user's opposite-side position on the same symbol.
      const oppositeSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
      const sourcePositionSide = pos.positionSide || (pos.side === 'BUY' ? 'LONG' : 'SHORT');
      const closingOrder = await Order.create({
        userId: pos.userId,
        accountId: pos.accountId,
        instrumentId: pos.instrumentId,
        symbol: pos.symbol,
        side: oppositeSide,
        positionSide: sourcePositionSide,
        type: 'MARKET',
        quantity: pos.quantity,
        leverage: pos.leverage,
        status: 'PENDING',
        closeOnly: true,
        reduceOnly: true,
      });
      try {
        await _submitFor(cache, closingOrder);
        notifyUser(String(pos.userId), 'positions', {
          event: reason,
          positionId: String(pos._id),
          symbol: pos.symbol,
          price,
        });
      } catch (e) {
        // Engine failed — release the CLOSING claim so the next tick can retry.
        await Position.updateOne(
          { _id: pos._id, status: POSITION_STATUS.CLOSING, settled: { $ne: true } },
          { $set: { status: POSITION_STATUS.OPEN }, $unset: { closeReason: '' } }
        );
        console.error('[Worker] SL/TP close failed:', e.message);
      }
    }
  }
};

/**
 * MARGIN-CALL notifications only (80% margin level). Actual liquidation is NOT
 * done here — zero-equity stop-out lives in stopOutService (real-time via the WS
 * price fan-out + the 5s safety-net sweep in checkNegativeBalanceProtection).
 * Keeping a margin-level liquidation here would close positions while equity is
 * still positive, contradicting the "run to equity 0, then floor at 0" rule.
 */
const checkMarginAndStopOut = async (cache = null) => {
  const callLevel = Number(process.env.DEFAULT_MARGIN_CALL_LEVEL || 80);
  const stopLevel = Number(process.env.DEFAULT_STOP_OUT_LEVEL || 50);

  // Accounts with open positions, with their wallets, positions and the
  // instruments those positions price off — loaded once and shared with the
  // stop-out sweep that follows. Without a cache this is the original
  // per-account read path, unchanged.
  const snap = cache ? await cache.accountSnapshot() : null;
  const accountIds = snap ? snap.accountIds : await Position.distinct('accountId', { status: POSITION_STATUS.OPEN });

  for (const accId of accountIds) {
    // An account the worker changed after the snapshot was taken is read
    // fresh, exactly as before; every other one comes from the snapshot.
    const fromSnapshot = Boolean(snap) && !snap.isTouched(accId);
    if (snap && !fromSnapshot) snap.noteFreshRead();
    const account = fromSnapshot ? snap.account(accId) : await TradingAccount.findById(accId);
    if (!account) continue;
    // A margin call above may have spent time on email; prices past the
    // age limit are re-read (one query) before this account is judged.
    if (fromSnapshot) await snap.refreshPricesIfStale(accId);

    const metrics = await riskService.calculateAccountMetrics(
      account.userId, accId, account.baseCurrency, fromSnapshot ? snap : null
    );
    const lvl = Number(metrics.marginLevel);

    // Only warn while there is used margin. The margin CALL band is
    // stopLevel < lvl <= callLevel; below/at stopLevel the account is deep in
    // drawdown and stopOutService handles the equity-0 liquidation separately.
    if (gt(metrics.usedMargin, '0')) {
      // MARGIN CALL
      if (lvl <= callLevel && lvl > stopLevel) {
        // Avoid duplicate calls within 5 minutes
        const recent = await MarginCall.findOne({
          accountId: accId,
          type: 'MARGIN_CALL',
          triggeredAt: { $gt: new Date(Date.now() - 5 * 60 * 1000) },
        });
        if (!recent) {
          await MarginCall.create({
            userId: account.userId,
            accountId: accId,
            type: 'MARGIN_CALL',
            marginLevel: metrics.marginLevel,
            equity: metrics.equity,
            usedMargin: metrics.usedMargin,
            actionTaken: 'NOTIFICATION_SENT',
          });
          await Notification.create({
            userId: account.userId,
            type: 'MARGIN_CALL',
            title: 'Margin Call',
            message: `Account ${account.accountNumber}: margin level at ${Number(metrics.marginLevel).toFixed(1)}%. Add funds or close positions.`,
            channels: ['IN_APP', 'EMAIL'],
          });
          notifyUser(String(account.userId), 'notifications', {
            type: 'MARGIN_CALL',
            accountId: String(accId),
            marginLevel: metrics.marginLevel,
          });
          // Email
          try {
            const User = require('../models/User');
            const userDoc = await User.findById(account.userId).select('email').lean();
            if (userDoc) {
              const emailSvc = require('./emailService');
              await emailSvc.sendMarginCallAlert({
                to: userDoc.email,
                accountNumber: account.accountNumber,
                marginLevel: metrics.marginLevel,
              });
            }
          } catch (e) { /* non-fatal */ }
        }
      }

      // STOP-OUT liquidation is intentionally NOT performed here anymore.
      // A margin-level (50%) trigger closes positions while equity is still
      // POSITIVE, which contradicts the product rule: let the position run and
      // liquidate the instant equity <= 0, then floor the balance at 0. That
      // zero-equity liquidation now lives in stopOutService — fired in REAL TIME
      // from the WS price fan-out and swept every 5s by
      // checkNegativeBalanceProtection above. This function keeps ONLY the
      // informational 80% MARGIN CALL notification (no early liquidation).
    }
  }
};

/**
 * Zero-equity STOP-OUT + negative-balance protection.
 *
 * The full liquidation — close ALL positions (closeReason STOP_OUT), cancel
 * pending orders, floor the balance at 0, and flip the account to STOPPED_OUT —
 * now lives in stopOutService and fires in REAL TIME from the WS price fan-out
 * (broadcaster.onTicker), the same tick equity crosses zero. This 5s pass is the
 * SAFETY NET: it re-checks every account with an open position and stops out any
 * whose equity has reached zero, covering a missed real-time tick (feed gap /
 * process restart). Idempotent — the service no-ops accounts already handled.
 */
const checkNegativeBalanceProtection = async (cache = null) => {
  await require('./stopOutService').evaluateAllOpenAccounts(cache ? await cache.accountSnapshot() : null);
};

/**
 * Auto mode-switching for instruments (doc §4.4).
 * Per-instrument autoSwitchRules:
 *   - internalWhenMarketClosed: switch to INTERNAL when outside tradingHours
 *   - internalVolumeThreshold: switch to INTERNAL when 24h internal volume crosses threshold
 *   - externalVolatilityThresholdPct: switch to EXTERNAL when 5min price change exceeds %
 *
 * Decisions are mutually exclusive (volatility wins over volume wins over hours).
 * Only flips the mode if it would actually change to avoid noisy DB writes.
 */
const checkAutoModeSwitch = async () => {
  const instruments = await Instrument.find({
    isActive: true,
    'autoSwitchRules.enabled': true,
  });
  if (!instruments.length) return;

  const now = new Date();
  for (const inst of instruments) {
    let targetMode = inst.mode;
    let reason = null;

    // Rule 1 (highest priority): volatility-based switch to EXTERNAL
    if (inst.autoSwitchRules.externalVolatilityThresholdPct != null) {
      const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
      const recent = await Trade.find({ symbol: inst.symbol, executedAt: { $gte: fiveMinAgo } })
        .sort({ executedAt: 1 })
        .lean();
      if (recent.length >= 2) {
        const first = Number(recent[0].price);
        const last = Number(recent[recent.length - 1].price);
        if (first > 0) {
          const pctChange = Math.abs(((last - first) / first) * 100);
          if (pctChange >= inst.autoSwitchRules.externalVolatilityThresholdPct) {
            targetMode = 'EXTERNAL';
            reason = `volatility ${pctChange.toFixed(2)}% >= threshold`;
          }
        }
      }
    }

    // Rule 2: liquidity-based graduation Hybrid -> Internal
    if (!reason && inst.autoSwitchRules.internalVolumeThreshold) {
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const trades = await Trade.find({ symbol: inst.symbol, routing: 'INTERNAL', executedAt: { $gte: dayAgo } }).lean();
      let totalVolume = 0;
      for (const t of trades) totalVolume += Number(t.quantity);
      if (totalVolume >= Number(inst.autoSwitchRules.internalVolumeThreshold)) {
        targetMode = 'INTERNAL';
        reason = `24h internal volume ${totalVolume.toFixed(2)} >= threshold`;
      }
    }

    // Rule 3: market-hours fallback (lowest priority)
    if (!reason && inst.autoSwitchRules.internalWhenMarketClosed && inst.tradingHours) {
      const day = now.getUTCDay();
      const utcHm = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
      const inDay = !inst.tradingHours.days || inst.tradingHours.days.includes(day);
      const start = inst.tradingHours.start;
      const end = inst.tradingHours.end;
      // Handle windows that wrap midnight (e.g. start='22:00', end='06:00')
      const inWindow = start <= end
        ? utcHm >= start && utcHm <= end
        : utcHm >= start || utcHm <= end;
      const marketOpen = inDay && inWindow;
      if (!marketOpen) {
        targetMode = 'INTERNAL';
        reason = 'external market closed';
      }
    }

    // Apply if changed
    if (targetMode !== inst.mode) {
      console.log(`[Worker] Auto mode-switch ${inst.symbol}: ${inst.mode} -> ${targetMode} (${reason})`);
      inst.mode = targetMode;
      // Safety: if switching to INTERNAL, force-disable B-book
      if (targetMode === 'INTERNAL' && inst.bBookEnabled) {
        inst.bBookEnabled = false;
      }
      await inst.save();
    }
  }
};

/**
 * OCO sibling cancellation (doc Phase 8).
 * For every order group: if any leg is FILLED, cancel all sibling legs that are still PENDING.
 * If any leg is CANCELLED by user/admin, also cancel siblings (so the group always exits cleanly).
 */
const processOcoGroups = async () => {
  const PriceAlert = require('../models/PriceAlert'); // (loaded once for this tick block)
  // Find recently completed orders that have an ocoGroupId
  const completedSinceLast = await Order.find({
    ocoGroupId: { $ne: null },
    status: { $in: [ORDER_STATUS.FILLED, ORDER_STATUS.CANCELLED, ORDER_STATUS.REJECTED] },
    updatedAt: { $gte: new Date(Date.now() - 30 * 1000) }, // last 30s
  }).select('ocoGroupId _id').lean();

  const groups = new Set(completedSinceLast.map((o) => `${o.ocoGroupId}|${o._id}`));
  const seenGroups = new Set();

  for (const key of groups) {
    const [ocoGroupId, completedId] = key.split('|');
    if (seenGroups.has(ocoGroupId)) continue;
    seenGroups.add(ocoGroupId);

    const siblings = await Order.find({
      ocoGroupId,
      _id: { $ne: completedId },
      status: ORDER_STATUS.PENDING,
    });
    for (const sib of siblings) {
      try {
        const fresh = await Order.findById(sib._id);
        if (!fresh || fresh.status !== ORDER_STATUS.PENDING) continue;
        fresh.rejectionReason = 'OCO sibling filled/cancelled';
        await fresh.save();
        // Route the cancel so an A-book sibling is also cancelled on the LP.
        await orderRouter.routeCancel({ order: fresh });
        notifyUser(String(fresh.userId), 'orders', {
          event: 'OCO_CANCELLED',
          accountId: fresh.accountId ? String(fresh.accountId) : null,
          orderId: String(fresh._id),
          symbol: fresh.symbol,
        });
      } catch (e) {
        console.error('[Worker] OCO sibling cancel failed:', e.message);
      }
    }
  }
};

/**
 * Trailing stop loss update.
 * For each open position with trailingDistance:
 *   1. Update high-watermark when price moves favorably
 *   2. Compute effective SL = watermark ± distance
 *   3. If price has retraced past effective SL, close position
 */
const updateTrailingStops = async (cache = createTickCache()) => {
  const positions = await Position.find({
    status: POSITION_STATUS.OPEN,
    trailingDistance: { $ne: null },
  });
  await cache.ensureInstruments(positions.map((p) => p.instrumentId));
  for (const pos of positions) {
    const inst = await cache.getInstrument(pos.instrumentId);
    if (!inst || !inst.lastPrice) continue;
    const price = inst.lastPrice;

    // Update watermark and check exit
    let watermark = pos.trailingHighWatermark || pos.entryPrice;
    let effectiveSl;
    let triggered = false;
    if (pos.side === 'BUY') {
      // For longs: watermark is highest seen price; SL trails behind
      if (gt(price, watermark)) watermark = price;
      effectiveSl = sub(watermark, pos.trailingDistance);
      if (lte(price, effectiveSl)) triggered = true;
    } else {
      if (lt(price, watermark)) watermark = price;
      effectiveSl = add(watermark, pos.trailingDistance);
      if (gte(price, effectiveSl)) triggered = true;
    }

    // Only persist the watermark when it actually moved — pre-fix every
    // tick wrote N positions to the DB regardless of whether anything
    // changed (5s × N positions = a lot of useless write traffic).
    const prevWatermark = pos.trailingHighWatermark;
    if (String(prevWatermark) !== String(watermark)) {
      pos.trailingHighWatermark = watermark;
      await pos.save();
    }

    if (triggered) {
      cache.markTouched(pos.accountId);
      // Atomic claim — same idempotency contract as manual close + SL/TP.
      const claimed = await Position.findOneAndUpdate(
        { _id: pos._id, status: POSITION_STATUS.OPEN, settled: { $ne: true } },
        { $set: { status: POSITION_STATUS.CLOSING, closeReason: 'TRAILING_STOP' } },
        { new: true }
      );
      if (!claimed) continue;

      // routing + executionSource stamped by orderRouter inside _submit().
      // Hedge mode: positionSide echoes the source so the close targets
      // the right bucket (LONG/SHORT) and doesn't accidentally hit the
      // user's opposite-side position on the same symbol.
      const oppositeSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
      const sourcePositionSide = pos.positionSide || (pos.side === 'BUY' ? 'LONG' : 'SHORT');
      const closingOrder = await Order.create({
        userId: pos.userId,
        accountId: pos.accountId,
        instrumentId: pos.instrumentId,
        symbol: pos.symbol,
        side: oppositeSide,
        positionSide: sourcePositionSide,
        type: 'MARKET',
        quantity: pos.quantity,
        leverage: pos.leverage,
        status: 'PENDING',
        closeOnly: true,
        reduceOnly: true,
      });
      try {
        await _submitFor(cache, closingOrder);
        notifyUser(String(pos.userId), 'positions', {
          event: 'TRAILING_STOP_HIT',
          accountId: pos.accountId ? String(pos.accountId) : null,
          positionId: String(pos._id),
          symbol: pos.symbol,
          price,
        });
      } catch (e) {
        // Release claim so next tick can retry.
        await Position.updateOne(
          { _id: pos._id, status: POSITION_STATUS.CLOSING, settled: { $ne: true } },
          { $set: { status: POSITION_STATUS.OPEN }, $unset: { closeReason: '' } }
        );
        console.error('[Worker] Trailing stop close failed:', e.message);
      }
    }
  }
};

/**
 * Price alert check (doc §7.14).
 * For each active alert, compare instrument's lastPrice against target.
 * If triggered: notify user, send email, mark inactive (or re-arm if repeatable).
 */
const checkPriceAlerts = async () => {
  const PriceAlert = require('../models/PriceAlert');
  const alerts = await PriceAlert.find({ isActive: true }).limit(500);
  if (!alerts.length) return;

  // Cache last prices per symbol for the tick
  const priceCache = new Map();
  for (const alert of alerts) {
    let price = priceCache.get(alert.symbol);
    if (price == null) {
      const inst = await Instrument.findOne({ symbol: alert.symbol }).select('lastPrice').lean();
      price = inst?.lastPrice;
      priceCache.set(alert.symbol, price);
    }
    if (!price) continue;

    const triggered =
      (alert.direction === 'ABOVE' && gte(price, alert.targetPrice)) ||
      (alert.direction === 'BELOW' && lte(price, alert.targetPrice));

    if (triggered) {
      alert.triggeredAt = new Date();
      alert.triggeredPrice = String(price);
      if (!alert.repeatable) alert.isActive = false;
      await alert.save();

      notifyUser(String(alert.userId), 'notifications', {
        type: 'PRICE_ALERT',
        symbol: alert.symbol,
        direction: alert.direction,
        targetPrice: alert.targetPrice,
        currentPrice: String(price),
      });

      try {
        const User = require('../models/User');
        const userDoc = await User.findById(alert.userId).select('email').lean();
        if (userDoc) {
          const emailSvc = require('./emailService');
          await emailSvc.sendPriceAlert({
            to: userDoc.email,
            symbol: alert.symbol,
            direction: alert.direction,
            targetPrice: alert.targetPrice,
            currentPrice: String(price),
          });
        }
      } catch (e) { /* non-fatal */ }
    }
  }
};

/**
 * Intraday (MIS) auto square-off. Any OPEN equity position opened with
 * productType:'INTRADAY' is force-closed at/after 15:15 IST on a trading day —
 * same atomic OPEN→CLOSING claim + closeOnly route as expiry/SL-TP, so wallet
 * settlement (incl. intraday STT) runs normally. closeOnly via orderRouter, so
 * the market-closed gate doesn't block it. Tunable: INTRADAY_SQUAREOFF_IST (min).
 */
const SQUAREOFF_IST_MIN = Number(process.env.INTRADAY_SQUAREOFF_IST) || (15 * 60 + 15); // 15:15 IST

const checkIntradaySquareOff = async () => {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000); // shift to IST (read via getUTC*)
  const istMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const istDay = ist.getUTCDay();
  if (istDay === 0 || istDay === 6) return;   // weekend — nothing to square off
  if (istMin < SQUAREOFF_IST_MIN) return;     // before the square-off time

  const positions = await Position.find({
    productType: 'INTRADAY', status: POSITION_STATUS.OPEN, settled: { $ne: true },
  });
  for (const pos of positions) {
    const claimed = await Position.findOneAndUpdate(
      { _id: pos._id, status: POSITION_STATUS.OPEN, settled: { $ne: true } },
      { $set: { status: POSITION_STATUS.CLOSING, closeReason: 'INTRADAY_SQUAREOFF' } },
      { new: true }
    );
    if (!claimed) continue;
    const oppositeSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
    const sourcePositionSide = pos.positionSide || (pos.side === 'BUY' ? 'LONG' : 'SHORT');
    const closingOrder = await Order.create({
      userId: pos.userId, accountId: pos.accountId, instrumentId: pos.instrumentId,
      symbol: pos.symbol, side: oppositeSide, positionSide: sourcePositionSide,
      type: ORDER_TYPE.MARKET, quantity: pos.quantity, leverage: pos.leverage,
      status: ORDER_STATUS.PENDING, closeOnly: true, reduceOnly: true,
    });
    try {
      await _submit(closingOrder);
      notifyUser(String(pos.userId), 'positions', { event: 'INTRADAY_SQUAREOFF', accountId: pos.accountId ? String(pos.accountId) : null, positionId: String(pos._id), symbol: pos.symbol });
    } catch (e) {
      await Position.updateOne(
        { _id: pos._id, status: POSITION_STATUS.CLOSING, settled: { $ne: true } },
        { $set: { status: POSITION_STATUS.OPEN }, $unset: { closeReason: '' } }
      );
      console.error('[Worker] intraday square-off failed:', e.message);
    }
  }
};

/**
 * Apply due corporate actions (cash equity) once, on/after exDate.
 *   SPLIT/BONUS — adjust open positions (qty ×mult, entry ÷mult, SL/TP ÷mult,
 *     closedQty ×mult) + resting orders; notional/margin unchanged. Idempotent
 *     per position via `corpActionsApplied`.
 *   DIVIDEND — credit longs / debit shorts (amount × qty), idempotent via
 *     a DIVIDEND:<caId>:<posId> wallet dedupeKey.
 */
const applyCorporateActions = async () => {
  const CorporateAction = require('../models/CorporateAction');
  const pending = await CorporateAction.find({ applied: false, exDate: { $lte: new Date() } }).limit(50);
  if (!pending.length) return;
  const walletService = require('./walletService');

  for (const ca of pending) {
    const claimed = await CorporateAction.findOneAndUpdate(
      { _id: ca._id, applied: false },
      { $set: { applied: true, appliedAt: new Date() } },
      { new: true }
    );
    if (!claimed) continue;
    try {
      let affected = 0;
      const positions = await Position.find({ symbol: ca.symbol, status: POSITION_STATUS.OPEN, settled: { $ne: true } });

      if (ca.type === 'SPLIT' || ca.type === 'BONUS') {
        const mult = (Number(ca.ratioTo) || 1) / (Number(ca.ratioFrom) || 1);
        if (mult > 0 && mult !== 1) {
          const m = String(mult);
          for (const pos of positions) {
            const set = {
              quantity: mul(pos.quantity, m),
              entryPrice: div(pos.entryPrice, m),
              closedQuantity: mul(pos.closedQuantity || '0', m),
            };
            if (pos.stopLoss) set.stopLoss = div(pos.stopLoss, m);
            if (pos.takeProfit) set.takeProfit = div(pos.takeProfit, m);
            const res = await Position.updateOne(
              { _id: pos._id, corpActionsApplied: { $ne: ca._id } }, // idempotent
              { $set: set, $push: { corpActionsApplied: ca._id } }
            );
            affected += res.modifiedCount || 0;
          }
          // Resting LIMIT/STOP orders on the symbol: price ÷mult, qty ×mult.
          const orders = await Order.find({ symbol: ca.symbol, status: { $in: [ORDER_STATUS.PENDING, ORDER_STATUS.PARTIALLY_FILLED] } });
          for (const o of orders) {
            const set = { quantity: mul(o.quantity, m) };
            if (o.price) set.price = div(o.price, m);
            if (o.stopPrice) set.stopPrice = div(o.stopPrice, m);
            await Order.updateOne({ _id: o._id }, { $set: set });
          }
        }
      } else if (ca.type === 'DIVIDEND') {
        const per = ca.amount || '0';
        for (const pos of positions) {
          const total = mul(pos.quantity, per);
          if (!gt(total, '0')) continue;
          const acct = await TradingAccount.findById(pos.accountId).select('baseCurrency').lean();
          // Base currency, not INR: this names the wallet the dividend is credited
          // to, and wallets are USD-denominated.
          const currency = (acct && acct.baseCurrency) || BASE_CURRENCY;
          const args = {
            userId: pos.userId, accountId: pos.accountId, currency, amount: total,
            type: 'DIVIDEND', referenceType: 'CORP_ACTION', referenceId: ca._id,
            note: `Dividend ${ca.symbol} @ ${per}/sh`, dedupeKey: `DIVIDEND:${ca._id}:${pos._id}`,
          };
          if (pos.side === 'BUY') await walletService.credit(args);  // long → credit
          else await walletService.debit(args);                     // short → debit
          notifyUser(String(pos.userId), 'wallet', { event: 'DIVIDEND', symbol: ca.symbol });
          affected++;
        }
      }

      await CorporateAction.updateOne({ _id: ca._id }, { $set: { appliedCount: affected } });
      console.log(`[Worker] corporate action: ${ca.type} ${ca.symbol} → ${affected} position(s)`);
    } catch (e) {
      console.error(`[Worker] corporate action ${ca._id} failed:`, e.message);
      await CorporateAction.updateOne({ _id: ca._id }, { $set: { applied: false, appliedAt: null } }); // retry next slow-tick
    }
  }
};

/** Read counts and duration of the last completed tick — for probes and tests. */
let _lastTickStats = null;

const tick = async () => {
  if (running) return;
  running = true;
  // Everything this tick reads once, it reads once (see workerTickCache).
  // Created per tick and dropped at the end — nothing carries over.
  const cache = createTickCache();
  try {
    await triggerStopOrders(cache);
    await triggerLimitOrders(cache);
    await checkSlTp(cache);
    await updateTrailingStops(cache);
    await processOcoGroups();
    // ORDER MATTERS: the account snapshot is taken on first use, here —
    // after every stage above that can close a position or fill an order.
    // Settlement is synchronous, so the margin check and the stop-out sweep
    // see post-close balances. A stage that can close or fill must stay
    // above this line, or call cache.markTouched() for what it changes.
    await checkMarginAndStopOut(cache);
    await checkNegativeBalanceProtection(cache);
    await checkPriceAlerts();
    await checkAutoModeSwitch();
    await checkIntradaySquareOff();
    await settleCopyMirrors();
  } catch (e) {
    console.error('[Worker] tick error:', e.message);
  } finally {
    _lastTickStats = cache.finish();
    if (process.env.WORKER_TICK_STATS === '1') console.log('[Worker] tick', JSON.stringify(_lastTickStats));
    running = false;
  }
};

const getLastTickStats = () => _lastTickStats;

/**
 * Subscription expiry sweep (low-cadence — runs hourly).
 *
 * A subscription whose `expiresAt` is in the past is treated as a
 * payment failure: the user is moved to the FREE plan and their
 * trading accounts are re-enforced (excess accounts get suspended).
 *
 * Suspended accounts can still WITHDRAW and view 3 months of history —
 * those rules live in the orderRouter and history endpoints, not here.
 */
const sweepExpiredSubscriptions = async () => {
  const { Subscription, Plan } = require('../models/Subscription');
  const subscriptionService = require('./subscriptionService');

  const now = new Date();
  // Only act on subs that are ACTIVE/TRIAL on a paid plan with a past
  // expiry. CANCELLED rows already had their downgrade applied on cancel.
  const expired = await Subscription.find({
    status: { $in: ['ACTIVE', 'TRIAL'] },
    expiresAt: { $ne: null, $lt: now },
    planCode: { $ne: 'FREE' },
  }).limit(200);

  if (!expired.length) return;
  console.log(`[Worker] subscription expiry sweep: ${expired.length} subscription(s) to downgrade`);

  for (const sub of expired) {
    try {
      // Postpaid plans are billed monthly by billPostpaid(), NOT this fixed-date
      // expiry flow (their monthlyPrice is 0, so they'd wrongly downgrade). If
      // one slipped in with a stale expiry, clear it (seed a billing anchor if
      // missing) and skip.
      const ppPlan = await Plan.findOne({ code: sub.planCode }).select('features').lean();
      if (ppPlan?.features?.postPaid) {
        await Subscription.updateOne(
          { _id: sub._id },
          { $set: { expiresAt: null, ...(sub.nextBillingAt ? {} : { nextBillingAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) }) } },
        );
        continue;
      }
      // ── Auto-renew attempt — Main Wallet, then Trading if enabled.
      //    The Bonus Wallet is NEVER charged. Only runs when the user
      //    enabled auto-renew on their Main Wallet. On success we renew the
      //    same plan and skip the downgrade; on failure the account enters a
      //    grace period (soft downgrade keeps withdrawals + history).
      try {
        const subscriptionWalletService = require('./subscriptionWalletService');
        const mainW = await subscriptionWalletService.getOrCreate(sub.userId);
        if (mainW.autoRenew) {
          const plan = await Plan.findOne({ code: sub.planCode, isActive: true }).lean();
          const cycle = sub.billingCycle || 'MONTHLY';
          const price = plan ? (cycle === 'YEARLY' ? Number(plan.yearlyPrice || 0) : Number(plan.monthlyPrice || 0)) : 0;
          if (plan && price > 0) {
            const ref = await subscriptionService.chargePlan({
              userId: sub.userId, amount: price,
              note: `Auto-renew · ${plan.name} (${cycle.toLowerCase()})`,
              planCode: plan.code, billingCycle: cycle,
            });
            await subscriptionService.subscribe({ userId: sub.userId, planCode: sub.planCode, billingCycle: cycle, paymentRef: ref });
            try {
              const { AuditLog, Notification } = require('../models/index');
              await AuditLog.create({ actorId: sub.userId, actorRole: 'SYSTEM', action: 'SUBSCRIPTION_AUTO_RENEW', targetType: 'SUBSCRIPTION', targetId: String(sub._id), metadata: { planCode: sub.planCode, amount: String(price), source: ref?.provider } });
              await Notification.create({ userId: sub.userId, type: 'SUBSCRIPTION_RENEWED', title: 'Subscription renewed', message: `Your ${plan.name} plan was auto-renewed from your Main Wallet.`, channels: ['IN_APP', 'EMAIL'] });
            } catch (_) { /* best-effort */ }
            notifyUser(String(sub.userId), 'subscription', { event: 'AUTO_RENEWED', plan: sub.planCode });
            continue; // renewed — skip downgrade
          }
        }
      } catch (renewErr) {
        // Insufficient Main (+Trading) balance → grace period + notify.
        // NEVER fall back to the Bonus Wallet.
        try {
          const { Notification } = require('../models/index');
          await Notification.create({
            userId: sub.userId, type: 'SUBSCRIPTION_RENEW_FAILED',
            title: 'Auto-renew failed — top up your Main Wallet',
            message: `We couldn't auto-renew your ${sub.planCode} plan: insufficient Main Wallet balance. Top up your Main Wallet and re-subscribe to keep your plan. You can still withdraw funds.`,
            channels: ['IN_APP', 'EMAIL'],
          });
        } catch (_) { /* best-effort */ }
      }

      // Mark the failed sub EXPIRED so we don't re-process it. The
      // subsequent subscribe() to FREE will overwrite the same row.
      sub.status = 'EXPIRED';
      sub.cancelledAt = now;
      sub.cancelReason = 'Payment failed / subscription expired — auto-downgraded to FREE';
      await sub.save();

      // Re-subscribe to FREE. This triggers leverage + plan-enforcement
      // hooks inside subscriptionService.subscribe (suspends excess).
      await subscriptionService.subscribe({
        userId: sub.userId,
        planCode: 'FREE',
        billingCycle: 'MONTHLY',
        paymentRef: {
          provider: 'AUTO',
          transactionId: `auto-downgrade-${sub._id}`,
          amount: '0',
          paidAt: now,
        },
      });

      // Notify the user (best-effort).
      try {
        const { Notification } = require('../models/index');
        await Notification.create({
          userId: sub.userId,
          type: 'SUBSCRIPTION_DOWNGRADED',
          title: 'Subscription downgraded to Free',
          message: 'Your paid subscription has expired or payment failed. You are now on the Free plan. Some accounts may be suspended until you re-subscribe — you can still withdraw funds and view 3 months of history.',
          channels: ['IN_APP', 'EMAIL'],
        });
      } catch (_) { /* notifications are best-effort */ }

      notifyUser(String(sub.userId), 'subscription', {
        event: 'AUTO_DOWNGRADED',
        from: sub.planCode,
        to: 'FREE',
        reason: 'expired',
      });
    } catch (e) {
      console.error(`[Worker] subscription downgrade failed for sub ${sub._id}:`, e.message);
    }
  }
};

// ─── Monthly partner-tier recalculation ──────────────────────────────
// Partner tiers are driven by the PREVIOUS calendar month's referral
// trading volume and must be recomputed on the 1st of each month, then
// held fixed for the whole month. We pigg-back on the hourly slow-tick:
// when the calendar month changes (or on first boot) we refresh every
// partner's tier snapshot. Reads also self-heal lazily, so this is a
// proactive sweep — even a missed run is corrected on the next read.
let _lastTierMonth = null;
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const recalcPartnerTiersIfNewMonth = async () => {
  const m = monthKey(new Date());
  if (_lastTierMonth === m) return;
  try {
    const partnerService = require('./partnerService');
    const n = await partnerService.recalcAllPartnerTiers();
    _lastTierMonth = m;
    console.log(`[Worker] partner tier monthly recalculation done for ${m} (${n} partners)`);
  } catch (e) {
    console.error('[Worker] partner tier recalculation failed:', e.message);
  }
};

// ─── Copy-trade mirror settlement (near-real-time) ───────────────────
// A follower mirror that closes OUTSIDE the master-close hook — the follower
// closing by hand, an SL/TP hit, a stop-out — used to be settled only when the
// FOLLOWER next opened their "My Copies" page. That made the master's
// performance fee depend on someone else's browsing, so a profitable close
// could sit unsettled forever and the master's earnings stayed at $0.
//
// checkSlTp() / checkMarginAndStopOut() run on this same 5s tick, so we sweep
// shortly after them — throttled, because the fee only has to be timely, not
// instant. Idempotent at the service layer (unique followerPositionId).
let _lastMirrorSweep = 0;
const MIRROR_SWEEP_MS = 60 * 1000;
const settleCopyMirrors = async () => {
  if (Date.now() - _lastMirrorSweep < MIRROR_SWEEP_MS) return;
  _lastMirrorSweep = Date.now();
  try {
    const ct = require('./copyTradingService');
    // (a) mirrors still marked OPEN whose follower position has closed, and
    // (b) mirrors already marked CLOSED whose fee never landed — settleCopy-
    //     TradeProfit() swallows its own errors, so a failed settlement leaves
    //     no trace on the CopyTrade and nothing else would ever retry it.
    const [opened, stranded] = await Promise.all([
      ct.sweepSettledMirrors(),
      ct.sweepUnsettledClosedMirrors(),
    ]);
    if (opened || stranded) {
      console.log(`[Worker] copy mirror sweep: settled ${opened} newly-closed, recovered ${stranded} stranded mirror(s)`);
    }
  } catch (e) {
    console.error('[Worker] copy mirror sweep failed:', e.message);
  }
};

// ─── Monthly copy-trading performance-fee settlement ─────────────────
// Copy-trade performance fees accrue in each box's escrow (copyEarningsService)
// instead of paying the master per trade. At each month rollover we release the
// accrued fee to the master's Main Wallet — but ONLY for boxes whose source
// account was net-profitable that month; the rest carry forward (high-water).
// Runs once per calendar month (module guard) + is idempotent per box+month at
// the service layer, so a missed run / restart self-corrects on the next sweep.
let _lastCopyFeeMonth = null;
const settleCopyFeesIfNewMonth = async () => {
  const m = monthKey(new Date());
  if (_lastCopyFeeMonth === m) return;
  try {
    const r = await require('./copyEarningsService').settleMonthlyFees(new Date());
    _lastCopyFeeMonth = m;
    if (r && (r.released || r.carried)) {
      console.log(`[Worker] copy fee settlement ${r.month}: released ${r.released} ($${r.releasedUsd}), carried ${r.carried}`);
    }
  } catch (e) {
    // Leave the guard unset → retried on the next slow-tick.
    console.error('[Worker] copy fee monthly settlement failed:', e.message);
  }
};

// Daily pre-market refresh of Dhan instruments (F&O tokens roll each series +
// new expiries appear). Runs once/day in the 07:00–09:59 IST window. No-op
// unless Dhan is configured. Idempotent via the IST day guard.
let _lastDhanSyncDay = null;
const syncDhanDaily = async () => {
  // Run whenever an Indian feed is configured — the scrip-master CSV is FREE
  // (no Dhan creds needed), so an Upstox/Yahoo-only setup must still get the
  // daily instrument refresh. (Previously gated on Dhan creds → never ran for
  // Upstox users.)
  const indianActive = process.env.INDIAN_FEED
    || (process.env.DHAN_CLIENT_ID && process.env.DHAN_ACCESS_TOKEN);
  if (!indianActive) return;
  // Admin ON/OFF switch (Instruments page). Default ON.
  try {
    if ((await require('./systemSettings.service').getSetting('dhan.autoSync')) === false) return;
  } catch (_) { /* default on */ }
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  });
  const p = {}; for (const x of f.formatToParts(new Date())) p[x.type] = x.value;
  const day = `${p.year}-${p.month}-${p.day}`;
  const hour = Number(p.hour) === 24 ? 0 : Number(p.hour);
  if (hour < 7 || hour >= 10) return;          // pre-market window only
  if (_lastDhanSyncDay === day) return;        // already synced today
  _lastDhanSyncDay = day;
  try {
    const r = await require('./dhanInstrumentSync').syncAll();
    console.log(`[Worker] Dhan instrument sync: ${r.ops} contracts (upserted ${r.upserted}, modified ${r.modified}, optKept ${r.optKept ?? '-'})`);
    // Ensure the Indian INDEX spot tiles (NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY/
    // SENSEX) exist so they show + tick live alongside their F&O contracts.
    try {
      const ix = await require('./indianIndices').ensureIndianIndices();
      console.log(`[Worker] Indian index spots: ensured ${ix.total} (inserted ${ix.inserted}, updated ${ix.updated})`);
    } catch (e) { console.error('[Worker] index-spot ensure failed:', e.message); }
  } catch (e) {
    console.error('[Worker] Dhan instrument sync failed:', e.message);
    _lastDhanSyncDay = null;                    // retry next slow-tick
  }
};

let _tickHandle = null;
let _slowTickHandle = null;
/**
 * Postpaid usage billing — bills each active postpaid subscriber once per cycle
 * (checked hourly). Bill = max(minimumMonthlyFee, perDevicePerMonth × devices +
 * perAccountPerMonth × accounts), where devices = distinct logged-in devices
 * (refresh tokens) and accounts = the user's REAL (non-demo) active trading
 * accounts. Charged from the Main Wallet via subscriptionService.chargePlan.
 * The anchor is advanced optimistically via an atomic claim so a concurrent
 * tick can't double-charge; on insufficient funds it retries in ~2 days (grace).
 */
const billPostpaid = async () => {
  const { Plan, Subscription } = require('../models/Subscription');
  const User = require('../models/User');
  const TradingAccount = require('../models/TradingAccount');
  const subscriptionService = require('./subscriptionService');
  const { Notification } = require('../models/index');

  const now = new Date();
  const due = await Subscription.find({ status: 'ACTIVE', nextBillingAt: { $ne: null, $lte: now } }).limit(200).lean();
  if (!due.length) return;

  const UNIT_MS = { MINUTES: 60 * 1000, HOURS: 60 * 60 * 1000, DAYS: 24 * 60 * 60 * 1000 };
  const cycleMs = (plan) => {
    const unit = UNIT_MS[plan.billingDays?.unit] || UNIT_MS.DAYS;
    const monthly = Number(plan.billingDays?.monthly) > 0 ? Number(plan.billingDays.monthly) : 30;
    return monthly * unit;
  };

  for (const sub of due) {
    const plan = await Plan.findById(sub.planId).lean();
    if (!plan?.features?.postPaid) {
      // Stray anchor on a non-postpaid plan — clear it so we stop re-checking.
      await Subscription.updateOne({ _id: sub._id }, { $set: { nextBillingAt: null } });
      continue;
    }
    const { bill, devices, accounts, currency, min } = await subscriptionService.computePostpaidBill(sub.userId, plan);
    const nextAt = new Date(new Date(sub.nextBillingAt).getTime() + cycleMs(plan));

    // Atomic claim — advance the anchor first so a concurrent tick can't double-bill.
    const claimed = await Subscription.findOneAndUpdate(
      { _id: sub._id, nextBillingAt: sub.nextBillingAt },
      { $set: { nextBillingAt: nextAt } },
    );
    if (!claimed) continue;

    if (!(bill > 0)) continue; // nothing to charge this cycle

    const note = `Postpaid usage · ${devices} device(s) + ${accounts} account(s) (min $${min})`;
    try {
      const pay = await subscriptionService.chargePlan({ userId: sub.userId, amount: bill.toFixed(2), note, planCode: plan.code, billingCycle: 'MONTHLY' });
      await Subscription.updateOne({ _id: sub._id }, { $set: { lastPayment: { ...pay, amount: bill.toFixed(2), currency } } });
      try {
        await Notification.create({
          userId: sub.userId, type: 'SUBSCRIPTION_RENEWED',
          title: 'Postpaid bill charged',
          message: `$${bill.toFixed(2)} charged from your Main Wallet — ${devices} device(s) + ${accounts} account(s) this cycle.`,
          channels: ['IN_APP', 'EMAIL'],
        });
      } catch (_) { /* best-effort */ }
      notifyUser(String(sub.userId), 'subscription', { event: 'POSTPAID_CHARGED', amount: bill.toFixed(2), devices, accounts });
      console.log(`[Worker] postpaid: charged $${bill.toFixed(2)} to ${sub.userId} (${devices}d / ${accounts}a)`);
    } catch (e) {
      // Insufficient funds → retry in ~2 days + notify. Keeps the plan active
      // (grace) rather than downgrading immediately.
      await Subscription.updateOne({ _id: sub._id }, { $set: { nextBillingAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000) } });
      try {
        await Notification.create({
          userId: sub.userId, type: 'SUBSCRIPTION_RENEW_FAILED',
          title: 'Postpaid bill due — top up your Main Wallet',
          message: `We couldn't charge your $${bill.toFixed(2)} postpaid usage bill: insufficient Main Wallet balance. Top up to avoid service interruption.`,
          channels: ['IN_APP', 'EMAIL'],
        });
      } catch (_) { /* best-effort */ }
      notifyUser(String(sub.userId), 'subscription', { event: 'POSTPAID_DUE', amount: bill.toFixed(2) });
      console.warn(`[Worker] postpaid: charge failed for ${sub.userId}: ${e.message}`);
    }
  }
};

const start = (intervalMs = 5000) => {
  if (_tickHandle) return; // already running — idempotent for hot-reload safety
  console.log('[Worker] Background worker started (STOP, LIMIT, SL/TP, trailing, OCO, margin, neg-balance, alerts, auto-switch every 5s; copy-mirror settlement every 60s)');
  _tickHandle = setInterval(tick, intervalMs);

  // Hourly low-cadence sweep for subscription expiry. Runs once on boot
  // (5s delay so DB is ready) then every hour. Separate handle so a
  // long-running expiry sweep can't starve the fast tick.
  const slowTick = async () => {
    try {
      await sweepExpiredSubscriptions();
      await billPostpaid();
      await recalcPartnerTiersIfNewMonth();
      await settleCopyFeesIfNewMonth();
      await syncDhanDaily();
      // Refresh the Upstox access token once/day after its 03:30 IST invalidation
      // (self-heals the daily-token expiry; no-op unless auto-login is configured).
      try { await require('./upstoxAuth').refreshDaily(); } catch (e) { console.error('[Worker] Upstox token refresh failed:', e.message); }
      await applyCorporateActions();
      // Candle retention, at most once a day, only when CANDLE_RETENTION=on
      // (off by default). Its own try: a failure here must not block the
      // sweeps above on the next hour.
      try { await require('./candleRetention').runDailyIfDue(); } catch (e) { console.error('[Worker] candle retention failed:', e.message); }
    } catch (e) {
      console.error('[Worker] slow-tick error:', e.message);
    }
  };
  setTimeout(slowTick, 5000);
  _slowTickHandle = setInterval(slowTick, 60 * 60 * 1000);
};

// Called from server.js on graceful shutdown — stops scheduling new ticks.
// An in-flight tick is allowed to complete (closing orders mid-flight
// must finish so we don't strand a position in CLOSING state).
const stop = () => {
  if (_tickHandle) {
    clearInterval(_tickHandle);
    _tickHandle = null;
    console.log('[Worker] Background worker stopped');
  }
  if (_slowTickHandle) {
    clearInterval(_slowTickHandle);
    _slowTickHandle = null;
  }
};

module.exports = { start, stop, setBroadcaster, getLastTickStats };
