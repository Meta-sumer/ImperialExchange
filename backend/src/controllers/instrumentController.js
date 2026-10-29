const Instrument = require('../models/Instrument');
const cacheService = require('../services/cacheService');
const Candle = require('../models/Candle');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const { applyMarketScope } = require('../services/marketScope');
const { getCandles } = require('../services/candleService');
const matchingEngine = require('../matching-engine/MatchingEngine');
const externalFeed = require('../services/externalFeedService');
const { D } = require('../utils/decimal');

// Derivatives (futures / options) are not offered on this platform, so the
// bulk catalog — thousands of contracts would flood every consumer (Explore,
// search, watchlists, the instrument strip) and slow the whole app. Callers that
// Derivative leftovers (FUT / OPT) are filtered out — see _excludeDerivatives.
// Fields no trading UI reads, stripped for every non-admin caller. Two reasons.
//
// Size: the catalogue went out with all 78 schema paths on every row (~2.3 kB
// each), so ~800 instruments was a ~1.8 MB response — fetched on the Trade page
// mount and revalidated every 30s. These paths are roughly a third of that.
//
// Disclosure: `mode`, `bBookEnabled`, `bBookDisableMode` and `routingOverride`
// tell a trader whether their own order is B-booked, and `profitSharePercent`
// is the broker's cut. Those belong to the admin surface, not the public
// catalogue.
//
// Verified against both SPAs before trimming: no client file reads any of them,
// and the two admin pages that call this endpoint without `includeInactive`
// (MarketExposure, RecommendedMarkets) only use symbol/name/category. The admin
// Instruments manager passes includeInactive=true and still gets every field.
const CLIENT_HIDDEN = [
  'instrumentToken', 'upstoxKey', 'isin',
  'priceSimulator', 'autoSwitchRules',
  'mode', 'bBookEnabled', 'bBookDisableMode', 'routingOverride',
  'profitSharePercent', 'commissionOverrides',
  'disabledReason', 'disabledAt', 'disabledBy',
  'marketDataEnabled', 'createdAt', 'updatedAt', '__v',
].map((f) => `-${f}`).join(' ');

// Derivatives were removed from the platform. Any FUT / OPT contract still in
// the database is a leftover: it cannot be traded, priced or expired any more,
// so it must not reach a client list — otherwise an untradeable index future
// would sit in Explore looking perfectly normal.
const DERIVATIVE_SEGMENTS = ['FUT', 'OPT'];
const _excludeDerivatives = (req, filter) => {
  if (req.query.segment) {
    const seg = String(req.query.segment).toUpperCase();
    // An explicit request for a derivative segment returns nothing, by design.
    filter.segment = DERIVATIVE_SEGMENTS.includes(seg) ? { $in: [] } : seg;
    return;
  }
  filter.segment = { $nin: DERIVATIVE_SEGMENTS };
};

const list = asyncHandler(async (req, res) => {
  // Admin management view can request inactive instruments too (to see + re-enable
  // a disabled symbol). The public trader list never passes this flag, so it stays
  // active-only everywhere else.
  // Admin (includeInactive) sees everything; clients see active + user-visible only.
  const filter = req.query.includeInactive === 'true' ? {} : { isActive: true, userVisible: { $ne: false } };
  if (req.query.includeInactive !== 'true') applyMarketScope(filter); // traders: Indian rows only (when scoped)
  if (req.query.category) filter.category = req.query.category;
  _excludeDerivatives(req, filter);
  const isAdminView = req.query.includeInactive === 'true';

  // Measured on the production box: this query plans in 34ms (IXSCAN, 381 docs
  // examined for 381 returned) but takes ~480-580ms end to end. The gap is not
  // the database — it is moving 0.44MB across a 19.4ms link at roughly 1.2MB/s.
  // No index or projection can fix that; the only remaining lever is not making
  // the trip.
  //
  // Staleness budget: the CLIENT already holds this response for 30 seconds
  // (useInstruments TTL), so a few seconds here cannot make anything staler than
  // the app already tolerates. lastPrice rides along in the payload but is
  // corrected within a second by the WebSocket ticker, and dailyBuyUsed/
  // dailySellUsed are display-only — daily volume is ENFORCED live at order time
  // in orderRouter.service.js via assertWithinDailyLimit, never from this.
  //
  // TTL only, deliberately no write-invalidation hook: the price feed writes
  // lastPrice on every tick, so a model-level hook would flush the cache
  // continuously and buy nothing. An admin edit appears within TTL_MS, which is
  // well inside the 30s the client would have shown the old copy for anyway.
  const CATALOGUE_TTL_MS = Number(process.env.INSTRUMENTS_CACHE_MS) >= 0
    ? Number(process.env.INSTRUMENTS_CACHE_MS)
    : 5000;
  const cacheKey = [
    'instruments:list',
    isAdminView ? 'admin' : 'client',
    req.query.category || '-',
    req.query.segment || '-',
    '-',
  ].join(':');

  const buildCatalogue = async () => {
    const q = Instrument.find(filter);
    if (!isAdminView) q.select(CLIENT_HIDDEN);
    return q.lean();
  };

  // The admin management view is never cached — it edits these rows and must see
  // its own writes immediately.
  const items = (isAdminView || !CATALOGUE_TTL_MS)
    ? await buildCatalogue()
    : await cacheService.getOrFetch(cacheKey, buildCatalogue, CATALOGUE_TTL_MS);
  // Enrich with any ACTIVE leverage / fixed-volume overrides so the client
  // can show indicators and lock the volume input. Batched (no N+1).
  const instrumentOverrideService = require('../services/instrumentOverrideService');
  const enriched = await instrumentOverrideService.attachActiveOverrides(items);

  // Attach today's per-side daily-volume usage for instruments with a cap
  // enabled (single batched aggregation; the all-unlimited case costs nothing).
  const capped = enriched.filter((i) => i.dailyVolumeLimitEnabled);
  if (capped.length) {
    const volumeLimitService = require('../services/volumeLimitService');
    const usedMap = await volumeLimitService.getUsedDailyVolumeForSymbols(capped.map((i) => i.symbol));
    for (const it of enriched) {
      if (it.dailyVolumeLimitEnabled) {
        const u = usedMap.get(it.symbol) || { BUY: 0, SELL: 0 };
        it.dailyBuyUsed = u.BUY;
        it.dailySellUsed = u.SELL;
      }
    }
  }
  sendSuccess(res, enriched);
});

// Daily volume usage for a single instrument → { enabled, limit, used, remaining }.
// Per-instrument limit usage: platform DAILY cap + GLOBAL LIFETIME cap, each
// per-side { limit, used, remaining }. Both are platform-wide (all users), so
// this stays public. Backward compatible — daily fields remain at top level.
const volumeUsage = asyncHandler(async (req, res) => {
  const inst = await Instrument.findOne({ symbol: req.params.symbol.toUpperCase() }).lean();
  if (!inst) throw new AppError('Instrument not found', 404);
  const [daily, lifetime] = await Promise.all([
    require('../services/volumeLimitService').getDailyVolumeUsage(inst),
    require('../services/lifetimeVolumeLimitService').getLifetimeVolumeUsage(inst),
  ]);
  sendSuccess(res, { ...daily, lifetime });
});

/**
 * Watchlist: every active instrument enriched with derived bid/ask, the
 * absolute spread, today's H/L and the 24h % change. The frontend can render
 * a market-watch table without N+1 calls.
 *
 * - bid/ask are derived from lastPrice and spreadValue/spreadType. We split
 *   the spread evenly: bid = last - half, ask = last + half.
 * - dayHigh/dayLow come from the most recent 1d candle (one query batched
 *   across symbols), falling back to the 1h candles if 1d isn't seeded.
 * - change24h compares the latest 1h candle close vs the 1h candle from
 *   ~24h ago. Approximate but cheap.
 */
const watchlist = asyncHandler(async (req, res) => {
  const filter = { isActive: true, userVisible: { $ne: false } };
  applyMarketScope(filter);
  if (req.query.category) filter.category = req.query.category;
  _excludeDerivatives(req, filter);
  // Same projection list() uses — this endpoint is public too, and it was still
  // shipping all 78 paths (including the B-book routing fields) per instrument.
  const items = await Instrument.find(filter).select(CLIENT_HIDDEN).lean();
  if (!items.length) return sendSuccess(res, []);

  const symbols = items.map((i) => i.symbol);

  // One query for today's 1d candle per symbol. Mongo "find latest per group"
  // would normally need an aggregation; for a small list of symbols (<50) a
  // straight find + in-memory pick is simpler and fast enough.
  const dayCandles = await Candle.find({
    symbol: { $in: symbols },
    timeframe: '1d',
  })
    .sort({ openTime: -1 })
    .limit(symbols.length * 3) // enough to capture the latest TWO sessions per symbol
    // Only these fields are read below; _id and the rest are dead weight on a
    // result set this size.
    .select('symbol openTime open high low close -_id')
    .lean();
  const dayBySymbol = new Map();      // latest 1d candle (current / most-recent session)
  const prevDayBySymbol = new Map();  // the session BEFORE it — baseline for daily % change
  for (const c of dayCandles) {
    if (!dayBySymbol.has(c.symbol)) dayBySymbol.set(c.symbol, c);
    else if (!prevDayBySymbol.has(c.symbol)) prevDayBySymbol.set(c.symbol, c);
  }

  // For 24h % change: latest 1h close vs the 1h candle ~24h prior.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentHourly = await Candle.find({
    symbol: { $in: symbols },
    timeframe: '1h',
    openTime: { $gte: new Date(Date.now() - 26 * 60 * 60 * 1000) },
  })
    .sort({ openTime: 1 })
    // 26 hours x every active symbol is thousands of documents on every call,
    // and exactly four fields of each are used (high/low for the day-range
    // fallback, close+openTime for the 24h baseline).
    .select('symbol openTime high low close -_id')
    .lean();
  const hourlyBySymbol = new Map();
  for (const c of recentHourly) {
    if (!hourlyBySymbol.has(c.symbol)) hourlyBySymbol.set(c.symbol, []);
    hourlyBySymbol.get(c.symbol).push(c);
  }

  const enriched = items.map((inst) => {
    const last = D(inst.lastPrice || '0');
    let bid = last;
    let ask = last;
    if (inst.spreadValue && Number(inst.spreadValue) > 0 && Number(inst.lastPrice) > 0) {
      const half = D(inst.spreadValue).div(2);
      if (inst.spreadType === 'PERCENTAGE') {
        bid = last.times(D('1').minus(half));
        ask = last.times(D('1').plus(half));
      } else {
        bid = last.minus(half);
        ask = last.plus(half);
      }
    }
    const spread = ask.minus(bid).toString();

    // ── Prefer the exchange-side 24h ticker when available (crypto via
    // Binance). Falls back to our own candle aggregation for forex /
    // stocks / commodities, which is computed below.
    const extTicker = externalFeed.getExternalTicker(inst.symbol);

    const day = dayBySymbol.get(inst.symbol);
    let dayHigh = extTicker?.dayHigh != null && Number.isFinite(extTicker.dayHigh)
      ? String(extTicker.dayHigh)
      : (day?.high || null);
    let dayLow = extTicker?.dayLow != null && Number.isFinite(extTicker.dayLow)
      ? String(extTicker.dayLow)
      : (day?.low || null);

    // Fallback to 1h aggregation when 1d candle is missing.
    const hourly = hourlyBySymbol.get(inst.symbol) || [];
    if ((!dayHigh || !dayLow) && hourly.length) {
      let h = D(hourly[0].high);
      let l = D(hourly[0].low);
      for (const c of hourly) {
        if (D(c.high).gt(h)) h = D(c.high);
        if (D(c.low).lt(l)) l = D(c.low);
      }
      dayHigh = dayHigh || h.toString();
      dayLow = dayLow || l.toString();
    }

    let change24h = null;
    if (extTicker && Number.isFinite(extTicker.change24h)) {
      // Exchange-computed % — always preferred when present.
      change24h = extTicker.change24h;
    } else if (hourly.length >= 2 && Number(inst.lastPrice) > 0) {
      // Find the candle closest to (now - 24h) without going past it.
      let baseline = hourly[0];
      for (const c of hourly) {
        if (new Date(c.openTime) <= dayAgo) baseline = c;
        else break;
      }
      if (Number(baseline.close) > 0) {
        change24h = ((Number(inst.lastPrice) - Number(baseline.close)) / Number(baseline.close)) * 100;
      }
    }
    // Final fallback for non-crypto (forex / stocks / indices / commodities):
    // derive a REAL daily % from the 1d candles already loaded — last price vs
    // the PREVIOUS session's close (the standard daily change), or today's open
    // when only one session exists. No external call; uses in-hand data. Only
    // fills the cases the branches above left null, so crypto/hourly are intact.
    if (change24h == null && Number(inst.lastPrice) > 0) {
      const prevDay = prevDayBySymbol.get(inst.symbol);
      const today = dayBySymbol.get(inst.symbol);
      let base = 0;
      if (prevDay && Number(prevDay.close) > 0) base = Number(prevDay.close);
      else if (today && Number(today.open) > 0) base = Number(today.open);
      if (base > 0) change24h = ((Number(inst.lastPrice) - base) / base) * 100;
    }

    const volume24h = extTicker && Number.isFinite(extTicker.volume24h)
      ? String(extTicker.volume24h)
      : (inst.volume24h || null);

    return {
      symbol: inst.symbol,
      name: inst.name,
      category: inst.category,
      logoUrl: inst.logoUrl || null,
      // exchange drives NSE/BSE session gating + ₹ display on the client.
      exchange: inst.exchange || null,
      segment: inst.segment || null,
      lotSize: inst.lotSize || null,
      // Quote currency lets the client decide whether to show INR primary +
      // USD secondary (USD-quoted) vs INR-only (INR-quoted) on the watchlist.
      quoteCurrency: inst.quoteCurrency,
      pricePrecision: inst.pricePrecision,
      lastPrice: inst.lastPrice,
      bid: bid.toString(),
      ask: ask.toString(),
      spread,
      dayHigh,
      dayLow,
      change24h,
      volume24h,
    };
  });

  sendSuccess(res, enriched);
});

const getOne = asyncHandler(async (req, res) => {
  const inst = await Instrument.findOne({ symbol: req.params.symbol.toUpperCase() }).lean();
  if (!inst) throw new AppError('Instrument not found', 404);
  sendSuccess(res, inst);
});

// Global instrument search across equities / forex / crypto / commodities.
const search = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return sendSuccess(res, []);
  const limit = Math.min(Number(req.query.limit) || 25, 50);
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const sel = 'symbol name category exchange segment lastPrice quoteCurrency lotSize logoUrl';

  const base = await Instrument.find(applyMarketScope({ isActive: true, userVisible: { $ne: false }, $or: [{ symbol: rx }, { name: rx }] }))
    .select(sel).limit(limit).lean();

  sendSuccess(res, base);
});

const candles = asyncHandler(async (req, res) => {
  const { symbol } = req.params;
  const { timeframe = '1m', limit = 500 } = req.query;
  const sym = symbol.toUpperCase();
  // Lazy history backfill: the first time an under-populated Indian chart is
  // opened, seed real past candles so it is not blank — the live feed only builds
  // candles going FORWARD, so an unvisited timeframe has nothing at all.
  //
  // Upstox first: it can serve every instrument including F&O, with real
  // contract history. But it needs the same access token the live feed uses, so
  // when that token dies a chart loses its live updates AND its history together
  // — switching 1m to 5m then renders empty, because those candles were never
  // built and could not be fetched either.
  //
  // Yahoo is the fallback: no key, no token. It only covers equities and indices
  // (see yahooBackfill — a derivative would resolve to its underlying spot, and
  // charting one instrument's past as another's is worse than an empty chart),
  // but that is exactly the set a user is most likely staring at.
  //
  // Both upsert by (symbol, timeframe, openTime), so whichever runs second just
  // overwrites the same rows. Best-effort — neither can block or break the chart.
  try { await require('../services/upstoxBackfill').ensureHistory(sym, timeframe); } catch (_) { /* */ }
  try { await require('../services/yahooBackfill').ensureHistory(sym, timeframe); } catch (_) { /* */ }
  const data = await getCandles(sym, timeframe, Number(limit));
  // Reverse to chronological for charts
  sendSuccess(res, data.reverse());
});

// Admin: the market price of a symbol at a past moment, from stored candles
// (lazy Yahoo backfill first). Powers the manual-trade form's "price at that
// time" auto-fill. Tries the finest timeframe whose history reaches that far;
// price null when nothing covers the moment (then the admin types it).
const PRICE_AT_TF_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '1d': 86400e3 };
const priceAt = asyncHandler(async (req, res) => {
  const sym = String(req.params.symbol || '').toUpperCase();
  const at = new Date(req.query.at);
  if (Number.isNaN(at.getTime())) throw new AppError('at must be an ISO date-time', 400);
  for (const tf of Object.keys(PRICE_AT_TF_MS)) {
    try { await require('../services/yahooBackfill').ensureHistory(sym, tf); } catch (_) { /* best effort */ }
    const c = await Candle.findOne({ symbol: sym, timeframe: tf, openTime: { $lte: at } }).sort({ openTime: -1 }).lean();
    if (c && at.getTime() - new Date(c.openTime).getTime() <= PRICE_AT_TF_MS[tf] * 3) {
      return sendSuccess(res, { symbol: sym, at, timeframe: tf, candleTime: c.openTime, price: c.close, open: c.open, high: c.high, low: c.low });
    }
  }
  sendSuccess(res, { symbol: sym, at, timeframe: null, price: null });
});

const orderbook = asyncHandler(async (req, res) => {
  const { symbol } = req.params;
  const sym = symbol.toUpperCase();
  const depth = Number(req.query.depth || 25);
  // 1. Prefer the cached external L2 book (Binance for crypto). This is
  //    what a real trader expects when they ask for "market depth".
  const ext = externalFeed.getExternalOrderbook(sym);
  if (ext && (ext.bids?.length || ext.asks?.length)) {
    const trimmed = {
      symbol: ext.symbol,
      bids: ext.bids.slice(0, depth),
      asks: ext.asks.slice(0, depth),
      ts: ext.ts,
      source: ext.source,
    };
    return sendSuccess(res, trimmed);
  }
  // 2. Fallback to the internal matching engine snapshot (user-placed
  //    limit orders, mostly empty for crypto pairs).
  const snap = matchingEngine.getSnapshot(sym, depth);
  sendSuccess(res, snap);
});

// Real fundamentals (market cap, P/E, EPS, 52-week range, etc.) via the
// free Yahoo Finance feed. Cached in-memory for 5 min per symbol so a page
// load doesn't hammer Yahoo. Returns whatever Yahoo yields — fields Yahoo
// can't provide come back null (the client shows "—" rather than a fake).
const _fundCache = new Map(); // symbol → { at, data }
const fundamentals = asyncHandler(async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const cached = _fundCache.get(sym);
  if (cached && (Date.now() - cached.at) < 5 * 60 * 1000) {
    return sendSuccess(res, cached.data);
  }
  const inst = await Instrument.findOne({ symbol: sym }).lean();
  if (!inst) throw new AppError('Instrument not found', 404);
  let data = { yahooSymbol: null };
  try {
    const yahooFeed = require('../services/yahooFeed');
    data = (await yahooFeed.getFundamentals(inst)) || data;
  } catch (_) { /* return whatever we have */ }
  _fundCache.set(sym, { at: Date.now(), data });
  sendSuccess(res, data);
});

// Real stock news via Yahoo Finance search. Cached 5 min per symbol.
const _newsCache = new Map();
const news = asyncHandler(async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const cached = _newsCache.get(sym);
  if (cached && (Date.now() - cached.at) < 5 * 60 * 1000) return sendSuccess(res, cached.data);
  const inst = await Instrument.findOne({ symbol: sym }).lean();
  if (!inst) throw new AppError('Instrument not found', 404);
  let data = [];
  try {
    const yahooFeed = require('../services/yahooFeed');
    data = (await yahooFeed.getNews(inst)) || [];
  } catch (_) { /* empty */ }
  _newsCache.set(sym, { at: Date.now(), data });
  sendSuccess(res, data);
});

// Admin CRUD
const validateBBook = (data) => {
  // CRITICAL: doc requirement (§4.1) - B-book MUST be disabled in Internal-Only mode
  if (data.bBookEnabled === true && data.mode === 'INTERNAL') {
    throw new AppError('B-book cannot be enabled when mode is INTERNAL (doc §4.1)', 400, 'INVALID_BBOOK_MODE');
  }
};

// Enforce that exactly ONE commission method is active: the field for the
// inactive type is forced to '0' so an instrument can never charge both a
// flat fee AND a percentage. Mutates `body` in place.
const normalizeCommission = (body, current = {}) => {
  if (!body || typeof body !== 'object') return;
  const type = String(body.commissionType ?? current.commissionType ?? 'PERCENTAGE').toUpperCase();
  if (type !== 'FIXED' && type !== 'PERCENTAGE') return;
  body.commissionType = type;
  if (type === 'FIXED') body.commissionPercent = '0';
  else body.commissionPerTrade = '0';
};

const create = asyncHandler(async (req, res) => {
  validateBBook(req.body);
  normalizeCommission(req.body);
  const inst = await Instrument.create(req.body);
  sendSuccess(res, inst, 201);
});

// Admin: read / toggle the DAILY pre-market Dhan instrument auto-import
// (backgroundWorker.syncDhanDaily). Stored in systemSettings 'dhan.autoSync'.
const getAutoSync = asyncHandler(async (req, res) => {
  const systemSettings = require('../services/systemSettings.service');
  const enabled = (await systemSettings.getSetting('dhan.autoSync')) !== false;
  return sendSuccess(res, { enabled });
});
const setAutoSync = asyncHandler(async (req, res) => {
  const systemSettings = require('../services/systemSettings.service');
  const enabled = !!req.body.enabled;
  await systemSettings.setSetting('dhan.autoSync', enabled, req.userId);
  // Turning auto-add ON → run a sync/check NOW so any missing instruments are
  // added immediately (idempotent upsert — no duplicates). Best-effort/async so
  // the toggle responds instantly; requires an Indian feed to be configured.
  if (enabled && process.env.INDIAN_FEED) {
    setImmediate(async () => {
      try {
        const r = await require('../services/dhanInstrumentSync').syncAll();
        console.log(`[auto-add] resync on enable: ${r.ops} contracts (upserted ${r.upserted}, modified ${r.modified})`);
      } catch (e) { console.error('[auto-add] resync on enable failed:', e.message); }
    });
  }
  return sendSuccess(res, { enabled });
});

// Admin: import Indian instruments from the OFFICIAL Dhan sync (full exchange
// metadata) on demand — the panel-friendly alternative to the CLI scripts.
//   EQUITY   → specific symbols via Dhan scrip master
//   INDICES  → NIFTY/BANKNIFTY/… spot tiles
const syncIndian = asyncHandler(async (req, res) => {
  const type = String(req.body.type || 'EQUITY').toUpperCase();
  const symbols = String(req.body.symbols || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (type === 'INDICES') {
    return sendSuccess(res, { type, ...(await require('../services/indianIndices').ensureIndianIndices()) });
  }
  if (type === 'MCX') {
    return sendSuccess(res, { type, ...(await require('../services/mcxCommodities').ensureMcxCommodities()) });
  }
  if (type !== 'EQUITY') {
    throw new AppError('type must be EQUITY, INDICES or MCX', 400);
  }
  if (!symbols.length) throw new AppError('symbols required (comma-separated, e.g. RELIANCE,TCS)', 400);
  if (symbols.length > 25) throw new AppError('Max 25 symbols per import — split into batches.', 400);
  const { importDhanInstruments } = require('../services/dhanImport');
  return sendSuccess(res, { type, ...(await importDhanInstruments({ kind: type, symbols })) });
});

// ─── Admin Instrument Management: impact / disable / enable ─────────────────

// GET /instruments/:symbol/impact — counts for the "Disable" confirmation modal.
const instrumentImpact = asyncHandler(async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const inst = await Instrument.findOne({ symbol })
    .select('symbol name tradingEnabled marketDataEnabled userVisible isActive').lean();
  if (!inst) throw new AppError('Instrument not found', 404);
  const Order = require('../models/Order');
  const Position = require('../models/Position');
  const { ORDER_STATUS, POSITION_STATUS } = require('../config/constants');
  const [openPositions, pendingOrders] = await Promise.all([
    Position.countDocuments({ symbol, status: POSITION_STATUS.OPEN }),
    Order.countDocuments({ symbol, status: { $in: [ORDER_STATUS.PENDING, ORDER_STATUS.PARTIALLY_FILLED] } }),
  ]);
  return sendSuccess(res, {
    symbol, openPositions, pendingOrders,
    state: {
      tradingEnabled: inst.tradingEnabled !== false,
      marketDataEnabled: inst.marketDataEnabled !== false,
      userVisible: inst.userVisible !== false,
      isActive: inst.isActive !== false,
    },
  });
});

// POST /instruments/:symbol/disable
// body: { openPositionAction: 'FORCE_CLOSE'|'KEEP_OPEN', marketData: 'CONTINUE'|'STOP',
//         userVisibility: 'SHOW'|'HIDE', reason }
// Idempotent — re-running only acts on orders/positions still live.
const disableInstrument = asyncHandler(async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const inst = await Instrument.findOne({ symbol });
  if (!inst) throw new AppError('Instrument not found', 404);

  const openAction = String(req.body.openPositionAction || 'KEEP_OPEN').toUpperCase();
  const forceClose = openAction === 'FORCE_CLOSE';
  const marketDataEnabled = String(req.body.marketData || 'CONTINUE').toUpperCase() !== 'STOP';
  const userVisible = String(req.body.userVisibility || 'SHOW').toUpperCase() !== 'HIDE';
  const reason = String(req.body.reason || '').slice(0, 300);

  const before = {
    tradingEnabled: inst.tradingEnabled !== false,
    marketDataEnabled: inst.marketDataEnabled !== false,
    userVisible: inst.userVisible !== false,
  };

  // 1. Flip trading OFF FIRST so the order-validation choke point rejects any
  //    concurrent new opens the instant we begin cancelling / closing.
  inst.tradingEnabled = false;
  inst.marketDataEnabled = marketDataEnabled;
  inst.userVisible = userVisible;
  inst.disabledReason = reason;
  inst.disabledAt = new Date();
  inst.disabledBy = req.userId;
  await inst.save();

  const Order = require('../models/Order');
  const Position = require('../models/Position');
  const TradingAccount = require('../models/TradingAccount');
  const walletService = require('../services/walletService');
  const orderRouter = require('../services/orderRouter.service');
  const wsServer = require('../websocket/server');
  const { ORDER_STATUS, POSITION_STATUS, ORDER_TYPE } = require('../config/constants');
  const { gt, sub, mul, div } = require('../utils/decimal');

  // 2. Cancel all pending / working orders for the symbol + release margin.
  const pending = await Order.find({
    symbol, status: { $in: [ORDER_STATUS.PENDING, ORDER_STATUS.PARTIALLY_FILLED] },
  });
  let cancelledOrders = 0;
  for (const o of pending) {
    const fresh = await Order.findById(o._id);
    if (!fresh || ![ORDER_STATUS.PENDING, ORDER_STATUS.PARTIALLY_FILLED].includes(fresh.status)) continue;
    try { await orderRouter.routeCancel({ order: fresh }); } catch (_) { /* LP cancel best-effort */ }
    fresh.status = ORDER_STATUS.CANCELLED;
    fresh.rejectionReason = 'INSTRUMENT_DISABLED';
    await fresh.save();
    if (gt(fresh.lockedMargin || '0', '0')) {
      const rawRemaining = sub(fresh.quantity, fresh.filledQuantity || '0');
      const remaining = gt(rawRemaining, '0') ? rawRemaining : '0';
      if (gt(remaining, '0')) {
        const releaseAmt = div(mul(fresh.lockedMargin, remaining), fresh.quantity);
        const acc = await TradingAccount.findById(fresh.accountId);
        try {
          await walletService.releaseMargin({
            userId: fresh.userId, accountId: fresh.accountId,
            currency: acc?.baseCurrency || 'USD', amount: releaseAmt,
            orderId: fresh._id, note: `Instrument disabled: released ${releaseAmt} for unfilled ${remaining}`,
          });
        } catch (_) { /* best-effort */ }
      }
    }
    try { wsServer.notifyUser(String(fresh.userId), 'orders', { event: 'CANCELLED', accountId: fresh.accountId ? String(fresh.accountId) : null, orderId: String(fresh._id), symbol }); } catch (_) {}
    cancelledOrders++;
  }

  // 3. Existing open positions — FORCE_CLOSE or KEEP_OPEN.
  let forceClosedPositions = 0;
  const affected = new Set();
  if (forceClose) {
    const positions = await Position.find({ symbol, status: POSITION_STATUS.OPEN });
    for (const pos of positions) {
      const claimed = await Position.findOneAndUpdate(
        { _id: pos._id, status: POSITION_STATUS.OPEN, settled: { $ne: true } },
        { $set: { status: POSITION_STATUS.CLOSING, closeReason: 'INSTRUMENT_DISABLED_FORCE_CLOSE' } },
        { new: true }
      );
      if (!claimed) continue;
      const closingOrder = await Order.create({
        userId: pos.userId, accountId: pos.accountId, instrumentId: pos.instrumentId, symbol: pos.symbol,
        side: pos.side === 'BUY' ? 'SELL' : 'BUY',
        positionSide: pos.positionSide || (pos.side === 'BUY' ? 'LONG' : 'SHORT'),
        type: ORDER_TYPE.MARKET, quantity: pos.quantity, leverage: pos.leverage,
        status: ORDER_STATUS.PENDING, closeOnly: true, reduceOnly: true,
      });
      try {
        await orderRouter.routeOrder({ order: closingOrder, userId: pos.userId });
        forceClosedPositions++;
        affected.add(String(pos.userId));
        const closedId = pos._id;
        setImmediate(async () => {
          try {
            const settled = await Position.findById(closedId).lean();
            await require('../services/copyTradingService').onMasterPositionClosed({ position: settled || pos, realizedPnl: settled?.realizedPnl });
          } catch (_) { /* fan-out best-effort */ }
        });
      } catch (err) {
        await Position.updateOne(
          { _id: pos._id, status: POSITION_STATUS.CLOSING, settled: { $ne: true } },
          { $set: { status: POSITION_STATUS.OPEN }, $unset: { closeReason: '' } }
        );
        console.error(`[instrument disable] force-close failed ${pos.symbol}:`, err.message);
      }
    }
    // Notify affected users (persist + live push).
    const { Notification } = require('../models/index');
    for (const uid of affected) {
      try {
        await Notification.create({
          userId: uid, type: 'INSTRUMENT_DISABLED',
          title: `${symbol} positions closed`,
          message: `Trading for ${symbol} was disabled by the platform${reason ? ` (${reason})` : ''}. Your open ${symbol} position(s) were force-closed at market.`,
          channels: ['IN_APP', 'EMAIL'],
        });
        wsServer.notifyUser(String(uid), 'positions', { event: 'INSTRUMENT_DISABLED_FORCE_CLOSE', symbol });
        wsServer.notifyUser(String(uid), 'notifications', { type: 'INSTRUMENT_DISABLED', symbol });
      } catch (_) { /* best-effort */ }
    }
  }

  // 4. Audit.
  try {
    const { AuditLog } = require('../models/index');
    await AuditLog.create({
      actorId: req.userId, actorRole: req.user?.role, action: 'INSTRUMENT_DISABLED',
      targetType: 'INSTRUMENT', targetId: String(inst._id),
      metadata: {
        symbol, reason, openPositionAction: openAction,
        before, after: { tradingEnabled: false, marketDataEnabled, userVisible },
        cancelledOrders, forceClosedPositions,
      },
      ip: req.ip, userAgent: req.headers['user-agent'],
    });
  } catch (_) { /* audit best-effort */ }

  return sendSuccess(res, {
    symbol, tradingEnabled: false, marketDataEnabled, userVisible,
    openPositionAction: openAction, cancelledOrders, forceClosedPositions,
  });
});

// POST /instruments/:symbol/enable — restore trading + market data + visibility.
const enableInstrument = asyncHandler(async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const inst = await Instrument.findOne({ symbol });
  if (!inst) throw new AppError('Instrument not found', 404);
  const before = {
    tradingEnabled: inst.tradingEnabled !== false,
    marketDataEnabled: inst.marketDataEnabled !== false,
    userVisible: inst.userVisible !== false,
    isActive: inst.isActive !== false,
  };
  inst.tradingEnabled = true;
  inst.marketDataEnabled = true;   // feeds re-scan on their interval → data restarts, no restart needed
  inst.userVisible = true;
  inst.isActive = true;            // un-archive if it was soft-deleted
  inst.disabledReason = '';
  inst.disabledAt = null;
  inst.disabledBy = null;
  await inst.save();
  try {
    const { AuditLog } = require('../models/index');
    await AuditLog.create({
      actorId: req.userId, actorRole: req.user?.role, action: 'INSTRUMENT_ENABLED',
      targetType: 'INSTRUMENT', targetId: String(inst._id),
      metadata: { symbol, before, after: { tradingEnabled: true, marketDataEnabled: true, userVisible: true, isActive: true } },
      ip: req.ip, userAgent: req.headers['user-agent'],
    });
  } catch (_) { /* audit best-effort */ }
  return sendSuccess(res, { symbol, tradingEnabled: true, marketDataEnabled: true, userVisible: true, isActive: true });
});

const update = asyncHandler(async (req, res) => {
  // Check final state against current record
  const current = await Instrument.findOne({ symbol: req.params.symbol.toUpperCase() });
  if (!current) throw new AppError('Instrument not found', 404);
  const finalMode = req.body.mode ?? current.mode;
  const finalBBook = req.body.bBookEnabled ?? current.bBookEnabled;
  validateBBook({ mode: finalMode, bBookEnabled: finalBBook });
  normalizeCommission(req.body, current);

  // B-book disable transition handler (doc §9.4)
  // If bBookEnabled is going from true -> false, take action on existing B-book positions
  // based on the configured bBookDisableMode.
  const bBookDisableTransition = current.bBookEnabled === true && finalBBook === false;

  const inst = await Instrument.findOneAndUpdate(
    { symbol: req.params.symbol.toUpperCase() },
    req.body,
    { new: true }
  );

  if (bBookDisableTransition) {
    const mode = inst.bBookDisableMode || 'LET_RUN';
    const Position = require('../models/Position');
    const Trade = require('../models/Trade');
    const Order = require('../models/Order');
    const matchingEngine = require('../matching-engine/MatchingEngine');

    // Find users with open positions whose latest trade for this symbol was B-book.
    // (Simpler heuristic: any open position on this symbol where any related trade was B_BOOK.)
    const openPositions = await Position.find({ symbol: inst.symbol, status: 'OPEN' });
    const affected = [];
    for (const pos of openPositions) {
      const recentBBookTrade = await Trade.findOne({
        symbol: inst.symbol,
        $or: [{ buyAccountId: pos.accountId }, { sellAccountId: pos.accountId }],
        routing: 'B_BOOK',
      }).sort({ executedAt: -1 });
      if (recentBBookTrade) affected.push(pos);
    }

    if (mode === 'CLOSE_ALL') {
      // Force-close all affected positions at last price. Each close is
      // routed through orderRouter so an A-book account's close still
      // flows to the LP rather than executing internally.
      const orderRouter = require('../services/orderRouter.service');
      for (const pos of affected) {
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
          await orderRouter.routeOrder({ order: closingOrder, userId: pos.userId });
        } catch (e) {
          console.error('[BBookDisable] close failed:', e.message);
        }
      }
      console.log(`[BBookDisable] ${inst.symbol}: CLOSE_ALL closed ${affected.length} positions`);
    } else if (mode === 'HEDGE_EXTERNAL') {
      // TODO: open offsetting positions on external broker (requires liquidity provider integration).
      // For now log the intent and leave positions running.
      console.warn(`[BBookDisable] ${inst.symbol}: HEDGE_EXTERNAL not yet implemented (${affected.length} positions need hedging). Falling back to LET_RUN.`);
    }
    // 'LET_RUN' = no action; positions remain open until user closes naturally.
  }

  sendSuccess(res, inst);
});

const remove = asyncHandler(async (req, res) => {
  const inst = await Instrument.findOneAndUpdate(
    { symbol: req.params.symbol.toUpperCase() },
    { isActive: false },
    { new: true }
  );
  if (!inst) throw new AppError('Instrument not found', 404);
  sendSuccess(res, inst);
});

// Bulk set routingOverride on many instruments at once.
const VALID_ROUTING = ['INHERIT', 'INTERNAL_MATCHING', 'A_BOOK', 'B_BOOK', 'HYBRID'];
const bulkRouting = asyncHandler(async (req, res) => {
  const { symbols, routingOverride } = req.body || {};
  if (!Array.isArray(symbols) || !symbols.length) throw new AppError('symbols[] required', 400);
  if (!VALID_ROUTING.includes(routingOverride)) throw new AppError('Invalid routingOverride', 400);
  const up = symbols.map((s) => String(s).toUpperCase());
  const r = await Instrument.updateMany({ symbol: { $in: up } }, { $set: { routingOverride } });
  sendSuccess(res, { matched: r.matchedCount ?? r.n ?? 0, modified: r.modifiedCount ?? r.nModified ?? 0, routingOverride });
});

// ── Economic calendar (Forex Factory / faireconomy — FREE, no API key) ──────
// Fetched server-side (avoids browser CORS + one shared cache for all clients),
// normalised to the exact shape the client's economicCalendar util renders, and
// cached ~1h (events don't change intra-hour). On failure we keep the last good
// cache (or empty) so the client falls back to its deterministic static schedule.
let _calCache = { at: 0, data: null };
const CAL_TTL_MS = 60 * 60 * 1000;
const FF_URLS = [
  'https://nfs.faireconomy.media/ff_calendar_lastweek.json',
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
];
const CCY_TO_COUNTRY = { USD: 'US', EUR: 'EU', GBP: 'GB', JPY: 'JP', CHF: 'CH', CAD: 'CA', AUD: 'AU', NZD: 'NZ', CNY: 'CN', INR: 'IN' };
const _calImpact = (s) => {
  const v = String(s || '').toLowerCase();
  if (v.includes('high')) return 'high';
  if (v.includes('medium') || v.includes('moderate')) return 'medium';
  if (v.includes('holiday')) return 'lowest';
  return 'low';
};
const _calNum = (s) => {
  if (s == null || s === '') return null;
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
async function _fetchFFCalendar() {
  const out = [];
  const seen = new Set();
  for (const url of FF_URLS) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Imperial Exchange calendar)' } });
      if (!res.ok) continue;
      const rows = await res.json();
      if (!Array.isArray(rows)) continue;
      for (const r of rows) {
        const currency = String(r.country || r.currency || '').toUpperCase();
        const dateStr = r.date || r.datetime;
        if (!currency || !dateStr) continue;
        const d = new Date(dateStr);
        if (Number.isNaN(d.getTime())) continue;
        const id = `${currency}-${r.title}-${d.toISOString()}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          date: d.toISOString(),
          country: CCY_TO_COUNTRY[currency] || currency,
          currency,
          impact: _calImpact(r.impact),
          event: String(r.title || 'Event'),
          period: '',
          unit: '',
          previous: _calNum(r.previous),
          consensus: null,
          forecast: _calNum(r.forecast),
          actual: _calNum(r.actual),
          previousLabel: r.previous || '—',
          consensusLabel: '—',
          forecastLabel: r.forecast || '—',
          actualLabel: r.actual || null,
          code: currency,
        });
      }
    } catch (_) { /* skip this window, keep others */ }
  }
  return out;
}
const economicCalendar = asyncHandler(async (req, res) => {
  const now = Date.now();
  if (!_calCache.data || now - _calCache.at > CAL_TTL_MS) {
    const data = await _fetchFFCalendar();
    if (data.length) _calCache = { at: now, data };            // only cache a good pull
    else if (!_calCache.data) _calCache = { at: now, data: [] }; // failed + nothing cached → don't hammer
  }
  sendSuccess(res, _calCache.data || []);
});

module.exports = { list, watchlist, getOne, search, volumeUsage, candles, orderbook, fundamentals, news, create, update, remove, bulkRouting, syncIndian, getAutoSync, setAutoSync, instrumentImpact, disableInstrument, enableInstrument, economicCalendar, priceAt };
