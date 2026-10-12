/**
 * Candle retention — removes candles that no screen or API reads.
 *
 * Measured on production (2026-10-04): candles were 98% of the database, and
 * 1-minute candles older than 7 days alone were 59.5% of them (9.4M rows,
 * ~711 MB) — yet no screen asks for more than 500 candles of any timeframe,
 * and the candles API cannot page back in time. Nothing else is touched:
 * this module only ever deletes from `candles`.
 *
 * Two rules:
 *   1. a contract that expired more than graceDays ago loses all its candles
 *      (it no longer trades; until then it stays fully viewable)
 *   2. for everything else, candles older than the timeframe's window go;
 *      1d and 1w are always kept (the stock page reads up to 5 years of 1w)
 *
 * Every window has a FLOOR above what the app reads, and a config below it is
 * refused outright — a typo must not be able to delete what a chart shows.
 *
 * Nothing here runs by itself. Callers:
 *   - scripts/candle-retention.js  (dry run by default; --apply to delete)
 *   - the worker's hourly slow tick, only when CANDLE_RETENTION=on
 *
 * Deletes use the {symbol, timeframe, openTime} unique index — one range per
 * symbol and timeframe — never a collection scan.
 */
const Candle = require('../models/Candle');
const Instrument = require('../models/Instrument');

const DAY = 864e5;

// Proposal, from what the app reads (longest request per timeframe):
// 1m 500 ≈ 8.3 h · 5m 500 ≈ 1.7 d · 15m 500 ≈ 5.2 d · 30m 90 ≈ 1.9 d ·
// 1h 500 ≈ 21 d · 4h 500 ≈ 83 d. Backfill needs >= 120 per timeframe.
const DEFAULT_KEEP_DAYS = { '1m': 7, '5m': 30, '15m': 30, '30m': 30, '1h': 90, '4h': 365 };
// Never below these: each is above the longest read for its timeframe.
const FLOOR_DAYS = { '1m': 1, '5m': 3, '15m': 7, '30m': 7, '1h': 30, '4h': 120 };
const DEFAULT_GRACE_DAYS = 30;

/** Retention windows from env (CANDLE_KEEP_1M=…, CANDLE_EXPIRED_GRACE_DAYS=…), validated. */
const readConfig = (env = process.env) => {
  const keep = {};
  for (const tf of Object.keys(DEFAULT_KEEP_DAYS)) {
    const v = Number(env[`CANDLE_KEEP_${tf.toUpperCase()}`]);
    keep[tf] = Number.isFinite(v) && v > 0 ? v : DEFAULT_KEEP_DAYS[tf];
  }
  const g = Number(env.CANDLE_EXPIRED_GRACE_DAYS);
  const graceDays = Number.isFinite(g) && g > 0 ? g : DEFAULT_GRACE_DAYS;
  return validate({ keep, graceDays });
};

const validate = ({ keep, graceDays }) => {
  for (const [tf, days] of Object.entries(keep)) {
    if (!(tf in FLOOR_DAYS)) throw new Error(`candle retention: unknown timeframe ${tf} (1d/1w are always kept)`);
    if (!(days >= FLOOR_DAYS[tf])) {
      throw new Error(`candle retention: ${tf} window ${days}d is below the ${FLOOR_DAYS[tf]}d floor — a chart reads that far back; refusing`);
    }
  }
  if (!(graceDays >= 1)) throw new Error('candle retention: expired-contract grace must be at least 1 day');
  return { keep, graceDays };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Count (dry run) or delete what the rules cover.
 *
 * A symbol counts as expired only when EVERY instrument carrying it has an
 * expiry in the past — if any instrument with that symbol is still live or
 * has no expiry, its candles are kept and only the age rules apply.
 */
const runCandleRetention = async ({ apply = false, keep, graceDays, now = Date.now(), pauseMs = 0, log = () => {} } = {}) => {
  ({ keep, graceDays } = validate({ keep: keep || DEFAULT_KEEP_DAYS, graceDays: graceDays || DEFAULT_GRACE_DAYS }));
  const symbols = await Candle.distinct('symbol');
  const insts = await Instrument.find({ symbol: { $in: symbols } }).select('symbol expiryDate').lean();

  // symbol -> latest expiry across its instruments, or Infinity if any has none.
  const expiry = new Map();
  for (const i of insts) {
    const e = i.expiryDate ? new Date(i.expiryDate).getTime() : Infinity;
    expiry.set(i.symbol, Math.max(expiry.get(i.symbol) ?? -Infinity, e));
  }
  const expiredCut = now - graceDays * DAY;

  const result = { apply, keep, graceDays, expired: { docs: 0, symbols: 0 }, byTf: {}, total: 0 };
  for (const tf of Object.keys(keep)) result.byTf[tf] = { docs: 0, symbols: 0 };
  const act = async (filter) => (apply
    ? (await Candle.deleteMany(filter)).deletedCount
    : Candle.countDocuments(filter));

  for (const sym of symbols) {
    const exp = expiry.get(sym);
    if (exp != null && exp !== Infinity && exp < expiredCut) {
      const n = await act({ symbol: sym });
      if (n) { result.expired.docs += n; result.expired.symbols += 1; }
    } else {
      for (const [tf, days] of Object.entries(keep)) {
        const n = await act({ symbol: sym, timeframe: tf, openTime: { $lt: new Date(now - days * DAY) } });
        if (n) { result.byTf[tf].docs += n; result.byTf[tf].symbols += 1; }
      }
    }
    if (apply && pauseMs) await sleep(pauseMs);
  }
  result.total = result.expired.docs + Object.values(result.byTf).reduce((t, r) => t + r.docs, 0);
  log(`[CandleRetention] ${apply ? 'deleted' : 'would delete'} ${result.total} candles ` +
    `(expired contracts ${result.expired.docs}, ${Object.entries(result.byTf).map(([tf, r]) => `${tf} ${r.docs}`).join(', ')})`);
  return result;
};

/**
 * The worker's daily slot. Runs at most once per UTC day, in the hour set by
 * CANDLE_RETENTION_HOUR_UTC (default 22 = 03:30 IST, after the 21:30 backup),
 * and only when CANDLE_RETENTION=on. Off by default.
 */
let _lastRunDay = null;
const runDailyIfDue = async (now = new Date()) => {
  if (String(process.env.CANDLE_RETENTION || '').toLowerCase() !== 'on') return null;
  const hour = Number.isFinite(Number(process.env.CANDLE_RETENTION_HOUR_UTC)) && process.env.CANDLE_RETENTION_HOUR_UTC !== ''
    ? Number(process.env.CANDLE_RETENTION_HOUR_UTC) : 22;
  const day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() !== hour || _lastRunDay === day) return null;
  _lastRunDay = day;
  const cfg = readConfig();
  return runCandleRetention({ apply: true, ...cfg, pauseMs: 5, log: (m) => console.log(m) });
};

module.exports = { runCandleRetention, runDailyIfDue, readConfig, DEFAULT_KEEP_DAYS, FLOOR_DAYS, DEFAULT_GRACE_DAYS };
