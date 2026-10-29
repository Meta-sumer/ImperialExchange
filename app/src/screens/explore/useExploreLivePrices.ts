import { useEffect, useRef, useState } from 'react';

import { applyTicks, bufferTick, type LivePrice, type PriceMap } from '@/utils/explore';
import { subscribeTicker, type Unsubscribe } from '@/websocket/channels';

/**
 * Explore's live prices — Explore.jsx:453-477, made safe for a phone.
 *
 *   • One `ticker:SYM` subscription per symbol in `symbolsKey` (sorted,
 *     '|'-joined — see utils/explore liveSymbolsKey), diffed: a symbol that
 *     joins or leaves the set is (un)subscribed on its own, so a position
 *     opening does not tear down and rebuild hundreds of subscriptions.
 *   • `enabled` false (the screen is not focused) releases EVERY
 *     subscription; the last prices stay on screen and the feed resumes on
 *     return. Unmount releases them too. A stack of screens never holds the
 *     catalogue's tickers.
 *   • Ticks are buffered in a ref and flushed at most every FLUSH_MS, so a
 *     busy feed re-renders the page a few times a second, not once per tick.
 *     The buffer applies the web's own per-tick rule (utils/explore
 *     bufferTick / applyTicks), so coalescing changes nothing but the timing.
 */
export const FLUSH_MS = 400;

export function useExploreLivePrices(symbolsKey: string, enabled: boolean): PriceMap {
  const [priceMap, setPriceMap] = useState<PriceMap>({});
  const pending = useRef(new Map<string, LivePrice>());
  const subs = useRef(new Map<string, Unsubscribe>());

  useEffect(() => {
    const want = new Set(enabled && symbolsKey ? symbolsKey.split('|').filter(Boolean) : []);
    for (const [sym, off] of [...subs.current]) {
      if (want.has(sym)) continue;
      off();
      subs.current.delete(sym);
      pending.current.delete(sym);
    }
    for (const sym of want) {
      if (subs.current.has(sym)) continue;
      subs.current.set(sym, subscribeTicker(sym, (tick) => {
        const next = bufferTick(pending.current.get(sym), tick);
        if (next) pending.current.set(sym, next);
      }));
    }
  }, [symbolsKey, enabled]);

  useEffect(() => () => {
    for (const off of subs.current.values()) off();
    subs.current.clear();
    pending.current.clear();
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const id = setInterval(() => {
      if (!pending.current.size) return;
      const batch = pending.current;
      pending.current = new Map();
      setPriceMap((prev) => applyTicks(prev, batch));
    }, FLUSH_MS);
    return () => clearInterval(id);
  }, [enabled]);

  return priceMap;
}
