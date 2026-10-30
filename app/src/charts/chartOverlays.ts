import type { CalendarEvent, CalendarImpact } from '@/types/market';
import type { OrderSide } from '@/types/trading';

import type { ChartPrefs } from './chartCatalog';

/**
 * What the chart draws for the trader's own book — PriceChart.jsx sections
 * 7 (symbol filters), 8 (price lines) and 8b (pill descriptors), as pure
 * functions. The WebView reconciles lines by key and positions pills; every
 * key a pill posts back is decoded here by `parsePillKey`.
 *
 * Order lines and position entry lines are coloured BY SIDE (the Buy /
 * Sell colours of Chart settings), matching their pills; TP / SL keep their
 * own colours.
 */

export interface ChartPositionRow {
  id: string;
  symbol: string;
  side: OrderSide;
  quantity: string | number;
  entryPrice: string | number | null;
  stopLoss?: string | number | null;
  takeProfit?: string | number | null;
  /** The live P&L the entry pill shows (the row's, as the book computes it). */
  pnl: number;
  /** When it was opened — the entry marker's time (null = no marker). */
  openedAt?: string | null;
}

export interface ChartOrderRow {
  id: string;
  symbol: string;
  side: OrderSide;
  type: string;
  status?: string | null;
  quantity: string | number;
  price?: string | number | null;
  stopPrice?: string | number | null;
  stopLoss?: string | number | null;
  takeProfit?: string | number | null;
  triggeredAt?: string | null;
}

export interface PendingPreviewInput { side: OrderSide | null; price: string | number | null }
export interface OrderPreviewInput { side: OrderSide; mode: string; entry: number | null; tp: number | null; sl: number | null }

export interface PriceLineSpec {
  key: string;
  price: number;
  color: string;
  lineWidth: number;
  /** 0 solid · 1 dotted · 2 dashed (lightweight-charts LineStyle). */
  lineStyle: number;
  axisLabelVisible: boolean;
  title: string;
}

export type PillKind = 'entry' | 'sl' | 'tp';

export interface PillSpec {
  key: string;
  kind: PillKind;
  target: 'position' | 'order';
  /** The position / order id, or '__preview__' — for +TP / +SL keys. */
  id: string;
  price: number;
  side: OrderSide;
  qty: number;
  /** The entry price SL / TP P&L is measured from. */
  entry: number;
  /** Entry pill only. */
  pnl: number;
  orderType?: string;
  preview?: boolean;
  quickTp: boolean;
  quickSl: boolean;
}

export const PREVIEW_ID = '__preview__';

const pos = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * A real pending order has landed at the preview's price — hide the preview
 * so the draft and the order it became never show together
 * (PriceChart.jsx:2716).
 */
export const previewRealMatch = (orderPreview: OrderPreviewInput | null, symbolOrders: readonly ChartOrderRow[]): boolean => {
  if (!orderPreview || orderPreview.mode !== 'LIMIT') return false;
  const ep = Number(orderPreview.entry);
  if (!(ep > 0)) return false;
  const tol = Math.max(ep * 0.0003, 1e-9);
  return symbolOrders.some((o) => {
    if (o.status && o.status !== 'PENDING') return false;
    if (o.side !== orderPreview.side) return false;
    const op = Number(o.type === 'STOP' ? o.stopPrice : o.price);
    return Number.isFinite(op) && Math.abs(op - ep) <= tol;
  });
};

export interface OverlayInput {
  symbol: string;
  positions: readonly ChartPositionRow[];
  orders: readonly ChartOrderRow[];
  pendingPreview: PendingPreviewInput | null;
  orderPreview: OrderPreviewInput | null;
  prefs: Pick<ChartPrefs, 'tpColor' | 'slColor' | 'entryColor' | 'buyColor' | 'sellColor'>;
  /** Show-on-Chart toggles (Trade.jsx:3037-3066). */
  show: { positions: boolean; tpsl: boolean; stopLimit: boolean; orderPreview: boolean };
}

/** PriceChart.jsx:2731-2917. */
export const buildPriceLines = (inp: OverlayInput): PriceLineSpec[] => {
  const out: PriceLineSpec[] = [];
  const orders = inp.show.stopLimit ? inp.orders.filter((o) => o.symbol === inp.symbol) : [];
  const positions = (inp.show.positions || inp.show.tpsl) ? inp.positions.filter((p) => p.symbol === inp.symbol) : [];

  for (const o of orders) {
    const color = o.side === 'BUY' ? inp.prefs.buyColor : inp.prefs.sellColor;
    const prefix = o.side === 'BUY' ? 'BUY' : 'SELL';
    const price = pos(o.price);
    const stop = pos(o.stopPrice);
    if (o.type === 'LIMIT' && price) {
      out.push({ key: `order:${o.id}:limit`, price, color, lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: `${prefix} LIM` });
    } else if (o.type === 'STOP') {
      if (stop) out.push({ key: `order:${o.id}:trigger`, price: stop, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: `${prefix} STP` });
      if (price) out.push({ key: `order:${o.id}:stoplimit`, price, color, lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: 'STP-LIM' });
    }
  }

  for (const p of positions) {
    const entry = inp.show.positions ? pos(p.entryPrice) : null;
    const sl = inp.show.tpsl ? pos(p.stopLoss) : null;
    const tp = inp.show.tpsl ? pos(p.takeProfit) : null;
    if (entry) out.push({ key: `pos:${p.id}:entry`, price: entry, color: p.side === 'SELL' ? inp.prefs.sellColor : inp.prefs.buyColor, lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: '' });
    if (sl) out.push({ key: `pos:${p.id}:sl`, price: sl, color: inp.prefs.slColor, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' });
    if (tp) out.push({ key: `pos:${p.id}:tp`, price: tp, color: inp.prefs.tpColor, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' });
  }

  const pp = inp.show.stopLimit ? inp.pendingPreview : null;
  const ppPrice = pp ? pos(pp.price) : null;
  if (pp && ppPrice) {
    out.push({ key: 'preview:form', price: ppPrice, color: pp.side === 'BUY' ? '#10b981' : '#ef4444', lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: pp.side === 'BUY' ? '↺ BUY' : '↺ SELL' });
  }

  const op = inp.show.orderPreview && inp.show.stopLimit ? inp.orderPreview : null;
  if (op && !previewRealMatch(op, orders)) {
    const isLimit = op.mode === 'LIMIT';
    const e = pos(op.entry); const t = pos(op.tp); const s = pos(op.sl);
    if (e) out.push({ key: 'preview:entry', price: e, color: op.side === 'SELL' ? inp.prefs.sellColor : inp.prefs.buyColor, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: isLimit ? '◹ LIMIT' : '◹ ENTRY' });
    if (t) out.push({ key: 'preview:tp', price: t, color: inp.prefs.tpColor, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '◹ TP' });
    if (s) out.push({ key: 'preview:sl', price: s, color: inp.prefs.slColor, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '◹ SL' });
  }
  return out;
};

/**
 * PriceChart.jsx:2928-3017, and the quick-add chips of :3864.
 *
 * One deliberate difference: with "Open positions" off and "TP / SL" on,
 * the web strips the entry price off the row and then measures the SL / TP
 * pill's P&L from 0 (a BTC stop reads as −$60,000). Here the pill keeps the
 * real entry for its arithmetic and only the entry PILL is hidden.
 */
export const buildPills = (inp: OverlayInput): PillSpec[] => {
  const out: PillSpec[] = [];
  const showTpSl = inp.show.tpsl;
  const orders = inp.show.stopLimit ? inp.orders.filter((o) => o.symbol === inp.symbol) : [];
  const positions = (inp.show.positions || inp.show.tpsl) ? inp.positions.filter((p) => p.symbol === inp.symbol) : [];

  for (const p of positions) {
    const entry = pos(p.entryPrice) ?? 0;
    const qty = Number(p.quantity) || 0;
    const sl = showTpSl ? pos(p.stopLoss) : null;
    const tp = showTpSl ? pos(p.takeProfit) : null;
    const base = { target: 'position' as const, id: p.id, side: p.side, qty, entry, pnl: 0, quickTp: false, quickSl: false };
    if (inp.show.positions && entry > 0) {
      out.push({ ...base, key: `pos:${p.id}:entry`, kind: 'entry', price: entry, pnl: p.pnl, quickTp: showTpSl && !tp, quickSl: showTpSl && !sl });
    }
    if (sl) out.push({ ...base, key: `pos:${p.id}:sl`, kind: 'sl', price: sl });
    if (tp) out.push({ ...base, key: `pos:${p.id}:tp`, kind: 'tp', price: tp });
  }

  for (const o of orders) {
    // Only PENDING can be modified, and a fired STOP cannot (PriceChart.jsx:2948).
    if (o.status && o.status !== 'PENDING') continue;
    if (o.type === 'STOP' && o.triggeredAt) continue;
    const entry = o.type === 'STOP' ? pos(o.stopPrice) : pos(o.price);
    if (!entry) continue;
    const sl = showTpSl ? pos(o.stopLoss) : null;
    const tp = showTpSl ? pos(o.takeProfit) : null;
    const base = { target: 'order' as const, id: o.id, side: o.side, qty: Number(o.quantity) || 0, entry, pnl: 0, orderType: o.type, quickTp: false, quickSl: false };
    out.push({ ...base, key: `order:${o.id}:entry`, kind: 'entry', price: entry, quickTp: showTpSl && !tp, quickSl: showTpSl && !sl });
    if (sl) out.push({ ...base, key: `order:${o.id}:sl`, kind: 'sl', price: sl });
    if (tp) out.push({ ...base, key: `order:${o.id}:tp`, kind: 'tp', price: tp });
  }

  const op = inp.show.orderPreview && inp.show.stopLimit ? inp.orderPreview : null;
  const opEntry = op ? pos(op.entry) : null;
  if (op && opEntry && !previewRealMatch(op, orders)) {
    const mode = op.mode === 'LIMIT' ? 'LIMIT' : 'MARKET';
    const sl = pos(op.sl);
    const tp = pos(op.tp);
    const base = { target: 'order' as const, id: PREVIEW_ID, side: op.side, qty: 0, entry: opEntry, pnl: 0, orderType: mode, preview: true, quickTp: false, quickSl: false };
    out.push({ ...base, key: 'preview:order:entry', kind: 'entry', price: opEntry, quickTp: showTpSl && !tp, quickSl: showTpSl && !sl });
    if (sl) out.push({ ...base, key: 'preview:order:sl', kind: 'sl', price: sl });
    if (tp) out.push({ ...base, key: 'preview:order:tp', kind: 'tp', price: tp });
  }
  return out;
};

export interface PillRef {
  target: 'position' | 'order';
  /** Position / order id; PREVIEW_ID for the order-form draft. */
  id: string;
  kind: PillKind;
  /** A +TP / +SL drag from the entry pill: the level does not exist yet. */
  isNew: boolean;
}

/** Decode a key the WebView posted. Null for anything unrecognised. */
export const parsePillKey = (key: string): PillRef | null => {
  const parts = key.split(':');
  const kindOf = (s: string | undefined): PillKind | null => (s === 'entry' || s === 'sl' || s === 'tp' ? s : null);
  if (parts[0] === 'preview' && parts[1] === 'order') {
    const kind = kindOf(parts[2]);
    return kind && parts.length === 3 ? { target: 'order', id: PREVIEW_ID, kind, isNew: false } : null;
  }
  if (parts[0] !== 'pos' && parts[0] !== 'order') return null;
  const id = parts[1];
  const kind = kindOf(parts[2]);
  if (!id || !kind) return null;
  const isNew = parts[3] === 'new';
  if (parts.length !== (isNew ? 4 : 3)) return null;
  return { target: parts[0] === 'pos' ? 'position' : 'order', id, kind, isNew };
};

/* ── Economic calendar on the chart (PriceChart.jsx:1344-1420) ───────── */

export interface CalendarMarkerInput { ts: number; currency: string; impact: CalendarImpact; code: string }
export interface CalendarFilters { high: boolean; medium: boolean; low: boolean; lowest: boolean }

const wantedImpacts = (f: CalendarFilters): Set<CalendarImpact> => {
  const s = new Set<CalendarImpact>();
  if (f.high) s.add('high');
  if (f.medium) s.add('medium');
  if (f.low) s.add('low');
  if (f.lowest) s.add('lowest');
  return s;
};

const DAY_MS = 86_400_000;

/**
 * Events for the chart's markers: ±7 days, the first 80, then the impact
 * filter and the instrument's two currencies. The runtime snaps each to the
 * nearest loaded candle. Live and admin events only — the web's generated
 * schedule is not ported (types/market CalendarEvent).
 */
export const chartCalendarEvents = (
  events: readonly CalendarEvent[],
  currencies: readonly (string | null | undefined)[],
  filters: CalendarFilters,
  nowMs: number,
): CalendarMarkerInput[] => {
  const wanted = wantedImpacts(filters);
  if (!wanted.size) return [];
  const ccys = new Set(currencies.filter((c): c is string => !!c));
  return [...events]
    .filter((e) => e.ts >= nowMs - 7 * DAY_MS && e.ts <= nowMs + 7 * DAY_MS)
    .sort((a, b) => a.ts - b.ts)
    .slice(0, 80)
    .filter((e) => wanted.has(e.impact) && (!ccys.size || !e.currency || ccys.has(e.currency)))
    .map((e) => ({ ts: e.ts, currency: e.currency, impact: e.impact, code: e.currency || 'EVT' }));
};

export interface NextEventChip { ts: number; currency: string; impact: CalendarImpact; event: string }

/** The "Next:" chip — the first matching event in the next 14 days. */
export const nextCalendarEvent = (
  events: readonly CalendarEvent[],
  currencies: readonly (string | null | undefined)[],
  filters: CalendarFilters,
  nowMs: number,
): NextEventChip | null => {
  const wanted = wantedImpacts(filters);
  if (!wanted.size) return null;
  const ccys = new Set(currencies.filter((c): c is string => !!c));
  let best: CalendarEvent | null = null;
  for (const e of events) {
    if (e.ts <= nowMs || e.ts > nowMs + 14 * DAY_MS) continue;
    if (!wanted.has(e.impact)) continue;
    if (ccys.size && e.currency && !ccys.has(e.currency)) continue;
    if (!best || e.ts < best.ts) best = e;
  }
  return best ? { ts: best.ts, currency: best.currency, impact: best.impact, event: best.event } : null;
};

/* ── Trade markers (PriceChart.jsx trade markers) ─────────────────────── */

/**
 * One time-anchored marker on the price series: an entry arrow (BUY below
 * the bar, SELL above) or an exit square coloured by the P&L sign. `ts` is
 * epoch MILLISECONDS; the runtime snaps it to the nearest loaded candle and
 * drops anything older than the loaded range rather than stacking it on
 * the first bar.
 */
export interface TradeMarkerInput {
  ts: number;
  position: 'aboveBar' | 'belowBar';
  color: string;
  shape: 'arrowUp' | 'arrowDown' | 'square';
  text: string;
}

/** A closed position (types/trading Position fits) as the exit marker reads it. */
export interface ClosedTradeMarkerRow {
  id: string;
  side: OrderSide;
  quantity: string | number | null;
  closedQuantity?: string | number | null;
  entryPrice: string | number | null;
  closePrice?: string | number | null;
  openedAt: string | null;
  closedAt?: string | null;
  realizedPnl?: string | number | null;
}

const TRADE_BUY = '#10B981';
const TRADE_SELL = '#EF4444';

const tsOf = (iso: string | null | undefined): number | null => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : null;
};
const pxText = (v: string | number | null | undefined, precision: number): string => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(precision) : '—';
};
const qtyText = (v: string | number | null | undefined): string => {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '';
};

/**
 * Entry markers for the OPEN positions and entry + exit markers for the
 * CLOSED trades of the chart's symbol — the web's trade markers (BUY entry
 * = green arrowUp below the bar "B 10 @ 2948.40", SELL = red arrowDown
 * above, exit = square coloured by the P&L sign "X @ 2970.10 (+21.70)"),
 * oldest first and capped to the most recent `cap`.
 */
export const buildTradeMarkers = (
  open: readonly ChartPositionRow[],
  closed: readonly ClosedTradeMarkerRow[],
  precision = 2,
  cap = 500,
): TradeMarkerInput[] => {
  const out: TradeMarkerInput[] = [];
  const entry = (side: OrderSide, qty: string | number | null | undefined, price: string | number | null | undefined, ts: number): void => {
    const buy = side === 'BUY';
    out.push({
      ts,
      position: buy ? 'belowBar' : 'aboveBar',
      color: buy ? TRADE_BUY : TRADE_SELL,
      shape: buy ? 'arrowUp' : 'arrowDown',
      text: `${buy ? 'B' : 'S'} ${qtyText(qty)} @ ${pxText(price, precision)}`.replace(/\s+/g, ' '),
    });
  };
  for (const p of open) {
    const ts = tsOf(p.openedAt);
    if (ts !== null) entry(p.side, p.quantity, p.entryPrice, ts);
  }
  for (const c of closed) {
    const qty = Number(c.closedQuantity) > 0 ? c.closedQuantity : c.quantity;
    const opened = tsOf(c.openedAt);
    if (opened !== null) entry(c.side, qty, c.entryPrice, opened);
    const exited = tsOf(c.closedAt);
    if (exited !== null && c.closePrice !== null && c.closePrice !== undefined) {
      const pnl = Number(c.realizedPnl);
      const hasPnl = Number.isFinite(pnl);
      out.push({
        ts: exited,
        position: c.side === 'BUY' ? 'aboveBar' : 'belowBar',
        color: hasPnl && pnl < 0 ? TRADE_SELL : TRADE_BUY,
        shape: 'square',
        text: `X @ ${pxText(c.closePrice, precision)}${hasPnl ? ` (${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)})` : ''}`,
      });
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.length > cap ? out.slice(out.length - cap) : out;
};
