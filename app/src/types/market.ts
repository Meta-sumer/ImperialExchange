/**
 * Market-data shapes: live quotes, depth, candles, option chains, news,
 * watchlists and alerts — plus the adapters for the ones that arrive over
 * BOTH REST and the WebSocket.
 *
 * ── WHY SOME ADAPTERS LIVE IN A TYPES FILE ────────────────────────────
 * A ticker, an order-book snapshot and a candle each reach the app two ways:
 * `GET /instruments/:symbol/orderbook` and the `orderbook:SYM` channel carry
 * the same body, and so do `/candles` and `candles:SYM:TF`. One adapter per
 * shape, used by both paths, is what keeps the REST snapshot and the live
 * update from disagreeing about a field. They sit here, beside the types and
 * the readers in types/api, because both the API modules and
 * websocket/channels import them — putting them in either would make the two
 * import each other.
 * ──────────────────────────────────────────────────────────────────────
 */
import { bool, dec, id, num, one, rows, str, strOrNull } from '@/types/api';
import type { Candle, Decimal } from '@/types/trading';

type Raw = Record<string, unknown>;

const asRaw = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {});

/** A decimal string, or null when absent. `dec` would invent a zero. */
export const decOrNull = (v: unknown): Decimal | null => {
  const s = dec(v, '');
  return s === '' ? null : s;
};

/** An ISO string from a Date, an ISO string or epoch millis; else null. */
export const isoOrNull = (v: unknown): string | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'string' && v.trim() !== '') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  return null;
};

/* ── Categories ───────────────────────────────────────────────────────── */

/**
 * The instrument categories, from backend/src/models/Instrument.js. There is
 * no categories endpoint — the enum IS the list.
 */
export const INSTRUMENT_CATEGORIES = ['FOREX', 'CRYPTO', 'STOCK', 'INDEX', 'COMMODITY'] as const;

/* ── Timeframes ───────────────────────────────────────────────────────── */

/** Every timeframe the candle store accepts (models/Candle.js enum). */
export const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/**
 * Bucket widths, copied from the SERVER's table (candleService TF_MS) rather
 * than the web chart's. PriceChart.jsx's TF_SECONDS has no `30m` or `1w` and
 * falls back to 60s for both — so a 1w live candle was snapped to a one-minute
 * grid and never met its historical bucket. The server's buckets are the ones
 * the history was written with, so they are the ones to snap to.
 */
export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1_800,
  '1h': 3_600,
  '4h': 14_400,
  '1d': 86_400,
  '1w': 604_800,
};

export const isTimeframe = (v: unknown): v is Timeframe =>
  typeof v === 'string' && (TIMEFRAMES as readonly string[]).includes(v);

export const timeframeSeconds = (tf: string): number =>
  (isTimeframe(tf) ? TIMEFRAME_SECONDS[tf] : 60);

/** Snap unix seconds down to the start of their bucket. */
export const bucketFloor = (sec: number, tfSec: number): number =>
  Math.floor(sec / tfSec) * tfSec;

/* ── Candles ──────────────────────────────────────────────────────────── */

/**
 * One raw candle — `{ openTime, open, high, low, close, volume }` with the
 * prices as decimal strings — to the chart's shape. Null when unusable.
 * `tfSec` snaps the time to the bucket grid, as PriceChart.jsx:2166 does, so
 * history and live updates share their time keys.
 */
export const adaptCandle = (rawIn: unknown, tfSec?: number): Candle | null => {
  const raw = asRaw(rawIn);
  // The server sends `openTime` as ISO; an already-shaped candle carries
  // `time` in unix seconds. Never Date.parse a number — V8 reads '2000' as
  // a year.
  const iso = isoOrNull(typeof raw.openTime === 'number' ? null : raw.openTime);
  let time = iso !== null ? Math.floor(Date.parse(iso) / 1000) : num(raw.time);
  if (time === null) return null;
  if (tfSec) time = bucketFloor(time, tfSec);
  const open = num(raw.open);
  const high = num(raw.high);
  const low = num(raw.low);
  const close = num(raw.close);
  if (open === null || high === null || low === null || close === null) return null;
  return { time, open, high, low, close, volume: num(raw.volume) ?? 0 };
};

/**
 * A candle history, cleaned the way the web chart cleans it
 * (PriceChart.jsx:2155-2183): unusable rows dropped, anything stamped after
 * `nowSec` dropped (server clock skew must not draw tomorrow), sorted, and
 * de-duplicated by bucket with the latest row winning.
 */
export const normaliseCandles = (
  body: unknown,
  timeframe: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Candle[] => {
  const tfSec = timeframeSeconds(timeframe);
  const out: Candle[] = [];
  const sorted = rows<unknown>(body)
    .map((r) => adaptCandle(r, tfSec))
    .filter((c): c is Candle => c !== null && c.time <= nowSec)
    .sort((a, b) => a.time - b.time);
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && last.time === c.time) out[out.length - 1] = c;
    else out.push(c);
  }
  return out;
};

/* ── Live quote ───────────────────────────────────────────────────────── */

/**
 * What `ticker:SYM` carries. Most feeds send only `lastPrice` + `ts`; the
 * Binance 24h ticker adds the day's range, change and bid/ask. Absent fields
 * are null — never zero, because a zero bid is a price and an absent one is
 * not.
 */
export interface Ticker {
  symbol: string;
  lastPrice: Decimal | null;
  bid: Decimal | null;
  ask: Decimal | null;
  change24h: number | null;
  dayHigh: Decimal | null;
  dayLow: Decimal | null;
  volume24h: Decimal | null;
  /** Epoch millis the feed stamped, when it did. */
  ts: number | null;
  /** 'BINANCE_TICKER', 'UPSTOX', 'DHAN', … — absent for engine fills. */
  source: string | null;
}

export const adaptTicker = (symbol: string, rawIn: unknown): Ticker => {
  const raw = asRaw(rawIn);
  return {
    symbol: symbol.toUpperCase(),
    lastPrice: decOrNull(raw.lastPrice ?? raw.price),
    bid: decOrNull(raw.bid),
    ask: decOrNull(raw.ask),
    change24h: num(raw.change24h),
    dayHigh: decOrNull(raw.dayHigh),
    dayLow: decOrNull(raw.dayLow),
    volume24h: decOrNull(raw.volume24h),
    ts: num(raw.ts),
    source: strOrNull(raw.source),
  };
};

/**
 * Fold a new tick into the last known one. A tick that omits a field keeps
 * the previous value — a lastPrice-only tick from Upstox must not blank the
 * day range the Binance ticker supplied a second earlier.
 */
export const mergeTicker = (prev: Ticker | undefined, next: Ticker): Ticker => {
  if (!prev) return next;
  return {
    symbol: next.symbol,
    lastPrice: next.lastPrice ?? prev.lastPrice,
    bid: next.bid ?? prev.bid,
    ask: next.ask ?? prev.ask,
    change24h: next.change24h ?? prev.change24h,
    dayHigh: next.dayHigh ?? prev.dayHigh,
    dayLow: next.dayLow ?? prev.dayLow,
    volume24h: next.volume24h ?? prev.volume24h,
    ts: next.ts ?? prev.ts,
    source: next.source ?? prev.source,
  };
};

/* ── Depth ────────────────────────────────────────────────────────────── */

export interface OrderBookLevel {
  price: Decimal;
  quantity: Decimal;
  /** Resting orders at this level. Binance pre-aggregates, so 1 there. */
  count: number;
}

export interface OrderBook {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  ts: number | null;
  /** 'BINANCE' for the external book; absent for the internal engine's. */
  source: string | null;
}

const adaptLevel = (rawIn: unknown): OrderBookLevel | null => {
  // Both [price, qty] tuples and { price, quantity } objects have been seen.
  if (Array.isArray(rawIn)) {
    const price = decOrNull(rawIn[0]);
    const quantity = decOrNull(rawIn[1]);
    return price !== null && quantity !== null ? { price, quantity, count: 1 } : null;
  }
  const raw = asRaw(rawIn);
  const price = decOrNull(raw.price);
  if (price === null || num(price) === null) return null;
  return { price, quantity: dec(raw.quantity ?? raw.qty), count: num(raw.count) ?? 1 };
};

const levels = (v: unknown): OrderBookLevel[] =>
  (Array.isArray(v) ? v : [])
    .map(adaptLevel)
    .filter((l): l is OrderBookLevel => l !== null);

export const adaptOrderBook = (rawIn: unknown, symbol = ''): OrderBook => {
  // The REST path wraps it ({ data: snapshot }); the WS frame is bare.
  const raw = asRaw(one<Raw>(rawIn, 'data'));
  return {
    symbol: (str(raw.symbol) || symbol).toUpperCase(),
    bids: levels(raw.bids),
    asks: levels(raw.asks),
    ts: num(raw.ts),
    source: strOrNull(raw.source),
  };
};

/* ── Option chain ─────────────────────────────────────────────────────── */

/**
 * The F&O kinds the option chain is grouped by — the instrument's
 * `category` (instrumentController.fnoUnderlyings groups by it).
 */
export type FnoKind = 'INDEX' | 'STOCK' | 'COMMODITY';

export const isFnoKind = (v: unknown): v is FnoKind => v === 'INDEX' || v === 'STOCK' || v === 'COMMODITY';

/**
 * OI / IV / Greeks for one side of a strike, from Dhan's option-chain API
 * (services/dhanOptionChain `_leg`). Present only when the Dhan Data API is
 * configured; every figure may be null.
 */
export interface OptionLegStats {
  oi: number | null;
  /** oi − previous_oi. */
  oiChange: number | null;
  volume: number | null;
  iv: number | null;
  delta: number | null;
  theta: number | null;
  gamma: number | null;
  vega: number | null;
}

/** One side of a strike — the contract's own live LTP, what an order fills against. */
export interface OptionLeg {
  symbol: string;
  lastPrice: Decimal | null;
  prevPrice: Decimal | null;
  /** `tradingEnabled !== false` server-side. */
  tradingEnabled: boolean;
  stats: OptionLegStats | null;
}

export interface OptionChainRow {
  strike: number;
  CE: OptionLeg | null;
  PE: OptionLeg | null;
}

/** The reference price: the index tile / cash equity, or (MCX) the future the options settle into. */
export interface OptionChainSpot {
  symbol: string;
  name: string | null;
  lastPrice: Decimal | null;
  isFuture: boolean;
}

/** Chain-wide figures from the Dhan analytics (instrumentController.optionChain). */
export interface OptionChainAnalytics {
  source: string;
  asOf: string | null;
  underlyingPrice: number | null;
  ceOi: number | null;
  peOi: number | null;
  pcr: number | null;
  maxPain: number | null;
}

/** GET /instruments/option-chain — strikes × CE / PE for one underlying and expiry. */
export interface OptionChain {
  underlying: string;
  kind: FnoKind | null;
  exchange: string | null;
  /** IST `YYYY-MM-DD` the chain was built for. */
  expiry: string | null;
  expiries: string[];
  expiryDate: string | null;
  spot: OptionChainSpot | null;
  future: { symbol: string; lastPrice: Decimal | null; expiryDate: string | null } | null;
  lotSize: number | null;
  contractUnit: string | null;
  tickSize: number | null;
  atmStrike: number | null;
  /** Ascending by strike. */
  strikes: OptionChainRow[];
  /** Null when Dhan is not configured or has not answered — the chain is LTP-only then. */
  analytics: OptionChainAnalytics | null;
}

/** A future listed on an underlying (fnoUnderlyings `futures`). */
export interface FnoFuture {
  symbol: string;
  expiryDate: string | null;
  lastPrice: Decimal | null;
}

/** One underlying in the option-chain picker. */
export interface FnoUnderlying {
  underlying: string;
  kind: FnoKind | null;
  exchange: string | null;
  name: string;
  lotSize: number | null;
  contractUnit: string | null;
  /** IST `YYYY-MM-DD`, ascending. Empty when only futures are listed. */
  optionExpiries: string[];
  futures: FnoFuture[];
  spot: OptionChainSpot | null;
}

/**
 * The admin's market-segment switches (services/marketSegments.getState):
 * India-only and each F&O segment. The server already scopes the picker by
 * them; the app only reads them.
 */
export interface MarketSegments {
  indiaOnly: boolean;
  indexFutures: boolean;
  indexOptions: boolean;
  stockFutures: boolean;
  stockOptions: boolean;
  mcxFutures: boolean;
  mcxOptions: boolean;
}

/** GET /instruments/fno/underlyings. */
export interface FnoUnderlyings {
  segments: MarketSegments;
  underlyings: FnoUnderlying[];
}

const finiteOr = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** `YYYY-MM-DD` as sent, else derived from a date (IST). */
const ymdOrNull = (v: unknown): string | null => {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const iso = isoOrNull(v);
  if (!iso) return null;
  return new Date(Date.parse(iso) + 5.5 * 3600e3).toISOString().slice(0, 10);
};

export const adaptOptionLegStats = (rawIn: unknown): OptionLegStats | null => {
  if (!rawIn || typeof rawIn !== 'object') return null;
  const r = rawIn as Raw;
  return {
    oi: finiteOr(r.oi),
    oiChange: finiteOr(r.oiChange),
    volume: finiteOr(r.volume),
    iv: finiteOr(r.iv),
    delta: finiteOr(r.delta),
    theta: finiteOr(r.theta),
    gamma: finiteOr(r.gamma),
    vega: finiteOr(r.vega),
  };
};

export const adaptOptionLeg = (rawIn: unknown): OptionLeg | null => {
  if (!rawIn || typeof rawIn !== 'object') return null;
  const raw = rawIn as Raw;
  const symbol = str(raw.symbol);
  if (!symbol) return null;
  return {
    symbol,
    lastPrice: decOrNull(raw.lastPrice),
    prevPrice: decOrNull(raw.prevPrice),
    tradingEnabled: raw.tradingEnabled !== false,
    stats: adaptOptionLegStats(raw.stats),
  };
};

export const adaptOptionChainSpot = (rawIn: unknown): OptionChainSpot | null => {
  if (!rawIn || typeof rawIn !== 'object') return null;
  const r = rawIn as Raw;
  const symbol = str(r.symbol);
  if (!symbol) return null;
  return { symbol, name: strOrNull(r.name), lastPrice: decOrNull(r.lastPrice), isFuture: r.isFuture === true };
};

const adaptAnalytics = (rawIn: unknown): OptionChainAnalytics | null => {
  if (!rawIn || typeof rawIn !== 'object') return null;
  const r = rawIn as Raw;
  return {
    source: str(r.source),
    asOf: isoOrNull(r.asOf),
    underlyingPrice: finiteOr(r.underlyingPrice),
    ceOi: finiteOr(r.ceOi),
    peOi: finiteOr(r.peOi),
    pcr: finiteOr(r.pcr),
    maxPain: finiteOr(r.maxPain),
  };
};

export const adaptOptionChain = (rawIn: unknown, underlying = ''): OptionChain => {
  const raw = asRaw(rawIn);
  const fut = raw.future && typeof raw.future === 'object' ? (raw.future as Raw) : null;
  const strikes = rows<unknown>(raw.strikes)
    .map((r): OptionChainRow | null => {
      const row = asRaw(r);
      const strike = finiteOr(row.strike);
      if (strike === null) return null;
      return { strike, CE: adaptOptionLeg(row.CE), PE: adaptOptionLeg(row.PE) };
    })
    .filter((r): r is OptionChainRow => r !== null)
    .sort((a, b) => a.strike - b.strike);
  return {
    underlying: (str(raw.underlying) || underlying).toUpperCase(),
    kind: isFnoKind(raw.kind) ? raw.kind : null,
    exchange: strOrNull(raw.exchange),
    expiry: ymdOrNull(raw.expiry),
    expiries: (Array.isArray(raw.expiries) ? raw.expiries : []).map(ymdOrNull).filter((e): e is string => !!e),
    expiryDate: isoOrNull(raw.expiryDate),
    spot: adaptOptionChainSpot(raw.spot),
    future: fut && str(fut.symbol)
      ? { symbol: str(fut.symbol), lastPrice: decOrNull(fut.lastPrice), expiryDate: isoOrNull(fut.expiryDate) }
      : null,
    lotSize: finiteOr(raw.lotSize),
    contractUnit: strOrNull(raw.contractUnit),
    tickSize: finiteOr(raw.tickSize),
    atmStrike: finiteOr(raw.atmStrike),
    strikes,
    analytics: adaptAnalytics(raw.analytics),
  };
};

const adaptFnoFuture = (rawIn: unknown): FnoFuture | null => {
  const r = asRaw(rawIn);
  const symbol = str(r.symbol);
  if (!symbol) return null;
  return { symbol, expiryDate: isoOrNull(r.expiryDate), lastPrice: decOrNull(r.lastPrice) };
};

export const adaptFnoUnderlying = (rawIn: unknown): FnoUnderlying | null => {
  const r = asRaw(rawIn);
  const underlying = str(r.underlying).toUpperCase();
  if (!underlying) return null;
  return {
    underlying,
    kind: isFnoKind(r.kind) ? r.kind : null,
    exchange: strOrNull(r.exchange),
    name: str(r.name) || underlying,
    lotSize: finiteOr(r.lotSize),
    contractUnit: strOrNull(r.contractUnit),
    optionExpiries: (Array.isArray(r.optionExpiries) ? r.optionExpiries : [])
      .map(ymdOrNull)
      .filter((e): e is string => !!e),
    futures: rows<unknown>(r.futures).map(adaptFnoFuture).filter((f): f is FnoFuture => f !== null),
    spot: adaptOptionChainSpot(r.spot),
  };
};

export const adaptMarketSegments = (rawIn: unknown): MarketSegments => {
  const r = asRaw(rawIn);
  // getState answers `!== false` for each switch: absent means on.
  const on = (k: string): boolean => r[k] !== false;
  return {
    indiaOnly: on('indiaOnly'),
    indexFutures: on('indexFutures'),
    indexOptions: on('indexOptions'),
    stockFutures: on('stockFutures'),
    stockOptions: on('stockOptions'),
    mcxFutures: on('mcxFutures'),
    mcxOptions: on('mcxOptions'),
  };
};

export const adaptFnoUnderlyings = (rawIn: unknown): FnoUnderlyings => {
  const r = asRaw(rawIn);
  return {
    segments: adaptMarketSegments(r.segments),
    underlyings: rows<unknown>(r.underlyings)
      .map(adaptFnoUnderlying)
      .filter((u): u is FnoUnderlying => u !== null),
  };
};

/* ── Fundamentals (Yahoo, via /instruments/:symbol/fundamentals) ──────── */

/**
 * Whatever Yahoo yields. A field it cannot provide is null and the screen
 * shows "—" — the backend's own rule, and it is kept: a fabricated P/E on a
 * stock page is worse than a missing one.
 */
export interface Fundamentals {
  yahooSymbol: string | null;
  currency: string | null;
  lastPrice: number | null;
  prevClose: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  week52High: number | null;
  week52Low: number | null;
  volume: number | null;
  marketCap: number | null;
  peRatio: number | null;
  eps: number | null;
  pbRatio: number | null;
  bookValue: number | null;
  roe: number | null;
  debtToEquity: number | null;
  dividendYield: number | null;
  revenueGrowth: number | null;
  earningsGrowth: number | null;
  finQuarterly: FinancialPoint[];
  finYearly: FinancialPoint[];
  earningsDate: string | null;
  exDividendDate: string | null;
  dividendDate: string | null;
}

export interface FinancialPoint {
  label: string;
  revenue: number | null;
  profit: number | null;
}

const finPoints = (v: unknown): FinancialPoint[] =>
  rows<unknown>(v).map((p) => {
    const r = asRaw(p);
    return { label: str(r.label), revenue: num(r.revenue), profit: num(r.profit) };
  });

export const adaptFundamentals = (rawIn: unknown): Fundamentals => {
  const r = asRaw(rawIn);
  return {
    yahooSymbol: strOrNull(r.yahooSymbol),
    currency: strOrNull(r.currency),
    lastPrice: num(r.lastPrice),
    prevClose: num(r.prevClose),
    dayHigh: num(r.dayHigh),
    dayLow: num(r.dayLow),
    week52High: num(r.week52High),
    week52Low: num(r.week52Low),
    volume: num(r.volume),
    marketCap: num(r.marketCap),
    peRatio: num(r.peRatio),
    eps: num(r.eps),
    pbRatio: num(r.pbRatio),
    bookValue: num(r.bookValue),
    roe: num(r.roe),
    debtToEquity: num(r.debtToEquity),
    dividendYield: num(r.dividendYield),
    revenueGrowth: num(r.revenueGrowth),
    earningsGrowth: num(r.earningsGrowth),
    finQuarterly: finPoints(r.finQuarterly),
    finYearly: finPoints(r.finYearly),
    earningsDate: strOrNull(r.earningsDate),
    exDividendDate: strOrNull(r.exDividendDate),
    dividendDate: strOrNull(r.dividendDate),
  };
};

/* ── News ─────────────────────────────────────────────────────────────── */

/** A per-symbol headline from `/instruments/:symbol/news` (Yahoo search). */
export interface InstrumentNewsItem {
  title: string;
  publisher: string | null;
  link: string | null;
  publishedAt: string | null;
  thumbnail: string | null;
}

/**
 * A Market News headline from `/instruments/market-news` (services/
 * marketNews): Economic Times, Mint, Business Standard and BusinessLine RSS,
 * global stories filtered out, each tagged with up to three listed stocks /
 * indices it mentions. The story itself lives on the publisher's site.
 */
export interface MarketNewsTag {
  symbol: string;
  name: string | null;
}

export interface MarketNewsItem {
  id: string;
  title: string;
  url: string | null;
  summary: string | null;
  image: string | null;
  source: string | null;
  publishedAt: string | null;
  tags: MarketNewsTag[];
}

export const adaptInstrumentNews = (rawIn: unknown): InstrumentNewsItem | null => {
  const r = asRaw(rawIn);
  const title = str(r.title).trim();
  // Nothing to show without a title. (yahooFeed.getNews already drops rows
  // missing a title or link; this does not rely on it.)
  if (!title) return null;
  return {
    title,
    publisher: strOrNull(r.publisher),
    link: strOrNull(r.link),
    publishedAt: isoOrNull(r.publishedAt),
    thumbnail: strOrNull(r.thumbnail),
  };
};

export const adaptMarketNews = (rawIn: unknown): MarketNewsItem | null => {
  const r = asRaw(rawIn);
  const title = str(r.title).trim();
  if (!title) return null;
  const tags = rows<unknown>(r.tags)
    .map((t): MarketNewsTag | null => {
      const tag = asRaw(t);
      const symbol = str(tag.symbol).toUpperCase();
      return symbol ? { symbol, name: strOrNull(tag.name) } : null;
    })
    .filter((t): t is MarketNewsTag => t !== null);
  const publishedAt = isoOrNull(r.publishedAt);
  return {
    id: str(r.id) || `${publishedAt ?? ''}-${title}`,
    title,
    url: strOrNull(r.url),
    summary: strOrNull(r.summary),
    image: strOrNull(r.image),
    source: strOrNull(r.source),
    publishedAt,
    tags,
  };
};

/*
 * CMS "Daily News Updates" articles (/cms/news) are types/cms NewsArticle —
 * one shape, owned there. news.api reads them through cms.api.
 */

/* ── Pagination ───────────────────────────────────────────────────────── */

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export const adaptPagination = (rawIn: unknown, fallbackLimit = 30): Pagination => {
  const r = asRaw(rawIn);
  return {
    page: num(r.page) ?? 1,
    limit: num(r.limit) ?? fallbackLimit,
    total: num(r.total) ?? 0,
    pages: num(r.pages) ?? 1,
  };
};

/* ── Economic calendar ────────────────────────────────────────────────── */

/**
 * The server's impact grades. `lowest` is Forex Factory's bank-holiday grade
 * (instrumentController `_calImpact`); the web has no style for it and falls
 * back to its Medium badge, so a screen must decide rather than assume three.
 */
export type CalendarImpact = 'high' | 'medium' | 'low' | 'lowest';

/**
 * One release, as a calendar screen renders it. Live rows come from
 * `/instruments/economic-calendar` (Forex Factory, proxied and cached ~1h by
 * the backend); admin rows from `/cms/economic-calendar` (types/cms
 * EconomicEvent). news.api merges both into this.
 *
 * The web also GENERATES a schedule with synthetic "actual" prints when the
 * live feed is down (utils/economicCalendar.js RECURRING + syntheticActual).
 * That is invented data shown as released figures, and it is not ported: no
 * live feed means only the admin's events, or nothing.
 */
export interface CalendarEvent {
  id: string;
  /** ISO, UTC. The web renders these times in UTC and labels them so. */
  date: string;
  /** Epoch ms of `date` — the sort key. */
  ts: number;
  /** Two-letter region ('US', 'EU', …) — drives the flag. */
  country: string;
  currency: string;
  impact: CalendarImpact;
  event: string;
  period: string;
  unit: string;
  previous: number | null;
  consensus: number | null;
  forecast: number | null;
  actual: number | null;
  /**
   * Display strings, verbatim from the server for live rows ("—" where the
   * feed has none). `actualLabel` null means "not released yet".
   */
  previousLabel: string | null;
  consensusLabel: string | null;
  forecastLabel: string | null;
  actualLabel: string | null;
  /** An event the platform admin entered by hand. */
  isAdmin: boolean;
}

const IMPACTS: readonly string[] = ['high', 'medium', 'low', 'lowest'];

/**
 * A live `/instruments/economic-calendar` row. Null when it has no usable
 * date or title — the server already skips those; this does not trust it to.
 */
export const adaptCalendarEvent = (rawIn: unknown): CalendarEvent | null => {
  const r = asRaw(rawIn);
  const date = isoOrNull(r.date);
  const event = str(r.event).trim();
  if (!date || !event) return null;
  const impact = str(r.impact).toLowerCase();
  return {
    id: str(r.id) || `${str(r.currency)}-${event}-${date}`,
    date,
    ts: Date.parse(date),
    country: str(r.country).toUpperCase(),
    currency: str(r.currency).toUpperCase(),
    impact: (IMPACTS.includes(impact) ? impact : 'low') as CalendarImpact,
    event,
    period: str(r.period),
    unit: str(r.unit),
    previous: num(r.previous),
    consensus: num(r.consensus),
    forecast: num(r.forecast),
    actual: num(r.actual),
    previousLabel: strOrNull(r.previousLabel),
    consensusLabel: strOrNull(r.consensusLabel),
    forecastLabel: strOrNull(r.forecastLabel),
    actualLabel: strOrNull(r.actualLabel),
    isAdmin: false,
  };
};

/* ── Watchlists ───────────────────────────────────────────────────────── */

export interface WatchlistItem {
  id: string;
  symbol: string;
  /** The instrument's category, stamped at add time; '' for legacy rows. */
  type: string;
  sortOrder: number;
  pinned: boolean;
  addedAt: string | null;
}

export interface Watchlist {
  id: string;
  name: string;
  emoji: string;
  color: string;
  /** The Favorites list — where the ★ always goes. */
  isDefault: boolean;
  sortOrder: number;
  /** Server order: pinned first, then sortOrder. */
  items: WatchlistItem[];
  itemCount: number;
}

export const adaptWatchlistItem = (rawIn: unknown): WatchlistItem => {
  const r = asRaw(rawIn);
  return {
    id: id(r),
    symbol: str(r.symbol).toUpperCase(),
    type: str(r.type),
    sortOrder: num(r.sortOrder) ?? 0,
    pinned: bool(r.pinned),
    addedAt: isoOrNull(r.addedAt),
  };
};

export const adaptWatchlist = (rawIn: unknown): Watchlist => {
  const r = asRaw(rawIn);
  const items = rows<unknown>(r.items).map(adaptWatchlistItem);
  return {
    id: id(r),
    name: str(r.name),
    emoji: str(r.emoji),
    color: str(r.color),
    isDefault: bool(r.isDefault),
    sortOrder: num(r.sortOrder) ?? 0,
    items,
    itemCount: num(r.itemCount) ?? items.length,
  };
};

/* ── Alerts ───────────────────────────────────────────────────────────── */

export type AlertDirection = 'ABOVE' | 'BELOW';

/** A trader's own price alert (`/reports/alerts`). */
export interface PriceAlert {
  id: string;
  symbol: string;
  direction: AlertDirection;
  targetPrice: Decimal;
  note: string | null;
  isActive: boolean;
  triggeredAt: string | null;
  triggeredPrice: Decimal | null;
  /** Re-arms after firing instead of switching itself off. */
  repeatable: boolean;
  createdAt: string | null;
}

export type GlobalAlertPriority = 'CRITICAL' | 'WARNING' | 'INFO';

/**
 * A platform announcement (`/alerts/pending`) — the blocking popup whose only
 * exit is OK. `message` is admin-authored HTML, sanitised server-side.
 */
export interface GlobalAlert {
  id: string;
  title: string;
  message: string;
  priority: GlobalAlertPriority;
  requireAcknowledgement: boolean;
  repeatDisplay: boolean;
  createdAt: string | null;
}

export const adaptPriceAlert = (rawIn: unknown): PriceAlert => {
  const r = asRaw(rawIn);
  return {
    id: id(r),
    symbol: str(r.symbol).toUpperCase(),
    direction: str(r.direction).toUpperCase() === 'BELOW' ? 'BELOW' : 'ABOVE',
    // Stored as a string server-side (`String(targetPrice)`) and shown as sent.
    targetPrice: dec(r.targetPrice, ''),
    note: strOrNull(r.note),
    // The model defaults to active; only an explicit false is paused.
    isActive: r.isActive !== false,
    triggeredAt: isoOrNull(r.triggeredAt),
    triggeredPrice: decOrNull(r.triggeredPrice),
    repeatable: bool(r.repeatable),
    createdAt: isoOrNull(r.createdAt),
  };
};

/**
 * The status PriceAlerts.jsx shows, in its precedence: a fired alert reads
 * "Triggered @ price" even while paused, then Active, then Paused.
 */
export type PriceAlertStatus = 'TRIGGERED' | 'ACTIVE' | 'PAUSED';

export const priceAlertStatus = (a: Pick<PriceAlert, 'triggeredAt' | 'isActive'>): PriceAlertStatus =>
  (a.triggeredAt ? 'TRIGGERED' : a.isActive ? 'ACTIVE' : 'PAUSED');

const PRIORITIES: readonly string[] = ['CRITICAL', 'WARNING', 'INFO'];

export const adaptGlobalAlert = (rawIn: unknown): GlobalAlert | null => {
  const r = asRaw(rawIn);
  const alertId = id(r);
  if (!alertId) return null; // nothing to acknowledge, so nothing to show
  const priority = str(r.priority).toUpperCase();
  return {
    id: alertId,
    title: str(r.title),
    message: str(r.message),
    // An unknown priority renders as INFO, as GlobalAlertPopup's fallback does.
    priority: (PRIORITIES.includes(priority) ? priority : 'INFO') as GlobalAlertPriority,
    requireAcknowledgement: bool(r.requireAcknowledgement),
    repeatDisplay: bool(r.repeatDisplay),
    createdAt: isoOrNull(r.createdAt),
  };
};

/* ── Candle cleaning for the stock page ───────────────────────────────── */

/**
 * Drop the LEADING run of flat carry-forward candles (volume 0, close
 * unchanged) a feed prepends before a session's first real tick, keeping one
 * as a lead-in — StockDetail.jsx `trimLeadingFlat`. Without it the pre-open
 * run sits at the day's base and squashes the real line into the right edge.
 * A no-op for daily and weekly bars, which carry volume.
 */
export const trimLeadingFlat = (candles: readonly Candle[]): Candle[] => {
  if (candles.length < 3) return [...candles];
  const first = candles[0]?.close;
  let i = 0;
  while (
    i < candles.length - 2
    && candles[i]?.close === first
    && (candles[i]?.volume ?? 0) === 0
  ) i += 1;
  const start = Math.max(0, i - 1);
  return start > 0 ? candles.slice(start) : [...candles];
};
