import type { Decimal, Instrument, OrderSide } from '@/types/trading';
import { canonicalAmount } from '@/utils/fundsFlows';
import { EMPTY, fmtMoney, fmtNum, fmtPrice } from '@/utils/money';

/**
 * The Explore page's logic — client/src/pages/Explore.jsx — and the pure half
 * of PositionSlTpModal.jsx, without React, so every number and label the
 * screen shows can be pinned against the web's own source by a test.
 *
 * Numbers follow the web's JavaScript on purpose: `Number(null)` is 0 there,
 * so an instrument whose 24h change the server reported as null reads
 * "+0.00%" and counts as 0 in a sector's average — exactly as on the web.
 *
 * Formatting goes through utils/money (rupees, en-IN grouping, a dash for a
 * missing figure — PORT-RULINGS §5), never toLocaleString.
 */

/* ══ Copy ═════════════════════════════════════════════════════════════ */

/** The web's colours for up / down on this page (not the theme's bull/bear). */
export const UP_COLOR = '#16A34A';
export const DOWN_COLOR = '#DC2626';
export const NO_CHANGE_COLOR = '#9CA3AF';

/**
 * Explore.jsx's fixed wording. EquityHub has one Explore — Indian markets
 * only — so there is no per-market copy.
 */
export const EXPLORE_COPY = {
  mostTraded: 'Top liquidity across all markets today',
  movers: 'Top names by performance over the last 24h.',
  emptyTrade: 'Fund your account and place your first trade on NSE, BSE or MCX.',
} as const;

/* ══ Segments and sectors — Indian market segments ════════════════════ */

const cat = (r: Pick<Instrument, 'category'>): string => (r.category || '').toUpperCase();
const seg = (r: Pick<Instrument, 'segment'>): string => (r.segment || '').toUpperCase();
const isDerivative = (r: Pick<Instrument, 'segment'>): boolean => seg(r) === 'FUT' || seg(r) === 'OPT';
const isFuture = (r: Pick<Instrument, 'segment'>): boolean => seg(r) === 'FUT';
const isCommodity = (r: Pick<Instrument, 'exchange' | 'category'>): boolean =>
  (r.exchange || '').toUpperCase() === 'MCX' || cat(r) === 'COMMODITY';
const isIndex = (r: Pick<Instrument, 'category' | 'segment'>): boolean => cat(r) === 'INDEX' && !isDerivative(r);
const isStock = (r: Pick<Instrument, 'category' | 'segment'>): boolean => cat(r) === 'STOCK' && !isDerivative(r);

export type SectorGlyph = 'stars' | 'bank' | 'layers' | 'bolt' | 'barrel' | 'ingot';

export interface SectorDef {
  key: string;
  label: string;
  icon: SectorGlyph;
  tint: string;
  match: (r: Instrument) => boolean;
}

/**
 * Explore.jsx SECTOR_DEFS — the Instrument model carries no sector metadata,
 * so the page groups by market segment: spot indices, cash stocks, futures
 * (NFO / BFO / MCX) and MCX commodities, plus two refinements (Index Futures,
 * Precious Metals). Indices / Stocks are spot only.
 */
export const SECTOR_DEFS: readonly SectorDef[] = [
  { key: 'indices', label: 'Indices', icon: 'stars', tint: '#3B82F6', match: isIndex },
  { key: 'stocks', label: 'Stocks', icon: 'bank', tint: '#8B5CF6', match: isStock },
  { key: 'futures', label: 'Futures', icon: 'layers', tint: '#0EA5E9', match: isFuture },
  { key: 'idxfut', label: 'Index Futures', icon: 'bolt', tint: '#10B981', match: (r) => isFuture(r) && cat(r) === 'INDEX' },
  { key: 'comm', label: 'MCX Commodities', icon: 'barrel', tint: '#A16207', match: isCommodity },
  {
    key: 'gold',
    label: 'Precious Metals',
    icon: 'ingot',
    tint: '#D4A017',
    match: (r) => isCommodity(r) && /^(GOLD|SILVER)/.test((r.underlying || r.symbol || '').toUpperCase()),
  },
];

export interface MoverSegment {
  key: string;
  label: string;
  match: (r: Instrument) => boolean;
}

/** Explore.jsx MOVER_SEGMENTS — the market movers' multi-select, same matchers as the sectors. */
export const MOVER_SEGMENTS: readonly MoverSegment[] = [
  { key: 'INDEX', label: 'Indices', match: isIndex },
  { key: 'STOCK', label: 'Stocks', match: isStock },
  { key: 'COMMODITY', label: 'MCX', match: isCommodity },
];

export interface SectorRow extends SectorDef {
  matches: Instrument[];
  perf: number;
  gainers: number;
  losers: number;
  top: Instrument | undefined;
}

/** Explore.jsx `sectors` — hidden when empty, strongest average first. */
export const sectorRows = (lived: readonly Instrument[]): SectorRow[] =>
  SECTOR_DEFS
    .map((s): SectorRow | null => {
      const matches = lived.filter(s.match);
      if (!matches.length) return null;
      const changes = matches.map((r) => Number(r.change24h)).filter(Number.isFinite);
      const perf = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
      const gainers = matches.filter((r) => Number(r.change24h) > 0).length;
      const losers = matches.filter((r) => Number(r.change24h) < 0).length;
      const top = [...matches].sort((a, b) => (Number(b.change24h) || 0) - (Number(a.change24h) || 0))[0];
      return { ...s, matches, perf, gainers, losers, top };
    })
    .filter((s): s is SectorRow => s !== null)
    .sort((a, b) => b.perf - a.perf);

/** GainersLosersBar: segment widths in percent; an idle sector is an even split. */
export const gainersLosersSplit = (gainers: number, losers: number): { gPct: number; lPct: number } => {
  const total = (gainers || 0) + (losers || 0);
  return {
    gPct: total ? (gainers / total) * 100 : 50,
    lPct: total ? (losers / total) * 100 : 50,
  };
};

/** "+1.23%" for a sector's average. */
export const fmtSectorPerf = (perf: number): string => `${perf >= 0 ? '+' : ''}${fmtNum(perf, 2)}%`;

/* ══ Products & Tools ═════════════════════════════════════════════════ */

export type ProductGlyph = 'user' | 'doller' | 'copy' | 'diamond' | 'headset' | 'signal' | 'bot';

/** Where a tile goes — the web path it links to, as the app route. */
export type ProductTarget = 'Wallet' | 'Partner' | 'Plans' | 'Helpdesk' | 'Alerts' | 'Trade';

export interface Product {
  /** The web's `to`, kept for the key and the tests. */
  to: string;
  route: ProductTarget;
  label: string;
  caption: string;
  icon: ProductGlyph;
  tint: string;
}

/** Explore.jsx PRODUCTS, verbatim. `/accounts` redirects to `/wallet` (App.jsx). */
export const PRODUCTS: readonly Product[] = [
  { to: '/accounts', route: 'Wallet', label: 'Trading Account', caption: 'Manage demo & real accounts', icon: 'user', tint: '#1D4ED8' },
  { to: '/ib-room', route: 'Partner', label: 'IB Room', caption: 'Partner & copy-trading hub', icon: 'copy', tint: '#2563EB' },
  { to: '/plans', route: 'Plans', label: 'Plans & Pricing', caption: 'Compare account tiers', icon: 'diamond', tint: '#8B5CF6' },
  { to: '/helpdesk', route: 'Helpdesk', label: 'Helpdesk', caption: 'Talk to our support team', icon: 'headset', tint: '#EC4899' },
  { to: '/alerts', route: 'Alerts', label: 'Signals & Alerts', caption: 'Price-based entry alerts', icon: 'signal', tint: '#3B82F6' },
  { to: '/trade', route: 'Trade', label: 'Trading Terminal', caption: 'Open the pro chart', icon: 'bot', tint: '#0EA5E9' },
];

/* ══ Live prices ══════════════════════════════════════════════════════ */

/** One symbol's live state — Explore.jsx `priceMap[sym]`. */
export interface LivePrice {
  /** `String(Number(lastPrice))`. */
  last: string;
  /** The feed's own 24h %, when one was ever pushed; else undefined. */
  change: number | undefined;
}

export type PriceMap = Record<string, LivePrice>;

/** The fields of a tick this page reads. */
export interface TickLike {
  lastPrice?: Decimal | number | null;
  change24h?: number | null;
}

/**
 * One tick folded into the pending buffer — the web's per-tick reducer
 * (Explore.jsx:461-473), split in two so ticks can be coalesced: an unusable
 * price is dropped whole, and a tick without a 24h % keeps the one already
 * buffered. Returns the buffered entry, or null to drop the tick.
 */
export const bufferTick = (pending: LivePrice | undefined, tick: TickLike): LivePrice | null => {
  const last = Number(tick.lastPrice ?? undefined);
  if (!Number.isFinite(last) || last <= 0) return null;
  const change = tick.change24h === null || tick.change24h === undefined ? NaN : Number(tick.change24h);
  return {
    last: String(last),
    change: Number.isFinite(change) ? change : pending?.change,
  };
};

/**
 * Apply buffered ticks to the price map — the rest of the web reducer. A
 * symbol whose price and % did not move leaves the map untouched, and a
 * flush that moved nothing returns the SAME object, so nothing re-renders.
 */
export const applyTicks = (prev: PriceMap, pending: ReadonlyMap<string, LivePrice>): PriceMap => {
  let next: PriceMap | null = null;
  for (const [sym, p] of pending) {
    const cur = (next ?? prev)[sym];
    const nextChange = p.change !== undefined ? p.change : (cur ? cur.change : undefined);
    if (cur && cur.last === p.last && cur.change === nextChange) continue;
    next = next ?? { ...prev };
    next[sym] = { last: p.last, change: nextChange };
  }
  return next ?? prev;
};

/**
 * Instruments with the live price and 24h % applied (Explore.jsx `lived`).
 * Most feeds push only a price, so the % is re-derived from the baseline the
 * first snapshot implies; a feed's own % (crypto) wins.
 */
export const livedRows = (instruments: readonly Instrument[], priceMap: PriceMap): Instrument[] =>
  instruments.map((r) => {
    const live = priceMap[r.symbol];
    if (!live) return r;
    const out: Instrument = { ...r, lastPrice: live.last };
    const liveLast = Number(live.last);
    if (live.change !== undefined && Number.isFinite(live.change)) {
      out.change24h = live.change;
    } else if (Number.isFinite(liveLast) && liveLast > 0) {
      const ch0 = Number(r.change24h);
      const last0 = Number(r.lastPrice);
      if (Number.isFinite(ch0) && Number.isFinite(last0) && last0 > 0) {
        const base = last0 / (1 + ch0 / 100);
        if (base > 0) out.change24h = ((liveLast - base) / base) * 100;
      }
    }
    return out;
  });

/**
 * The symbols to keep live while a page is on screen: its pool, plus whatever
 * the activity rows hold. Sorted and de-duplicated so an unchanged set is an
 * unchanged key.
 */
export const liveSymbolsKey = (
  pool: readonly Pick<Instrument, 'symbol'>[],
  activity: readonly { symbol: string }[],
): string => [...new Set([...pool.map((r) => r.symbol), ...activity.map((r) => r.symbol)].filter(Boolean))]
  .sort()
  .join('|');

/* ══ Sections ═════════════════════════════════════════════════════════ */

/** Recently viewed symbols resolved against the live pool, in visit order. */
export const recentlyViewedRows = (symbols: readonly string[], lived: readonly Instrument[]): Instrument[] =>
  symbols.map((s) => lived.find((r) => r.symbol === s)).filter((r): r is Instrument => !!r);

/** Most traded: by 24h volume, then by the size of the move. Top 5. */
export const mostTradedRows = (lived: readonly Instrument[]): Instrument[] =>
  [...lived]
    .sort((a, b) => {
      const va = Number(a.volume24h) || 0;
      const vb = Number(b.volume24h) || 0;
      if (vb !== va) return vb - va;
      const ca = Math.abs(Number(a.change24h) || 0);
      const cb = Math.abs(Number(b.change24h) || 0);
      return cb - ca;
    })
    .slice(0, 5);

export const MOVER_TABS = ['Gainers', 'Losers', 'Most Active', 'Trending'] as const;
export type MoverTab = (typeof MOVER_TABS)[number];

type Cmp = (a: Instrument, b: Instrument) => number;

const MOVER_SORT: Record<MoverTab, Cmp> = {
  Gainers: (a, b) => (Number(b.change24h) || -Infinity) - (Number(a.change24h) || -Infinity),
  Losers: (a, b) => (Number(a.change24h) || Infinity) - (Number(b.change24h) || Infinity),
  'Most Active': (a, b) => (Number(b.volume24h) || 0) - (Number(a.volume24h) || 0),
  Trending: (a, b) => Math.abs(Number(b.change24h) || 0) - Math.abs(Number(a.change24h) || 0),
};

/**
 * Market movers: the tab's order, narrowed by sector and by the segment
 * multi-select (an instrument in ANY chosen segment — an MCX future is both
 * Futures and Commodities). Top 8.
 */
export const moverRows = (
  lived: readonly Instrument[],
  tab: MoverTab,
  sector: Pick<SectorDef, 'match'> | null,
  segments: readonly string[],
): Instrument[] => {
  let pool: Instrument[] = [...lived];
  if (sector) pool = pool.filter(sector.match);
  if (segments.length) pool = pool.filter((m) => MOVER_SEGMENTS.some((sg) => segments.includes(sg.key) && sg.match(m)));
  return pool.sort(MOVER_SORT[tab] ?? MOVER_SORT.Gainers).slice(0, 8);
};

/** The filter button's label. */
export const categoryButtonLabel = (selected: readonly string[]): string =>
  (selected.length === 0
    ? 'All categories'
    : `${selected.length} categor${selected.length === 1 ? 'y' : 'ies'}`);

/** Toggle one category in the multi-select. */
export const toggleCategory = (prev: readonly string[], key: string): string[] =>
  (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);

/* ══ Price and change display ═════════════════════════════════════════ */

/** The currency whose grouping an instrument's figures follow — INR on EquityHub. */
export const quoteOf = (r: Pick<Instrument, 'quoteCurrency'> | null | undefined): string =>
  (r?.quoteCurrency || 'INR').toUpperCase();

/** Explore.jsx fmtPrice: the instrument's own precision, at most 6. */
export const fmtExplorePrice = (
  raw: Decimal | number | null | undefined,
  precision: number | null | undefined,
  currency = 'INR',
): string => {
  const v = Number(raw);
  if (!Number.isFinite(v)) return EMPTY;
  return fmtPrice(v, Math.min(Number(precision) || 2, 6), currency);
};

/** Explore.jsx fmtVolume: compact B / M / K, a dash when there is none. */
export const fmtVolume = (raw: Decimal | number | null | undefined): string => {
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return EMPTY;
  if (v >= 1e9) return `${fmtNum(v / 1e9, 1)}B`;
  if (v >= 1e6) return `${fmtNum(v / 1e6, 1)}M`;
  if (v >= 1e3) return `${fmtNum(v / 1e3, 1)}K`;
  return fmtNum(v, 0);
};

/** ChangePill: `+1.23%` / `-0.40%`, or null (a dash) with no finite change. */
export const changePill = (value: number): { text: string; positive: boolean } | null => {
  if (!Number.isFinite(value)) return null;
  const positive = value >= 0;
  return { text: `${positive ? '+' : ''}${fmtNum(value, 2)}%`, positive };
};

/** A row's 24h change in price units — `price × pct / 100`, or NaN. */
export const absChangeOf = (r: Pick<Instrument, 'change24h' | 'lastPrice'>): number => {
  const change = Number(r.change24h);
  const price = Number(r.lastPrice);
  return Number.isFinite(change) && Number.isFinite(price) ? (price * change) / 100 : NaN;
};

/**
 * ChangeText: "+1.68 (+9.41%)" — the absolute move at the instrument's
 * precision (at most 4) then the percentage. Null when the % is not finite.
 */
export const changeText = (
  absChange: number,
  pct: number,
  precision: number | null | undefined,
  currency = 'INR',
): { abs: string; pct: string; positive: boolean } | null => {
  if (!Number.isFinite(pct)) return null;
  const positive = pct >= 0;
  const sign = positive ? '+' : '-';
  const absStr = Number.isFinite(absChange)
    ? fmtNum(Math.abs(absChange), Math.min(Number(precision) || 2, 4), currency)
    : EMPTY;
  return { abs: `${sign}${absStr}`, pct: `(${sign}${fmtNum(Math.abs(pct), 2)}%)`, positive };
};

/* ══ Sparkline ════════════════════════════════════════════════════════ */

/** Explore.jsx synthSpark: a stylised 10-point trend from the 24h %. */
export const synthSpark = (change: number, seed = 0): number[] => {
  const ch = Number(change);
  const dir = !Number.isFinite(ch) ? 0 : ch >= 0 ? 1 : -1;
  const N = 10;
  const start = 50 - dir * 12;
  const end = 50 + dir * 12;
  const pts: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const wiggle = Math.sin((i + seed) * 1.3) * 3;
    pts.push(start + (end - start) * t + wiggle);
  }
  return pts;
};

/** Sparkline: the stroke path and the filled area under it. */
export const sparkPaths = (points: readonly number[], width: number, height: number): { line: string; area: string } | null => {
  if (!points.length) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = Math.max(max - min, 1);
  const step = width / (points.length - 1);
  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(2)} ${(height - ((p - min) / span) * (height - 4) - 2).toFixed(2)}`)
    .join(' ');
  return { line, area: `${line} L ${width} ${height} L 0 ${height} Z` };
};

/* ══ PositionSlTpModal ════════════════════════════════════════════════ */

/** The instrument fields the SL/TP sheet reads. An Instrument fits. */
export interface SlTpInstrument {
  symbol?: string;
  pricePrecision?: number | null;
  lastPrice?: Decimal | number | null;
  quoteCurrency?: string | null;
  /** A glyph the web shows before the symbol when the row carries one. */
  icon?: string | null;
}

/** The row being edited — an open Position or a pending Order. */
export interface SlTpTarget {
  id?: string;
  symbol: string;
  side: OrderSide | string;
  quantity: Decimal | number;
  entryPrice?: Decimal | number | null;
  price?: Decimal | number | null;
  stopPrice?: Decimal | number | null;
  takeProfit?: Decimal | number | null;
  stopLoss?: Decimal | number | null;
  unrealizedPnl?: Decimal | number | null;
}

/** What Modify sends: a level, or null to remove it. */
export interface SlTpPayload {
  takeProfit: Decimal | null;
  stopLoss: Decimal | null;
}

/** 0–8 decimals, 2 when the instrument does not say. */
export const slTpPrecision = (inst: SlTpInstrument | null | undefined): number =>
  Math.max(0, Math.min(8, Number(inst?.pricePrecision) || 2));

/** One pip is one unit of the last decimal: 10^-precision. */
export const pipSizeFor = (precision: number): number => 10 ** -precision;

/** A position's entry; a pending order anchors to its own trigger. */
export const slTpEntry = (p: SlTpTarget): number =>
  Number(p.entryPrice) || Number(p.price) || Number(p.stopPrice) || 0;

export interface SlTpContext {
  entry: number;
  qty: number;
  isBuy: boolean;
  pipSize: number;
}

export interface SlTpDelta { pips: number; money: number; pct: number }

/** How far a level sits from the entry: pips, money (quote currency) and %. */
export const slTpDelta = (priceStr: string, ctx: SlTpContext): SlTpDelta => {
  const p = Number(priceStr);
  if (!Number.isFinite(p) || !ctx.entry) return { pips: 0, money: 0, pct: 0 };
  const raw = ctx.isBuy ? p - ctx.entry : ctx.entry - p;
  return { pips: raw / ctx.pipSize, money: raw * ctx.qty, pct: (raw / ctx.entry) * 100 };
};

/**
 * The web's header figure: `(last − entry) × qty` for a buy, the reverse for
 * a sell. Used for a pending ORDER only, which has no server P&L; an open
 * position shows the server's `unrealizedPnl`.
 */
export const slTpHypotheticalPnl = (lastPx: number, ctx: Pick<SlTpContext, 'entry' | 'qty' | 'isBuy'>): number =>
  (ctx.isBuy ? lastPx - ctx.entry : ctx.entry - lastPx) * ctx.qty;

/** The ± stepper: one pip from the current value (or the entry, or the last price). */
export const stepSlTpPrice = (
  curr: string | number,
  dir: 1 | -1,
  opts: { entry: number; lastPx: number; precision: number; pipSize: number },
): string => {
  const base = Number(curr) || opts.entry || opts.lastPx || 0;
  return (base + dir * opts.pipSize).toFixed(opts.precision);
};

/**
 * Modify's body — PositionSlTpModal.jsx submitModify. An empty field removes
 * the level (null). The web sends `Number(field)`; a field that is not a
 * number reaches its server as null (a number input reports '' for garbage),
 * so it does here too. The level is sent as the decimal string it is —
 * the server stores `String(level)`.
 */
export const slTpPayload = (tp: string, sl: string): SlTpPayload => {
  const level = (v: string): Decimal | null => {
    const s = v.trim();
    if (s === '' || !Number.isFinite(Number(s))) return null;
    // "82450." → "82450", ".5" → "0.5" — the number, not the keystrokes.
    return canonicalAmount(s);
  };
  return { takeProfit: level(tp), stopLoss: level(sl) };
};

export type PriceFieldMode = 'price' | 'pips' | 'money' | 'percent';

/** PF_MODES. `money`'s short label is the instrument's quote currency. */
export const PF_MODES: readonly { id: PriceFieldMode; label: string; short: string }[] = [
  { id: 'price', label: 'By asset price', short: 'Price' },
  { id: 'pips', label: 'In pips', short: 'Pips' },
  { id: 'money', label: 'In money', short: 'INR' },
  { id: 'percent', label: 'In % of equity', short: '%' },
];

export interface PriceFieldContext {
  refPrice: number;
  qty: number;
  pipSize: number;
  free: number;
  isTp: boolean;
  side: string;
}

/** TP moves price up for a BUY and down for a SELL; SL the other way. */
export const slTpDir = (side: string, isTp: boolean): number => (side === 'BUY' ? 1 : -1) * (isTp ? 1 : -1);

const trimTo = (n: number, dp: number): string => {
  const r = Number(Number(n).toFixed(dp));
  return Number.isFinite(r) ? String(r) : '';
};

/** A value typed in the field's unit → the asset price that is stored. '' when it cannot be. */
export const priceFromUnit = (raw: string, mode: PriceFieldMode, ctx: PriceFieldContext): number | '' => {
  const v = Number(raw);
  if (!Number.isFinite(v) || v === 0) return '';
  if (mode === 'price') return v;
  if (!ctx.refPrice) return '';
  const dir = slTpDir(ctx.side, ctx.isTp);
  if (mode === 'pips') return ctx.refPrice + dir * v * ctx.pipSize;
  if (mode === 'money') return ctx.qty > 0 ? ctx.refPrice + dir * (v / ctx.qty) : '';
  if (mode === 'percent') {
    if (!ctx.qty || !ctx.free) return '';
    return ctx.refPrice + dir * (((v / 100) * ctx.free) / ctx.qty);
  }
  return v;
};

/** The stored price → what the field shows in its unit. */
export const unitFromPrice = (priceStr: string, mode: PriceFieldMode, ctx: PriceFieldContext): string => {
  const p = Number(priceStr);
  if (!Number.isFinite(p) || p === 0) return '';
  if (mode === 'price') return String(priceStr);
  if (!ctx.refPrice) return '';
  const diff = (p - ctx.refPrice) * slTpDir(ctx.side, ctx.isTp);
  if (mode === 'pips') return trimTo(diff / ctx.pipSize, 1);
  if (mode === 'money') return ctx.qty > 0 ? trimTo(diff * ctx.qty, 2) : '';
  if (mode === 'percent') {
    if (!ctx.qty || !ctx.free) return '';
    return trimTo(((diff * ctx.qty) / ctx.free) * 100, 2);
  }
  return String(priceStr);
};

/** The partial-close field's first value: half the position, as typed. */
export const initialPartialQty = (quantity: Decimal | number): string => String((Number(quantity) || 0) / 2);

/** The 25 / 50 / 75 / 100 % presets, as the field's text. */
export const PARTIAL_FRACTIONS = [0.25, 0.5, 0.75, 1] as const;
export const partialPreset = (qty: number, f: number): string => (qty * f).toFixed(2);

/** "+12.3 pips · ₹45.00 · 0.52 %" pieces (PositionSlTpModal.jsx: `{usd < 0 ? '-' : ''}₹{|usd|}`). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const deltaParts = (d: SlTpDelta, _currency = 'INR'): { pips: string; money: string; pct: string } => ({
  pips: `${d.pips >= 0 ? '+' : ''}${fmtNum(d.pips, 1)} pips`,
  money: `${d.money < 0 ? '-' : ''}${fmtMoney(Math.abs(d.money), 'INR')}`,
  pct: `${fmtNum(d.pct, 2)} %`,
});
