/**
 * Zero-equity STOP-OUT engine (single source of truth).
 *
 * Rule enforced everywhere:
 *
 *     REAL-TIME PRICE → REAL-TIME uPnL → REAL-TIME EQUITY
 *        Equity = Balance + Σ Unrealized P&L
 *     IF Equity <= 0  → IMMEDIATE STOP-OUT:
 *        1. atomically flip the account to STOPPED_OUT  (blocks new orders)
 *        2. cancel ALL pending / working orders (release their margin)
 *        3. close ALL open positions (closeReason = STOP_OUT)
 *        4. floor the wallet balance at 0 (negative-balance protection)
 *
 * WHY THIS EXISTS (root cause it fixes):
 *   The only liquidation path used to be the 5-second background poll
 *   (backgroundWorker.checkNegativeBalanceProtection / checkMarginAndStopOut).
 *   Nothing was hooked into the real-time price stream, so on a busy box the
 *   poll lagged and a losing position ran far past equity=0 for "minutes"
 *   until the user closed it by hand — only then did the balance settle
 *   (sometimes negative). This service is invoked DIRECTLY from the WS price
 *   fan-out (broadcaster.onTicker) so the stop-out fires on the same tick the
 *   equity crosses zero, and the 5s poll is kept only as a safety net.
 *
 * Design guarantees:
 *   - IDEMPOTENT: the account-status flip is an atomic findOneAndUpdate; the
 *     per-position OPEN→CLOSING claim and the balance-floor are atomic too, so
 *     re-entry (real-time + poll firing together, or many ticks at once) can
 *     never double-close or over-absorb.
 *   - RACE-SAFE: the status flip to STOPPED_OUT happens BEFORE liquidation, so
 *     a concurrent order is rejected by orderRouter._validate
 *     (ACCOUNT_STOPPED_OUT) before it can add exposure.
 *   - REUSES the existing engine: closes route through orderRouter.routeOrder
 *     (same book/execution as a manual close), never a parallel risk system.
 */
const Order = require('../models/Order');
const Position = require('../models/Position');
const Instrument = require('../models/Instrument');
const TradingAccount = require('../models/TradingAccount');
const MarginCall = require('../models/MarginCall');
const { Wallet, WalletLedger } = require('../models/Wallet');
const { Notification } = require('../models/index');
const orderRouter = require('./orderRouter.service');
const walletService = require('./walletService');
const { BASE_CURRENCY, ORDER_STATUS, ORDER_TYPE, POSITION_STATUS, BOOK_TYPE } = require('../config/constants');
const { add, sub, mul, div, gt, lte } = require('../utils/decimal');

let broadcaster = null;
const setBroadcaster = (b) => { broadcaster = b; };
const notifyUser = (userId, channel, data) => {
  try { if (broadcaster) broadcaster.notifyUser(String(userId), channel, data); } catch (_) { /* never throw on broadcast */ }
};

// ── Throttles / guards ────────────────────────────────────────────────
// _inflight: accounts currently being liquidated in THIS process — skip a
//   concurrent trigger (the atomic DB claims below make it safe anyway, this
//   just avoids redundant work under a tick burst).
// _acctThrottle / _symbolThrottle: bound how often the hot real-time path
//   re-evaluates the same account/symbol. The 5s safety-net poll ignores these.
const _inflight = new Set();
const _acctThrottle = new Map();   // accountId -> last eval ms
const _symbolThrottle = new Map(); // symbol -> last eval ms
const ACCT_MIN_INTERVAL_MS = 300;
const SYMBOL_MIN_INTERVAL_MS = 400;

// Cache of symbols that currently hold at least one OPEN position, refreshed by
// the 5s safety-net sweep. Lets the real-time hook skip a DB `distinct` for the
// (common) case of a symbol nobody holds — most ticks cost only a Set lookup. A
// symbol newly opened is covered by the 5s poll until the next refresh includes
// it, so correctness is never worse than the poll.
let _activeSymbols = new Set();
let _activeSymbolsAt = 0;
const ACTIVE_SYMBOLS_TTL_MS = 10000;

// Freshest price seen on the WS fan-out, per symbol. See the note in
// computeAccountEquity: the DB copy of Instrument.lastPrice is written on a
// throttle by the feeds, so marking to it alone lags the market.
const _livePrice = new Map(); // symbol -> { price, at }
const LIVE_PRICE_TTL_MS = 15000;

const _freshMark = (symbol) => {
  if (!symbol) return null;
  const hit = _livePrice.get(symbol);
  if (!hit) return null;
  if (Date.now() - hit.at > LIVE_PRICE_TTL_MS) return null; // stale, fall back to DB
  return hit.price;
};

/**
 * Register a symbol as holding open exposure RIGHT NOW.
 *
 * Called by the matching engine the moment a position is created. Without it
 * the real-time path is blind to a brand-new position: evaluateSymbol skips
 * any symbol missing from `_activeSymbols`, and that set is only rebuilt by
 * the 5s safety sweep — so a position opened just after a refresh went
 * unmonitored by the fast path until the next one. The 5s poll still caught
 * it, but 5s of unmonitored exposure is exactly what lets equity run past
 * zero on a fast move.
 */
const noteOpenSymbol = (symbol) => {
  if (symbol) _activeSymbols.add(symbol);
};

/**
 * Submit a worker-originated order (close/cancel-follow-ups) through the
 * router so it respects the account's book + stamps executionSource. Mirrors
 * backgroundWorker._submit: B-book accounts may fall back to the engine on a
 * routing failure; A/HYBRID must not silently mis-route.
 */
const _submit = async (order) => {
  try {
    const { settledOrder } = await orderRouter.routeOrder({ order, userId: order.userId });
    return settledOrder;
  } catch (err) {
    const account = await TradingAccount.findById(order.accountId).lean();
    const bookType = account?.bookType || BOOK_TYPE.B_BOOK;
    if (bookType === BOOK_TYPE.B_BOOK) {
      console.warn(`[stopOut] router failed for B-book order ${order._id}: ${err.message} — falling back to engine`);
      return require('../matching-engine/MatchingEngine').submit(order);
    }
    order.status = ORDER_STATUS.REJECTED;
    order.rejectionReason = `Stop-out route failed: ${err.message}`;
    try { await order.save(); } catch (_) {}
    throw err;
  }
};

/**
 * REAL-TIME equity for one account, batched (1 Wallet + 1 Position + 1
 * Instrument query — no N+1). Uses the SAME mark (Instrument.lastPrice) + uPnL
 * formula as GET /wallet/equity and GET /trading/positions so every surface
 * agrees on the number that trips the stop-out.
 */
/**
 * Equity, marked at one of two prices.
 *
 *   default             the freshest tick (_freshMark) — for DETECTION, so a
 *                       fast move is noticed the instant it happens
 *   opts.markSource:
 *     'execution'       Instrument.lastPrice — the value the matching engine
 *                       actually fills against — for CONFIRMING a liquidation
 *                       before acting on it
 *
 * The two genuinely differ: the feeds write lastPrice on a throttle, so on a
 * spike the tick leads the DB copy. Deciding to liquidate on a price the
 * platform will not fill at is what let a stop-out close an account that was
 * solvent at the fillable level.
 */
//
// opts.preloaded (optional) is the background worker's tick snapshot — the
// same wallet, positions and instruments the queries below would read,
// loaded once for every account. It returns LEAN objects, as these queries
// do. Only the 5s sweep passes it; the real-time path and the execution-
// price confirmation always query fresh.
const computeAccountEquity = async (account, opts = {}) => {
  const atExecutionPrice = opts.markSource === 'execution';
  const pre = opts.preloaded || null;
  const currency = account.baseCurrency || BASE_CURRENCY;
  const wallet = pre
    ? pre.walletRaw(account.userId, account._id, currency)
    : await Wallet.findOne({ userId: account.userId, accountId: account._id, currency }).lean();
  const balance = wallet ? wallet.balance : '0';

  const positions = pre
    ? pre.positionsRaw(account._id)
    : await Position.find({ accountId: account._id, status: POSITION_STATUS.OPEN })
      .select('instrumentId symbol side quantity entryPrice margin').lean();
  if (!positions.length) {
    return { balance, equity: balance, usedMargin: '0', unrealizedPnl: '0', marginLevel: '0', positions };
  }

  const instrIds = [...new Set(positions.map((p) => String(p.instrumentId)))];
  if (pre && instrIds.some((id) => !require('mongoose').isValidObjectId(id))) {
    // The query below throws a CastError on an id that is not an ObjectId
    // (a position stored without an instrument), and the sweep skips the
    // account. Keep that outcome rather than quietly marking at entry.
    throw new Error(`Cast to ObjectId failed for instrumentId in account ${account._id}`);
  }
  const instruments = pre
    ? instrIds.map((id) => pre.instrumentRaw(id)).filter(Boolean)
    : await Instrument.find({ _id: { $in: instrIds } }).select('_id lastPrice').lean();
  const markById = new Map(instruments.map((i) => [String(i._id), i.lastPrice]));

  let unrealizedPnl = '0';
  let usedMargin = '0';
  for (const p of positions) {
    // Prefer the live tick over the stored lastPrice. Feeds batch their DB
    // writes (the Binance one flushes once a second), so Instrument.lastPrice
    // can lag the market by up to that interval — and for a rule as sharp as
    // "liquidate the instant equity reaches zero", that lag is exactly the
    // difference between flooring the balance at 0 and letting it run
    // negative. _livePrice is fed by the same WS fan-out that triggered this
    // evaluation, so it is never older than the tick we are reacting to.
    const mark = atExecutionPrice
      ? (markById.get(String(p.instrumentId)) || _freshMark(p.symbol) || p.entryPrice)
      : (_freshMark(p.symbol) || markById.get(String(p.instrumentId)) || p.entryPrice);
    const pnl = p.side === 'BUY'
      ? mul(sub(mark, p.entryPrice), p.quantity)
      : mul(sub(p.entryPrice, mark), p.quantity);
    unrealizedPnl = add(unrealizedPnl, pnl);
    usedMargin = add(usedMargin, p.margin || '0');
  }
  const equity = add(balance, unrealizedPnl);
  const marginLevel = gt(usedMargin, '0') ? mul(div(equity, usedMargin), '100') : '0';
  return { balance, equity, usedMargin, unrealizedPnl, marginLevel, positions };
};

/** Cancel every pending / working order on the account and release its margin. */
const _cancelAllPending = async (account, currency) => {
  const pending = await Order.find({
    accountId: account._id,
    status: { $in: [ORDER_STATUS.PENDING, ORDER_STATUS.PARTIALLY_FILLED] },
  });
  let cancelled = 0;
  for (const o of pending) {
    const fresh = await Order.findById(o._id);
    if (!fresh || ![ORDER_STATUS.PENDING, ORDER_STATUS.PARTIALLY_FILLED].includes(fresh.status)) continue;
    try { await orderRouter.routeCancel({ order: fresh }); } catch (_) { /* LP cancel best-effort */ }
    fresh.status = ORDER_STATUS.CANCELLED;
    fresh.rejectionReason = 'ACCOUNT_STOPPED_OUT';
    await fresh.save();
    // Release the still-locked margin for the UNFILLED remainder.
    if (gt(fresh.lockedMargin || '0', '0')) {
      const rawRemaining = sub(fresh.quantity, fresh.filledQuantity || '0');
      const remaining = gt(rawRemaining, '0') ? rawRemaining : '0';
      if (gt(remaining, '0')) {
        const releaseAmt = div(mul(fresh.lockedMargin, remaining), fresh.quantity);
        try {
          await walletService.releaseMargin({
            userId: fresh.userId, accountId: fresh.accountId, currency,
            amount: releaseAmt, orderId: fresh._id,
            note: `Stop-out: released ${releaseAmt} for unfilled ${remaining}`,
          });
        } catch (_) { /* best-effort */ }
      }
    }
    notifyUser(fresh.userId, 'orders', { event: 'CANCELLED', accountId: fresh.accountId ? String(fresh.accountId) : null, orderId: String(fresh._id), symbol: fresh.symbol, reason: 'ACCOUNT_STOPPED_OUT' });
    cancelled++;
  }
  return cancelled;
};

/**
 * Close EVERY open position on the account (not just the loser). Atomic
 * OPEN→CLOSING claim + opposite closeOnly/reduceOnly MARKET order via the
 * router, same as SL/TP and expiry square-off. closeReason=STOP_OUT.
 */
const _closeAllPositions = async (account) => {
  const positions = await Position.find({ accountId: account._id, status: POSITION_STATUS.OPEN, settled: { $ne: true } });
  const closedIds = [];
  for (const p of positions) {
    const claimed = await Position.findOneAndUpdate(
      { _id: p._id, status: POSITION_STATUS.OPEN, settled: { $ne: true } },
      { $set: { status: POSITION_STATUS.CLOSING, closeReason: 'STOP_OUT' } },
      { new: true }
    );
    if (!claimed) continue; // another path (SL/TP/manual) beat us — fine

    const oppositeSide = p.side === 'BUY' ? 'SELL' : 'BUY';
    const sourcePositionSide = p.positionSide || (p.side === 'BUY' ? 'LONG' : 'SHORT');
    const closingOrder = await Order.create({
      userId: p.userId,
      accountId: p.accountId,
      instrumentId: p.instrumentId,
      symbol: p.symbol,
      side: oppositeSide,
      positionSide: sourcePositionSide,
      type: ORDER_TYPE.MARKET,
      quantity: p.quantity,
      leverage: p.leverage,
      status: ORDER_STATUS.PENDING,
      closeOnly: true,
      reduceOnly: true,
    });
    try {
      await _submit(closingOrder);
      closedIds.push(p._id);
    } catch (e) {
      // Engine failed — release the CLOSING claim so the next tick / poll
      // retries. closeReason is unset along with it: the claim above stamped
      // STOP_OUT, and leaving that on a position that went back to OPEN would
      // label whatever eventually closes it — a manual close, an SL — as a
      // liquidation. The engine now defaults closeReason only when the stored
      // value is empty, so a stale one here would be preserved rather than
      // corrected.
      await Position.updateOne(
        { _id: p._id, status: POSITION_STATUS.CLOSING, settled: { $ne: true } },
        { $set: { status: POSITION_STATUS.OPEN }, $unset: { closeReason: '' } }
      );
      console.error('[stopOut] position close failed:', e.message);
    }
  }
  return closedIds;
};

/**
 * Negative-balance protection: after the losing closes settle (which debit the
 * realized loss and can push the wallet below zero), floor the balance at 0 so
 * the customer never ends negative. Atomic $expr guard — only acts while the
 * balance is genuinely < 0, so it can't race a concurrent settle into
 * over-absorbing. Returns the absorbed amount (string) or null.
 */
const _floorBalance = async (account, currency) => {
  const floored = await Wallet.findOneAndUpdate(
    {
      userId: account.userId,
      accountId: account._id,
      currency,
      $expr: { $lt: [{ $toDouble: '$balance' }, 0] },
    },
    [{ $set: { balance: '0' } }],
    { new: false } // pre-update doc so we can log how much was absorbed
  );
  if (!floored) return null;
  const absorbed = Math.abs(Number(floored.balance)).toFixed(2);
  try {
    await WalletLedger.create({
      walletId: floored._id,
      userId: account.userId,
      accountId: account._id,
      type: 'ADJUSTMENT',
      currency,
      amount: '+' + absorbed,
      balanceAfter: '0',
      referenceType: 'NEGATIVE_BALANCE_PROTECTION',
      note: `Broker absorbed ${absorbed} ${currency} (stop-out negative-balance protection)`,
    });
  } catch (e) {
    console.warn('[stopOut] negative-balance ledger insert failed:', e.message);
  }
  return absorbed;
};

/**
 * Release margin still locked after everything has been closed.
 *
 * A completed stop-out leaves no open positions and no live orders, so any
 * remaining `locked` is holding margin for something that no longer exists.
 * It survives because margin is locked as one computed figure and released
 * as another; releaseMargin clamps at zero on the low side but nothing ever
 * swept a small positive remainder. Free balance is balance - locked, so the
 * residue silently reduced everything paid in afterwards.
 *
 * Only runs when the account is genuinely empty — if a close failed and a
 * position is still open, its margin is real and stays locked.
 *
 * Returns the swept amount (string) or null.
 */
const _sweepStaleLocked = async (account, currency) => {
  const stillOpen = await Position.countDocuments({
    accountId: account._id, status: 'OPEN',
  });
  if (stillOpen) return null;
  const stillLive = await Order.countDocuments({
    accountId: account._id,
    status: { $in: [ORDER_STATUS.PENDING, ORDER_STATUS.PARTIALLY_FILLED] },
  });
  if (stillLive) return null;

  // Atomic + conditional, so it cannot race a concurrent lock into
  // releasing margin that was just legitimately taken.
  const swept = await Wallet.findOneAndUpdate(
    {
      userId: account.userId,
      accountId: account._id,
      currency,
      $expr: { $gt: [{ $toDouble: '$locked' }, 0] },
    },
    [{ $set: { locked: '0' } }],
    { new: false } // pre-update doc, so we can report what was released
  );
  if (!swept) return null;
  const amount = Number(swept.locked).toFixed(2);
  try {
    await WalletLedger.create({
      walletId: swept._id,
      userId: account.userId,
      accountId: account._id,
      type: 'TRADE_CLOSE',
      currency,
      amount: '0', // margin release touches `locked` only
      balanceBefore: swept.balance,
      balanceAfter: swept.balance,
      referenceType: 'STOP_OUT_MARGIN_SWEEP',
      referenceId: account._id,
      note: `Released ${amount} ${currency} of margin left locked after stop-out (nothing open to hold it)`,
    });
  } catch (e) { console.warn('[stopOut] locked-sweep ledger insert failed:', e.message); }
  return amount;
};

/**
 * Execute the full stop-out for one account. Idempotent + race-safe.
 * `account` may be a stale doc; we re-read via the atomic status flip.
 */
const triggerStopOut = async (account, meta = {}) => {
  const key = String(account._id);
  if (_inflight.has(key)) return { skipped: 'inflight' };
  _inflight.add(key);
  try {
    // 1. ATOMIC race guard. Flip ACTIVE-ish → STOPPED_OUT before touching any
    //    position. The instant this lands, orderRouter._validate rejects new
    //    orders on this account (ACCOUNT_STOPPED_OUT). `newlyStopped` marks the
    //    single winner so we only log/notify the transition once; the
    //    liquidation below still runs even for a re-entry (to sweep any
    //    straggler position that slipped in during the flip window).
    const claimed = await TradingAccount.findOneAndUpdate(
      { _id: account._id, status: { $ne: 'STOPPED_OUT' } },
      { $set: { status: 'STOPPED_OUT', stoppedOutAt: new Date() } },
      { new: true }
    );
    const acc = claimed || (await TradingAccount.findById(account._id));
    if (!acc) return { skipped: 'no-account' };
    const currency = acc.baseCurrency || BASE_CURRENCY;
    const newlyStopped = !!claimed;

    // 2. Cancel pending orders (release margin) so nothing fills post-stopout.
    const cancelledOrders = await _cancelAllPending(acc, currency);
    // 3. Close ALL open positions.
    const closedIds = await _closeAllPositions(acc);
    // 4. Floor the (now possibly negative) balance at 0.
    const absorbed = await _floorBalance(acc, currency);
    // 4a. Release margin still locked for positions that no longer exist.
    //     Must come BEFORE clearIfFunded below, which decides whether the
    //     account is solvent from balance - locked: a stale lock made a
    //     funded account look empty.
    const sweptLocked = await _sweepStaleLocked(acc, currency);
    if (sweptLocked) {
      console.log(`[stopOut] released ${sweptLocked} ${currency} of stale locked margin on account ${acc._id}`);
    }

    // 4b. If liquidation left the account solvent, unlock it again.
    //
    // NOTE ON THE THRESHOLD: evaluateAccount fires on `equity <= 0`, NOT on a
    // margin-level percentage — this comment used to claim the opposite. It
    // matters, because at that threshold a correct stop-out settles at roughly
    // zero and a positive residual is a signal something mispriced, not the
    // expected outcome. The balance is still never FORCED to zero: after a
    // legitimate stop-out whatever remains is the customer's, and _floorBalance
    // only lifts a NEGATIVE balance up to 0 (broker absorbs). If you ever move
    // to a margin-level threshold, a positive residual becomes normal and this
    // note stops applying. The status was only
    // ever cleared by a later credit, so an account that came out of its own
    // liquidation with usable funds stayed blocked indefinitely, showing
    // "deposit funds to resume" beside a positive free margin. Nothing would
    // ever clear it, because the money needed to clear it was already there.
    //
    // Safe to run here: the STOPPED_OUT flip at step 1 exists to stop orders
    // racing the liquidation, and by this line the liquidation is finished.
    // clearIfFunded is itself conditional — it only acts when free balance is
    // actually positive, so a wiped-out account stays blocked as intended.
    await clearIfFunded(acc.userId, acc._id);

    // 5. Audit + live push. Only emit the heavy notification on the transition.
    if (newlyStopped || closedIds.length || cancelledOrders) {
      try {
        await MarginCall.create({
          userId: acc.userId,
          accountId: acc._id,
          type: 'STOP_OUT',
          marginLevel: meta.marginLevel != null ? String(meta.marginLevel) : '0',
          equity: meta.equity != null ? String(meta.equity) : '0',
          usedMargin: meta.usedMargin != null ? String(meta.usedMargin) : '0',
          actionTaken: 'POSITION_LIQUIDATED',
          closedPositionIds: closedIds,
        });
      } catch (e) { console.warn('[stopOut] MarginCall log failed:', e.message); }

      if (newlyStopped) {
        try {
          await Notification.create({
            userId: acc.userId,
            type: 'STOP_OUT',
            title: 'Account stopped out',
            message: `Account ${acc.accountNumber}: equity reached zero. All positions were closed and pending orders cancelled. Your balance is protected at 0 — deposit funds to resume trading.`,
            channels: ['IN_APP', 'EMAIL'],
          });
        } catch (_) { /* best-effort */ }
      }
    }

    // Live-refresh every open-positions / wallet / status view. Closes routed
    // through A-book paths don't self-broadcast, so without this the liquidated
    // positions would linger in the UI until a manual refresh.
    notifyUser(acc.userId, 'positions', {
      event: 'STOP_OUT',
      accountId: String(acc._id),
      positionIds: closedIds.map(String),
    });
    notifyUser(acc.userId, 'wallet', { reason: 'STOP_OUT', accountId: String(acc._id) });
    notifyUser(acc.userId, 'notifications', {
      type: 'STOP_OUT',
      accountId: String(acc._id),
      liquidatedCount: closedIds.length,
      cancelledOrders,
      absorbed: absorbed || '0',
    });

    if (newlyStopped) {
      console.log(`[stopOut] account ${acc.accountNumber} stopped out — closed ${closedIds.length} position(s), cancelled ${cancelledOrders} order(s)${absorbed ? `, broker absorbed ${absorbed} ${currency}` : ''}`);
    }
    return { stopped: true, newlyStopped, closed: closedIds.length, cancelledOrders, absorbed };
  } catch (e) {
    console.error('[stopOut] triggerStopOut failed for', key, e.message);
    return { error: e.message };
  } finally {
    _inflight.delete(key);
  }
};

/**
 * Evaluate ONE account: compute real-time equity; stop out if equity <= 0 with
 * open exposure, or sweep stragglers if it's already STOPPED_OUT but still
 * holds positions. A brand-new/zero-balance account with NO open positions is
 * never stopped out (equity 0 but no exposure).
 *
 * `opts.throttle` (default true on the real-time path) rate-limits repeat
 * evaluations of the same account; the 5s safety-net poll passes throttle:false.
 */
const evaluateAccount = async (accountOrId, opts = {}) => {
  const throttle = opts.throttle !== false;
  const id = typeof accountOrId === 'object' ? accountOrId._id : accountOrId;
  if (throttle) {
    const now = Date.now();
    const last = _acctThrottle.get(String(id)) || 0;
    if (now - last < ACCT_MIN_INTERVAL_MS) return;
    _acctThrottle.set(String(id), now);
  }

  const account = typeof accountOrId === 'object' && accountOrId.userId
    ? accountOrId
    : await TradingAccount.findById(id);
  if (!account) return;

  // Detection only. The confirmation below never takes the snapshot — a
  // liquidation is always re-checked against a fresh read.
  const m = await computeAccountEquity(account, opts.preloaded ? { preloaded: opts.preloaded } : {});
  const hasExposure = m.positions.length > 0;
  if (!hasExposure) return; // nothing at risk → never stop out
  const equityZero = lte(m.equity, '0');
  const alreadyStopped = account.status === 'STOPPED_OUT';

  // Confirm at the EXECUTION price before destroying the positions.
  //
  // Detection above marks at the freshest tick so a fast move is caught at
  // once. The close, however, fills at Instrument.lastPrice, which the feeds
  // write on a throttle — computeAccountEquity says so itself. On a spike the
  // two disagree, and the account was being liquidated on a level the
  // platform would never fill at: the close then settled at the real price,
  // booking a much smaller loss or even a profit, which is how a stop-out
  // could leave an account richer than it started. The surplus was the
  // symptom; the position being closed at all was the bug.
  //
  // Only runs when a stop-out is about to fire, so the per-tick path is
  // unchanged. `alreadyStopped` skips it — that is the finish-the-job pass
  // for an account already under liquidation, not a fresh decision.
  if (equityZero && !alreadyStopped) {
    const atFill = await computeAccountEquity(account, { markSource: 'execution' });
    if (!lte(atFill.equity, '0')) return; // solvent at the price we can fill — stand down
  }

  if (equityZero || alreadyStopped) {
    await triggerStopOut(account, { equity: m.equity, usedMargin: m.usedMargin, marginLevel: m.marginLevel });
    return { acted: true }; // the sweep marks the account so nothing reuses its snapshot
  }
};

/**
 * Real-time hook: called from the WS price fan-out whenever `symbol` ticks.
 * Evaluates every account holding that symbol. Per-symbol throttled so a hot
 * feed can't hammer the DB; each account is additionally in-flight-guarded.
 */
const evaluateSymbol = async (symbol, data) => {
  if (!symbol) return;
  const now = Date.now();
  // Record the tick FIRST — before any throttle or early return. Even a tick
  // we decline to act on carries the freshest price, and the evaluation that
  // does run (this symbol later, or another symbol on the same account) must
  // mark against it rather than the throttled DB copy.
  const px = data && data.lastPrice;
  if (px != null && Number(px) > 0) _livePrice.set(symbol, { price: String(px), at: now });
  // Skip the DB round-trip for symbols nobody holds (cache fresh → Set lookup).
  if (now - _activeSymbolsAt < ACTIVE_SYMBOLS_TTL_MS && !_activeSymbols.has(symbol)) return;
  const last = _symbolThrottle.get(symbol) || 0;
  if (now - last < SYMBOL_MIN_INTERVAL_MS) return;
  _symbolThrottle.set(symbol, now);
  try {
    const accountIds = await Position.distinct('accountId', { symbol, status: POSITION_STATUS.OPEN });
    for (const accId of accountIds) {
      // sequential await bounds concurrency; in-flight/throttle guards keep it cheap
      await evaluateAccount(accId).catch(() => {});
    }
  } catch (_) { /* never let a price tick throw */ }
};

/**
 * Safety-net sweep — every account with an open position, no throttle. Invoked
 * by the 5s background worker so a missed real-time tick (feed gap, restart)
 * still liquidates within one poll.
 */
//
// `snapshot` (optional) is the worker's tick snapshot. With it, accounts,
// wallets, positions and instruments come from memory instead of three
// queries per account; an account the worker changed after the snapshot
// was taken is read fresh, as is every liquidation confirmation.
const evaluateAllOpenAccounts = async (snapshot = null) => {
  // Refresh the real-time hook's symbol cache while we're already scanning.
  if (snapshot) {
    _activeSymbols = new Set(snapshot.symbols);
    _activeSymbolsAt = Date.now();
  } else {
    try {
      const symbols = await Position.distinct('symbol', { status: POSITION_STATUS.OPEN });
      _activeSymbols = new Set(symbols);
      _activeSymbolsAt = Date.now();
    } catch (_) { /* keep the stale cache on failure */ }
  }

  const accountIds = snapshot
    ? snapshot.accountIds
    : await Position.distinct('accountId', { status: POSITION_STATUS.OPEN });
  for (const accId of accountIds) {
    if (snapshot && !snapshot.isTouched(accId)) {
      const account = snapshot.account(accId);
      if (!account) continue; // findById would have returned null
      // Prices past the age limit — or written by a liquidation earlier in
      // this sweep — are re-read (one query) before this account is judged.
      await snapshot.refreshPricesIfStale(accId);
      const res = await evaluateAccount(account, { throttle: false, preloaded: snapshot }).catch(() => {});
      if (res && res.acted) {
        // Its closes changed this account and wrote new trade prices into the
        // instruments it held: read the account fresh if anything asks again,
        // and re-read those prices before the next account that uses them.
        snapshot.markTouched(accId);
        snapshot.expirePricesOf(accId);
      }
    } else {
      if (snapshot) snapshot.noteFreshRead();
      await evaluateAccount(accId, { throttle: false }).catch(() => {});
    }
  }
};

/**
 * Auto-clear a stop-out once the account is re-funded (deposit → balance > 0).
 * Called from walletService.credit on genuine funding events. Only lifts an
 * account that is actually STOPPED_OUT and now has a positive balance.
 */
const clearIfFunded = async (userId, accountId) => {
  try {
    const acc = await TradingAccount.findOne({ _id: accountId, status: 'STOPPED_OUT' }).select('baseCurrency userId accountNumber');
    if (!acc) return;

    // Look at EVERY wallet on the account, not just the one matching
    // acc.baseCurrency.
    //
    // The old lookup was Wallet.findOne({ userId, accountId, currency }) with
    // currency taken from the account. When those disagreed — an account whose
    // baseCurrency was never migrated, or a wallet created under a different
    // code — the query matched nothing, clearIfFunded returned silently, and
    // the account stayed locked no matter how much was paid in. The user saw
    // their balance rise and the "deposit funds to resume" banner stay up.
    //
    // It also keyed on the userId passed by the caller rather than the
    // account's own owner, so a credit applied on a user's behalf looked up a
    // wallet that did not exist.
    const wallets = await Wallet.find({ accountId, userId: acc.userId }).select('balance locked currency').lean();

    // FREE balance, not gross. Clearing the flag while every unit is still
    // locked would lift the block and the next order would fail on margin
    // instead — the account would look tradeable and refuse to trade.
    const funded = wallets.some((w) => gt(sub(w.balance || '0', w.locked || '0'), '0'));
    if (!funded) return;
    const updated = await TradingAccount.findOneAndUpdate(
      { _id: accountId, status: 'STOPPED_OUT' },
      { $set: { status: 'ACTIVE', stoppedOutAt: null } },
      { new: true }
    );
    if (updated) {
      console.log(`[stopOut] account ${acc.accountNumber} re-funded — cleared STOPPED_OUT`);
      notifyUser(userId, 'wallet', { reason: 'STOP_OUT_CLEARED', accountId: String(accountId) });
    }
  } catch (e) {
    console.warn('[stopOut] clearIfFunded failed:', e.message);
  }
};

module.exports = {
  setBroadcaster,
  noteOpenSymbol,
  computeAccountEquity,
  triggerStopOut,
  evaluateAccount,
  evaluateSymbol,
  evaluateAllOpenAccounts,
  clearIfFunded,
};
