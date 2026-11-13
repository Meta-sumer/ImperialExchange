/**
 * yahooFeed.js — FREE live-price feed for Indian instruments via Yahoo Finance.
 * No API key. The zero-cost alternative to the paid Dhan Data API: since this is
 * a B-book (we never route real orders), we only need market DATA, not trading.
 *
 * Coverage:
 *   NSE / BSE equity      → real LTP           (RELIANCE.NS, TCS.NS, …)
 *   Index F&O underlying  → real index LTP     (NIFTY→^NSEI, BANKNIFTY→^NSEBANK)
 *   Futures               → underlying spot    (proxy — B-book approximation)

 *                            NO time value — Yahoo has no NSE option premiums, so
 *                            this only verifies the plumbing, not real pricing.
 *
 * Strategy: fetch each UNIQUE underlying spot once per cycle from Yahoo's public
 * v8 chart endpoint (no crumb needed — just a browser User-Agent), then derive
 * every instrument's price from that spot. Session-gated to NSE hours.
 *
 * Enabled when:  INDIAN_FEED=yahoo,  OR  (no Dhan creds AND INDIAN_FEED!=dhan).
 *
 * Env:
 *   INDIAN_FEED=yahoo|dhan      force a provider (default: auto)
 *   YAHOO_POLL_MS=5000
 *   YAHOO_MAX_SYMBOLS=300       safety cap on unique Yahoo requests / cycle
 *   YAHOO_CONCURRENCY=5
 */
const Instrument = require('../models/Instrument');
const { updateCandlesForTrade } = require('./candleService');
const { derivedPrice } = require('../utils/derivedPrice');

const POLL_MS = Number(process.env.YAHOO_POLL_MS) || 5000;
// Indices (NIFTY, BANKNIFTY, …) and the derived MCX rows run on their own fast
// loop: one batched request every FAST_MS instead of waiting behind the ~200
// stock requests of the slow loop (which left them 6–13 s apart).
const FAST_MS = Number(process.env.YAHOO_FAST_MS) || 1500;
const TIMEOUT_MS = Number(process.env.YAHOO_TIMEOUT_MS) || 7000;
// The whole NSE cash universe is ~3,000 scrips; batched 20 per request that is
// ~150 requests a cycle, fewer than the one-per-symbol polling of 200 stocks.
const MAX = Number(process.env.YAHOO_MAX_SYMBOLS) || 4000;
const CONC = Number(process.env.YAHOO_CONCURRENCY) || 8;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Underlying → Yahoo index ticker. Unknown underlyings fall back to `<U>.NS`.
const INDEX_YH = {
  NIFTY: '^NSEI', 'NIFTY 50': '^NSEI', NIFTY50: '^NSEI',
  BANKNIFTY: '^NSEBANK', 'NIFTY BANK': '^NSEBANK',
  FINNIFTY: '^CNXFIN', 'NIFTY FIN SERVICE': '^CNXFIN',
  MIDCPNIFTY: '^NSEMDCP50',
  SENSEX: '^BSESN',
};

let broadcaster = null;
let active = false;
let _timer = null;
let _fastTimer = null;
let _warnedCap = false;
// Fallback override: when Upstox (the primary Indian feed) dies, the
// indianFeedSupervisor flips this ON so Yahoo starts pricing Indian instruments
// even though INDIAN_FEED=upstox. Flipped OFF again when Upstox recovers.
let _indianFallback = false;

const setBroadcaster = (b) => { broadcaster = b; };

// Called by indianFeedSupervisor to engage/disengage Yahoo as the Indian feed.
const setIndianFallback = (on) => {
  _indianFallback = !!on;
  console.log(_indianFallback
    ? '[Yahoo] Indian FALLBACK engaged (Upstox down) — pricing NSE/BSE/F&O via Yahoo.'
    : '[Yahoo] Indian fallback disengaged — Upstox is primary again.');
};

function _enabled() {
  const f = (process.env.INDIAN_FEED || '').toLowerCase();
  if (f === 'yahoo') return true;
  if (f === 'dhan' || f === 'upstox') return false;
  return !(process.env.DHAN_CLIENT_ID && process.env.DHAN_ACCESS_TOKEN); // auto
}

// Yahoo spot ticker for an instrument's underlying (null if underivable).
function spotSymbol(inst) {
  if (inst.segment === 'EQ') return `${inst.symbol}${inst.exchange === 'BSE' ? '.BO' : '.NS'}`;
  const u = String(inst.underlying || '').toUpperCase();
  if (!u) return null;
  return INDEX_YH[u] || `${u}.NS`;
}

// Derive an instrument's price from its underlying spot.
function priceFor(inst, spot) {
  if (spot == null) return null;
  return spot;
}

async function _yahooQuote(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    const m = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
    if (!m) return null;
    const px = m.regularMarketPrice != null ? m.regularMarketPrice : m.previousClose;
    return px != null ? Number(px) : null;
  } catch (_) {
    return null;
  } finally { clearTimeout(t); }
}

// Many symbols in one request through Yahoo's spark endpoint (no crumb, a
// browser User-Agent is enough), up to 20 per call, CONC calls at a time.
// Yahoo answers in one of two shapes and has switched between them:
//   { spark: { result: [{ symbol, response: [{ meta, indicators }] }] } }
//   { "<SYM>": { symbol, close: [...], previousClose, chartPreviousClose } }
// The live price is meta.regularMarketPrice when present, else the last
// 1-minute close (Yahoo keeps the current bar's close live). A symbol spark
// leaves out is asked once on the per-symbol chart endpoint; one that fails
// there too is not asked again for 10 minutes (delisted / not on Yahoo).
// Returns Map(symbol → price).
const _noQuoteUntil = new Map();
const NO_QUOTE_RETRY_MS = 10 * 60 * 1000;

function _lastClose(closes) {
  if (!Array.isArray(closes)) return null;
  for (let k = closes.length - 1; k >= 0; k -= 1) { if (closes[k] != null) return closes[k]; }
  return null;
}

function _readSpark(j, out) {
  if (j && j.spark && Array.isArray(j.spark.result)) {
    for (const r of j.spark.result) {
      const resp = r && r.response && r.response[0];
      const m = (resp && resp.meta) || {};
      let px = m.regularMarketPrice;
      if (px == null) px = _lastClose(resp && resp.indicators && resp.indicators.quote && resp.indicators.quote[0] && resp.indicators.quote[0].close);
      if (px == null) px = m.previousClose != null ? m.previousClose : m.chartPreviousClose;
      if (r && r.symbol && px != null && Number.isFinite(Number(px))) out.set(r.symbol, Number(px));
    }
    return;
  }
  if (!j || typeof j !== 'object') return;
  for (const [key, v] of Object.entries(j)) {
    if (!v || typeof v !== 'object' || !Array.isArray(v.close)) continue;
    let px = _lastClose(v.close);
    if (px == null) px = v.previousClose != null ? v.previousClose : v.chartPreviousClose;
    if (px != null && Number.isFinite(Number(px))) out.set(v.symbol || key, Number(px));
  }
}

async function _batchQuotes(symbols) {
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < symbols.length; i += 20) chunks.push(symbols.slice(i, i + 20));
  await _mapPool(chunks, CONC, async (chunk) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${chunk.map(encodeURIComponent).join(',')}&range=1d&interval=1m`;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
      if (res.ok) _readSpark(await res.json(), out);
    } catch (_) { /* fall through to per-symbol */ } finally { clearTimeout(t); }
  });
  const now = Date.now();
  const missing = symbols.filter((sym) => !out.has(sym) && !((_noQuoteUntil.get(sym) || 0) > now));
  if (missing.length) {
    for (const [sym, px] of await _mapPool(missing, CONC, async (x) => [x, await _yahooQuote(x)])) {
      if (px != null) { out.set(sym, px); _noQuoteUntil.delete(sym); } else _noQuoteUntil.set(sym, now + NO_QUOTE_RETRY_MS);
    }
  }
  return out;
}

const _isIndexTicker = (sym) => typeof sym === 'string' && sym.startsWith('^');

// Bounded-concurrency map.
async function _mapPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  });
  await Promise.all(workers);
  return out;
}

async function _publishTick(inst, ltp) {
  const price = Number(ltp).toFixed(inst.pricePrecision || 2);
  // Pipeline update: copy the old lastPrice into prevPrice + stamp the
  // feed-exclusive feedUpdatedAt (for the stuck-feed execution guard).
  await Instrument.updateOne({ _id: inst._id }, [{ $set: {
    prevPrice: { $ifNull: ['$lastPrice', '0'] },
    lastPrice: price,
    lastPriceUpdatedAt: '$$NOW',
    feedUpdatedAt: '$$NOW',
    // Only advance when the price genuinely changed — a poll that rewrites
    // the same value on a quiet market must not look like a price move.
    priceChangedAt: { $cond: [
      { $eq: [{ $toString: { $ifNull: ['$lastPrice', ''] } }, String(price)] },
      { $ifNull: ['$priceChangedAt', '$$NOW'] },
      '$$NOW',
    ] },
  } }]);
  try { await updateCandlesForTrade({ symbol: inst.symbol, price, quantity: '0', ts: Date.now() }); } catch (_) { /* */ }
  if (broadcaster) broadcaster.publish(`ticker:${inst.symbol}`, { lastPrice: price, ts: Date.now(), source: 'YAHOO' });
}

// The stock loop's publisher: thousands of rows a cycle, so one bulkWrite for
// the rows whose price changed (same pipeline as _publishTick) and one
// updateMany that only refreshes the feed timestamps of the rest — the stale-
// feed guard reads those, and priceChangedAt stays put so a frozen quote still
// shows as frozen. Candles and the ticker broadcast go out for changed rows only.
const _lastPublished = new Map(); // symbol → price string last written

async function _publishMany(entries) {
  const changed = [];
  const sameIds = [];
  for (const { inst, px } of entries) {
    const price = Number(px).toFixed(inst.pricePrecision || 2);
    if (_lastPublished.get(inst.symbol) === price) sameIds.push(inst._id);
    else changed.push({ inst, price });
  }
  if (changed.length) {
    await Instrument.bulkWrite(changed.map(({ inst, price }) => ({ updateOne: { filter: { _id: inst._id }, update: [{ $set: {
      prevPrice: { $ifNull: ['$lastPrice', '0'] },
      lastPrice: price,
      lastPriceUpdatedAt: '$$NOW',
      feedUpdatedAt: '$$NOW',
      priceChangedAt: { $cond: [
        { $eq: [{ $toString: { $ifNull: ['$lastPrice', ''] } }, String(price)] },
        { $ifNull: ['$priceChangedAt', '$$NOW'] },
        '$$NOW',
      ] },
    } }] } })), { ordered: false });
  }
  if (sameIds.length) {
    await Instrument.updateMany({ _id: { $in: sameIds } }, [{ $set: { lastPriceUpdatedAt: '$$NOW', feedUpdatedAt: '$$NOW' } }]);
  }
  const ts = Date.now();
  for (const { inst, price } of changed) {
    _lastPublished.set(inst.symbol, price);
    try { await updateCandlesForTrade({ symbol: inst.symbol, price, quantity: '0', ts }); } catch (_) { /* */ }
    if (broadcaster) broadcaster.publish(`ticker:${inst.symbol}`, { lastPrice: price, ts, source: 'YAHOO' });
  }
  return changed.length + sameIds.length;
}

async function _pollOnce() {
  const insts = await Instrument.find({
    exchange: { $in: ['NSE', 'BSE', 'NFO', 'BFO'] }, isActive: true, marketDataEnabled: { $ne: false },
  }).select('_id symbol exchange segment underlying pricePrecision tickSize').lean();
  if (!insts.length) return;

  // Map each instrument → its underlying spot symbol; collect the unique set.
  // Index tickers (^NSEI, ^NSEBANK, …) are priced by the fast loop.
  const symFor = new Map();
  const uniq = new Set();
  for (const i of insts) {
    const s = spotSymbol(i);
    if (_isIndexTicker(s)) continue;
    symFor.set(String(i._id), s);
    if (s) uniq.add(s);
  }

  // Indices first, then equities; cap to protect against rate-limit/ban.
  let list = [...uniq];
  if (list.length > MAX) {
    const idx = list.filter((s) => s.startsWith('^'));
    const rest = list.filter((s) => !s.startsWith('^'));
    list = [...idx, ...rest].slice(0, MAX);
    if (!_warnedCap) { console.warn(`[Yahoo] ${uniq.size} symbols > cap ${MAX}; polling first ${MAX}. Raise YAHOO_MAX_SYMBOLS or curate instruments.`); _warnedCap = true; }
  }

  const spotMap = await _batchQuotes(list);

  const entries = [];
  for (const i of insts) {
    if (!symFor.has(String(i._id))) continue;
    const s = symFor.get(String(i._id));
    const px = priceFor(i, s ? spotMap.get(s) : null);
    if (px == null) continue;
    entries.push({ inst: i, px });
  }
  const wrote = entries.length ? await _publishMany(entries) : 0;
  if (wrote) { try { require('./feedOrchestrator').recordTick('YAHOO'); } catch (_) {} }
}

// Global instruments (any asset class) that opt into the FREE Yahoo feed via
// externalProvider='YAHOO' + externalFeedSymbol=<Yahoo ticker>. Examples:
//   stock AAPL · index ^GSPC/^NSEI · forex EURUSD=X · gold GC=F · crypto BTC-USD
// NOT NSE-gated — each ticker's own market decides freshness (Yahoo returns the
// last close outside hours). This is what makes "add from the admin form → live
// price, no API key" work for global forex/stocks/indices/commodities/crypto.
// Returns how many such instruments exist so the loop can idle-back-off.
async function _pollGlobalYahoo(indexInsts = []) {
  const insts = await Instrument.find({
    externalProvider: 'YAHOO', externalFeedSymbol: { $exists: true, $ne: null }, isActive: true, marketDataEnabled: { $ne: false },
  }).select('_id symbol exchange externalFeedSymbol pricePrecision feedConvert').lean();
  if (!insts.length && !indexInsts.length) return 0;
  const uniq = [...new Set(insts.map((i) => String(i.externalFeedSymbol).trim()).filter(Boolean))].slice(0, MAX);
  // Derived rows (MCX commodities) need the USD→INR rate in the same poll.
  if (insts.some((i) => i.feedConvert && i.feedConvert.fx === 'USDINR') && !uniq.includes('INR=X')) uniq.push('INR=X');
  // Indian index rows ride the same batched request.
  for (const i of indexInsts) { const sym = spotSymbol(i); if (sym && !uniq.includes(sym)) uniq.push(sym); }
  const prices = await _batchQuotes(uniq);
  let wrote = 0;
  for (const i of indexInsts) {
    const px = prices.get(spotSymbol(i));
    if (px == null) continue;
    await _publishTick(i, px); wrote += 1;
  }
  const mh = require('./marketHours');
  for (const i of insts) {
    // An exchange-bound derived row (MCX) holds its last price while that
    // exchange is shut, as the real contract does: COMEX keeps trading
    // overnight and on Sunday night, MCX does not.
    if (i.exchange && mh.SESSIONS[i.exchange] && !mh.isExchangeOpen(i.exchange)) continue;
    let px = prices.get(String(i.externalFeedSymbol).trim());
    if (px == null) continue;
    const conv = i.feedConvert || null;
    if (conv && (conv.fx || (conv.multiplier && conv.multiplier !== 1) || Number(conv.adjustPct))) {
      // price(₹) = feed × USDINR × unit multiplier × (1 + adjustPct/100)
      // (services/mcxCommodities.js, utils/derivedPrice.js)
      let fx = 1;
      if (conv.fx === 'USDINR') { fx = prices.get('INR=X'); if (fx == null) continue; }
      px = derivedPrice(px, fx, conv.multiplier, conv.adjustPct);
    }
    await _publishTick(i, px); wrote += 1;   // spot instruments → price is the LTP as-is
  }
  if (wrote) { try { require('./feedOrchestrator').recordTick('YAHOO'); } catch (_) {} }
  return insts.length + indexInsts.length;
}

// Indian index rows (spot ticker ^…), when Yahoo is the Indian feed and NSE is open.
async function _indexInstruments() {
  if (!(_enabled() || _indianFallback)) return [];
  let open = true;
  try { open = require('./marketHours').isExchangeOpen('NSE'); } catch (_) { open = true; }
  if (!open) return [];
  const rows = await Instrument.find({
    exchange: { $in: ['NSE', 'BSE'] }, isActive: true, marketDataEnabled: { $ne: false }, segment: { $ne: 'EQ' },
  }).select('_id symbol exchange segment underlying pricePrecision tickSize').lean();
  return rows.filter((i) => _isIndexTicker(spotSymbol(i)));
}

// The fast loop: indices + derived MCX rows, one batched request per tick.
async function _fastLoop() {
  if (!active) return;
  let n = 0;
  try { n = await _pollGlobalYahoo(await _indexInstruments()); }
  catch (e) { console.error('[Yahoo] fast poll error:', e.message); }
  _fastTimer = setTimeout(_fastLoop, n ? FAST_MS : 60000);
}

async function _loop() {
  if (!active) return;
  // Global YAHOO-provider rows and the index rows are the fast loop's job.
  const globalN = 0;

  // Indian instruments — only when Yahoo is the ACTIVE Indian provider AND
  //    NSE is open (unchanged behaviour; off in prod where INDIAN_FEED=upstox).
  let indianOpen = false;
  const startedAt = Date.now();
  if (_enabled() || _indianFallback) {
    try { indianOpen = require('./marketHours').isExchangeOpen('NSE'); } catch (_) { indianOpen = true; }
    if (indianOpen) {
      try {
        await _pollOnce();
        try { require('./feedOrchestrator').recordConnection('YAHOO', true); } catch (_) {}
      } catch (e) {
        console.error('[Yahoo] poll error:', e.message);
        try { require('./feedOrchestrator').recordError('YAHOO', e); } catch (_) {}
      }
    }
  }
  // A new cycle every POLL_MS measured start to start (a big universe takes a
  // few seconds to fetch, and the stale-feed guard allows 10 s); idle-back-off
  // while nothing is live to poll.
  _timer = setTimeout(_loop, (globalN || indianOpen) ? Math.max(1000, POLL_MS - (Date.now() - startedAt)) : 60000);
}

const start = () => {
  if (active) return;
  active = true;
  console.log(`[Yahoo] FREE feed started (stocks every ${POLL_MS}ms, indices + MCX every ${FAST_MS}ms, no API key) — global via externalProvider=YAHOO; Indian NSE-gated when active.`);
  _fastLoop().catch((e) => console.error('[Yahoo] fast start error:', e.message));
  _loop().catch((e) => console.error('[Yahoo] start error:', e.message));
};

const stop = () => {
  active = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (_fastTimer) { clearTimeout(_fastTimer); _fastTimer = null; }
};

// ─── Fundamentals (real, on-demand) ──────────────────────────────────
// Two sources, both free:
//   1. v8 chart `meta` — reliable, no auth: 52-week hi/lo, prev close,
//      day hi/lo, volume, currency.
//   2. v10 quoteSummary — needs a cookie+crumb: market cap, P/E, EPS,
//      P/B, book value, ROE, dividend yield. Best-effort; if Yahoo blocks
//      the crumb the caller still gets the reliable chart fields.
const _num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
let _crumbCache = { cookie: null, crumb: null, at: 0 };

function _yahooSymbol(inst) {
  if (!inst) return null;
  if (inst.segment === 'EQ') return `${inst.symbol}${inst.exchange === 'BSE' ? '.BO' : '.NS'}`;
  return spotSymbol(inst) || null;
}

async function _fetchJson(url, headers = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; } finally { clearTimeout(t); }
}

async function _getCrumb() {
  // Cache the cookie+crumb for 10 min — it's valid across symbols.
  if (_crumbCache.crumb && (Date.now() - _crumbCache.at) < 10 * 60 * 1000) return _crumbCache;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const c = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, signal: ctl.signal }).catch(() => null);
    const cookie = c && c.headers.get('set-cookie');
    if (!cookie) return { cookie: null, crumb: null };
    const cookieVal = cookie.split(';')[0];
    const r = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookieVal }, signal: ctl.signal }).catch(() => null);
    const crumb = r && r.ok ? (await r.text()).trim() : null;
    if (crumb && crumb.length && !crumb.includes('<')) {
      _crumbCache = { cookie: cookieVal, crumb, at: Date.now() };
      return _crumbCache;
    }
    return { cookie: cookieVal, crumb: null };
  } catch (_) { return { cookie: null, crumb: null }; } finally { clearTimeout(t); }
}

async function getFundamentals(inst) {
  const ySym = _yahooSymbol(inst);
  if (!ySym) return null;
  const out = { yahooSymbol: ySym };

  // 1) Reliable chart meta (no auth).
  const chart = await _fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=1d&range=1y`);
  const m = chart && chart.chart && chart.chart.result && chart.chart.result[0] && chart.chart.result[0].meta;
  if (m) {
    out.currency = m.currency || null;
    out.lastPrice = _num(m.regularMarketPrice);
    out.prevClose = _num(m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose);
    out.dayHigh = _num(m.regularMarketDayHigh);
    out.dayLow = _num(m.regularMarketDayLow);
    out.week52High = _num(m.fiftyTwoWeekHigh);
    out.week52Low = _num(m.fiftyTwoWeekLow);
    out.volume = _num(m.regularMarketVolume);
  }

  // 2) Best-effort quoteSummary (cookie+crumb) for the fundamentals card.
  try {
    const { cookie, crumb } = await _getCrumb();
    if (crumb && cookie) {
      const mods = 'summaryDetail,defaultKeyStatistics,financialData,price,earnings,calendarEvents';
      const j = await _fetchJson(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ySym)}?modules=${mods}&crumb=${encodeURIComponent(crumb)}`,
        { Cookie: cookie }
      );
      const r = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
      if (r) {
        const sd = r.summaryDetail || {}, ks = r.defaultKeyStatistics || {}, fd = r.financialData || {}, pr = r.price || {};
        const raw = (o, k) => (o && o[k] && typeof o[k] === 'object' ? o[k].raw : o && o[k]);
        out.marketCap = _num(raw(pr, 'marketCap') ?? raw(sd, 'marketCap'));
        out.peRatio = _num(raw(sd, 'trailingPE') ?? raw(ks, 'trailingPE'));
        out.eps = _num(raw(ks, 'trailingEps'));
        out.pbRatio = _num(raw(ks, 'priceToBook'));
        out.bookValue = _num(raw(ks, 'bookValue'));
        out.roe = _num(raw(fd, 'returnOnEquity'));
        out.debtToEquity = _num(raw(fd, 'debtToEquity'));
        out.dividendYield = _num(raw(sd, 'dividendYield') ?? raw(sd, 'trailingAnnualDividendYield'));
        out.revenueGrowth = _num(raw(fd, 'revenueGrowth'));
        out.earningsGrowth = _num(raw(fd, 'earningsGrowth'));
        // Quarterly + yearly revenue/profit for the financials chart.
        const er = r.earnings || {};
        const fc = er.financialsChart || {};
        const mapFC = (arr) => (Array.isArray(arr) ? arr : []).map((q) => ({
          label: q && q.date != null ? String(q.date) : '',
          revenue: _num(raw(q, 'revenue')),
          profit: _num(raw(q, 'earnings')),
        })).filter((q) => q.revenue != null || q.profit != null);
        out.finQuarterly = mapFC(fc.quarterly);
        out.finYearly = mapFC(fc.yearly);
        // Upcoming events (earnings / dividend). Yahoo timestamps = seconds.
        const ce = r.calendarEvents || {};
        const ts = (v) => (v != null ? new Date(_num(v) * 1000).toISOString() : null);
        out.earningsDate = ts(ce.earnings && ce.earnings.earningsDate && ce.earnings.earningsDate[0] && raw(ce.earnings.earningsDate[0], 'raw'));
        out.exDividendDate = ts(raw(ce, 'exDividendDate'));
        out.dividendDate = ts(raw(ce, 'dividendDate'));
      }
    }
  } catch (_) { /* keep chart fields */ }

  return out;
}

// Real stock news via Yahoo's public search endpoint (no crumb needed).
async function getNews(inst) {
  const ySym = _yahooSymbol(inst) || (inst && inst.symbol);
  if (!ySym) return [];
  const j = await _fetchJson(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ySym)}&newsCount=10&quotesCount=0&enableFuzzyQuery=false`);
  const news = (j && Array.isArray(j.news)) ? j.news : [];
  return news.map((n) => ({
    title: n.title,
    publisher: n.publisher,
    link: n.link,
    publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
    thumbnail: (n.thumbnail && n.thumbnail.resolutions && n.thumbnail.resolutions[0] && n.thumbnail.resolutions[0].url) || null,
  })).filter((n) => n.title && n.link);
}

module.exports = { start, stop, setBroadcaster, setIndianFallback, isActive: () => active, _enabled, spotSymbol, priceFor, getFundamentals, getNews, quoteRaw: _yahooQuote, batchQuotes: _batchQuotes };
