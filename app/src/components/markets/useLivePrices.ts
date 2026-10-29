import { useIsFocused } from '@react-navigation/native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Ticker } from '@/types/market';
import { subscribeTicker, type Unsubscribe } from '@/websocket/channels';

/**
 * Live last prices for a set of symbols — the markets pages' `priceMap`
 * (MarketList.jsx:165-183, FnoHome.jsx:166-174), made safe for a phone:
 *
 *   • COALESCED. The web calls setState on every tick of every symbol. Here a
 *     tick only lands in a buffer; the buffer is flushed into state at most
 *     once per `flushMs` (default 300 ms), and only when something changed.
 *     A list of hundreds of rows re-renders a few times a second, not once
 *     per tick.
 *   • PAUSED WHILE NOT FOCUSED. Every subscription is released when the
 *     screen loses focus (another screen pushed on top) and on unmount, and
 *     taken again on return — a stack of market screens never holds their
 *     tickers open underneath. Prices already seen are kept, so a returning
 *     screen shows its last figures until the next tick.
 *   • DIFFED. When the symbol set changes (a list scrolled, a tab switched)
 *     only the symbols that left are unsubscribed and only the new ones are
 *     subscribed, instead of tearing every channel down and back up.
 *
 * The acceptance rule is MarketList's: a tick whose lastPrice is not a
 * positive finite number is ignored. (FnoHome accepted any finite number,
 * zero included, and would print ₹0.00 for a glitched tick — the port uses
 * the one rule on both pages.) Values are stored as `String(Number(last))`,
 * as MarketList stores them.
 */
export const LIVE_FLUSH_MS = 300;

/** The accepted price for a tick, or null to drop it. Exported for tests. */
export const acceptTick = (t: Pick<Ticker, 'lastPrice'>): string | null => {
  const last = Number(t.lastPrice);
  if (t.lastPrice === null || t.lastPrice === undefined || !Number.isFinite(last) || last <= 0) return null;
  return String(last);
};

/** The sorted, de-duplicated, upper-cased set as a key. Exported for tests. */
export const symbolsKey = (symbols: readonly string[]): string =>
  [...new Set(symbols.filter(Boolean).map((s) => s.toUpperCase()))].sort().join('|');

export function useLivePrices(
  symbols: readonly string[],
  opts: { flushMs?: number; enabled?: boolean } = {},
): Record<string, string> {
  const { flushMs = LIVE_FLUSH_MS, enabled = true } = opts;
  const focused = useIsFocused();
  const active = focused && enabled;
  const key = useMemo(() => symbolsKey(symbols), [symbols]);

  const [prices, setPrices] = useState<Record<string, string>>({});
  /** Every price seen, newest first — what a flush publishes. */
  const latest = useRef<Record<string, string>>({});
  const dirty = useRef(false);
  const subs = useRef(new Map<string, Unsubscribe>());
  const mounted = useRef(true);

  const onTick = useCallback((t: Ticker) => {
    const v = acceptTick(t);
    if (v === null) return;
    if (latest.current[t.symbol] === v) return;
    latest.current = { ...latest.current, [t.symbol]: v };
    dirty.current = true;
  }, []);

  const flush = useCallback(() => {
    if (!dirty.current || !mounted.current) return;
    dirty.current = false;
    setPrices(latest.current);
  }, []);

  // Keep exactly the wanted channels open.
  useEffect(() => {
    const want = new Set(active && key ? key.split('|') : []);
    for (const [sym, off] of subs.current) {
      if (!want.has(sym)) {
        off();
        subs.current.delete(sym);
      }
    }
    for (const sym of want) {
      if (!subs.current.has(sym)) subs.current.set(sym, subscribeTicker(sym, onTick));
    }
  }, [active, key, onTick]);

  // The flush clock runs only while there is something to listen to.
  useEffect(() => {
    if (!active || !key) return undefined;
    const timer = setInterval(flush, flushMs);
    return () => {
      clearInterval(timer);
      flush();
    };
  }, [active, key, flushMs, flush]);

  // Unmount (and StrictMode's rehearsal of it): release everything. The
  // subscription effect above runs again after a rehearsal and re-opens.
  useEffect(() => {
    mounted.current = true;
    const open = subs.current;
    return () => {
      mounted.current = false;
      for (const off of open.values()) off();
      open.clear();
    };
  }, []);

  return prices;
}

/**
 * The live price for a row, else its catalogue price — the web's
 * `priceMap[r.symbol] ? { ...r, lastPrice: priceMap[r.symbol] } : r`.
 */
export const livePriceOf = (
  prices: Record<string, string>,
  row: { symbol: string; lastPrice?: string | null },
): string | null => prices[row.symbol] ?? row.lastPrice ?? null;
