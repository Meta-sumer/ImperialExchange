/**
 * yahooBackfill.js — seed historical candles for Indian instruments from Yahoo's
 * free chart API, with NO API key and NO token.
 *
 * Why this exists: upstoxBackfill is the primary source, but it needs a working
 * UPSTOX_ACCESS_TOKEN — the same token the live feed uses. So when that token
 * dies, a chart loses BOTH its live updates and its history at once, and every
 * timeframe the user has not already visited renders empty. Switching from 1m to
 * 5m then shows nothing at all, because 5m candles were never built and cannot
 * be fetched either. That is a single point of failure for the entire chart.
 *
 * This is the fallback: same Candle shape, same idempotent upsert by
 * (symbol, timeframe, openTime), so the two sources can freely overwrite each
 * other's rows without conflict.
 *
 * COVERAGE IS DELIBERATELY NARROW — equities and indices only.
 *   NSE/BSE equity → RELIANCE.NS / .BO      real prices for that instrument
 *   Index          → ^NSEI, ^NSEBANK, …     real index history
 *   F&O / MCX      → SKIPPED ON PURPOSE
 *
 * yahooFeed.spotSymbol() resolves a derivative to its UNDERLYING spot, which is
 * fine for a live proxy price but wrong as history: charting NIFTY spot on a
 * NIFTY futures contract would be presenting one instrument's past as another's.
 * upstoxBackfill refuses spot-proxy history for exactly this reason, and so do
 * we. A futures chart stays empty until Upstox is reachable, which is honest.
 */
const Candle = require('../models/Candle');
const Instrument = require('../models/Instrument');
const { TF_MS } = require('./candleService');

const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
// Runs inside the chart request; Yahoo answers in ~300ms, so 8s is already
// generous and 12s was just a longer stall on a bad day.
const TIMEOUT_MS = 8000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Our timeframe → Yahoo [interval, range]. Yahoo caps intraday history hard:
// 1m only reaches ~7 days, and 5m–1h about 60. Asking beyond the cap returns an
// error rather than a truncated series, so each range sits inside its limit.
// 4h is absent from Yahoo's interval list entirely — omitted rather than faked
// from a different interval.
const YH_TF = {
  '1m': ['1m', '5d'],
  '5m': ['5m', '1mo'],
  '15m': ['15m', '1mo'],
  '30m': ['30m', '1mo'],
  '1h': ['1h', '3mo'],
  '1d': ['1d', '2y'],
  '1w': ['1wk', '5y'],
};

const INDIAN_EXCH = ['NSE', 'BSE'];
const ENOUGH = 120;                       // already have this many → nothing to do
const RECENT_TTL_MS = 6 * 60 * 60 * 1000; // never re-attempt the same (symbol,tf) within 6h
const _recent = new Map();
const _inflight = new Set();

/** Equities and indices only — see the header. Returns null for anything else. */
function _yahooTicker(inst) {
  if (inst.segment === 'EQ') {
    return `${inst.symbol}${inst.exchange === 'BSE' ? '.BO' : '.NS'}`;
  }
  // Cash index: seeded with segment null and underlying === its own symbol.
  if (!inst.segment) {
    try {
      const sym = require('./yahooFeed').spotSymbol(inst);
      // Only accept a real index ticker (^NSEI …). A bare "<U>.NS" fallback here
      // would silently be an equity lookup for something that is not one.
      return sym && sym.startsWith('^') ? sym : null;
    } catch (_) { return null; }
  }
  return null; // FUT / OPT / MCX — spot proxy would be the wrong instrument
}

async function _backfillOne(inst, tf) {
  const ticker = _yahooTicker(inst);
  if (!ticker || !YH_TF[tf]) return 0;
  const [interval, range] = YH_TF[tf];
  const url = `${BASE}/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`;

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let j;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    j = await res.json();
  } finally { clearTimeout(t); }

  const r = j && j.chart && j.chart.result && j.chart.result[0];
  const ts = r && r.timestamp;
  const q = r && r.indicators && r.indicators.quote && r.indicators.quote[0];
  if (!Array.isArray(ts) || !q) return 0;

  const tfMs = TF_MS[tf];
  const ops = [];
  for (let i = 0; i < ts.length; i += 1) {
    // Yahoo pads every array to the same length and uses null for gaps (halts,
    // holidays, the not-yet-closed bar). A null OHLC would upsert a candle of
    // NaNs that the chart cannot draw, so skip those rows entirely.
    const o = q.open && q.open[i];
    const h = q.high && q.high[i];
    const l = q.low && q.low[i];
    const c = q.close && q.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    const openTime = new Date(ts[i] * 1000);
    ops.push({
      updateOne: {
        filter: { symbol: inst.symbol, timeframe: tf, openTime },
        update: {
          $set: {
            symbol: inst.symbol, timeframe: tf, openTime,
            closeTime: new Date(openTime.getTime() + tfMs),
            open: String(o), high: String(h), low: String(l), close: String(c),
            volume: String((q.volume && q.volume[i]) != null ? q.volume[i] : '0'),
          },
        },
        upsert: true,
      },
    });
  }
  if (!ops.length) return 0;
  try { await Candle.bulkWrite(ops, { ordered: false }); }
  catch (e) { if (e.code !== 11000) throw e; } // dup-key race with the live feed is harmless
  return ops.length;
}

/**
 * Lazily seed history for (symbol, tf) from Yahoo. Safe to call on every chart
 * open — deduped, TTL-guarded, and never throws.
 */
async function ensureHistory(symbol, tf) {
  try {
    if (!YH_TF[tf]) return;
    const rkey = `${symbol}:${tf}`;
    if (_inflight.has(rkey)) return;
    const last = _recent.get(rkey);
    if (last && Date.now() - last < RECENT_TTL_MS) return;

    const inst = await Instrument.findOne({ symbol })
      .select('symbol exchange segment underlying isin').lean();
    if (!inst || !INDIAN_EXCH.includes(inst.exchange)) return;
    if (!_yahooTicker(inst)) return; // derivative — see the header

    const count = await Candle.countDocuments({ symbol, timeframe: tf });
    if (count >= ENOUGH) { _recent.set(rkey, Date.now()); return; }

    _inflight.add(rkey);
    try {
      const n = await _backfillOne(inst, tf);
      if (n) console.log(`[YahooBackfill] ${symbol} ${tf}: +${n} historical candles`);
    } finally {
      // Recorded on failure too — see upstoxBackfill. A source that cannot
      // deliver must stop being asked on every chart open.
      _recent.set(rkey, Date.now());
      _inflight.delete(rkey);
    }
  } catch (e) {
    console.error(`[YahooBackfill] ${symbol} ${tf} failed:`, e.message);
  }
}

/** Explicit backfill for a script — all or selected timeframes. */
async function backfillInstrument(symbol, { timeframes } = {}) {
  const inst = await Instrument.findOne({ symbol })
    .select('symbol exchange segment underlying isin').lean();
  if (!inst) throw new Error(`no instrument ${symbol}`);
  let total = 0;
  for (const tf of (timeframes || Object.keys(YH_TF))) {
    try { total += await _backfillOne(inst, tf); }
    catch (e) { console.error(`[YahooBackfill] ${symbol} ${tf}: ${e.message}`); }
  }
  return total;
}

module.exports = { ensureHistory, backfillInstrument, _yahooTicker };
