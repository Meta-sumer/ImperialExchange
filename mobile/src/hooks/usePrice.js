import { useEffect, useState } from 'react';
import { wsClient } from '../services/ws';

/**
 * Live last-price for a symbol via the WebSocket `ticker:<symbol>` channel.
 * Seed it with a known price (e.g. from the list row) so the UI isn't blank
 * before the first tick arrives.
 */
export function usePrice(symbol, seed) {
  const [price, setPrice] = useState(seed != null ? Number(seed) : null);

  useEffect(() => {
    if (seed != null) setPrice(Number(seed));
  }, [seed]);

  useEffect(() => {
    if (!symbol) return undefined;
    const off = wsClient.subscribe(`ticker:${symbol}`, (data) => {
      const p = Number(data?.lastPrice ?? data?.price);
      if (Number.isFinite(p)) setPrice(p);
    });
    return off;
  }, [symbol]);

  return price;
}
