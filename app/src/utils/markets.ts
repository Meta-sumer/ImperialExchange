import type {
  FnoKind,
  FnoUnderlying,
  OptionChain,
  OptionChainRow,
  OptionLeg,
  OptionLegStats,
} from '@/types/market';
import type { Candle, DashboardSummary, Instrument } from '@/types/trading';
import { getMarketSession, istParts, type MarketSession } from '@/utils/marketSession';
import { EMPTY, fmtNum } from '@/utils/money';

/**
 * The markets pages' logic — MarketList.jsx (`/markets?view=&sector=`) and
 * OptionChain.jsx (`/options?underlying=&expiry=`) — with no React in it, so
 * it tests fast and is pinned against the web's own source.
 *
 * ── HOW THE PORT READS "NO FIGURE" ───────────────────────────────────
 * The web coerces with `Number(x)`, so a `change24h: null` from the server
 * (it has no candles to compare) is 0 there. Where that only ORDERS rows —
 * the rankings, the sector average — the port keeps `Number(x)` exactly
 * (`webNum`), so the same rows land in the same places. Where it is
 * DISPLAYED, the port shows "—" instead of the web's "+0.00 (+0.00%)" or
 * "0": a missing figure is not a zero (utils/money EMPTY, PORT-RULINGS).
 *
 * ── CURRENCY ─────────────────────────────────────────────────────────
 * EquityHub is INR only: every price is rupees, grouped en-IN
 * (utils/money).
 * ──────────────────────────────────────────────────────────────────────
 */

/** JS `Number(v)` — the web's coercion (null → 0, absent → NaN). For ordering only. */
export const webNum = (v: unknown): number => (v === undefined ? Number.NaN : Number(v));

/** A finite number, or null — for DISPLAY, where absent must not read as 0. */
export const finiteOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** MarketList's `r.name || r.symbol`. */
export const listName = (r: Pick<Instrument, 'name' | 'symbol' | 'raw'>): string => {
  const serverName = r.raw ? (typeof r.raw.name === 'string' ? r.raw.name : '') : r.name;
  return serverName || r.symbol;
};

/* ══ MarketList.jsx ═════════════════════════════════════════════════════ */

type Row = Instrument;
type Comparator = (a: Row, b: Row) => number;

export type MarketViewKey = 'most-traded' | 'gainers' | 'losers' | 'volume';

export interface MarketViewConfig {
  key: MarketViewKey;
  title: string;
  caption: string;
  sort: Comparator;
}

/** MarketList.jsx VIEWS — title, caption and ranking per `?view=`. */
export const MARKET_VIEWS: Record<MarketViewKey, MarketViewConfig> = {
  'most-traded': {
    key: 'most-traded',
    title: 'Most traded markets',
    caption: 'Highest liquidity across stocks, indices, futures and commodities.',
    sort: (a, b) => {
      const va = webNum(a.volume24h) || 0;
      const vb = webNum(b.volume24h) || 0;
      if (vb !== va) return vb - va;
      return Math.abs(webNum(b.change24h) || 0) - Math.abs(webNum(a.change24h) || 0);
    },
  },
  gainers: {
    key: 'gainers',
    title: 'Top gainers',
    caption: 'Best 24h performers across the platform.',
    sort: (a, b) => (webNum(b.change24h) || -Infinity) - (webNum(a.change24h) || -Infinity),
  },
  losers: {
    key: 'losers',
    title: 'Top losers',
    caption: 'Worst 24h performers across the platform.',
    sort: (a, b) => (webNum(a.change24h) || Infinity) - (webNum(b.change24h) || Infinity),
  },
  volume: {
    key: 'volume',
    title: 'Highest volume',
    caption: 'Where the money is flowing right now.',
    sort: (a, b) => (webNum(b.volume24h) || 0) - (webNum(a.volume24h) || 0),
  },
};

export const DEFAULT_MARKET_VIEW: MarketViewKey = 'most-traded';

/** `params.get('view') || 'most-traded'`, then `VIEWS[view] || VIEWS['most-traded']`. */
export const marketViewConfig = (view: string | null | undefined): MarketViewConfig => {
  const key = view || DEFAULT_MARKET_VIEW;
  return Object.prototype.hasOwnProperty.call(MARKET_VIEWS, key)
    ? MARKET_VIEWS[key as MarketViewKey]
    : MARKET_VIEWS[DEFAULT_MARKET_VIEW];
};

/** `?view=sectors` renders the sector table instead. */
export const isSectorsView = (view: string | null | undefined): boolean => view === 'sectors';

/* ── Sectors — Indian market segments ────────────────────────────────── */

const cat = (r: Pick<Row, 'category'>): string => String(r.category || '').toUpperCase();
const seg = (r: Pick<Row, 'segment'>): string => String(r.segment || '').toUpperCase();
const isDerivative = (r: Pick<Row, 'segment'>): boolean => seg(r) === 'FUT' || seg(r) === 'OPT';
const isFuture = (r: Pick<Row, 'segment'>): boolean => seg(r) === 'FUT';
const isCommodity = (r: Pick<Row, 'exchange' | 'category'>): boolean =>
  String(r.exchange || '').toUpperCase() === 'MCX' || cat(r) === 'COMMODITY';
const isIndex = (r: Pick<Row, 'category' | 'segment'>): boolean => cat(r) === 'INDEX' && !isDerivative(r);
const isStock = (r: Pick<Row, 'category' | 'segment'>): boolean => cat(r) === 'STOCK' && !isDerivative(r);

export interface SectorDef {
  key: string;
  label: string;
  tint: string;
  match: (r: Row) => boolean;
}

/**
 * MarketList.jsx SECTOR_DEFS — four segments plus two refinements. Indices
 * and Stocks are spot only; futures (NFO / BFO / MCX) sit under Futures.
 */
export const SECTOR_DEFS: readonly SectorDef[] = [
  { key: 'indices', label: 'Indices', tint: '#3B82F6', match: isIndex },
  { key: 'stocks', label: 'Stocks', tint: '#8B5CF6', match: isStock },
  { key: 'futures', label: 'Futures', tint: '#0EA5E9', match: isFuture },
  { key: 'idxfut', label: 'Index Futures', tint: '#10B981', match: (r) => isFuture(r) && cat(r) === 'INDEX' },
  { key: 'comm', label: 'Commodities', tint: '#A16207', match: isCommodity },
  {
    key: 'gold',
    label: 'Precious Metals',
    tint: '#D4A017',
    match: (r) => isCommodity(r) && /^(GOLD|SILVER)/.test((r.underlying || r.symbol || '').toUpperCase()),
  },
];

/** `?sector=<key>` — `SECTOR_DEFS.find((s) => s.key === params.get('sector')) || null`. */
export const sectorFor = (key: string | null | undefined): SectorDef | null =>
  SECTOR_DEFS.find((s) => s.key === key) ?? null;

/** The ranked list: narrowed to the `?sector=` when there is one, then sorted. A new array. */
export const sortMarketRows = (
  rows: readonly Row[],
  view: string | null | undefined,
  sector: Pick<SectorDef, 'match'> | null = null,
): Row[] => (sector ? rows.filter(sector.match) : [...rows]).sort(marketViewConfig(view).sort);

/** The page title: `{cfg.title}{sector ? ` · ${sector.label}` : ''}`. */
export const marketListTitle = (view: string | null | undefined, sector: Pick<SectorDef, 'label'> | null): string =>
  `${marketViewConfig(view).title}${sector ? ` · ${sector.label}` : ''}`;

export interface SectorSummary {
  key: string;
  label: string;
  tint: string;
  matches: Row[];
  /** Mean 24h change of the members, in % (the web's own average). */
  perf: number;
  gainers: number;
  losers: number;
  /** The best 24h performer — where tapping the sector goes. */
  top: Row | undefined;
}

/** SectorsListView's useMemo — empty sectors dropped, best average first. */
export const summariseSectors = (rows: readonly Row[]): SectorSummary[] =>
  SECTOR_DEFS
    .map((s): SectorSummary | null => {
      const matches = rows.filter(s.match);
      if (!matches.length) return null;
      const changes = matches.map((r) => webNum(r.change24h)).filter(Number.isFinite);
      const perf = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
      const gainers = matches.filter((r) => webNum(r.change24h) > 0).length;
      const losers = matches.filter((r) => webNum(r.change24h) < 0).length;
      const top = [...matches].sort(
        (a, b) => (webNum(b.change24h) || 0) - (webNum(a.change24h) || 0),
      )[0];
      return { key: s.key, label: s.label, tint: s.tint, matches, perf, gainers, losers, top };
    })
    .filter((s): s is SectorSummary => s !== null)
    .sort((a, b) => b.perf - a.perf);

/** The gainers/losers bar: `total = g + l || 1`, as a percentage each. */
export const sectorBar = (s: Pick<SectorSummary, 'gainers' | 'losers' | 'perf'>): { gPct: number; lPct: number; positive: boolean } => {
  const total = s.gainers + s.losers || 1;
  return { gPct: (s.gainers / total) * 100, lPct: (s.losers / total) * 100, positive: s.perf >= 0 };
};

/** `{positive ? '+' : ''}{perf.toFixed(2)}%` */
export const sectorPerfText = (perf: number): string => `${perf >= 0 ? '+' : ''}${perf.toFixed(2)}%`;

/** `{n} instruments · Top {symbol || '—'}` */
export const sectorCaption = (s: Pick<SectorSummary, 'matches' | 'top'>): string =>
  `${s.matches.length} instruments · Top ${s.top?.symbol || '—'}`;

/* ── Top movers card ─────────────────────────────────────────────────── */

export const TOP_MOVER_TABS = ['Gainers', 'Losers', 'Most Active'] as const;
export type TopMoverTab = (typeof TOP_MOVER_TABS)[number];

const MOVER_SORTERS: Record<TopMoverTab, Comparator> = {
  Gainers: (a, b) => (webNum(b.change24h) || -Infinity) - (webNum(a.change24h) || -Infinity),
  Losers: (a, b) => (webNum(a.change24h) || Infinity) - (webNum(b.change24h) || Infinity),
  'Most Active': (a, b) => (webNum(b.volume24h) || 0) - (webNum(a.volume24h) || 0),
};

/** TopMoversCard's list — three rows for the tab. */
export const topMovers = (rows: readonly Row[], tab: TopMoverTab): Row[] =>
  [...rows].sort(MOVER_SORTERS[tab] ?? MOVER_SORTERS.Gainers).slice(0, 3);

/* ── Row figures ─────────────────────────────────────────────────────── */

/** `Math.min(Number(precision) || 2, 6)` — the list's price decimals. */
export const listPriceDecimals = (precision: unknown): number => Math.min(Number(precision) || 2, 6);

/** `Math.min(Number(precision) || 2, 4)` — the change's decimals. */
export const listChangeDecimals = (precision: unknown): number => Math.min(Number(precision) || 2, 4);

/** MarketList's fmtPrice — the instrument's own precision, rupee grouping. */
export const fmtListPrice = (raw: unknown, precision: unknown, currency?: string | null): string => {
  const v = finiteOrNull(raw);
  if (v === null) return EMPTY;
  return fmtNum(v, listPriceDecimals(precision), currency || 'INR');
};

/** MarketList.jsx fmtVolume — compact B / M / K, "—" for none. */
export const fmtVolume = (raw: unknown): string => {
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return EMPTY;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return v.toFixed(0);
};

export interface ListChange {
  /** Colour and sparkline direction: `change >= 0`, and up when unknown (the web's default). */
  positive: boolean;
  /** The two parts, or null when there is no change figure to show. */
  abs: string | null;
  pct: string | null;
}

/**
 * The table's second line — `+12.34 (+0.56%)` / `-12.34 (-0.56%)` — the
 * rupee move backed out as `price × change / 100`.
 */
export const listChange = (row: Pick<Row, 'change24h' | 'pricePrecision' | 'quoteCurrency'>, price: unknown): ListChange => {
  const change = finiteOrNull(row.change24h);
  const p = finiteOrNull(price);
  const positive = change === null ? true : change >= 0;
  if (change === null || p === null) return { positive, abs: null, pct: null };
  const absChange = (p * change) / 100;
  const sign = positive ? '+' : '-';
  return {
    positive,
    abs: `${sign}${fmtNum(Math.abs(absChange), listChangeDecimals(row.pricePrecision), row.quoteCurrency || 'INR')}`,
    pct: `(${sign}${Math.abs(change).toFixed(2)}%)`,
  };
};

/**
 * TopMoversCard's line — `{+}{|abs|} ({+}{change}%)`. Note the web prints
 * the absolute move WITHOUT a minus for a loser (the colour carries it);
 * kept, it is what a trader sees on the web.
 */
export const moverChange = (row: Pick<Row, 'change24h' | 'pricePrecision' | 'quoteCurrency'>, price: unknown): { positive: boolean; text: string } | null => {
  const change = finiteOrNull(row.change24h);
  if (change === null) return null;
  const p = finiteOrNull(price);
  const positive = change >= 0;
  const plus = positive ? '+' : '';
  const pct = `(${plus}${change.toFixed(2)}%)`;
  if (p === null) return { positive, text: pct };
  const abs = fmtNum(Math.abs((p * change) / 100), listChangeDecimals(row.pricePrecision), row.quoteCurrency || 'INR');
  return { positive, text: `${plus}${abs} ${pct}` };
};

/* ── Decorative sparkline ────────────────────────────────────────────── */

/**
 * MarketList.jsx synthSpark — NOT market data. The web draws a fixed wiggle
 * rising or falling with the sign of the 24h change, seeded by row index,
 * and shows it only at `sm:` (≥ 640px) and up. Ported as the web has it,
 * with the same breakpoint.
 */
export const synthSpark = (change: unknown, seed = 0): number[] => {
  const ch = Number(change);
  const dir = !Number.isFinite(ch) ? 0 : ch >= 0 ? 1 : -1;
  const N = 24;
  const start = 50 - dir * 12;
  const end = 50 + dir * 12;
  const pts: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const wiggle = Math.sin((i + seed) * 0.9) * 3 + Math.sin((i + seed) * 2.1) * 1.5;
    pts.push(start + (end - start) * t + wiggle);
  }
  return pts;
};

/** The web Sparkline's SVG path for `points` in a width × height box. */
export const sparkPath = (points: readonly number[], width: number, height: number): string | null => {
  if (!points.length) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = Math.max(max - min, 1);
  const step = width / (points.length - 1);
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(2)} ${(height - ((p - min) / span) * (height - 4) - 2).toFixed(2)}`)
    .join(' ');
};

/** The table's sparkline column is `hidden sm:block`. */
export const SPARKLINE_MIN_WIDTH = 640;

/* ── Portfolio card ──────────────────────────────────────────────────── */

export interface PortfolioFigures {
  currentValue: number;
  investedValue: number;
  totalReturns: number;
  returnsPct: number;
  positive: boolean;
  /** Always INR on EquityHub. */
  currency: string;
}

/**
 * PortfolioCard's arithmetic, from `/user/dashboard`, as the web does it:
 *
 *   current  = live cash (the primary-currency balance; if that is 0, every
 *              live currency summed) + unrealised P&L
 *   invested = lifetime net deposits if reported, else the cost of the open
 *              positions (margin, else entry × qty ÷ leverage)
 *   returns  = current − invested
 *
 * The server sends neither deposits nor a position's margin or leverage
 * (dashboardController.getDashboard), so on the web — and here — invested is
 * Σ entry × quantity of the open live positions. The card prints "₹".
 */
export const portfolioFigures = (data: DashboardSummary | null): PortfolioFigures => {
  const liveByCur = data?.balance.liveByCurrency ?? {};
  let liveCash = Number(data?.balance.live || 0);
  if (liveCash === 0) {
    liveCash = Object.values(liveByCur).reduce((sum, t) => sum + (Number(t?.balance) || 0), 0);
  }
  const unrealised = Number(data?.equity.unrealizedPnl || 0);
  const currentValue = liveCash + unrealised;

  const open = data?.equity.openPositions ?? [];
  let investedValue = 0;
  if (open.length) {
    investedValue = open.reduce((sum, p) => {
      const entry = Number(p.entryPrice) || 0;
      const qty = Number(p.quantity) || 0;
      // No margin / leverage in the payload → the web's 1× fallback.
      return sum + (entry * qty) / 1;
    }, 0);
  }

  const diff = currentValue - investedValue;
  const totalReturns = Number.isFinite(diff) ? diff : 0;
  const returnsPct = investedValue > 0 ? (totalReturns / investedValue) * 100 : 0;
  return { currentValue, investedValue, totalReturns, returnsPct, positive: totalReturns >= 0, currency: 'INR' };
};

export const HIDDEN_VALUE = '••••••';
export const HIDDEN_RETURNS = '••••';

/** `{+}{fmtNum(totalReturns, 2)}` and `({+}{pct.toFixed(2)}%)`. */
export const portfolioReturnsText = (f: PortfolioFigures): { value: string; pct: string } => {
  const plus = f.positive ? '+' : '';
  return { value: `${plus}${fmtNum(f.totalReturns, 2, f.currency)}`, pct: `(${plus}${f.returnsPct.toFixed(2)}%)` };
};

/* ── Explore card ────────────────────────────────────────────────────── */

export type ExploreTileIcon = 'indices' | 'stocks' | 'futures' | 'commodities';

/** ExploreLinksCard's tiles — each opens the most-traded list narrowed to its segment. */
export const EXPLORE_TILES: readonly {
  label: string;
  tint: string;
  view: MarketViewKey;
  sector: string;
  icon: ExploreTileIcon;
}[] = [
  { label: 'Indices', tint: '#3B82F6', view: 'most-traded', sector: 'indices', icon: 'indices' },
  { label: 'Stocks', tint: '#8B5CF6', view: 'most-traded', sector: 'stocks', icon: 'stocks' },
  { label: 'Futures', tint: '#0EA5E9', view: 'most-traded', sector: 'futures', icon: 'futures' },
  { label: 'Commodities', tint: '#D4A017', view: 'most-traded', sector: 'comm', icon: 'commodities' },
];

/** MarketList's fixed up / down colours (green-600 / red-600, inline on the web). */
export const LIST_UP = '#16A34A';
export const LIST_DOWN = '#DC2626';

/* ── Candle sparkline ────────────────────────────────────────────────── */

export interface CandleMark {
  cx: number;
  yHigh: number;
  yLow: number;
  top: number;
  height: number;
  bodyW: number;
  green: boolean;
}

/** A candlestick sparkline's geometry in a W × H box. Null under two candles. */
export const candleSparkMarks = (
  candles: readonly Pick<Candle, 'open' | 'high' | 'low' | 'close'>[] | null | undefined,
  W = 140,
  H = 48,
): CandleMark[] | null => {
  if (!candles || candles.length < 2) return null;
  const n = candles.length;
  const lo = Math.min(...candles.map((c) => c.low));
  const hi = Math.max(...candles.map((c) => c.high));
  const span = hi - lo || 1;
  const y = (v: number) => H - ((v - lo) / span) * (H - 4) - 2;
  const cw = W / n;
  const bodyW = Math.max(1.6, cw * 0.55);
  return candles.map((c, i) => {
    const yO = y(c.open);
    const yC = y(c.close);
    return {
      cx: i * cw + cw / 2,
      yHigh: y(c.high),
      yLow: y(c.low),
      top: Math.min(yO, yC),
      height: Math.max(1, Math.abs(yC - yO)),
      bodyW,
      green: c.close >= c.open,
    };
  });
};

/* ══ OptionChain.jsx ═══════════════════════════════════════════════════ */

/** The segment tabs, in the web's order and words. */
export const OPTION_CHAIN_KINDS: readonly { key: FnoKind; label: string }[] = [
  { key: 'INDEX', label: 'Index' },
  { key: 'STOCK', label: 'Stocks' },
  { key: 'COMMODITY', label: 'Commodity (MCX)' },
];

/** The chain re-polls this often while it is on screen (POLL_MS). */
export const OPTION_CHAIN_POLL_MS = 3000;

/** The Greeks toggle — the web's localStorage key, kept in AsyncStorage here. */
export const GREEKS_STORAGE_KEY = 'eh:oc:greeks';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `₹{fmtNum(v, d)}` for a positive price, else "—" — the web's `inr`. */
export const inr = (v: unknown, d = 2): string => (Number(v) > 0 ? `₹${fmtNum(Number(v), d, 'INR')}` : EMPTY);

/** `2026-10-27` → "27 Oct". */
export const expiryLabel = (ymd: string): string => {
  const [, m, d] = ymd.split('-');
  return `${Number(d)} ${MON[Number(m) - 1] ?? ''}`;
};

/** IST today as `YYYY-MM-DD`. */
export const istToday = (nowMs: number): string => new Date(nowMs + 5.5 * 3600e3).toISOString().slice(0, 10);

/** Whole days from IST today to the expiry. */
export const daysTo = (ymd: string, nowMs: number = Date.now()): number =>
  Math.round((Date.parse(ymd) - Date.parse(istToday(nowMs))) / 864e5);

/** The chip's muted suffix: "today", else "3d". */
export const expiryDaysText = (d: number): string => (d <= 0 ? 'today' : `${d}d`);

/** A strike: whole numbers bare, else two decimals (`Number.isInteger(strike) ? 0 : 2`). */
export const fmtStrike = (v: number | null | undefined): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return EMPTY;
  return fmtNum(v, Number.isInteger(v) ? 0 : 2, 'INR');
};

/**
 * Indian-style compact counts: 12.5K · 3.25L · 1.40Cr. A missing figure is
 * "—" — the web's `Number(null)` reads 0 there, but an OI the feed did not
 * send is not an OI of zero.
 */
export const compactCount = (v: number | null | undefined): string => {
  if (v === null || v === undefined) return EMPTY;
  const n = Number(v);
  if (!Number.isFinite(n)) return EMPTY;
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
};

const fixed = (dp: number) => (v: number | null | undefined): string =>
  (v === null || v === undefined || !Number.isFinite(v) ? EMPTY : v.toFixed(dp));

const signedCompact = (v: number | null | undefined): string =>
  (v === null || v === undefined ? EMPTY : `${v > 0 ? '+' : ''}${compactCount(v)}`);

export type ChainStatKey = keyof OptionLegStats;

export interface ChainColumn {
  key: ChainStatKey;
  label: string;
  fmt: (v: number | null | undefined) => string;
  /** OI: a bar sized to the chain's largest OI. */
  bar?: boolean;
  /** Chg OI: green when up, red when down. */
  tone?: boolean;
}

/**
 * The analytics columns, outward from the strike on the CALL side (the PUT
 * side mirrors them). The web hides the less essential ones by breakpoint;
 * on a phone the table scrolls sideways instead, so all of them show.
 */
export const BASE_COLS: readonly ChainColumn[] = [
  { key: 'oi', label: 'OI', fmt: compactCount, bar: true },
  { key: 'oiChange', label: 'Chg OI', fmt: signedCompact, tone: true },
  { key: 'iv', label: 'IV', fmt: fixed(1) },
];

export const GREEK_COLS: readonly ChainColumn[] = [
  ...BASE_COLS,
  { key: 'volume', label: 'Vol', fmt: compactCount },
  { key: 'delta', label: 'Δ Delta', fmt: fixed(2) },
  { key: 'theta', label: 'Θ Theta', fmt: fixed(2) },
  { key: 'gamma', label: 'Γ Gamma', fmt: fixed(4) },
  { key: 'vega', label: 'V Vega', fmt: fixed(2) },
];

/** Which columns the table carries: none without analytics, the Greeks when toggled on. */
export const chainColumns = (hasAnalytics: boolean, showGreeks: boolean): readonly ChainColumn[] =>
  (hasAnalytics ? (showGreeks ? GREEK_COLS : BASE_COLS) : []);

/** The largest OI on either side — the OI bars are a share of it. */
export const maxOiOf = (strikes: readonly OptionChainRow[]): number => {
  let m = 0;
  for (const s of strikes) m = Math.max(m, s.CE?.stats?.oi || 0, s.PE?.stats?.oi || 0);
  return m;
};

/** An OI bar's width in %: at least 2 for any OI, 0 for none. */
export const oiBarPct = (v: number | null | undefined, maxOi: number): number =>
  (v !== null && v !== undefined && v > 0 && maxOi > 0 ? Math.max(2, Math.round((v / maxOi) * 100)) : 0);

/** A tone column's colour: 'bull' up, 'bear' down, 'plain' flat, 'muted' with no figure. */
export const statTone = (col: Pick<ChainColumn, 'tone'>, v: number | null | undefined): 'bull' | 'bear' | 'plain' | 'muted' => {
  if (!col.tone || v === null || v === undefined) return 'muted';
  return v > 0 ? 'bull' : v < 0 ? 'bear' : 'plain';
};

/** Where the spot sits between strikes — the divider row goes before this index (-1: no spot). */
export const spotIndexOf = (strikes: readonly OptionChainRow[], spot: number): number => {
  if (!(spot > 0) || !strikes.length) return -1;
  const i = strikes.findIndex((s) => s.strike > spot);
  return i === -1 ? strikes.length : i;
};

/** CALL is in the money below the spot, PUT above it. */
export const ceIsItm = (strike: number, spot: number): boolean => spot > 0 && strike < spot;
export const peIsItm = (strike: number, spot: number): boolean => spot > 0 && strike > spot;

/** A premium: `px > 0 ? fmtNum(px, 2) : '—'`. */
export const legPremiumText = (leg: Pick<OptionLeg, 'lastPrice'> | null | undefined): string => {
  const px = Number(leg?.lastPrice);
  return px > 0 ? fmtNum(px, 2, 'INR') : EMPTY;
};

/** The kinds that have at least one underlying with option expiries — the tabs offered. */
export const kindsAvailable = (list: readonly FnoUnderlying[]): { key: FnoKind; label: string }[] =>
  OPTION_CHAIN_KINDS.filter((k) => list.some((u) => u.kind === k.key && u.optionExpiries.length > 0));

/** The underlyings of one kind that list options. */
export const underlyingsOfKind = (list: readonly FnoUnderlying[], kind: FnoKind): FnoUnderlying[] =>
  list.filter((u) => u.kind === kind && u.optionExpiries.length > 0);

/** `current?.kind || kindTab || kindsAvailable[0]?.key || 'INDEX'`. */
export const activeKind = (
  current: Pick<FnoUnderlying, 'kind'> | null,
  kindTab: FnoKind | null,
  list: readonly FnoUnderlying[],
): FnoKind => current?.kind || kindTab || kindsAvailable(list)[0]?.key || 'INDEX';

/** The stock select's option text: `RELIANCE — Reliance Industries`, the bare symbol when the name adds nothing. */
export const underlyingOptionLabel = (u: Pick<FnoUnderlying, 'underlying' | 'name'>): string =>
  `${u.underlying}${u.name && u.name !== u.underlying ? ` — ${u.name}` : ''}`;

/** The summary card's caption over the spot price. */
export const spotCaption = (
  current: Pick<FnoUnderlying, 'underlying' | 'name'>,
  chain: Pick<OptionChain, 'spot'> | null,
): string => (chain?.spot?.isFuture
  ? `${current.underlying} future (${chain.spot.symbol})`
  : (current.name || current.underlying));

/** ` lots`-style unit note: ` barrels` for MCX contracts that carry one, else nothing. */
export const unitNote = (chain: Pick<OptionChain, 'contractUnit'> | null): string =>
  (chain?.contractUnit ? ` ${chain.contractUnit}` : '');

/** The summary card's stat cells, in the web's order; the analytics three only with analytics. */
export const chainStats = (chain: OptionChain | null): { label: string; value: string }[] => {
  const note = unitNote(chain);
  const out = [
    { label: 'Lot size', value: chain?.lotSize ? `${chain.lotSize}${note}` : EMPTY },
    { label: 'ATM strike', value: chain?.atmStrike !== null && chain?.atmStrike !== undefined ? fmtStrike(chain.atmStrike) : EMPTY },
    { label: 'Expiry', value: chain?.expiry ? `${expiryLabel(chain.expiry)} ${chain.expiry.slice(0, 4)}` : EMPTY },
  ];
  const an = chain?.analytics;
  if (an) {
    out.push(
      { label: 'PCR (OI)', value: an.pcr !== null ? an.pcr.toFixed(2) : EMPTY },
      { label: 'Max pain', value: an.maxPain !== null ? fmtStrike(an.maxPain) : EMPTY },
      { label: 'Call OI / Put OI', value: `${compactCount(an.ceOi)} / ${compactCount(an.peOi)}` },
    );
  }
  return out;
};

const timeOfDay = (d: Date): string => {
  try {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return d.toTimeString().slice(0, 8);
  }
};

/**
 * "OI, IV & Greeks via Dhan · 2:32:05 pm" — when Dhan's figures were taken,
 * in the device's locale and zone (PORT-RULINGS §5; the web's
 * toLocaleTimeString uses the browser's zone too).
 */
export const analyticsCaption = (asOf: string | null, fmtTime: (d: Date) => string = timeOfDay): string => {
  const base = 'OI, IV & Greeks via Dhan';
  if (!asOf) return base;
  const t = Date.parse(asOf);
  if (Number.isNaN(t)) return base;
  return `${base} · ${fmtTime(new Date(t))}`;
};

/** The footnote under the table, verbatim. */
export const optionChainFootnote = (chain: Pick<OptionChain, 'lotSize' | 'contractUnit'> | null): string => {
  const note = unitNote(chain);
  return `Shaded cells are in the money. Premiums are per unit; one lot is ${chain?.lotSize || '—'}${note}, so a lot costs premium × ${chain?.lotSize || 'lot size'}. `
    + 'Options can be bought (calls or puts) and sold to close; selling to open (option writing) isn’t available. '
    + 'Open positions are squared off shortly before expiry, and anything still open at expiry settles at intrinsic value.';
};

export const OPTION_CHAIN_SUBTITLE =
  'Live call and put premiums for index, stock and MCX commodity options. Tap a premium to trade that contract.';
export const OPTION_CHAIN_EMPTY_TITLE = 'Option chains aren’t available right now';
export const OPTION_CHAIN_EMPTY_BODY =
  'F&O trading is switched off or today’s contracts haven’t been listed yet. Please check back shortly.';
export const noOptionsText = (underlying: string): string =>
  `${underlying} has no options listed on EquityHub. Pick an underlying above.`;

/**
 * The session badge on the summary card: MCX commodity F&O trades 09:00–23:30
 * IST, Mon–Fri (utils/marketSession.js `mcxSession` — the server-side gate in
 * marketHours.js is authoritative, this is UI only); everything else is the
 * app's getMarketSession.
 */
export const chainSession = (
  exchange: string | null | undefined,
  kind: string | null | undefined,
  now: Date = new Date(),
): MarketSession => {
  if (String(exchange || '').toUpperCase() !== 'MCX') return getMarketSession({ exchange, category: kind }, now);
  const { day, mins } = istParts(now);
  if (day === 0 || day === 6) return { isOpen: false, label: 'Market Closed', detail: 'MCX closed on weekends', tz: 'IST' };
  const open = 9 * 60;
  const close = 23 * 60 + 30;
  if (mins < open) return { isOpen: false, label: 'Pre-open', detail: 'MCX opens 09:00 IST', tz: 'IST' };
  if (mins >= close) return { isOpen: false, label: 'Market Closed', detail: 'MCX closes 23:30 IST', tz: 'IST' };
  return { isOpen: true, label: 'MCX open', tz: 'IST' };
};
