import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { api } from '@/api/client';
import {
  adaptFnoUnderlyings,
  adaptFundamentals,
  adaptOptionChain,
  adaptOrderBook,
  mergeTicker,
  normaliseCandles,
  type FnoKind,
  type FnoUnderlyings,
  type Fundamentals,
  type OptionChain,
  type OrderBook,
  type Ticker,
} from '@/types/market';
import type { Candle, Instrument } from '@/types/trading';
import { subscribeOrderBook, subscribeTicker, type Unsubscribe } from '@/websocket/channels';

/**
 * Market data: candles, depth, the option chain, fundamentals, and the live
 * quote store every price on screen reads from.
 *
 * There is no `/market` or `/quotes` route in the backend — quotes are the
 * `ticker:SYM` channel over a REST snapshot (the instrument row's lastPrice).
 * Endpoints: backend/src/routes/instrument.js.
 */

type Raw = Record<string, unknown>;

const payload = (body: unknown): unknown => {
  const env = body && typeof body === 'object' ? (body as Raw) : {};
  return 'data' in env ? env.data : body;
};

const path = (symbol: string, tail: string): string =>
  `/instruments/${encodeURIComponent(symbol.toUpperCase())}/${tail}`;

/* ── Candles ──────────────────────────────────────────────────────────── */

/**
 * GET /instruments/:symbol/candles — chronological, cleaned for the chart:
 * snapped to the bucket grid, nothing after "now", one candle per bucket.
 * `limit` defaults to the chart's 500; the sparkline callers pass their own
 * (FnoHome asks for 24 daily bars, Trade's mini-chart 48 hourly).
 */
export const fetchCandles = async (
  symbol: string,
  timeframe: string,
  limit = 500,
  opts: { signal?: AbortSignal } = {},
): Promise<Candle[]> => {
  const res = await api.get(path(symbol, 'candles'), {
    params: { timeframe, limit },
    signal: opts.signal,
  });
  return normaliseCandles(payload(res.data), timeframe);
};

/**
 * The stock page's range chips and the candles each one asks for —
 * StockDetail.jsx TF_MAP. Pass the result through trimLeadingFlat
 * (types/market), as the web does, before drawing.
 */
export const STOCK_CHART_RANGES = [
  { id: '1D', timeframe: '5m', limit: 80 },
  { id: '1W', timeframe: '30m', limit: 90 },
  { id: '1M', timeframe: '1d', limit: 30 },
  { id: '3M', timeframe: '1d', limit: 90 },
  { id: '6M', timeframe: '1d', limit: 180 },
  { id: '1Y', timeframe: '1w', limit: 52 },
  { id: '3Y', timeframe: '1w', limit: 156 },
  { id: '5Y', timeframe: '1w', limit: 260 },
  { id: 'All', timeframe: '1w', limit: 520 },
] as const;
export type StockChartRange = (typeof STOCK_CHART_RANGES)[number]['id'];

/* ── Depth ────────────────────────────────────────────────────────────── */

/**
 * GET /instruments/:symbol/orderbook — the external L2 book where the feed
 * has one (Binance), else the internal engine's resting orders. Trade asks
 * for 20 levels, StockDetail for 5; the server's default is 25.
 */
export const fetchOrderBook = async (symbol: string, depth?: number): Promise<OrderBook> => {
  const res = await api.get(path(symbol, 'orderbook'), {
    params: depth ? { depth } : undefined,
  });
  return adaptOrderBook(payload(res.data), symbol);
};

/**
 * The snapshot, then every `orderbook:SYM` frame over it — Trade.jsx:903-930.
 * Pass null to switch it off (Trade only pays for depth while the Depth tab
 * is open). A frame carries the whole top of book, so it replaces the
 * snapshot rather than merging into it.
 */
export function useOrderBook(
  symbol: string | null | undefined,
  depth = 20,
): { book: OrderBook | null; loading: boolean } {
  const [book, setBook] = useState<OrderBook | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!symbol) {
      setBook(null);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setBook(null);
    setLoading(true);
    fetchOrderBook(symbol, depth)
      .then((b) => { if (!cancelled) setBook(b); })
      .catch(() => { if (!cancelled) setBook(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    const off = subscribeOrderBook(symbol, (b) => {
      if (cancelled) return;
      setBook(b);
      setLoading(false);
    });
    return () => { cancelled = true; off(); };
  }, [symbol, depth]);

  return { book, loading };
}

/* ── Option chain ─────────────────────────────────────────────────────── */

/**
 * GET /instruments/fno/underlyings — the option-chain picker: which market
 * segments are switched on, and every underlying with live F&O in scope
 * (kind, exchange, spot, option expiries, futures), index → stock →
 * commodity. The server applies the admin's segment switches; a switched-off
 * segment's underlyings are simply absent.
 */
export const fetchFnoUnderlyings = async (): Promise<FnoUnderlyings> => {
  const res = await api.get('/instruments/fno/underlyings');
  return adaptFnoUnderlyings(payload(res.data));
};

/**
 * GET /instruments/option-chain?underlying=&expiry=&kind= — strikes × CE/PE
 * for one expiry (the nearest unexpired when `expiry` is absent or not
 * listed), the expiries, the spot (or, for MCX, the future the options settle
 * into), the lot size and the ATM strike. `analytics` and each leg's `stats`
 * (OI, IV, Greeks, PCR, max pain) come from Dhan and are null without it.
 *
 * A 404 `NO_OPTION_CHAIN` means the segment is off or nothing is listed —
 * the server's message says so.
 */
export const fetchOptionChain = async (
  underlying: string,
  expiry?: string | null,
  kind?: FnoKind | null,
): Promise<OptionChain> => {
  const params: Record<string, string> = { underlying: underlying.toUpperCase() };
  if (expiry) params.expiry = expiry;
  if (kind) params.kind = kind;
  const res = await api.get('/instruments/option-chain', { params });
  return adaptOptionChain(payload(res.data), underlying);
};

/* ── Fundamentals ─────────────────────────────────────────────────────── */

/** GET /instruments/:symbol/fundamentals — Yahoo, cached 5 min server-side. */
export const fetchFundamentals = async (symbol: string): Promise<Fundamentals> => {
  const res = await api.get(path(symbol, 'fundamentals'));
  return adaptFundamentals(payload(res.data));
};

/* ── Live quotes ──────────────────────────────────────────────────────── */

/**
 * The latest tick per symbol, for the whole app.
 *
 * The web keeps a `priceMap` in each page and subscribes per page — Trade
 * alone opens five separate ticker subscriptions (chart symbol, positions,
 * pending orders, movers, the equity strip). Here there is one store, and a
 * symbol is subscribed while at least one screen retains it.
 */
interface TickerState {
  bySymbol: Record<string, Ticker>;
}

export const useTickerStore = create<TickerState>(() => ({ bySymbol: {} }));

const onTick = (t: Ticker): void => {
  useTickerStore.setState((s) => ({
    bySymbol: { ...s.bySymbol, [t.symbol]: mergeTicker(s.bySymbol[t.symbol], t) },
  }));
};

const retained = new Map<string, { count: number; off: Unsubscribe }>();

/** Keep `symbol`'s ticker live until the returned release is called. */
export const retainTicker = (symbol: string): Unsubscribe => {
  const sym = symbol.toUpperCase();
  if (!sym) return () => undefined;
  const entry = retained.get(sym);
  if (entry) entry.count += 1;
  else retained.set(sym, { count: 1, off: subscribeTicker(sym, onTick) });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const e = retained.get(sym);
    if (!e) return;
    e.count -= 1;
    if (e.count <= 0) {
      e.off();
      retained.delete(sym);
    }
  };
};

export const retainTickers = (symbols: readonly string[]): Unsubscribe => {
  const offs = [...new Set(symbols.map((s) => s.toUpperCase()).filter(Boolean))].map(retainTicker);
  return () => { for (const off of offs) off(); };
};

/** The last tick for a symbol, if one has arrived. */
export const getTicker = (symbol: string): Ticker | undefined =>
  useTickerStore.getState().bySymbol[symbol.toUpperCase()];

/** The live tick for one symbol; null until the first one arrives. */
export function useTicker(symbol: string | null | undefined): Ticker | null {
  const sym = symbol ? symbol.toUpperCase() : '';
  useEffect(() => (sym ? retainTicker(sym) : undefined), [sym]);
  return useTickerStore((s) => (sym ? s.bySymbol[sym] ?? null : null));
}

/**
 * Live ticks for a set of symbols, keyed by symbol. The subscription follows
 * the SET, not the array's identity — a refetch that returns the same
 * symbols in a new array does not tear down and rebuild every channel
 * (the reason Trade.jsx keys its effects on a joined-symbol string).
 */
export function useTickers(symbols: readonly string[]): Record<string, Ticker> {
  const key = useMemo(
    () => [...new Set(symbols.map((s) => s.toUpperCase()).filter(Boolean))].sort().join('|'),
    [symbols],
  );
  useEffect(() => (key ? retainTickers(key.split('|')) : undefined), [key]);
  return useTickerStore(useShallow((s) => {
    const out: Record<string, Ticker> = {};
    if (!key) return out;
    for (const sym of key.split('|')) {
      const t = s.bySymbol[sym];
      if (t) out[sym] = t;
    }
    return out;
  }));
}

/**
 * An instrument row with its live tick laid over it. Fields the tick does not
 * carry keep the row's value; the row is returned untouched without a tick.
 */
export const withLiveQuote = (inst: Instrument, tick: Ticker | null | undefined): Instrument => {
  if (!tick) return inst;
  return {
    ...inst,
    lastPrice: tick.lastPrice ?? inst.lastPrice ?? null,
    bid: tick.bid ?? inst.bid ?? null,
    ask: tick.ask ?? inst.ask ?? null,
    change24h: tick.change24h ?? inst.change24h ?? null,
    dayHigh: tick.dayHigh ?? inst.dayHigh ?? null,
    dayLow: tick.dayLow ?? inst.dayLow ?? null,
    volume24h: tick.volume24h ?? inst.volume24h ?? null,
  };
};
