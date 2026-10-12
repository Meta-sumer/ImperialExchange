/**
 * upstoxBackfill.js — seed REAL historical candles for Indian instruments from
 * Upstox's FREE historical-candle API, so a chart shows past data immediately
 * instead of only what the live feed has aggregated since it started (which left
 * everything empty during the 44-day token outage + for freshly-added contracts).
 *
 * Mirrors binanceBackfill (crypto) but for the Indian side: same Candle shape,
 * same idempotent upsert by (symbol, timeframe, openTime).
 *
 * Trigger: LAZY, on chart-open. instrumentController.candles calls ensureHistory
 * (symbol, tf) before serving — the first time an under-populated Indian chart is
 * opened, its history is fetched once from Upstox and cached; subsequent opens
 * hit the DB. Deduped per (symbol,tf) with a TTL so we never hammer the API.
 *
 * Coverage (needs a DIRECT real Upstox key — no misleading spot-proxy history):
 *   NSE/BSE equity  → NSE_EQ|<ISIN>
 *   Index           → NSE_INDEX|Nifty 50 … (via upstoxFeed.spotKeyFor)
 *   F&O / MCX        → inst.upstoxKey (only if mapped; unmapped contracts skipped)
 */
const Candle = require('../models/Candle');
const Instrument = require('../models/Instrument');
const { TF_MS } = require('./candleService');

const BASE = 'https://api.upstox.com';
// This runs INSIDE the chart request, so the ceiling is what a user will wait
// for a chart, not what a batch job can tolerate.
const TIMEOUT_MS = 8000;

// Our timeframe → Upstox v3 historical (unit, interval). v3 supports custom
// minute/hour intervals (v2 only did 1minute/30minute/day/week/month).
const UP_TF = {
  '1m': ['minutes', 1], '5m': ['minutes', 5], '15m': ['minutes', 15], '30m': ['minutes', 30],
  '1h': ['hours', 1], '4h': ['hours', 4], '1d': ['days', 1], '1w': ['weeks', 1],
};
// How far back to request per timeframe (kept modest for intraday — Upstox caps
// minute history; a few hundred candles is all the chart's default window needs).
const RANGE_DAYS = { '1m': 30, '5m': 60, '15m': 90, '30m': 90, '1h': 180, '4h': 365, '1d': 1095, '1w': 1825 };

const INDIAN_EXCH = ['NSE', 'BSE', 'NFO', 'BFO', 'MCX'];
const ENOUGH = 120;                       // already have this many candles → skip
const RECENT_TTL_MS = 6 * 60 * 60 * 1000; // don't re-backfill same (symbol,tf) within 6h
const _recent = new Map();                // `${symbol}:${tf}` -> lastAttempt ms
const _inflight = new Set();

const _dateStr = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);

// A DIRECT Upstox instrument_key (real contract/equity/index) — never a
// spot-proxy, since proxy history would be wrong for the actual instrument.
function _directKey(inst) {
  if (inst.segment === 'EQ') {
    return inst.isin ? `${inst.exchange === 'BSE' ? 'BSE_EQ' : 'NSE_EQ'}|${inst.isin}` : null;
  }
  if (inst.upstoxKey) return inst.upstoxKey; // real F&O / MCX contract
  // Index underlyings (underlying=self) resolve to a real index key via the feed's map.
  let k = null;
  try { k = require('./upstoxFeed').spotKeyFor(inst, null); } catch (_) { /* */ }
  return (k && /_INDEX\|/.test(k)) ? k : null; // accept index keys only
}

// Fetch + upsert one instrument's history for one timeframe. Returns #candles.
async function _backfillOne(inst, tf) {
  const key = _directKey(inst);
  if (!key || !UP_TF[tf]) return 0;
  const [unit, interval] = UP_TF[tf];
  const url = `${BASE}/v3/historical-candle/${encodeURIComponent(key)}/${unit}/${interval}/${_dateStr(0)}/${_dateStr(RANGE_DAYS[tf] || 90)}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let j;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.UPSTOX_ACCESS_TOKEN}`, Accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    j = await res.json();
  } finally { clearTimeout(t); }

  const candles = j && j.data && Array.isArray(j.data.candles) ? j.data.candles : [];
  if (!candles.length) return 0;
  const tfMs = TF_MS[tf];
  // Upstox candle row: [ ISOtimestamp, open, high, low, close, volume, oi ]
  const ops = candles.map((c) => {
    const openTime = new Date(c[0]);
    return {
      updateOne: {
        filter: { symbol: inst.symbol, timeframe: tf, openTime },
        update: {
          $set: {
            symbol: inst.symbol, timeframe: tf, openTime,
            closeTime: new Date(openTime.getTime() + tfMs),
            open: String(c[1]), high: String(c[2]), low: String(c[3]), close: String(c[4]),
            volume: String(c[5] != null ? c[5] : '0'),
          },
        },
        upsert: true,
      },
    };
  });
  try { await Candle.bulkWrite(ops, { ordered: false }); }
  catch (e) { if (e.code !== 11000) throw e; } // dup-key race with the live feed is harmless
  return ops.length;
}

/**
 * Lazily ensure an Indian instrument's chart has real history for `tf`. Safe to
 * call on every chart open — deduped, guarded, best-effort (never throws).
 */
async function ensureHistory(symbol, tf) {
  try {
    if (!UP_TF[tf]) return;
    if ((process.env.INDIAN_FEED || '').toLowerCase() !== 'upstox') return; // Upstox is the Indian source
    // A present-but-malformed token is worse than a missing one: it passes the
    // check above and then 401s on every request. An Upstox token is a JWT, so a
    // value that is not three dot-separated segments cannot possibly work — skip
    // it here rather than paying a network round trip to be told so.
    const _tok = process.env.UPSTOX_ACCESS_TOKEN;
    if (!_tok || String(_tok).split('.').length !== 3) return;
    const rkey = `${symbol}:${tf}`;
    if (_inflight.has(rkey)) return;
    const last = _recent.get(rkey);
    if (last && Date.now() - last < RECENT_TTL_MS) return;

    const inst = await Instrument.findOne({ symbol })
      .select('symbol exchange segment isin upstoxKey').lean();
    if (!inst || !INDIAN_EXCH.includes(inst.exchange)) return; // only Indian instruments

    // Already have plenty of candles for this tf → nothing to backfill.
    const count = await Candle.countDocuments({ symbol, timeframe: tf });
    if (count >= ENOUGH) { _recent.set(rkey, Date.now()); return; }

    _inflight.add(rkey);
    try {
      const n = await _backfillOne(inst, tf);
      if (n) console.log(`[UpstoxBackfill] ${symbol} ${tf}: +${n} historical candles`);
    } finally {
      // Record the attempt whether it SUCCEEDED OR FAILED. This used to sit
      // inside the try after the fetch, so a throw skipped it entirely and the
      // TTL never engaged — with a dead token every chart open re-ran two DB
      // queries and a doomed HTTP call that could hang for the full timeout.
      // A failing source must back off exactly like a succeeding one.
      _recent.set(rkey, Date.now());
      _inflight.delete(rkey);
    }
  } catch (e) {
    console.error(`[UpstoxBackfill] ${symbol} ${tf} failed:`, e.message);
  }
}

// Explicit full-instrument backfill (all/selected timeframes) — for a script.
async function backfillInstrument(symbol, { timeframes } = {}) {
  const inst = await Instrument.findOne({ symbol })
    .select('symbol exchange segment isin upstoxKey').lean();
  if (!inst) throw new Error(`no instrument ${symbol}`);
  let total = 0;
  for (const tf of (timeframes || Object.keys(UP_TF))) {
    try { total += await _backfillOne(inst, tf); } catch (e) { console.error(`[UpstoxBackfill] ${symbol} ${tf}: ${e.message}`); }
  }
  return total;
}

module.exports = { ensureHistory, backfillInstrument };
