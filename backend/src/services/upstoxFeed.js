/**
 * upstoxFeed.js — FREE real-time-ish live prices for Indian instruments via the
 * Upstox Market-Quote API. Upstox does NOT charge for market data (unlike Dhan's
 * paid Data API), so this gives real exchange prices for ₹0 — at the cost of a
 * DAILY access token (Upstox tokens expire ~03:30 IST every day; regenerate &
 * update UPSTOX_ACCESS_TOKEN, then restart / it picks up on next poll).
 *
 * Coverage (mirrors yahooFeed):
 *   NSE/BSE equity      → real LTP via instrument key  NSE_EQ|<ISIN>
 *   Index underlyings   → real LTP                     NSE_INDEX|Nifty 50 …
 *   Futures             → underlying-spot proxy
 *   Options             → intrinsic value (floored)
 * (Real F&O contract prices need Upstox's own instrument tokens — a separate
 *  master-file mapping — so derivatives use the spot-proxy for now.)
 *
 * Equity keys use the ISIN imported from Dhan's scrip master (Instrument.isin),
 * so run the importer/sync once after adding ISIN before enabling this feed.
 *
 * Enabled when INDIAN_FEED=upstox.
 *
 * Env:
 *   INDIAN_FEED=upstox
 *   UPSTOX_ACCESS_TOKEN=...     (daily OAuth token)
 *   UPSTOX_POLL_MS=1500
 */
const Instrument = require('../models/Instrument');
const { updateCandlesForTrade } = require('./candleService');

const BASE = 'https://api.upstox.com';
const POLL_MS = Number(process.env.UPSTOX_POLL_MS) || 1500;
const TIMEOUT_MS = Number(process.env.UPSTOX_TIMEOUT_MS) || 7000;
const CHUNK = 500; // Upstox LTP accepts up to ~500 instrument keys / request

// Underlying → Upstox index instrument_key.
const INDEX_UP = {
  NIFTY: 'NSE_INDEX|Nifty 50', 'NIFTY 50': 'NSE_INDEX|Nifty 50',
  BANKNIFTY: 'NSE_INDEX|Nifty Bank', 'NIFTY BANK': 'NSE_INDEX|Nifty Bank',
  FINNIFTY: 'NSE_INDEX|Nifty Fin Service', 'NIFTY FIN SERVICE': 'NSE_INDEX|Nifty Fin Service',
  MIDCPNIFTY: 'NSE_INDEX|Nifty Midcap 50',
  SENSEX: 'BSE_INDEX|SENSEX',
};

let broadcaster = null;
let active = false;
let _timer = null;

// The instrument list, cached between polls.
//
// _pollOnce re-read every Indian instrument on EVERY poll — measured at 1.3-3.0
// seconds against the live cluster, at a poll interval of 1500ms. No index
// covers {exchange, isActive, marketDataEnabled}, and the $in spans every
// Indian exchange so it matches most of the collection anyway, which is why it
// costs a scan rather than a lookup. That was the feed spending the majority of
// each cycle waiting on MongoDB before it ever spoke to Upstox — and it is a
// meaningful slice of the load on a cluster that had already auto-scaled once.
//
// What it returns only changes when an admin edits an instrument or the daily
// F&O import runs, so a short TTL costs nothing. lastPrice is the one field
// that moves every poll, and the cached objects are updated in place after each
// price write below, so the skip-unchanged comparison stays exact.
const INST_TTL_MS = Number(process.env.UPSTOX_INSTRUMENT_TTL_MS) || 60000;

// How often to refresh feedUpdatedAt for instruments whose price has not moved.
// Must stay well under feedGuard's FEED_STALE_MS (10s default) or quiet
// instruments become untradeable between heartbeats.
const HEARTBEAT_MS = Number(process.env.UPSTOX_HEARTBEAT_MS) || 4000;
let _lastHeartbeatAt = 0;
let _instCache = null;
let _instCacheAt = 0;
// Also clears the heartbeat clock: the instrument set is being re-read, so the
// next poll starts from a clean slate rather than inheriting a throttle set by
// whatever the previous set contained.
const invalidateInstruments = () => { _instCache = null; _instCacheAt = 0; _lastHeartbeatAt = 0; };

const setBroadcaster = (b) => { broadcaster = b; };

function _enabled() {
  return (process.env.INDIAN_FEED || '').toLowerCase() === 'upstox';
}
const _tokenPresent = () => !!process.env.UPSTOX_ACCESS_TOKEN;

// Upstox instrument key for an instrument's underlying spot.
function spotKeyFor(inst, isinBySym) {
  if (inst.segment === 'EQ') {
    if (!inst.isin) return null;
    return `${inst.exchange === 'BSE' ? 'BSE_EQ' : 'NSE_EQ'}|${inst.isin}`;
  }
  const u = String(inst.underlying || '').toUpperCase();
  if (!u) return null;
  if (INDEX_UP[u]) return INDEX_UP[u];
  const isin = isinBySym && isinBySym.get(u); // stock-derivative underlying
  return isin ? `NSE_EQ|${isin}` : null;
}

// Live key + how to read its price. 'direct' = the key IS this instrument's own
// contract (EQ via ISIN, or an F&O contract mapped to its Upstox key) → use the
// price as-is. 'spot' = underlying spot for an F&O without a mapped key →
// priceFor() derives a proxy (FUT) / intrinsic (OPT).
function feedKeyFor(inst, isinBySym) {
  if (inst.segment === 'EQ') {
    const k = spotKeyFor(inst, isinBySym);
    return k ? { key: k, mode: 'direct' } : { key: null };
  }
  if (inst.upstoxKey) return { key: inst.upstoxKey, mode: 'direct' }; // real F&O premium
  const k = spotKeyFor(inst, isinBySym);
  return k ? { key: k, mode: 'spot' } : { key: null };
}

// Derive an instrument's price from its underlying spot (same rules as yahooFeed).
function priceFor(inst, spot) {
  if (spot == null) return null;
  return spot;
}

// Rotates which chunk goes FIRST each round. Chunks were always built and
// requested in the same order, so the instruments at the tail of the list were
// always asked last and were always the first to be dropped when a round broke
// early. MCX contracts roll monthly and each new month appends to the end, so
// the newest contracts were reliably the hungriest.
let _chunkCursor = 0;

// Fetch LTP for a list of instrument keys → Map(key → price).
async function _ltp(keys) {
  const out = new Map();
  const total = Math.ceil(keys.length / CHUNK) || 0;
  let failed = 0;
  let lastErr = null;
  for (let n = 0; n < total; n += 1) {
    const i = (((_chunkCursor + n) % total) * CHUNK);
    const chunk = keys.slice(i, i + CHUNK);
    const url = `${BASE}/v2/market-quote/ltp?instrument_key=${encodeURIComponent(chunk.join(','))}`;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.UPSTOX_ACCESS_TOKEN}`, Accept: 'application/json' },
        signal: ctl.signal,
      });
      if (res.status === 401) throw new Error('401 — UPSTOX_ACCESS_TOKEN rejected (expired, revoked, or wrong app)');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const data = (j && j.data) || {};
      for (const v of Object.values(data)) {
        const k = v && v.instrument_token;            // echoes the key we sent
        const px = v && (v.last_price != null ? v.last_price : v.ltp);
        if (k && px != null) out.set(k, Number(px));
      }
    } catch (e) {
      // One bad chunk must NOT abandon the round. This was a try/finally with no
      // catch, so a single timeout or HTTP 500 threw straight out of _ltp and
      // every instrument in every LATER chunk went unasked that round — combined
      // with the fixed chunk order above, the same symbols starved every time.
      // It also failed the whole poll, so a partial provider hiccup looked
      // identical to a total outage.
      failed += 1;
      lastErr = e;
    } finally { clearTimeout(t); }
  }
  _chunkCursor = total ? (_chunkCursor + 1) % total : 0;

  // Every chunk failing IS a real outage — rethrow so the 401 self-heal and the
  // supervisor still fire. A partial failure keeps what it got and says so.
  if (total && failed === total) throw lastErr;
  if (failed) console.warn(`[Upstox] ${failed}/${total} chunks failed this round — kept ${out.size} prices`);
  return out;
}

// Bounded-concurrency map (keeps candle writes from running all-at-once).
async function _mapPool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  });
  await Promise.all(workers);
}

async function _pollOnce() {
  let insts = _instCache;
  if (!insts || Date.now() - _instCacheAt >= INST_TTL_MS) {
    insts = await Instrument.find({
      exchange: { $in: ['NSE', 'BSE', 'NFO', 'BFO', 'MCX'] }, isActive: true, marketDataEnabled: { $ne: false },
    }).select('_id symbol exchange segment underlying isin upstoxKey pricePrecision tickSize lastPrice').lean();
    _instCache = insts;
    _instCacheAt = Date.now();
  }
  // Both of these used to return silently, and _loop then reported the poll as
  // healthy — so a feed fetching nothing looked identical to a feed working
  // perfectly. Health is no longer reported for either path; say why, once it
  // matters, rather than leaving an operator to infer it from missing prices.
  if (!insts.length) {
    console.warn('[Upstox] no active Indian instruments matched — nothing to price.');
    return;
  }

  const isinBySym = new Map();
  for (const i of insts) if (i.segment === 'EQ' && i.isin) isinBySym.set(i.symbol, i.isin);

  const keyFor = new Map();
  const uniq = new Set();
  for (const i of insts) {
    const m = feedKeyFor(i, isinBySym);
    keyFor.set(String(i._id), m);
    if (m.key) uniq.add(m.key);
  }
  if (!uniq.size) {
    // Every instrument failed to resolve a quote key: equities need `isin`,
    // F&O contracts need `upstoxKey` (scripts/map-upstox-fno.js stamps it), and
    // indices need `underlying` to match INDEX_UP. This is a data problem and
    // the feed cannot price anything until it is fixed.
    console.warn(`[Upstox] none of ${insts.length} instruments resolved a quote key — check isin / upstoxKey / underlying.`);
    return;
  }

  const priceByKey = await _ltp([...uniq]);

  // Upstox has answered. Report health HERE, not after the poll finishes.
  //
  // This used to be reported once by _loop, after everything below had run —
  // and everything below includes a candle write for every instrument whose
  // price moved. At ~3.4k moving instruments, eight timeframes each, twelve at
  // a time over a link with ~19ms of latency, that phase alone runs ~40s. The
  // supervisor gives up after HEALTHY_MS (45s) without a success, so it kept
  // declaring the feed DOWN in the middle of a poll that was going perfectly
  // well, switching Indian prices to the Yahoo fallback, and then switching
  // back when the poll finally reported in. Every flip changed where prices
  // came from, which is what chopped up the charts.
  //
  // Upstox's health is whether Upstox answered — it did, in 34ms — not how
  // long OUR database takes afterwards. Those are different facts and only one
  // of them is the supervisor's business.
  try { require('./indianFeedSupervisor').reportUpstox(true); } catch (_) {}

  // Only touch instruments whose price actually CHANGED — bulk-write the price
  // updates (one op, not ~6k sequential writes), then candle + broadcast for the
  // changed ones. Most options' intrinsic is stable → skipped → cycle stays fast.
  const now = new Date();
  const bulk = [];
  const changed = [];
  const quiet = [];   // answered for, but price unchanged — see the heartbeat below
  for (const i of insts) {
    const m = keyFor.get(String(i._id));
    const raw = m && m.key ? priceByKey.get(m.key) : null;
    // direct = real contract/equity price as-is; spot = derive proxy/intrinsic.
    const px = raw == null ? null : (m.mode === 'direct' ? raw : priceFor(i, raw));
    if (px == null) continue;
    const priceStr = Number(px).toFixed(i.pricePrecision || 2);
    if (priceStr === String(i.lastPrice)) {
      // Unchanged price: no candle, no price write — but the feed DID answer for
      // this instrument, and that has to be recorded. See the heartbeat below.
      quiet.push(i._id);
      continue;
    }
    bulk.push({ updateOne: { filter: { _id: i._id }, update: { $set: {
      prevPrice: String(i.lastPrice ?? '0'), lastPrice: priceStr, lastPriceUpdatedAt: now, feedUpdatedAt: now,
      // This branch is only reached when the price CHANGED (unchanged ticks
      // are skipped above), so stamping unconditionally is correct here.
      priceChangedAt: now,
    } } } });
    changed.push([i, priceStr]);
  }
  // ── Feed heartbeat ───────────────────────────────────────────────────
  // `feedUpdatedAt` means "a market-data feed answered for this instrument",
  // NOT "the price moved" — utils/feedGuard reads it to decide whether a B-book
  // fill is executing against a live feed or a dead one, and rejects the order
  // with STALE_FEED once it is older than FEED_STALE_MS (10s by default).
  //
  // This feed skipped it entirely for an unchanged price, so a quiet instrument
  // looked identical to a dead feed and became untradeable after ten seconds of
  // not moving — on a feed polling perfectly well every 1500ms. The guard's own
  // comment says a quiet minute must not block trading, and `priceChangedAt`
  // already exists to carry the "has it moved" question separately. Every other
  // feed here (angel, dhan, finnhub, twelveData, yahoo, oanda) stamps
  // feedUpdatedAt on every tick and advances priceChangedAt only on a change;
  // this one was the exception.
  //
  // Throttled rather than written every poll: one updateMany every few seconds
  // keeps these comfortably inside the staleness window without adding a write
  // for every instrument to every 1500ms cycle.
  if (quiet.length && Date.now() - _lastHeartbeatAt >= HEARTBEAT_MS) {
    _lastHeartbeatAt = Date.now();
    try {
      await Instrument.updateMany({ _id: { $in: quiet } }, { $set: { feedUpdatedAt: now } });
    } catch (e) { console.warn('[Upstox] feed heartbeat failed:', e.message); }
  }

  // NOTE: this return sits AFTER the heartbeat on purpose. A completely still
  // market produces an empty `bulk`, and returning first would skip the
  // heartbeat in precisely the case it exists for.
  if (!bulk.length) return;
  for (let b = 0; b < bulk.length; b += 1000) await Instrument.bulkWrite(bulk.slice(b, b + 1000), { ordered: false });
  // Mirror the write onto the cached documents. Without this the next poll
  // would compare each new price against the price from whenever the cache was
  // filled, decide every instrument had "changed", and write the whole universe
  // of candles again every cycle. Done after the bulkWrite, because the ops
  // above read the previous value for prevPrice.
  for (const [i, priceStr] of changed) i.lastPrice = priceStr;
  // Candle writes are the per-cycle bottleneck (one DB upsert each) — run them
  // with bounded concurrency instead of sequentially so the cycle stays snappy.
  await _mapPool(changed, 12, async ([i, priceStr]) => {
    // Options get candles for INTRADAY timeframes only (1m/5m/15m) — they're
    // short-lived and there are ~thousands, so writing all 8 ×each contract
    // overloads a small box. Equities/futures keep the full timeframe set.
    const tfs = i.segment === 'OPT' ? ['1m', '5m', '15m'] : undefined;
    try { await updateCandlesForTrade({ symbol: i.symbol, price: priceStr, quantity: '0', ts: Date.now(), timeframes: tfs }); } catch (_) { /* */ }
    if (broadcaster) broadcaster.publish(`ticker:${i.symbol}`, { lastPrice: priceStr, ts: Date.now(), source: 'UPSTOX' });
  });
  try { require('./feedOrchestrator').recordTick('UPSTOX'); } catch (_) {}
}

async function _loop() {
  if (!active) return;
  let open = true;
  // Poll while EITHER NSE (09:15–15:30) or MCX (09:00–23:30) is open, so MCX
  // commodity futures keep pricing through their evening session — not just
  // during NSE hours. _pollOnce covers both exchanges in one query.
  try {
    const mh = require('./marketHours');
    open = mh.isExchangeOpen('NSE') || mh.isExchangeOpen('MCX');
  } catch (_) { /* default open */ }
  if (open) {
    try {
      await _pollOnce();
      try { require('./feedOrchestrator').recordConnection('UPSTOX', true); } catch (_) {}
      // Health is NOT reported here. _pollOnce reports it the moment Upstox
      // answers, which is both earlier (so a slow candle-write phase cannot look
      // like an outage) and stricter: _pollOnce has early returns for "no
      // instruments" and "no resolvable quote keys", and reporting success out
      // here counted those as healthy polls. A poll that fetched nothing is not
      // a healthy poll, and calling it one produced the phantom RECOVERED that
      // hid this for so long.
    } catch (e) {
      console.error('[Upstox] poll error:', e.message);
      try { require('./feedOrchestrator').recordError('UPSTOX', e); } catch (_) {}
      try { require('./indianFeedSupervisor').reportUpstox(false, e.message); } catch (_) {}
      // Token died mid-session → self-heal (throttled) so we don't wait for the
      // daily refresh. Non-401 errors (network) don't trigger a re-login.
      if (/401/.test(e.message || '')) { try { require('./upstoxAuth').maybeReactiveRefresh(); } catch (_) {} }
    }
  }
  _timer = setTimeout(_loop, open ? POLL_MS : 60000);
}

const start = () => {
  if (!_enabled()) return; // only when INDIAN_FEED=upstox
  if (!_tokenPresent()) {
    console.log('[Upstox] INDIAN_FEED=upstox but no UPSTOX_ACCESS_TOKEN — Indian feed disabled (set the daily token).');
    return;
  }
  if (active) return;
  active = true;
  console.log(`[Upstox] starting FREE real-time Indian feed (poll ${POLL_MS}ms, NSE+MCX session-gated)`);
  _loop().catch((e) => console.error('[Upstox] start error:', e.message));
};

const stop = () => { active = false; if (_timer) { clearTimeout(_timer); _timer = null; } };

module.exports = { start, stop, setBroadcaster, isActive: () => active, _enabled, spotKeyFor, feedKeyFor, priceFor, invalidateInstruments, _pollOnce };
