import { useEffect, useState } from 'react';

import { fetchCandles } from '@/api/market.api';
import type { Candle } from '@/types/trading';

/**
 * FnoHome's sparkline candles — `GET /instruments/:symbol/candles?timeframe=1d&limit=24`
 * — cached per symbol so switching the Equity / Commodities tab does not
 * refetch, and one request in flight per symbol (FnoHome.jsx:45-64).
 *
 * The web's cache lives until the page reloads, and a failure is cached as
 * "no candles" for as long. An app is not reloaded — it can sit in the
 * background for days — so entries here expire: daily candles after
 * SPARK_TTL_MS, a failure after SPARK_FAIL_TTL_MS so one network blip does
 * not blank the sparklines for the rest of the session.
 *
 * Public market data, not per-user: nothing to reset on sign-out.
 */
export const SPARK_TTL_MS = 15 * 60_000;
export const SPARK_FAIL_TTL_MS = 60_000;
export const SPARK_TIMEFRAME = '1d';
export const SPARK_LIMIT = 24;

interface Entry { candles: Candle[]; at: number; ttl: number }

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Candle[]>>();

/** A usable cached value, or undefined. */
export const cachedSpark = (symbol: string, now = Date.now()): Candle[] | undefined => {
  const e = cache.get(symbol);
  return e && now - e.at < e.ttl ? e.candles : undefined;
};

export const fetchSpark = (symbol: string): Promise<Candle[]> => {
  const hit = cachedSpark(symbol);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(symbol);
  if (pending) return pending;
  const p = fetchCandles(symbol, SPARK_TIMEFRAME, SPARK_LIMIT)
    .then((candles) => {
      cache.set(symbol, { candles, at: Date.now(), ttl: SPARK_TTL_MS });
      return candles;
    })
    .catch(() => {
      cache.set(symbol, { candles: [], at: Date.now(), ttl: SPARK_FAIL_TTL_MS });
      return [] as Candle[];
    })
    .finally(() => { inflight.delete(symbol); });
  inflight.set(symbol, p);
  return p;
};

/** Test hook: forget everything. */
export const _resetSparkCache = (): void => {
  cache.clear();
  inflight.clear();
};

/** The candles for `symbol`, or null until they arrive. */
export function useSparkCandles(symbol: string): Candle[] | null {
  const [candles, setCandles] = useState<Candle[] | null>(() => cachedSpark(symbol) ?? null);
  useEffect(() => {
    let cancelled = false;
    setCandles(cachedSpark(symbol) ?? null);
    fetchSpark(symbol).then((pts) => { if (!cancelled) setCandles(pts); });
    return () => { cancelled = true; };
  }, [symbol]);
  return candles;
}
