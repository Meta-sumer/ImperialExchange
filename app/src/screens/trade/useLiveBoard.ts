import { useEffect, useMemo, useState } from 'react';

import type { Ticker } from '@/types/market';
import { createTickBuffer, mergePrices, tickPrice } from '@/utils/dashboard';
import { subscribeTickers } from '@/websocket/channels';

import type { MoverOverlay } from './tradeLogic';

/**
 * Live prices for the terminal's other symbols — every open position's and
 * pending order's (so each row's P&L and "current price" tick, Trade.jsx:
 * 934-969) and the rows a side panel shows (1445-1469, 1334-1377).
 *
 * The web sets state on every frame of every channel; here ticks are
 * coalesced to one update per 400 ms, and nothing is subscribed while the
 * screen is out of focus or the app is in the background. The subscription
 * follows the symbol SET — a refetch returning the same symbols in a new
 * array does not rebuild it.
 */
export function useLiveBoard(symbols: readonly string[], active: boolean): {
  prices: Record<string, number>;
  overlay: Record<string, MoverOverlay>;
} {
  const key = useMemo(
    () => [...new Set(symbols.filter(Boolean).map((s) => s.toUpperCase()))].sort().join('|'),
    [symbols],
  );
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [overlay, setOverlay] = useState<Record<string, MoverOverlay>>({});

  useEffect(() => {
    if (!active || !key) return undefined;
    const pendingOverlay: Record<string, MoverOverlay> = {};
    let overlayDirty = false;
    const buffer = createTickBuffer(400, (next) => {
      setPrices((prev) => mergePrices(prev, next));
      if (overlayDirty) {
        const snap = { ...pendingOverlay };
        overlayDirty = false;
        setOverlay((prev) => ({ ...prev, ...snap }));
      }
    });
    const off = subscribeTickers(key.split('|'), (t: Ticker) => {
      const px = tickPrice(t);
      const sym = String(t.symbol || '').toUpperCase();
      if (!sym) return;
      if (px !== null) buffer.push(sym, px);
      if (t.change24h !== null && Number.isFinite(Number(t.change24h))) {
        pendingOverlay[sym] = {
          change24h: Number(t.change24h),
          dayHigh: Number(t.dayHigh),
          dayLow: Number(t.dayLow),
          volume24h: Number(t.volume24h),
          lastPrice: Number(t.lastPrice),
        };
        overlayDirty = true;
      }
    });
    return () => { off(); buffer.cancel(); };
  }, [key, active]);

  return { prices, overlay };
}
