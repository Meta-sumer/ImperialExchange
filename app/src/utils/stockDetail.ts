import {
  timeframeSeconds,
  type FinancialPoint,
  type Fundamentals,
  type InstrumentNewsItem,
  type OrderBook,
  type OrderBookLevel,
} from '@/types/market';
import type { Candle, Instrument } from '@/types/trading';
import { EMPTY, fmtNum } from '@/utils/money';

/**
 * The instrument page's numbers — EquityHub's client/src/pages/StockDetail.jsx, as pure
 * functions so each can be pinned against the web's own source
 * (src/__tests__/stage3_stockDetail.logic.test.ts lifts the web's code with
 * `new Function` and runs both on the same inputs).
 *
 * ── WHAT IS NOT PORTED, AND WHY ───────────────────────────────────────
 * StockDetail.jsx fills gaps in its data with invented figures. Each is
 * mock data shown as if it were real, so none is ported; the port shows "—"
 * or leaves the block out instead (PORT-RULINGS: the app displays server
 * figures; the economic calendar's synthetic schedule was dropped for the
 * same reason):
 *
 *   • Market depth with no real book → a random book around the last price,
 *     re-rolled every 1.2 s (OverviewTab `depth` + `pulse`).  Port: the
 *     web's own "No depth" rows.
 *   • 52-week range without Yahoo → dayLow × 0.72 / dayHigh × 1.38.
 *   • Lower / upper circuit without a band → lastPrice × 0.9 / × 1.1.
 *   • Previous close without Yahoo → the chart's first open, under the
 *     "Previous close" label.
 *   • Financial performance without Yahoo → five hard-coded quarters.
 *   • Similar stocks' "Market cap" → lastPrice × 4.2e8 / 1e7.
 *
 * Also dropped: the retired `OrderPanel` in the same file (never rendered —
 * the page uses the platform OrderForm) and its hard-coded 83 FX fallback.
 * ──────────────────────────────────────────────────────────────────────
 *
 * EquityHub lists Indian instruments only: every quote is in rupees (the
 * web's `cur = '₹'`) and every figure groups the Indian way. Figures the web
 * renders with `toFixed` go through fmtNum too (CONTRACT §9), so a
 * four-digit ratio gains a separator.
 */

/* ── Constants ────────────────────────────────────────────────────────── */

/** Positions last: the one tab about YOUR money rather than the instrument (StockDetail.jsx TABS). */
export const STOCK_TABS = ['Overview', 'Technicals', 'News', 'Positions'] as const;
export type StockTab = (typeof STOCK_TABS)[number];

export type ChartMode = 'line' | 'candle';
export type FinMode = 'Quarterly' | 'Yearly';
export const FIN_MODES: readonly FinMode[] = ['Quarterly', 'Yearly'];

/** The web inlines these hexes (not theme classes) — kept verbatim. */
export const STOCK_COLORS = {
  up: '#16A34A',
  down: '#EA580C',
  /** Technical summary "Bearish" (text, not a candle). */
  bearSignal: '#DC2626',
  neutral: '#64748B',
  /** The chart's dashed first-close line. */
  baseline: '#E2E8F0',
  crosshair: '#94A3B8',
  /** RangeBar's position marker. */
  marker: '#334155',
  lime: '#84CC16',
  revenue: '#64748B',
  revenueDim: '#CBD5E1',
  profit: '#16A34A',
  profitDim: '#A7F3D0',
} as const;

/** How many "Similar stocks" rows. */
export const SIMILAR_MAX = 6;
/** Depth levels asked for and shown. */
export const DEPTH_LEVELS = 5;

/* ── Currency and precision ───────────────────────────────────────────── */

export interface StockCurrency {
  /** What the web prefixes — always ₹ on EquityHub. */
  symbol: '₹';
  /** The grouping to use — Indian. */
  group: 'INR';
}

type InstLike = Pick<Instrument, 'category' | 'exchange' | 'quoteCurrency' | 'pricePrecision'> | null | undefined;

/** `inst.category === 'STOCK' && ['NSE','BSE'].includes(inst.exchange)` — StockDetail.jsx:149. */
export const isIndianEquity = (inst: InstLike): boolean =>
  !!inst && inst.category === 'STOCK' && (inst.exchange === 'NSE' || inst.exchange === 'BSE');

/**
 * StockDetail.jsx `cur` — "Indian instruments only — every quote is in
 * rupees": ₹ whatever the row says.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const stockCurrency = (_inst?: InstLike): StockCurrency => ({ symbol: '₹', group: 'INR' });

/** `Math.min(inst?.pricePrecision || 2, 5)` — StockDetail.jsx:140. */
export const stockPrecision = (inst: InstLike): number => Math.min(inst?.pricePrecision || 2, 5);

const finite = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A price with the page's prefix: `₹1,234.50`. Absent → "—" (the web printed 0). */
export const fmtPx = (v: unknown, prec: number, cur: StockCurrency): string => {
  const n = finite(v);
  return n === null ? EMPTY : `${cur.symbol}${fmtNum(n, prec, cur.group)}`;
};

/**
 * A quantity or volume — the web's bare `toLocaleString('en-IN')`: up to
 * three decimals, trailing zeros dropped, grouped by the currency.
 */
export const fmtQty = (v: unknown, cur: StockCurrency): string => {
  const n = finite(v);
  if (n === null) return EMPTY;
  const s = fmtNum(n, 3, cur.group);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

/** `(v >= 0 ? '+' : '') + v.toFixed(d) + '%'`. */
export const fmtSignedPct = (v: number | null | undefined, decimals = 2): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return EMPTY;
  return `${v >= 0 ? '+' : ''}${fmtNum(v, decimals)}%`;
};

/* ── Header figures ───────────────────────────────────────────────────── */

export interface StockFigures {
  /** Live tick, else the last candle's close, else the instrument row. Null when none is known. */
  lastPrice: number | null;
  /** The range's first open. */
  openPrice: number | null;
  change: number;
  pct: number;
  up: boolean;
  /** Low / high across the chart's candles (the web's "Today's" range). */
  dayLow: number | null;
  dayHigh: number | null;
}

/**
 * StockDetail.jsx:140-148. The one difference: with no tick, no candles and
 * no price on the row the web shows ₹0.00 — here the price is null ("—").
 */
export const stockFigures = (
  candles: readonly Candle[],
  livePrice: number | null,
  inst: Pick<Instrument, 'lastPrice'> | null | undefined,
): StockFigures => {
  const last = candles[candles.length - 1];
  const rowPrice = finite(inst?.lastPrice);
  const lastPrice = livePrice ?? (last ? last.close : (rowPrice !== null && rowPrice > 0 ? rowPrice : null));
  const first = candles[0];
  const openPrice = first ? first.open : lastPrice;
  const change = lastPrice !== null && openPrice !== null ? lastPrice - openPrice : 0;
  const pct = openPrice ? (change / openPrice) * 100 : 0;
  let dayLow: number | null = lastPrice;
  let dayHigh: number | null = lastPrice;
  if (candles.length) {
    dayLow = Infinity;
    dayHigh = -Infinity;
    for (const c of candles) {
      if (c.low < dayLow) dayLow = c.low;
      if (c.high > dayHigh) dayHigh = c.high;
    }
  }
  return { lastPrice, openPrice, change, pct, up: change >= 0, dayLow, dayHigh };
};

/** The live tick's price, when it is a number — StockDetail.jsx:123. */
export const livePriceOf = (tick: { lastPrice?: unknown } | null | undefined): number | null => {
  const px = finite(tick?.lastPrice);
  return px;
};

/** `{up ? '' : '-'}{cur}{|change|} ({up ? '+' : ''}{pct}%)` — StockDetail.jsx:219. */
export const changeLabel = (f: Pick<StockFigures, 'change' | 'pct' | 'up'>, prec: number, cur: StockCurrency): string =>
  `${f.up ? '' : '-'}${cur.symbol}${fmtNum(Math.abs(f.change), prec, cur.group)} (${f.up ? '+' : ''}${fmtNum(f.pct, 2)}%)`;

/* ── Overview: fundamentals ───────────────────────────────────────────── */

const dash = (v: number | null | undefined, fmt: (n: number) => string): string =>
  (v === null || v === undefined ? EMPTY : fmt(v));

/** The Fundamentals grid, labels and formats verbatim — StockDetail.jsx:343-354. */
export const fundamentalRows = (
  fund: Fundamentals | null,
  cur: StockCurrency,
  prec: number,
): Array<[string, string]> => [
  ['Market Cap', dash(fund?.marketCap, (v) => `${cur.symbol}${fmtNum(v / 1e7, 0, cur.group)}Cr`)],
  ['P/E Ratio (TTM)', dash(fund?.peRatio, (v) => fmtNum(v, 2))],
  ['P/B Ratio', dash(fund?.pbRatio, (v) => fmtNum(v, 2))],
  ['ROE', dash(fund?.roe, (v) => `${fmtNum(v * 100, 2)}%`)],
  ['Debt to Equity', dash(fund?.debtToEquity, (v) => fmtNum(v / 100, 2))],
  ['EPS (TTM)', dash(fund?.eps, (v) => fmtNum(v, 2))],
  ['Dividend Yield', dash(fund?.dividendYield, (v) => `${fmtNum(v * 100, 2)}%`)],
  ['Book Value', dash(fund?.bookValue, (v) => fmtNum(v, 2))],
  ['52W High', dash(fund?.week52High, (v) => fmtPx(v, prec, cur))],
  ['52W Low', dash(fund?.week52Low, (v) => fmtPx(v, prec, cur))],
];

/* ── Overview: performance ────────────────────────────────────────────── */

/**
 * RangeBar's marker position, 0–100 — StockDetail.jsx:512. Null when either
 * end is unknown: there is no bar to place it on.
 */
export const rangePosition = (value: number | null, lo: number | null, hi: number | null): number | null => {
  if (value === null || lo === null || hi === null) return null;
  return hi > lo ? Math.min(100, Math.max(0, ((value - lo) / (hi - lo)) * 100)) : 50;
};

/** Yahoo's 52-week range; each end null when Yahoo has none (no × 0.72 / × 1.38). */
export const week52 = (fund: Fundamentals | null): { low: number | null; high: number | null } => ({
  low: fund?.week52Low ?? null,
  high: fund?.week52High ?? null,
});

/** Σ candle volume — the web's "Live volume" fallback when Yahoo has none. */
export const candleVolume = (candles: readonly Candle[]): number =>
  candles.reduce((s, c) => s + (Number(c.volume) || 0), 0);

/** A circuit band from the row — only a positive one is a band. */
const band = (v: unknown): number | null => {
  const n = finite(v);
  return n !== null && n > 0 ? n : null;
};

/** The five Performance metrics, labels verbatim — StockDetail.jsx:421-425. */
export const performanceMetrics = (
  f: Pick<StockFigures, 'openPrice'>,
  fund: Fundamentals | null,
  inst: Pick<Instrument, 'lowerCircuit' | 'upperCircuit'> | null | undefined,
  candles: readonly Candle[],
  cur: StockCurrency,
  prec: number,
): Array<[string, string]> => [
  ['Open price', fmtPx(f.openPrice, prec, cur)],
  ['Previous close', fmtPx(fund?.prevClose ?? null, prec, cur)],
  ['Live volume', fmtQty(fund?.volume ?? candleVolume(candles), cur)],
  ['Lower circuit', fmtPx(band(inst?.lowerCircuit), prec, cur)],
  ['Upper circuit', fmtPx(band(inst?.upperCircuit), prec, cur)],
];

/* ── Overview: market depth ───────────────────────────────────────────── */

/** `Number(r.quantity ?? r.qty ?? 0)`. */
export const levelQty = (l: Pick<OrderBookLevel, 'quantity'>): number => Number(l.quantity) || 0;

export interface DepthSummary {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  bidTotal: number;
  askTotal: number;
  /** Share of resting size on the bid, 0–100; 50 with an empty book. */
  buyPct: number;
}

/**
 * StockDetail.jsx:381-384 over the REAL book only. Totals cover every level
 * the book carries (a socket frame can carry more than the five shown), as
 * the web's do.
 */
export const depthSummary = (book: Pick<OrderBook, 'bids' | 'asks'> | null): DepthSummary => {
  const bids = book?.bids ?? [];
  const asks = book?.asks ?? [];
  const bidTotal = bids.reduce((s, b) => s + levelQty(b), 0);
  const askTotal = asks.reduce((s, a) => s + levelQty(a), 0);
  const total = bidTotal + askTotal;
  return { bids, asks, bidTotal, askTotal, buyPct: total ? (bidTotal / total) * 100 : 50 };
};

/** One depth column's rows: the first five, each with its bar width (% of the column's largest). */
export const depthRows = (
  rows: readonly OrderBookLevel[],
): Array<{ level: OrderBookLevel; qty: number; widthPct: number }> => {
  const max = Math.max(1, ...rows.map(levelQty));
  return rows.slice(0, DEPTH_LEVELS).map((level) => {
    const qty = levelQty(level);
    return { level, qty, widthPct: (qty / max) * 100 };
  });
};

/* ── Overview: similar ────────────────────────────────────────────────── */

/** StockDetail.jsx:386-388 — same category, not this symbol, the first six. */
export const similarInstruments = <T extends Pick<Instrument, 'symbol' | 'category'>>(
  rows: readonly T[],
  symbol: string,
  category: string | null | undefined,
): T[] => rows.filter((r) => r.symbol !== symbol && r.category === (category || 'STOCK')).slice(0, SIMILAR_MAX);

/* ── Financial performance ────────────────────────────────────────────── */

/** StockDetail.jsx:535 — the axis top. */
export const niceCeil = (v: number): number => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 3 ? 3 : n <= 5 ? 5 : n <= 7 ? 7 : 10;
  return step * p;
};

/** `1Q2025` → `Q1 '25`, `2024` → `FY '24` — StockDetail.jsx:542. */
export const fmtFinLabel = (l: string | null | undefined): string => {
  const m = /^(\d)Q(\d{4})$/.exec(l || '');
  if (m) return `Q${m[1]} '${(m[2] ?? '').slice(2)}`;
  if (/^\d{4}$/.test(l || '')) return `FY '${(l || '').slice(2)}`;
  return l || '';
};

export interface FinBar {
  label: string;
  /** Crore. */
  rev: number;
  pr: number;
}

/** Yahoo's points for the mode, in crore. Empty when Yahoo has none — no placeholder quarters. */
export const financialBars = (fund: Fundamentals | null, mode: FinMode): FinBar[] => {
  const raw: FinancialPoint[] = (mode === 'Quarterly' ? fund?.finQuarterly : fund?.finYearly) ?? [];
  return raw.map((d) => ({
    label: fmtFinLabel(d.label),
    rev: (Number(d.revenue) || 0) / 1e7,
    pr: (Number(d.profit) || 0) / 1e7,
  }));
};

const growthAt = (arr: readonly FinBar[], i: number, k: 'rev' | 'pr'): number | null => {
  const prev = arr[i - 1];
  const cur = arr[i];
  return i > 0 && prev && cur && prev[k] ? ((cur[k] - prev[k]) / Math.abs(prev[k])) * 100 : null;
};

/** The 3Y CAGR from the yearly points — StockDetail.jsx:568-573. */
export const finCagr = (fund: Fundamentals | null, k: 'revenue' | 'profit'): number | null => {
  const yearly = fund?.finYearly ?? [];
  if (yearly.length < 3) return null;
  const a = Number(yearly[0]?.[k]);
  const b = Number(yearly[yearly.length - 1]?.[k]);
  if (!(a > 0) || !(b > 0)) return null;
  return ((b / a) ** (1 / (yearly.length - 1)) - 1) * 100;
};

export interface FinancialView {
  bars: FinBar[];
  selIdx: number;
  selBar: FinBar | null;
  revG: number | null;
  prG: number | null;
  niceMax: number;
  ticks: number[];
  growth: Array<{ title: string; one: number | null; three: number | null }>;
}

/** StockDetail.jsx:552-575 — everything the Financial performance card draws. */
export const financialView = (fund: Fundamentals | null, mode: FinMode, sel: number | null): FinancialView => {
  const bars = financialBars(fund, mode);
  const selIdx = sel !== null && sel < bars.length ? sel : bars.length - 1;
  const niceMax = niceCeil(Math.max(...bars.map((b) => Math.max(b.rev, b.pr)), 1));
  return {
    bars,
    selIdx,
    selBar: bars[selIdx] ?? null,
    revG: growthAt(bars, selIdx, 'rev'),
    prG: growthAt(bars, selIdx, 'pr'),
    niceMax,
    ticks: [0, 0.25, 0.5, 0.75, 1].map((f) => niceMax * f),
    growth: [
      { title: 'Revenue Growth', one: fund?.revenueGrowth != null ? fund.revenueGrowth * 100 : null, three: finCagr(fund, 'revenue') },
      { title: 'Profit Growth', one: fund?.earningsGrowth != null ? fund.earningsGrowth * 100 : null, three: finCagr(fund, 'profit') },
    ],
  };
};

/** Axis label — `${Math.round(v / 1000)}k`. */
export const kfmt = (v: number): string => `${Math.round(v / 1000)}k`;

/** A crore figure — `${cur}${Math.round(v).toLocaleString('en-IN')}`. */
export const crfmt = (v: number, cur: StockCurrency): string =>
  `${cur.symbol}${fmtNum(Math.round(v), 0, cur.group)}`;

/* ── Technicals ───────────────────────────────────────────────────────── */

/** StockDetail.jsx:653. */
export const sma = (arr: readonly number[], n: number): number | null =>
  (arr.length < n ? null : arr.slice(-n).reduce((s, v) => s + v, 0) / n);

/** StockDetail.jsx:654-660 — a simple (not Wilder-smoothed) 14-period RSI. */
export const rsi14 = (arr: readonly number[]): number | null => {
  if (arr.length < 15) return null;
  let g = 0;
  let l = 0;
  for (let i = arr.length - 14; i < arr.length; i += 1) {
    const d = (arr[i] ?? 0) - (arr[i - 1] ?? 0);
    if (d >= 0) g += d;
    else l -= d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + (g / 14) / (l / 14));
};

export type Signal = 'Bullish' | 'Bearish' | 'Neutral';

export interface TechRow {
  indicator: string;
  value: string;
  /** '' — no signal (the web shows "—"). */
  signal: string;
  /** Bull colour when true, bear when false; null for a row with no signal. */
  positive: boolean | null;
}

export interface TechnicalsView {
  signal: Signal;
  signalColor: string;
  summary: string;
  rows: TechRow[];
  footnote: string;
}

/** TechnicalsTab — StockDetail.jsx:661-703. */
export const technicalsView = (
  candles: readonly Candle[],
  lastPrice: number | null,
  fund: Fundamentals | null,
  dayLow: number | null,
  dayHigh: number | null,
  cur: StockCurrency,
  prec: number,
): TechnicalsView => {
  const closes = candles.map((c) => c.close);
  const lp = lastPrice ?? Number.NaN;
  const mas = ([['SMA 20', sma(closes, 20)], ['SMA 50', sma(closes, 50)], ['SMA 200', sma(closes, 200)]] as Array<[string, number | null]>)
    .filter((e): e is [string, number] => e[1] !== null);
  const r = rsi14(closes);
  let bull = 0;
  let bear = 0;
  for (const [, v] of mas) {
    if (lp >= v) bull += 1;
    else bear += 1;
  }
  if (r !== null) {
    if (r >= 55) bull += 1;
    else if (r <= 45) bear += 1;
  }
  const signal: Signal = bull > bear ? 'Bullish' : bear > bull ? 'Bearish' : 'Neutral';
  const signalColor = signal === 'Bullish' ? STOCK_COLORS.up : signal === 'Bearish' ? STOCK_COLORS.bearSignal : STOCK_COLORS.neutral;
  const rows: TechRow[] = mas.map(([k, v]) => ({
    indicator: k,
    value: fmtPx(v, prec, cur),
    signal: lp >= v ? 'Bullish' : 'Bearish',
    positive: lp >= v,
  }));
  if (r !== null) {
    rows.push({
      indicator: 'RSI (14)',
      value: fmtNum(r, 2),
      signal: r >= 70 ? 'Overbought' : r <= 30 ? 'Oversold' : r >= 55 ? 'Bullish' : r <= 45 ? 'Bearish' : 'Neutral',
      positive: r >= 50,
    });
  }
  rows.push({ indicator: 'Day range', value: `${fmtPx(dayLow, prec, cur)} – ${fmtPx(dayHigh, prec, cur)}`, signal: '', positive: null });
  if (fund?.week52Low != null) {
    rows.push({
      indicator: '52-week range',
      value: `${fmtPx(fund.week52Low, prec, cur)} – ${fmtPx(fund.week52High, prec, cur)}`,
      signal: '',
      positive: null,
    });
  }
  const bullishMas = mas.filter(([, v]) => lp >= v).length;
  return {
    signal,
    signalColor,
    summary: `${bullishMas} of ${mas.length} moving averages bullish${r !== null ? ` · RSI ${fmtNum(r, 0)}` : ''}`,
    rows,
    footnote: `Computed live from ${candles.length} price candles. Not investment advice.`,
  };
};

/* ── News ─────────────────────────────────────────────────────────────── */

/**
 * The News tab's own `timeAgo` — StockDetail.jsx:706, NOT news.api's
 * newsTimeAgo (StocksInNews.jsx words it differently): "5m ago", "3h ago",
 * "2d ago".
 */
export const stockNewsAgo = (iso: string | null | undefined, nowMs: number = Date.now()): string => {
  if (!iso) return '';
  const s = (nowMs - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/** `{publisher}{publishedAt ? ' · ' + timeAgo : ''}`. */
export const newsMeta = (n: Pick<InstrumentNewsItem, 'publisher' | 'publishedAt'>, nowMs: number = Date.now()): string =>
  `${n.publisher ?? ''}${n.publishedAt ? ` · ${stockNewsAgo(n.publishedAt, nowMs)}` : ''}`;

export const newsEmptyText = (name: string): string => `No recent news for ${name}.`;

/* ── Chart ────────────────────────────────────────────────────────────── */

/** Candle open / close in epoch ms. The server's closeTime is openTime + one bucket. */
export const candleOpenMs = (c: Pick<Candle, 'time'>): number => c.time * 1000;
export const candleCloseMs = (c: Pick<Candle, 'time'>, timeframe: string): number =>
  (c.time + timeframeSeconds(timeframe)) * 1000;

/** `toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })`, device locale. */
export const fmtChartDate = (ms: number, locale?: string): string =>
  new Date(ms).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });

/** `toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })`, device locale. */
export const fmtChartDateTime = (ms: number, locale?: string): string =>
  new Date(ms).toLocaleString(locale, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** `toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })`, device locale. */
export const fmtChartTime = (ms: number, locale?: string): string =>
  new Date(ms).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', hour12: true });

/** `toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })`, device locale. */
export const fmtChartDateShort = (ms: number, locale?: string): string =>
  new Date(ms).toLocaleDateString(locale, { day: 'numeric', month: 'short' });

/**
 * The candle-mode hover label — the candle's open → close WITH time
 * (StockDetail.jsx hoverRange): a same-day candle gives the date once and a
 * time range ("12 Oct 2026 · 9:15 am – 9:20 am"); a multi-day one (weekly /
 * monthly) gives date and time on both ends.
 */
export const candleRangeLabel = (c: Pick<Candle, 'time'>, timeframe: string, locale?: string): string => {
  const open = candleOpenMs(c);
  const close = candleCloseMs(c, timeframe);
  const dLo = fmtChartDate(open, locale);
  const dHi = fmtChartDate(close, locale);
  return dLo === dHi
    ? `${dLo} · ${fmtChartTime(open, locale)} – ${fmtChartTime(close, locale)}`
    : `${dLo} ${fmtChartTime(open, locale)} – ${dHi} ${fmtChartTime(close, locale)}`;
};

/**
 * The drag-selection's span line (StockDetail.jsx): "9:15 am, 12 Oct - 3:30 pm,
 * 12 Oct" — the first candle's open and the last candle's close.
 */
export const selectionRangeLabel = (
  first: Pick<Candle, 'time'>,
  last: Pick<Candle, 'time'>,
  timeframe: string,
  locale?: string,
): string => {
  const a = candleOpenMs(first);
  const b = candleCloseMs(last, timeframe);
  return `${fmtChartTime(a, locale)}, ${fmtChartDateShort(a, locale)} - ${fmtChartTime(b, locale)}, ${fmtChartDateShort(b, locale)}`;
};

export interface ChartModel {
  n: number;
  W: number;
  H: number;
  padX: number;
  padR: number;
  padT: number;
  padB: number;
  plotB: number;
  closes: number[];
  yMin: number;
  yMax: number;
  x: (i: number) => number;
  y: (v: number) => number;
  /** Candle body width. */
  bw: number;
  vMax: number;
  volH: number;
  /** The close line, `M…L…` with one decimal, as the web builds it. */
  line: string;
  /** The line closed down to the plot bottom — the selection fill. */
  area: string;
  stroke: string;
}

/**
 * StockChart's geometry — StockDetail.jsx:1008-1037. The web draws in an
 * 800 × 320 viewBox stretched to the box; here the chart draws in pixels at
 * the measured width, with the horizontal pads scaled by width / 800 so the
 * proportions match. At W = 800, H = 320 every coordinate equals the web's.
 */
export const chartModel = (
  candles: readonly Candle[],
  mode: ChartMode,
  showVol: boolean,
  up: boolean,
  W = 800,
  H = 320,
): ChartModel => {
  const n = candles.length;
  const k = W / 800;
  const padX = 8 * k;
  const padR = 48 * k;
  const padT = mode === 'candle' ? 10 : 8;
  const padB = showVol ? 54 : 18;
  const closes = candles.map((c) => c.close);
  let yMin = Infinity;
  let yMax = -Infinity;
  let vMax = 1;
  for (const c of candles) {
    const lo = mode === 'candle' ? c.low : c.close;
    const hi = mode === 'candle' ? c.high : c.close;
    if (lo < yMin) yMin = lo;
    if (hi > yMax) yMax = hi;
    const v = Number(c.volume || 0);
    if (v > vMax) vMax = v;
  }
  if (!n) { yMin = 0; yMax = 0; }
  const span = (yMax - yMin) || 1;
  const plotB = H - padB;
  const x = (i: number): number => padX + (n > 1 ? i / (n - 1) : 0) * (W - padX - padR);
  const y = (v: number): number => padT + (1 - (v - yMin) / span) * (plotB - padT);
  const bw = Math.max(1.5, ((W - padX - padR) / Math.max(1, n)) * 0.6);
  const line = closes.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = n ? `${line} L${x(n - 1)},${plotB} L${x(0)},${plotB} Z` : '';
  return {
    n, W, H, padX, padR, padT, padB, plotB, closes, yMin, yMax, x, y, bw, vMax, volH: 40, line, area,
    stroke: up ? STOCK_COLORS.up : STOCK_COLORS.down,
  };
};

/** The candle under a horizontal position — StockDetail.jsx:1025 `idxFromX`, in the model's own units. */
export const indexAtX = (m: Pick<ChartModel, 'n' | 'W' | 'padX' | 'padR'>, rx: number): number => {
  if (m.n < 2) return 0;
  const i = Math.round(((rx - m.padX) / (m.W - m.padX - m.padR)) * (m.n - 1));
  return Math.max(0, Math.min(m.n - 1, i));
};

export interface ChartSelection { a: number; b: number }

export interface SelectionInfo {
  lo: number;
  hi: number;
  ch: number;
  p: number;
}

/** The drag-selected return — StockDetail.jsx:1039-1044. Null for no range. */
export const selectionInfo = (sel: ChartSelection | null, closes: readonly number[]): SelectionInfo | null => {
  if (!sel || sel.a === sel.b) return null;
  const lo = Math.min(sel.a, sel.b);
  const hi = Math.max(sel.a, sel.b);
  const pa = closes[lo] ?? 0;
  const pb = closes[hi] ?? 0;
  return { lo, hi, ch: pb - pa, p: pa ? ((pb - pa) / pa) * 100 : 0 };
};

/** `{+|-}{cur}{|ch|} ({+}{p}%)` — the selection tooltip. */
export const selectionLabel = (s: Pick<SelectionInfo, 'ch' | 'p'>, prec: number, cur: StockCurrency): string =>
  `${s.ch >= 0 ? '+' : '-'}${cur.symbol}${fmtNum(Math.abs(s.ch), prec, cur.group)} (${s.ch >= 0 ? '+' : ''}${fmtNum(s.p, 2)}%)`;
