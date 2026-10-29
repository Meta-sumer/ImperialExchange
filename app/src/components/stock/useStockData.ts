import type { AxiosError } from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage } from '@/api/client';
import { fetchInstrument } from '@/api/instruments.api';
import {
  STOCK_CHART_RANGES,
  fetchCandles,
  fetchFundamentals,
  fetchOrderBook,
  retainTicker,
  useTickerStore,
  type StockChartRange,
} from '@/api/market.api';
import { walletApi } from '@/api/wallet.api';
import { trimLeadingFlat, type Fundamentals, type OrderBook } from '@/types/market';
import type { Candle, Instrument } from '@/types/trading';
import { DEPTH_LEVELS, livePriceOf } from '@/utils/stockDetail';
import { subscribeOrderBook, subscribeWallet } from '@/websocket/channels';

/**
 * The data behind the instrument page — StockDetail.jsx's effects, one hook
 * per source so each keeps its own loading / error state.
 *
 * Live sources (ticker, depth, the wallet nudge) subscribe only while the
 * screen is FOCUSED: a stack of instrument pages must not hold a socket
 * channel each. Frames are coalesced — the server already flushes ticker and
 * depth at most every 150 ms; the page re-renders at most every
 * LIVE_FLUSH_MS on top of that, because a tick re-renders the chart and the
 * open tab.
 */

export const LIVE_FLUSH_MS = 300;

const statusOf = (err: unknown): number | undefined => (err as AxiosError | undefined)?.response?.status;

/* ── Instrument ───────────────────────────────────────────────────────── */

export interface InstrumentState {
  inst: Instrument | null;
  loading: boolean;
  /** A failed load that was NOT "no such instrument". */
  error: string | null;
  /** The server answered 404 "Instrument not found" (or sent no row). */
  notFound: string | null;
  reload: () => Promise<void>;
}

/**
 * GET /instruments/:symbol. The web swallows a failure and renders the page
 * around a null instrument for ever; the port says so — a 404 is a
 * not-found page, anything else a retryable error.
 */
export function useStockInstrument(symbol: string): InstrumentState {
  const [inst, setInst] = useState<Instrument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (quiet: boolean) => {
    const mine = ++seq.current;
    if (!quiet) { setLoading(true); setError(null); setNotFound(null); }
    try {
      const row = symbol ? await fetchInstrument(symbol) : null;
      if (mine !== seq.current) return;
      if (row) { setInst(row); setNotFound(null); setError(null); } else { setInst(null); setNotFound('Instrument not found'); }
    } catch (err) {
      if (mine !== seq.current) return;
      if (statusOf(err) === 404) { setInst(null); setNotFound(errorMessage(err)); } else setError(errorMessage(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    setInst(null);
    void load(false);
    return () => { seq.current += 1; };
  }, [load]);

  const reload = useCallback(() => load(true), [load]);
  return { inst, loading, error, notFound, reload };
}

/* ── Fundamentals ─────────────────────────────────────────────────────── */

/**
 * GET /instruments/:symbol/fundamentals. A failure leaves null and every
 * figure reads "—", as on the web (`.catch(() => {})`).
 */
export function useStockFundamentals(symbol: string): { fund: Fundamentals | null; reload: () => Promise<void> } {
  const [fund, setFund] = useState<Fundamentals | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const f = await fetchFundamentals(symbol);
      if (mine === seq.current) setFund(f);
    } catch {
      // Keep what we had; the grid shows "—" for anything missing.
    }
  }, [symbol]);

  useEffect(() => {
    setFund(null);
    if (symbol) void load();
    return () => { seq.current += 1; };
  }, [symbol, load]);

  return { fund, reload: load };
}

/* ── Candles ──────────────────────────────────────────────────────────── */

export interface CandleState {
  candles: Candle[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export const rangeSpec = (tf: StockChartRange): { timeframe: string; limit: number } => {
  const r = STOCK_CHART_RANGES.find((x) => x.id === tf) ?? STOCK_CHART_RANGES[0];
  return { timeframe: r.timeframe, limit: r.limit };
};

/**
 * GET /instruments/:symbol/candles for the range chip — StockDetail.jsx:101.
 * `trimLeadingFlat` as the web does. A range switch clears the old candles
 * (the web keeps drawing the previous range until the new one lands, with
 * the header's range label already switched; here the chart says Loading).
 */
export function useStockCandles(symbol: string, tf: StockChartRange): CandleState {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (quiet: boolean) => {
    const mine = ++seq.current;
    if (!quiet) { setLoading(true); setError(null); }
    const { timeframe, limit } = rangeSpec(tf);
    try {
      const rows = await fetchCandles(symbol, timeframe, limit);
      if (mine !== seq.current) return;
      setCandles(trimLeadingFlat(rows));
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      if (!quiet) setCandles([]);
      setError(errorMessage(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [symbol, tf]);

  useEffect(() => {
    setCandles([]);
    if (symbol) void load(false);
    else setLoading(false);
    return () => { seq.current += 1; };
  }, [symbol, load]);

  const reload = useCallback(() => load(true), [load]);
  return { candles, loading, error, reload };
}

/* ── Depth ────────────────────────────────────────────────────────────── */

/**
 * The five-level snapshot, then every `orderbook:SYM` frame over it —
 * StockDetail.jsx:111-118. market.api's useOrderBook does the same but
 * cannot pause; this one keeps the book while the screen is covered and
 * re-reads the snapshot when it comes back.
 */
export function useStockDepth(symbol: string, focused: boolean): { book: OrderBook | null; reload: () => Promise<void> } {
  const [book, setBook] = useState<OrderBook | null>(null);
  const seq = useRef(0);

  useEffect(() => { setBook(null); }, [symbol]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const b = await fetchOrderBook(symbol, DEPTH_LEVELS);
      if (mine === seq.current) setBook(b);
    } catch {
      // The web ignores a failed snapshot; frames may still arrive.
    }
  }, [symbol]);

  useEffect(() => {
    if (!symbol || !focused) return undefined;
    void load();
    let pending: OrderBook | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      timer = null;
      if (pending) { seq.current += 1; setBook(pending); pending = null; }
    };
    const off = subscribeOrderBook(symbol, (b) => {
      pending = b;
      if (!timer) timer = setTimeout(flush, LIVE_FLUSH_MS);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
      seq.current += 1;
    };
  }, [symbol, focused, load]);

  return { book, reload: load };
}

/* ── Live price ───────────────────────────────────────────────────────── */

/**
 * The `ticker:SYM` price — StockDetail.jsx:121-127. Through market.api's
 * shared ticker store (one socket subscription per symbol app-wide), held
 * only while focused. Like the web's `live` state it starts empty for each
 * symbol: a tick left in the store by an earlier screen may be hours old,
 * and the candles' last close is the better figure until a fresh one lands.
 */
export function useStockLivePrice(symbol: string, focused: boolean): number | null {
  const [price, setPrice] = useState<number | null>(null);
  const sym = symbol.toUpperCase();

  useEffect(() => { setPrice(null); }, [sym]);

  useEffect(() => {
    if (!sym || !focused) return undefined;
    const release = retainTicker(sym);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      timer = null;
      const px = livePriceOf(useTickerStore.getState().bySymbol[sym]);
      if (px !== null) setPrice(px);
    };
    const unsub = useTickerStore.subscribe((s, prev) => {
      if (s.bySymbol[sym] === prev.bySymbol[sym]) return;
      if (!timer) timer = setTimeout(flush, LIVE_FLUSH_MS);
    });
    return () => {
      unsub();
      release();
      if (timer) clearTimeout(timer);
    };
  }, [sym, focused]);

  return price;
}

/* ── Wallet balances ──────────────────────────────────────────────────── */

/**
 * StockDetail.jsx loads GET /wallet/balances with the page, again on every
 * `user:wallet` event and after an order is placed (OrderForm's onPlaced).
 * Kept for parity; the web kept them for the order panel it has since
 * retired, and nothing on the page renders them (see open issues).
 */
export function useStockBalances(focused: boolean): { reload: () => Promise<void> } {
  const latest = useRef<unknown>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const rows = await walletApi.balances();
      if (mine === seq.current) latest.current = rows;
    } catch {
      // `.catch(() => {})` on the web.
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (!focused) return undefined;
    return subscribeWallet(() => { void reload(); });
  }, [focused, reload]);

  return { reload };
}
