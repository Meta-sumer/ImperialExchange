/**
 * Per-tick read cache for the 5-second background worker.
 *
 * Every tick used to re-read the same documents over and over: each open
 * position fetched its instrument once in SL/TP, again in trailing stops and
 * again in the margin check, and every account and wallet was read twice.
 * Measured on 10 accounts / 50 positions / 20 instruments: 230 queries a tick,
 * most of them fetching something the same tick had already fetched.
 *
 * This holds what one tick has read so each stage asks only for what is
 * missing. It is created at the start of a tick and dropped at the end —
 * nothing here outlives a tick and nothing is ever written through it.
 *
 * Three things it is careful about, because the worker makes money decisions:
 *
 * 1. PRICE AGE. SL/TP, trailing stops and STOP/LIMIT triggers still price off
 *    Instrument.lastPrice, exactly as before. But a tick that closes several
 *    positions can take seconds — each close is a chain of round trips — and a
 *    tick-long snapshot would then judge later positions on an older price
 *    than the per-position read it replaces. So a cached price is reused for
 *    at most INSTRUMENT_MAX_AGE_MS; past that, every stale one is re-read in a
 *    single batch. A quiet tick (the common case) reads them once.
 *
 *    Age is not the only way a price goes stale: a fill writes the trade
 *    price straight into that instrument's lastPrice. A before/after test of
 *    the whole worker caught exactly this — a LIMIT fill moved the price and
 *    the cached copy moved a trailing stop differently from the old code. So
 *    every worker submit drops the traded instrument (invalidateInstrument),
 *    and a stop-out expires the prices of the instruments it closed.
 *
 * 2. DOCUMENT SEMANTICS. A lean object and a hydrated document disagree about
 *    a missing field: Instrument.lastPrice has a schema default of "0", so a
 *    hydrated document reads a missing price as "0" while a lean object reads
 *    undefined — and the callers depend on which they got (checkSlTp skips on
 *    undefined, calculateAccountMetrics marks at "0"). The account snapshot
 *    therefore keeps the raw lean objects and hands out hydrated copies
 *    (Model.hydrate, which applies defaults exactly as a find does) to the
 *    callers that used to receive documents.
 *
 * 3. STATE CHANGES. The account snapshot is taken AFTER every stage that can
 *    close a position or fill an order, and settlement is synchronous, so the
 *    margin check and stop-out sweep see post-close balances without reloading
 *    anything. Any account the worker changes AFTER the snapshot was taken is
 *    marked, and callers read that one account fresh instead of from the
 *    snapshot — only the affected account, never all of them.
 */
const mongoose = require('mongoose');
const Position = require('../models/Position');
const Instrument = require('../models/Instrument');
const TradingAccount = require('../models/TradingAccount');
const { Wallet } = require('../models/Wallet');
const { POSITION_STATUS } = require('../config/constants');

// The fields any worker stage reads off an instrument. Lean + projected gives
// the same values those fields had on the full lean document it replaces.
const INSTRUMENT_FIELDS = '_id symbol lastPrice lastPriceUpdatedAt spreadValue spreadType';

// The fields calculateAccountMetrics and computeAccountEquity read off a
// position, plus accountId to group them.
const POSITION_FIELDS = 'accountId instrumentId symbol side quantity entryPrice margin';

// A quarter of the feeds' one-second price flush: a reused price can be at
// most one flush behind what an on-the-spot read would have returned.
const INSTRUMENT_MAX_AGE_MS = Number(process.env.WORKER_PRICE_MAX_AGE_MS) > 0
  ? Number(process.env.WORKER_PRICE_MAX_AGE_MS)
  : 250;

const _id = (v) => (v == null ? null : String(v));

/**
 * @param {object}   [opts]
 * @param {Function} [opts.now] clock, ms. Date.now in the worker; tests pass a
 *                              controllable one so the age rule is tested by
 *                              advancing time, not by racing it.
 */
const createTickCache = ({ now: clock = Date.now } = {}) => {
  const startedAt = clock();
  const stats = {
    instrumentQueries: 0,     // batched instrument reads issued for trigger stages
    instrumentsRead: 0,       // documents those reads returned
    priceRefreshes: 0,        // batches caused by a cached price going stale mid-tick
    snapshotLoads: 0,         // account snapshots taken (one per tick)
    snapshotAccounts: 0,
    snapshotPositions: 0,
    freshAccountReads: 0,     // accounts read fresh because the worker changed them after the snapshot
    touchedAccounts: 0,       // accounts the worker submitted an order for this tick
  };

  // ── instruments for the trigger stages ───────────────────────────────
  // id -> { doc, at }. doc is null when the instrument does not exist, which
  // is what findById returned for it — cached so it is not re-asked.
  const instruments = new Map();

  /**
   * Make sure every id is cached and no older than INSTRUMENT_MAX_AGE_MS.
   * One query covers everything missing; if anything asked for has gone stale,
   * every stale entry is refreshed in that same query, so a long tick re-reads
   * prices in one batch instead of drifting back to one read per position.
   */
  const ensureInstruments = async (ids) => {
    const now = clock();
    const want = [...new Set((ids || []).map(_id).filter(Boolean))];
    const missing = want.filter((id) => !instruments.has(id));
    const anyStale = want.some((id) => instruments.has(id) && now - instruments.get(id).at > INSTRUMENT_MAX_AGE_MS);
    const stale = anyStale
      ? [...instruments.entries()].filter(([, e]) => now - e.at > INSTRUMENT_MAX_AGE_MS).map(([id]) => id)
      : [];
    const toLoad = [...new Set([...missing, ...stale])].filter((id) => mongoose.isValidObjectId(id));
    // An id that cannot be an ObjectId would have made findById return null.
    for (const id of missing) if (!mongoose.isValidObjectId(id)) instruments.set(id, { doc: null, at: now });
    if (!toLoad.length) return;

    if (stale.length) stats.priceRefreshes++;
    stats.instrumentQueries++;
    const docs = await Instrument.find({ _id: { $in: toLoad } }).select(INSTRUMENT_FIELDS).lean();
    const at = clock();
    stats.instrumentsRead += docs.length;
    const found = new Map(docs.map((d) => [String(d._id), d]));
    for (const id of toLoad) instruments.set(id, { doc: found.get(id) || null, at });
  };

  /** The lean instrument for `id`, or null — what findById(id).lean() returned. */
  const getInstrument = async (id) => {
    const key = _id(id);
    if (!key) return null;
    await ensureInstruments([key]);
    const e = instruments.get(key);
    return e ? e.doc : null;
  };

  /**
   * Forget one instrument, so its next use re-reads it.
   *
   * Called after the worker submits an order: a fill writes the trade price
   * into that instrument's lastPrice (MatchingEngine._persistLastPrice), and
   * the per-position reads this cache replaced would have picked it up for
   * the very next position. Only the traded instrument changes, so only it is
   * dropped.
   */
  const invalidateInstrument = (id) => {
    const key = _id(id);
    if (key) instruments.delete(key);
  };

  // ── accounts touched by the worker this tick ─────────────────────────
  const touched = new Set();        // every account, for the stats
  const touchedAfter = new Set();   // only those changed after the snapshot
  let snapshotPromise = null;

  /** Record that the worker is about to change this account's state. */
  const markTouched = (accountId) => {
    const key = _id(accountId);
    if (!key) return;
    touched.add(key);
    if (snapshotPromise) touchedAfter.add(key);
  };

  // ── the account snapshot ─────────────────────────────────────────────
  const loadSnapshot = async () => {
    stats.snapshotLoads++;
    // Every OPEN position — the same set Position.distinct('accountId',
    // {status: OPEN}) enumerated, plus the rows each account's own query read.
    const positions = await Position.find({ status: POSITION_STATUS.OPEN }).select(POSITION_FIELDS).lean();

    const byAccount = new Map();   // accountId string -> raw positions
    const idValue = new Map();     // accountId string -> the id as stored
    for (const p of positions) {
      const key = _id(p.accountId);
      if (!byAccount.has(key)) { byAccount.set(key, []); idValue.set(key, p.accountId); }
      byAccount.get(key).push(p);
    }
    const accountIds = [...idValue.values()];
    const validAccountIds = accountIds.filter((v) => v != null && mongoose.isValidObjectId(v));
    const instrumentIds = [...new Set(positions.map((p) => _id(p.instrumentId)).filter((v) => v && mongoose.isValidObjectId(v)))];

    const [accounts, wallets, insts] = validAccountIds.length
      ? await Promise.all([
        // Hydrated, as TradingAccount.findById returned them to both stages.
        TradingAccount.find({ _id: { $in: validAccountIds } }),
        // Raw; walletDoc() hydrates on request. (userId, accountId, currency)
        // is unique, so the match below is exactly what findOne returned.
        Wallet.find({ accountId: { $in: validAccountIds } }).lean(),
        Instrument.find({ _id: { $in: instrumentIds } }).select(INSTRUMENT_FIELDS).lean(),
      ])
      : [[], [], []];

    const accountById = new Map(accounts.map((a) => [String(a._id), a]));
    const walletByKey = new Map(wallets.map((w) => [`${w.userId}|${w.accountId}|${w.currency}`, w]));
    const instrumentById = new Map(insts.map((i) => [String(i._id), i]));
    // When each snapshot price was read. Prices follow the same age rule as the
    // trigger stages: never reused past INSTRUMENT_MAX_AGE_MS.
    const loadedAt = clock();
    const priceAt = new Map(instrumentIds.map((id) => [id, loadedAt]));
    const instrumentIdsOf = (accountId) => [...new Set((byAccount.get(_id(accountId)) || [])
      .map((p) => _id(p.instrumentId)).filter((v) => v && priceAt.has(v)))];

    stats.snapshotAccounts = accountIds.length;
    stats.snapshotPositions = positions.length;

    return {
      accountIds,
      symbols: [...new Set(positions.map((p) => p.symbol))],

      /**
       * Before an account is judged: if any price it marks against has gone
       * stale, re-read every stale price in ONE query. In a quiet tick this
       * never fires — the whole sweep runs within milliseconds of the load.
       */
      refreshPricesIfStale: async (accountId) => {
        const now = clock();
        const mine = instrumentIdsOf(accountId);
        if (!mine.some((id) => now - priceAt.get(id) > INSTRUMENT_MAX_AGE_MS)) return;
        const stale = [...priceAt.entries()].filter(([, at]) => now - at > INSTRUMENT_MAX_AGE_MS).map(([id]) => id);
        stats.priceRefreshes++;
        const fresh = await Instrument.find({ _id: { $in: stale } }).select(INSTRUMENT_FIELDS).lean();
        const at = clock();
        const found = new Map(fresh.map((i) => [String(i._id), i]));
        for (const id of stale) {
          if (found.has(id)) instrumentById.set(id, found.get(id)); else instrumentById.delete(id);
          priceAt.set(id, at);
        }
      },

      /**
       * After a stop-out: its closes wrote new trade prices into the
       * instruments it held, so those — and only those — are re-read before
       * the next account that marks against them.
       */
      expirePricesOf: (accountId) => {
        for (const id of instrumentIdsOf(accountId)) priceAt.set(id, 0);
      },

      /** Changed by the worker after this snapshot was taken → read it fresh. */
      isTouched: (accountId) => touchedAfter.has(_id(accountId)),
      markTouched,
      noteFreshRead: () => { stats.freshAccountReads++; },

      /** Hydrated account document, as TradingAccount.findById returned. */
      account: (accountId) => accountById.get(_id(accountId)) || null,

      /** Lean wallet, as Wallet.findOne(...).lean() returned. */
      walletRaw: (userId, accountId, currency) =>
        walletByKey.get(`${userId}|${accountId}|${currency}`) || null,
      /** Hydrated wallet, as Wallet.findOne(...) returned. */
      walletDoc: (userId, accountId, currency) => {
        const raw = walletByKey.get(`${userId}|${accountId}|${currency}`);
        return raw ? Wallet.hydrate(raw) : null;
      },

      /** Lean open positions of the account. A copy, so callers cannot disturb the snapshot. */
      positionsRaw: (accountId) => [...(byAccount.get(_id(accountId)) || [])],
      /** Hydrated open positions of the account, as Position.find(...) returned. */
      positionDocs: (accountId) => (byAccount.get(_id(accountId)) || []).map((p) => Position.hydrate(p)),

      /** Lean instrument, as Instrument.find(...).lean() returned; null if none. */
      instrumentRaw: (id) => instrumentById.get(_id(id)) || null,
      /** Hydrated instrument, as Instrument.findById(...) returned; null if none. */
      instrumentDoc: (id) => {
        const raw = instrumentById.get(_id(id));
        return raw ? Instrument.hydrate(raw) : null;
      },
    };
  };

  /** The tick's account snapshot, taken on first use and shared after that. */
  const accountSnapshot = () => {
    if (!snapshotPromise) snapshotPromise = loadSnapshot();
    return snapshotPromise;
  };

  const finish = () => ({
    ...stats,
    touchedAccounts: touched.size,
    tickMs: clock() - startedAt,
  });

  return { ensureInstruments, getInstrument, invalidateInstrument, markTouched, accountSnapshot, finish, stats };
};

module.exports = { createTickCache, INSTRUMENT_MAX_AGE_MS, INSTRUMENT_FIELDS, POSITION_FIELDS };
