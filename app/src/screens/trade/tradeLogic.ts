import type { Instrument, Order, Position } from '@/types/trading';
import type { OrderBook, Watchlist } from '@/types/market';
import type { WalletBalance } from '@/types/wallet';
import { currencySymbol, fmtNum } from '@/utils/money';

import type { ChartOrderRow, ChartPositionRow } from '@/charts/chartOverlays';
import { isChartTimeframe, isChartType, type ChartTimeframe, type ChartType, type IndicatorMap } from '@/charts/chartCatalog';

/**
 * The Trade terminal's decisions — EquityHub's client/src/pages/Trade.jsx —
 * as pure functions, so each can be tested against the web's own
 * arithmetic. The screen (TradeScreen.tsx) holds state and draws.
 *
 * ── DELIBERATE DIFFERENCES FROM THE WEB ──────────────────────────────
 * 1. Market Depth shows the real book, and only the real top-of-book when
 *    the venue has no L2. The web SYNTHESISES nine more levels a side with
 *    a seeded sine "noise" — invented sizes shown as depth — which
 *    PORT-RULINGS forbids, as stage 3 did for StockDetail.
 * 2. Before the wallet answers, the account figures are unknown (a dash),
 *    not ₹0.00 — the web seeds `walletFree` with '0'.
 * ──────────────────────────────────────────────────────────────────────
 */

/* ── Symbol tabs (Trade.jsx symbol tabs) ─────────────────────────────── */

/** The symbol the terminal opens on when the link carries none. */
export const DEFAULT_SYMBOL = 'NIFTY';

/** Restore saved tabs, making sure the symbol on screen has one. */
export const restoreTabs = (saved: unknown, symbol: string): string[] => {
  if (Array.isArray(saved)) {
    const list = saved.filter((s): s is string => typeof s === 'string' && !!s);
    if (list.length) return list.includes(symbol) ? list : [...list, symbol];
  }
  return [symbol];
};

export const withTab = (tabs: readonly string[], sym: string): string[] => (tabs.includes(sym) ? [...tabs] : [...tabs, sym]);

/**
 * Close a tab. Closing the last one is a no-op; closing the active one
 * falls back to the previous tab, else the next.
 */
export const closeTab = (tabs: readonly string[], sym: string, active: string): { tabs: string[]; nextActive: string | null } => {
  if (tabs.length <= 1) return { tabs: [...tabs], nextActive: null };
  const idx = tabs.indexOf(sym);
  if (idx === -1) return { tabs: [...tabs], nextActive: null };
  const next = [...tabs.slice(0, idx), ...tabs.slice(idx + 1)];
  const fallback = sym === active ? (next[idx - 1] ?? next[0] ?? null) : null;
  return { tabs: next, nextActive: fallback };
};

/* ── Per-instrument chart view ────────────────────────────────────────── */

export interface ChartView {
  chartType: ChartType;
  indicators: IndicatorMap;
  timeframe: ChartTimeframe;
}

export interface ChartViewMaps {
  ind: Record<string, IndicatorMap>;
  ct: Record<string, string>;
  tf: Record<string, string>;
}

/**
 * The view an instrument opens with: its own saved one; on the very first
 * run (nothing saved per instrument yet) the old global settings; for an
 * instrument never seen, a clean default.
 */
export const viewForSymbol = (
  maps: ChartViewMaps,
  symbol: string,
  legacy: { indicators: IndicatorMap; chartType: string | null; timeframe: string | null },
): ChartView => {
  const savedInd = maps.ind[symbol];
  const indicators = savedInd !== undefined
    ? savedInd
    : Object.keys(maps.ind).length === 0 ? legacy.indicators : {};
  const savedCt = maps.ct[symbol];
  const ct = savedCt !== undefined
    ? savedCt
    : Object.keys(maps.ct).length === 0 ? (legacy.chartType ?? 'candles') : 'candles';
  const savedTf = maps.tf[symbol];
  const tf = savedTf !== undefined
    ? savedTf
    : Object.keys(maps.tf).length !== 0 ? '1m' : (legacy.timeframe ?? '1m');
  return {
    indicators: indicators && typeof indicators === 'object' ? indicators : {},
    chartType: isChartType(ct) ? ct : 'candles',
    timeframe: isChartTimeframe(tf) ? tf : '1m',
  };
};

/* ── Indian market segments (Trade.jsx MARKET_SEGMENTS) ──────────────── */

type SegRow = Pick<Instrument, 'segment' | 'category' | 'exchange'>;

const segOf = (r: SegRow): string => String(r.segment || '').toUpperCase();
const catOf = (r: SegRow): string => String(r.category || '').toUpperCase();
const isDerivativeRow = (r: SegRow): boolean => segOf(r) === 'FUT' || segOf(r) === 'OPT';

export interface MarketSegment {
  key: 'INDEX' | 'STOCK' | 'FUT' | 'COMMODITY';
  label: string;
  match: (r: SegRow) => boolean;
}

/**
 * The instruments-panel filter and the Top Movers chips. Indices / Stocks
 * are spot only (index tiles, NSE/BSE cash); every future (NFO/BFO/MCX) sits
 * under Futures, and MCX contracts also show under Commodities.
 */
export const MARKET_SEGMENTS: readonly MarketSegment[] = [
  { key: 'STOCK', label: 'Stocks', match: (r) => catOf(r) === 'STOCK' && !isDerivativeRow(r) },
  { key: 'INDEX', label: 'Indices', match: (r) => catOf(r) === 'INDEX' && !isDerivativeRow(r) },
  { key: 'COMMODITY', label: 'MCX', match: (r) => String(r.exchange || '').toUpperCase() === 'MCX' || catOf(r) === 'COMMODITY' },
];

export const SEGMENT_BY_KEY: ReadonlyMap<string, MarketSegment> = new Map(MARKET_SEGMENTS.map((s) => [s.key, s]));

/** "Indices", "Futures"… for a segment key; the key itself when unknown. */
export const segmentLabel = (key: string): string => SEGMENT_BY_KEY.get(key)?.label || key;

/* ── Instruments panel ───────────────────────────────────────────────── */

export interface InstrumentRow extends Instrument {
  bid: string;
  ask: string;
  /** The live last used for the row. */
  last: number;
}

/**
 * Bid / ask from the last price and the instrument's spread rule — the
 * panel's own derivation (a PERCENTAGE spread is a fraction of price).
 */
export const deriveBidAsk = (px: number, spreadValue: unknown, spreadType: unknown): { bid: number; ask: number } => {
  const half = Number(spreadValue || 0) / 2;
  if (spreadType === 'PERCENTAGE') return { bid: px * (1 - half), ask: px * (1 + half) };
  return { bid: px - half, ask: px + half };
};

export const instrumentRows = (instruments: readonly Instrument[], priceMap: Record<string, number | undefined>): InstrumentRow[] =>
  instruments
    .filter((i) => i.isActive !== false)
    .map((i) => {
      const px = Number(priceMap[i.symbol] ?? i.lastPrice ?? 0) || 0;
      const { bid, ask } = deriveBidAsk(px, i.spreadValue, i.spreadType);
      return { ...i, bid: String(bid), ask: String(ask), last: px };
    });

/** The segments present in the data — an empty segment (F&O switched off) never shows. */
export const instrumentCategories = (rows: readonly SegRow[]): string[] =>
  MARKET_SEGMENTS.filter((s) => rows.some(s.match)).map((s) => s.key);

/**
 * Keep the filter valid as data loads: a missing watchlist falls back to
 * Favorites (or ALL), a vanished segment to ALL. A 'wl:' filter is left
 * alone until the lists have loaded.
 */
export const reconcileFilter = (
  filter: string,
  categories: readonly string[],
  watchlists: readonly Pick<Watchlist, 'id'>[],
  favoritesId: string | null,
): string => {
  if (filter.startsWith('wl:')) {
    if (!watchlists.length) return filter;
    return watchlists.some((w) => w.id === filter.slice(3)) ? filter : (favoritesId ? `wl:${favoritesId}` : 'ALL');
  }
  if (filter !== 'ALL' && !categories.includes(filter)) return 'ALL';
  return filter;
};

/** Filter by watchlist OR segment, then by the search box within it. */
export const visibleRows = <R extends Pick<Instrument, 'symbol' | 'name' | 'category' | 'segment' | 'exchange'>>(
  rows: readonly R[],
  filter: string,
  watchlists: readonly Pick<Watchlist, 'id' | 'items'>[],
  search: string,
): R[] => {
  const q = search.trim().toUpperCase();
  const wl = filter.startsWith('wl:') ? watchlists.find((w) => w.id === filter.slice(3)) : null;
  const set = filter.startsWith('wl:') ? new Set((wl?.items ?? []).map((it) => it.symbol)) : null;
  const seg = !set && filter !== 'ALL' ? SEGMENT_BY_KEY.get(filter) : undefined;
  return rows.filter((r) => {
    if (set) { if (!set.has(r.symbol)) return false; } else if (seg && !seg.match(r)) return false;
    if (!q) return true;
    return r.symbol.toUpperCase().includes(q) || (r.name || '').toUpperCase().includes(q);
  });
};

/** At most this many visible rows are subscribed to live. */
export const VISIBLE_SUBSCRIBE_CAP = 60;

/* ── Live P&L (Trade.jsx positionsWithLivePnl) ───────────────────────── */

export type PriceSource = 'bid' | 'ask' | 'mid';

export interface LivePositionRow extends Position {
  /** The mark the row is valued at. */
  markLive: number;
  /** The row's floating P&L — the tick's re-mark, else the server's. */
  pnlLive: number;
}

/**
 * Re-mark one position at the latest price with the server's formula
 * (orderController.listPositions; sign by positionSide, PORT-RULINGS §2).
 * Without a tick the server's `unrealizedPnl` stands. The active symbol
 * honours Settings → Price source when bid / ask are known.
 */
export const livePositionRow = (
  p: Position,
  priceMap: Record<string, number | undefined>,
  active: { symbol: string; bid: number | null; ask: number | null } | null,
  source: PriceSource,
): LivePositionRow => {
  const serverMark = Number(p.markPrice ?? p.entryPrice) || 0;
  const tick = priceMap[p.symbol];
  let mark: number | null = typeof tick === 'number' && Number.isFinite(tick) && tick > 0 ? tick : null;
  if (active && p.symbol === active.symbol) {
    const b = active.bid; const a = active.ask;
    if (source === 'bid' && b != null && b > 0) mark = b;
    else if (source === 'ask' && a != null && a > 0) mark = a;
    else if (source === 'mid' && a != null && b != null && a > 0 && b > 0) mark = (a + b) / 2;
  }
  if (mark === null) return { ...p, markLive: serverMark, pnlLive: Number(p.unrealizedPnl) || 0 };
  const entry = Number(p.entryPrice);
  const qty = Number(p.quantity);
  if (!Number.isFinite(entry) || !Number.isFinite(qty)) return { ...p, markLive: mark, pnlLive: 0 };
  const long = p.positionSide ? p.positionSide === 'LONG' : p.side === 'BUY';
  return { ...p, markLive: mark, pnlLive: long ? (mark - entry) * qty : (entry - mark) * qty };
};

/** The chart's position rows (Trade.jsx PriceChart `positions`). */
export const chartPositionRows = (rows: readonly LivePositionRow[]): ChartPositionRow[] =>
  rows.map((p) => ({
    id: p.id, symbol: p.symbol, side: p.side, quantity: p.quantity, entryPrice: p.entryPrice,
    stopLoss: p.stopLoss ?? null, takeProfit: p.takeProfit ?? null, pnl: p.pnlLive, openedAt: p.openedAt ?? null,
  }));

export const chartOrderRows = (orders: readonly Order[]): ChartOrderRow[] =>
  orders.map((o) => ({
    id: o.id, symbol: o.symbol, side: o.side, type: o.type, status: o.status, quantity: o.quantity,
    price: o.price ?? null, stopPrice: o.stopPrice ?? null, stopLoss: o.stopLoss ?? null, takeProfit: o.takeProfit ?? null,
    triggeredAt: o.triggeredAt ?? null,
  }));

/* ── Account figures (Trade.jsx equityNums) ──────────────────────────── */

export interface EquityFigures {
  currency: string;
  equity: number | null;
  balance: number | null;
  free: number | null;
  used: number | null;
  /** null when no margin is in use. */
  marginLevel: number | null;
}

/**
 * The account's free wallet balance as Trade.jsx reads it after every
 * refresh: the base-currency row, else the first, `free` else `balance`.
 * null while there are no rows.
 */
export const pickWalletFree = (
  rows: readonly Pick<WalletBalance, 'currency' | 'free' | 'balance'>[] | null | undefined,
  baseCurrency: string | null | undefined,
): number | null => {
  if (!rows || !rows.length) return rows ? 0 : null;
  const w = rows.find((b) => b.currency === baseCurrency) ?? rows[0];
  const v = Number(w?.free ?? w?.balance ?? 0);
  return Number.isFinite(v) ? v : 0;
};

/**
 * The footer strip, the account menu and the header chip — Trade.jsx
 * equityNums, line for line:
 *   used    = Σ entryPrice × quantity / max(leverage, 1)
 *   balance = wallet free + used           (realised cash in the wallet)
 *   equity  = balance + Σ live P&L
 *   free    = equity − used                (the broker free-margin formula)
 *   level   = used > 0 ? equity / used × 100 : null
 * Everything is null until the wallet's free balance is known.
 */
export const equityFigures = (
  walletFree: number | null,
  positions: readonly Pick<LivePositionRow, 'entryPrice' | 'quantity' | 'leverage' | 'pnlLive'>[],
  currency = 'INR',
): EquityFigures => {
  if (walletFree === null || !Number.isFinite(walletFree)) {
    return { currency, equity: null, balance: null, free: null, used: null, marginLevel: null };
  }
  const upnl = positions.reduce((acc, p) => acc + (Number(p.pnlLive) || 0), 0);
  const used = positions.reduce((acc, p) => {
    const px = Number(p.entryPrice || 0) * Number(p.quantity || 0);
    const lev = Math.max(Number(p.leverage || 1), 1);
    return acc + px / lev;
  }, 0);
  const balance = walletFree + used;
  const equity = balance + upnl;
  return {
    currency,
    equity,
    balance,
    free: equity - used,
    used,
    marginLevel: used > 0 ? (equity / used) * 100 : null,
  };
};

/** "1:100" — the account menu's leverage row (Trade.jsx `1:${accLeverage}`). */
export const leverageText = (lev: number | null | undefined): string => {
  const n = Number(lev);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return `1:${n}`;
};

/**
 * Each account's free balance for the account switcher, from one
 * GET /wallet/balances (no accountId — every row tagged with its account):
 * the row whose currency is the account's base currency.
 */
export const accountFreeBalances = (
  rows: readonly Pick<WalletBalance, 'accountId' | 'currency' | 'free'>[],
  accounts: readonly { id: string; baseCurrency?: string | null }[],
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const a of accounts) {
    const w = rows.find((b) => b.accountId === a.id && b.currency === a.baseCurrency);
    const v = Number(w?.free);
    if (w && w.free != null && Number.isFinite(v)) out[a.id] = v;
  }
  return out;
};

/* ── Rows ────────────────────────────────────────────────────────────── */

/**
 * The order ticket a user sees — the last six hex characters of the id,
 * upper-cased and '#'-prefixed (utils/ticket.js `ticketShort`, which mirrors
 * backend/src/utils/ticket.js). One rendering on every screen.
 */
export const ticketShort = (id: string | null | undefined, fallback = '—'): string =>
  (id ? `#${String(id).slice(-6).toUpperCase()}` : fallback);

export const orderTypeLabel = (o: Pick<Order, 'side' | 'type'>): string => {
  const w = o.side === 'BUY' ? 'Buy' : 'Sell';
  if (o.type === 'LIMIT') return `${w} Limit`;
  if (o.type === 'STOP') return `${w} Stop`;
  if (o.type === 'MARKET') return `${w} Market`;
  return `${w} ${o.type || ''}`.trim();
};

/** A price in rupees at the instrument's precision. */
export const priceText = (v: unknown, quote: string, prec: number): string => {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return '—';
  return `${currencySymbol(quote)}${fmtNum(n, prec, quote)}`;
};

/** A row's display precision and quote: the catalogue's, else INR at 4 (Trade.jsx tables). */
export const rowMeta = (inst: Pick<Instrument, 'quoteCurrency' | 'pricePrecision'> | undefined): { quote: string; prec: number } => ({
  quote: inst?.quoteCurrency || 'INR',
  prec: inst?.pricePrecision || 4,
});

/** One fee lands in one column by its type; swap is always a charge. */
export const feeColumns = (row: { commission?: unknown; swap?: unknown; feeCategory?: string | null }): { comm: number; charges: number } => {
  const fee = Number(row.commission || 0) || 0;
  const swap = Number(row.swap || 0) || 0;
  const isCharge = row.feeCategory === 'CHARGES';
  return { comm: isCharge ? 0 : fee, charges: (isCharge ? fee : 0) + swap };
};

/* ── Why a position closed (Trade.jsx CLOSE_REASONS) ─────────────────── */

export type ReasonTone = 'bull' | 'bear' | 'warn' | 'secondary' | 'muted';

/**
 * Every reason the Position model can carry. A missing entry used to fall
 * through to "Manual", so a forced liquidation (STOP_OUT) was reported as
 * something the user did.
 */
export const CLOSE_REASONS: Readonly<Record<string, { t: string; tone: ReasonTone }>> = {
  TAKE_PROFIT: { t: 'Take Profit', tone: 'bull' },
  STOP_LOSS: { t: 'Stop Loss', tone: 'bear' },
  TRAILING_STOP: { t: 'Trailing Stop', tone: 'bear' },
  // Both spellings exist: the engine writes STOP_OUT, older rows carry MARGIN_STOPOUT.
  STOP_OUT: { t: 'Stop Out', tone: 'bear' },
  MARGIN_STOPOUT: { t: 'Stop Out', tone: 'bear' },
  NEGATIVE_BALANCE: { t: 'Neg. Balance', tone: 'bear' },
  EXPIRY: { t: 'Expired', tone: 'secondary' },
  INTRADAY_SQUAREOFF: { t: 'Square-off', tone: 'secondary' },
  INSTRUMENT_DISABLED_FORCE_CLOSE: { t: 'Instrument Disabled', tone: 'warn' },
  COPY_MASTER_CLOSED: { t: 'Master Closed', tone: 'secondary' },
  MANUAL: { t: 'Manual', tone: 'secondary' },
  ADMIN: { t: 'Manual', tone: 'warn' },
};

/**
 * The Reason cell (Trade.jsx ReasonBadge): a known reason by name; none →
 * a dash; an unknown one shown as what it was ("SOME_REASON" → "Some
 * Reason"), never guessed.
 */
export const closeReasonInfo = (reason: string | null | undefined): { text: string; tone: ReasonTone } => {
  if (reason) {
    const r = CLOSE_REASONS[reason];
    if (r) return { text: r.t, tone: r.tone };
    const pretty = String(reason).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());
    return { text: pretty, tone: 'muted' };
  }
  return { text: '—', tone: 'muted' };
};

/* ── Rejected orders (Trade.jsx RejectedTable) ───────────────────────── */

/** The reason column — a blank one is shown as such, never filled with a guess. */
export const rejectionText = (o: Pick<Order, 'rejectionReason'>): { text: string; recorded: boolean } =>
  (o.rejectionReason ? { text: o.rejectionReason, recorded: true } : { text: 'No reason recorded', recorded: false });

/** When it was refused: the last write, else the placement. */
export const rejectedAt = (o: Pick<Order, 'updatedAt' | 'createdAt'>): string | null => o.updatedAt || o.createdAt || null;

/* ── Individual trades of a netted position (Trade.jsx PositionsTable) ── */

export interface FillRow {
  id: string;
  side: string;
  /** The part of this fill still in the open position. */
  qty: number;
  price: number;
  at: string | null;
}

/**
 * The newest same-side fills that add up to the open quantity, the last one
 * clamped; the position itself when nothing matches.
 */
export const tradesFor = (
  p: Pick<Position, 'id' | 'symbol' | 'side' | 'quantity' | 'entryPrice' | 'openedAt' | 'createdAt'>,
  fills: readonly Pick<Order, 'id' | 'symbol' | 'side' | 'filledQuantity' | 'quantity' | 'avgFillPrice' | 'price' | 'filledAt' | 'createdAt'>[],
): FillRow[] => {
  const total = Number(p.quantity || 0);
  const matched = fills
    .filter((o) => o.symbol === p.symbol && o.side === p.side)
    .slice()
    .sort((a, b) => new Date(b.filledAt || b.createdAt || 0).getTime() - new Date(a.filledAt || a.createdAt || 0).getTime());
  let acc = 0;
  const rows: FillRow[] = [];
  for (const o of matched) {
    if (acc >= total - 1e-9) break;
    const full = Number(o.filledQuantity || o.quantity || 0);
    const dq = Math.min(full, total - acc);
    rows.push({ id: o.id, side: o.side, qty: dq, price: Number(o.avgFillPrice || o.price || 0), at: o.filledAt || o.createdAt || null });
    acc += dq;
  }
  if (!rows.length) rows.push({ id: p.id, side: p.side, qty: total, price: Number(p.entryPrice) || 0, at: p.openedAt || p.createdAt || null });
  return rows;
};

/** Each fill's share of the group P&L, normalised to sum to it. */
export const fillPnls = (rows: readonly FillRow[], side: string, mark: number, groupPnl: number, totalQty: number): number[] => {
  const raws = rows.map((r) => (side === 'SELL' ? (r.price - mark) : (mark - r.price)) * r.qty);
  const sum = raws.reduce((a, b) => a + b, 0);
  return rows.map((r, i) => (sum !== 0 ? groupPnl * ((raws[i] ?? 0) / sum) : (totalQty > 0 ? groupPnl * (r.qty / totalQty) : 0)));
};

/* ── Positions panel groups (Trade.jsx SidebarPositions) ─────────────── */

export interface PositionGroup {
  key: string;
  symbol: string;
  side: string;
  items: LivePositionRow[];
  totalQty: number;
  notional: number;
  pnl: number;
  avgEntry: number;
  pnlPct: number;
}

export interface PositionsSummary {
  open: number;
  totalPnl: number;
  pnlPct: number;
  winners: number;
  losers: number;
}

export const summarisePositions = (rows: readonly LivePositionRow[]): PositionsSummary => {
  const totalPnl = rows.reduce((s, p) => s + p.pnlLive, 0);
  const notional = rows.reduce((s, p) => s + Number(p.quantity || 0) * Number(p.entryPrice || 0), 0);
  const winners = rows.filter((p) => p.pnlLive >= 0).length;
  return {
    open: rows.length,
    totalPnl,
    pnlPct: notional > 0 ? (totalPnl / notional) * 100 : 0,
    winners,
    losers: rows.length - winners,
  };
};

/** Group by symbol + side (UI only — the backend keeps each position intact). */
export const groupPositions = (rows: readonly LivePositionRow[]): PositionGroup[] => {
  const map = new Map<string, PositionGroup>();
  for (const p of rows) {
    const key = `${p.symbol}|${p.side}`;
    let g = map.get(key);
    if (!g) {
      g = { key, symbol: p.symbol, side: p.side, items: [], totalQty: 0, notional: 0, pnl: 0, avgEntry: 0, pnlPct: 0 };
      map.set(key, g);
    }
    g.items.push(p);
  }
  return [...map.values()].map((g) => {
    const totalQty = g.items.reduce((s, p) => s + Number(p.quantity || 0), 0);
    const notional = g.items.reduce((s, p) => s + Number(p.quantity || 0) * Number(p.entryPrice || 0), 0);
    const pnl = g.items.reduce((s, p) => s + p.pnlLive, 0);
    return { ...g, totalQty, notional, pnl, avgEntry: totalQty > 0 ? notional / totalQty : 0, pnlPct: notional > 0 ? (pnl / notional) * 100 : 0 };
  });
};

/* ── Pending panel (Trade.jsx SidebarPendingOrders) ──────────────────── */

export const pendingSummary = (orders: readonly Order[]): { count: number; buy: number; sell: number; limit: number; stop: number } => {
  const buy = orders.filter((o) => o.side === 'BUY').length;
  const limit = orders.filter((o) => o.type === 'LIMIT').length;
  return { count: orders.length, buy, sell: orders.length - buy, limit, stop: orders.length - limit };
};

export const triggerPrice = (o: Pick<Order, 'type' | 'price' | 'stopPrice'>): number =>
  Number(o.type === 'STOP' ? o.stopPrice : o.price) || 0;

export const distanceFromMarket = (trigger: number, last: number): number | null =>
  (trigger > 0 && last > 0 ? ((trigger - last) / last) * 100 : null);

export const ageLabel = (createdAt: string | null | undefined, nowMs: number): string | null => {
  if (!createdAt) return null;
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return null;
  const m = Math.max(0, Math.floor((nowMs - t) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
};

/* ── Movers (Trade.jsx Top Movers pane) ──────────────────────────────── */

export interface MoverOverlay { change24h: number; dayHigh: number; dayLow: number; volume24h: number; lastPrice: number }

/** "All" then the market segments, in their order. */
export const MOVER_CATS: readonly { key: string; label: string }[] = [
  { key: 'ALL', label: 'All' },
  ...MARKET_SEGMENTS.map((s) => ({ key: s.key, label: s.label })),
];

export interface MoverRow { symbol: string; change24h: number; lastPrice: number; volume24h: number | null; pricePrecision: number; row: InstrumentRow }

/**
 * Gainers and losers within the chosen segment, with per-segment counts for
 * the chips — computed over everything that has 24h data. An instrument
 * counts under every segment it matches (an MCX future is both Futures and
 * Commodities), as on the web.
 */
export const rankMovers = (
  rows: readonly InstrumentRow[],
  overlay: Record<string, MoverOverlay | undefined>,
  cat: string,
): { gainers: MoverRow[]; losers: MoverRow[]; counts: Record<string, number>; ranked: number } => {
  const merged: MoverRow[] = [];
  for (const r of rows) {
    const o = overlay[r.symbol];
    const change = o ? o.change24h : Number(r.change24h);
    if (!Number.isFinite(change)) continue;
    merged.push({
      symbol: r.symbol,
      change24h: change,
      lastPrice: o && Number.isFinite(o.lastPrice) ? o.lastPrice : Number(r.lastPrice) || 0,
      volume24h: o ? o.volume24h : (r.volume24h != null ? Number(r.volume24h) : null),
      pricePrecision: Math.min(r.pricePrecision || 2, 5),
      row: r,
    });
  }
  const counts: Record<string, number> = { ALL: merged.length };
  for (const s of MARKET_SEGMENTS) counts[s.key] = merged.filter((m) => s.match(m.row)).length;
  const match = SEGMENT_BY_KEY.get(cat)?.match;
  const ranked = merged.filter((m) => !match || match(m.row)).sort((a, b) => b.change24h - a.change24h);
  return { gainers: ranked.slice(0, 8), losers: ranked.slice(-8).reverse(), counts, ranked: ranked.length };
};

/** "Vol 1.2M". */
export const volumeShort = (v: number | null | undefined): string | null => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
};

/* ── Market depth (minus the synthetic ladder) ───────────────────────── */

export interface DepthLevel { price: number; size: number | null; count: number | null; topOnly?: boolean }

export interface DepthView {
  /** Real levels exist (the venue's L2), vs the top-of-book fallback. */
  real: boolean;
  asks: DepthLevel[];
  bids: DepthLevel[];
  askCumul: number[];
  bidCumul: number[];
  maxSize: number;
  mid: number | null;
  spread: number | null;
  totalBidSize: number;
  totalAskSize: number;
  totalBidNotional: number;
  totalAskNotional: number;
  bidPct: number;
}

const pos = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Top of book through three fallbacks: the instrument's bid/ask, the live tick ± half spread, the last ± half spread. */
export const topOfBook = (
  inst: Pick<Instrument, 'bid' | 'ask' | 'lastPrice' | 'spreadValue' | 'spreadType'>,
  livePrice: number | null | undefined,
): { bid: number | null; ask: number | null } => {
  const b = pos(inst.bid);
  const a = pos(inst.ask);
  if (b && a) return { bid: b, ask: a };
  const lp = pos(livePrice) ?? pos(inst.lastPrice);
  if (!lp) return { bid: null, ask: null };
  const sv = Number(inst.spreadValue) || 0;
  const half = sv > 0 ? sv / 2 : 0;
  if (inst.spreadType === 'PERCENTAGE') return { bid: lp * (1 - half), ask: lp * (1 + half) };
  return { bid: lp - half, ask: lp + half };
};

export const depthView = (
  book: OrderBook | null,
  inst: Pick<Instrument, 'bid' | 'ask' | 'lastPrice' | 'spreadValue' | 'spreadType'>,
  livePrice: number | null | undefined,
): DepthView => {
  const toLevel = (l: { price: unknown; quantity: unknown; count?: unknown }): DepthLevel => ({
    price: Number(l.price), size: Number(l.quantity), count: l.count == null ? null : Number(l.count),
  });
  const realAsks = (book?.asks ?? []).slice(0, 8).map(toLevel).filter((r) => Number.isFinite(r.price));
  const realBids = (book?.bids ?? []).slice(0, 8).map(toLevel).filter((r) => Number.isFinite(r.price));
  const real = realAsks.length > 0 || realBids.length > 0;
  const top = topOfBook(inst, livePrice);
  let asks = [...realAsks].sort((a, b) => b.price - a.price);
  let bids = [...realBids].sort((a, b) => b.price - a.price);
  if (asks.length === 0 && top.ask !== null) asks = [{ price: top.ask, size: null, count: null, topOnly: true }];
  if (bids.length === 0 && top.bid !== null) bids = [{ price: top.bid, size: null, count: null, topOnly: true }];
  const bestBid = bids[0]?.price;
  const bestAsk = asks[asks.length - 1]?.price;
  const hasBoth = bestAsk !== undefined && bestBid !== undefined && Number.isFinite(bestAsk) && Number.isFinite(bestBid);
  const sz = (r: DepthLevel): number => (r.size !== null && Number.isFinite(r.size) ? r.size : 0);
  const sumSize = (arr: DepthLevel[]): number => arr.reduce((s, r) => s + sz(r), 0);
  const sumNotional = (arr: DepthLevel[]): number => arr.reduce((s, r) => s + sz(r) * r.price, 0);
  const totalBidSize = sumSize(bids);
  const totalAskSize = sumSize(asks);
  const total = totalBidSize + totalAskSize;
  const askCumul = new Array<number>(asks.length).fill(0);
  let runA = 0;
  for (let i = asks.length - 1; i >= 0; i--) { runA += sz(asks[i] as DepthLevel); askCumul[i] = runA; }
  const bidCumul = new Array<number>(bids.length).fill(0);
  let runB = 0;
  for (let i = 0; i < bids.length; i++) { runB += sz(bids[i] as DepthLevel); bidCumul[i] = runB; }
  return {
    real,
    asks,
    bids,
    askCumul,
    bidCumul,
    maxSize: Math.max(...asks.map(sz), ...bids.map(sz), 0.0001),
    mid: hasBoth ? ((bestAsk as number) + (bestBid as number)) / 2 : null,
    spread: hasBoth ? (bestAsk as number) - (bestBid as number) : null,
    totalBidSize,
    totalAskSize,
    totalBidNotional: sumNotional(bids),
    totalAskNotional: sumNotional(asks),
    bidPct: total > 0 ? (totalBidSize / total) * 100 : 50,
  };
};

/* ── Performance (Trade.jsx SidebarPerformance) ──────────────────────── */

export interface PerformanceFigures {
  last: number;
  change: number | null;
  hi: number | null;
  lo: number | null;
  pctOfRange: number | null;
  open24h: number | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spreadAbs: number | null;
  spreadBps: number | null;
  rangePct: number | null;
  volume: number | null;
  turnover: number | null;
}

const numOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
};

/** Instrument fields first; 48 × 1h candles fill what they lack. */
export const performanceFigures = (
  inst: Pick<Instrument, 'lastPrice' | 'change24h' | 'dayHigh' | 'dayLow' | 'bid' | 'ask' | 'volume24h'>,
  candles: readonly { close: number; high: number; low: number }[],
  livePrice: number | null | undefined,
): PerformanceFigures => {
  const last = Number(livePrice ?? inst.lastPrice);
  let change: number | null = numOrNull(inst.change24h);
  if (change === null && candles.length >= 2) {
    const first = Number(candles[0]?.close);
    const lastClose = Number(candles[candles.length - 1]?.close);
    if (Number.isFinite(first) && first > 0 && Number.isFinite(lastClose)) change = ((lastClose - first) / first) * 100;
  }
  let hi: number | null = numOrNull(inst.dayHigh);
  let lo: number | null = numOrNull(inst.dayLow);
  if ((hi === null || lo === null || hi <= lo) && candles.length) {
    const highs = candles.map((c) => Number(c.high)).filter(Number.isFinite);
    const lows = candles.map((c) => Number(c.low)).filter(Number.isFinite);
    if (highs.length && lows.length) { hi = Math.max(...highs); lo = Math.min(...lows); }
  }
  const hasRange = hi !== null && lo !== null && hi > lo;
  const bid = numOrNull(inst.bid);
  const ask = numOrNull(inst.ask);
  const haveBA = bid !== null && ask !== null && ask > 0;
  const mid = haveBA ? ((bid as number) + (ask as number)) / 2 : null;
  const spreadAbs = haveBA ? (ask as number) - (bid as number) : null;
  const volume = numOrNull(inst.volume24h);
  return {
    last,
    change,
    hi: hasRange ? hi : null,
    lo: hasRange ? lo : null,
    pctOfRange: hasRange && Number.isFinite(last) ? ((last - (lo as number)) / ((hi as number) - (lo as number))) * 100 : null,
    open24h: Number.isFinite(last) && change !== null && change !== -100 ? last / (1 + change / 100) : null,
    bid,
    ask,
    mid,
    spreadAbs,
    spreadBps: mid && spreadAbs !== null ? (spreadAbs / mid) * 10000 : null,
    rangePct: hasRange ? (((hi as number) - (lo as number)) / (lo as number)) * 100 : null,
    volume,
    turnover: volume !== null && Number.isFinite(last) ? volume * last : null,
  };
};

export const compactNumber = (n: number | null | undefined): string => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return v.toFixed(0);
};

/**
 * Max leverage with where it came from — the Details pane: the instrument's
 * cap, else unlimited on a practice account, else the plan's, else the 1:100
 * default.
 */
export const maxLeverageLabel = (
  inst: Pick<Instrument, 'maxLeverage'>,
  demo: boolean,
  planLeverage: number | null | undefined,
): string => {
  const own = Number(inst.maxLeverage);
  let cap: number; let src: string;
  if (Number.isFinite(own) && own > 0) { cap = own; src = ' · from instrument'; }
  else if (demo) { cap = 999_999; src = ' · demo'; }
  else if (planLeverage) { cap = Number(planLeverage); src = ' · from plan'; }
  else { cap = 100; src = ' · default'; }
  return `${cap >= 999_999 ? 'Unlimited' : `1:${cap}`}${src}`;
};

/**
 * The About pane (Trade.jsx): the description, asset class and hours for an
 * Indian instrument — option, future (index / stock / commodity), NSE/BSE
 * stock, MCX commodity or index.
 */
export const aboutFor = (
  instrument: Pick<Instrument, 'category' | 'segment' | 'exchange' | 'underlying'>,
): { desc: string; hours: string; assetClass: string } => {
  const cat = catOf(instrument);
  const seg = segOf(instrument);
  const isMcx = String(instrument.exchange || '').toUpperCase() === 'MCX' || cat === 'COMMODITY';
  const futKind = isMcx ? 'Commodity' : cat === 'INDEX' ? 'Index' : 'Stock';
  const desc = seg === 'OPT'
    ? 'Exchange-traded option contract — a call (CE) or put (PE) on the underlying at a fixed strike, expiring on its contract date. Trades in lots.'
    : seg === 'FUT'
      ? `${futKind} futures contract${instrument.underlying ? ` on ${instrument.underlying}` : ''} — trades in lots and expires on its contract date.`
      : cat === 'STOCK'
        ? 'Listed equity — company shares traded on NSE / BSE during market hours.'
        : isMcx
          ? 'MCX commodity contract — crude oil, natural gas, gold, silver and base metals, priced in rupees.'
          : cat === 'INDEX'
            ? 'Indian stock-market index — tracks a basket of listed NSE / BSE equities.'
            : 'Tradable instrument quoted in real time.';
  const assetClass = seg === 'OPT' ? 'Options'
    : seg === 'FUT' ? `${futKind} futures`
      : cat ? cat.charAt(0) + cat.slice(1).toLowerCase() : '—';
  return { desc, hours: 'Exchange hours', assetClass };
};

/** Close-all's toast. */
export const closeAllMessage = (r: { closed: number; total: number; failed: readonly unknown[] }): { ok: boolean; text: string } =>
  (r.failed.length
    ? { ok: false, text: `Closed ${r.closed}/${r.total}. ${r.failed.length} failed.` }
    : { ok: true, text: `Closed ${r.closed} position(s)` });
