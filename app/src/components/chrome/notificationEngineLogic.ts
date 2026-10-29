/**
 * The bell engine's decisions that are not already in types/notifications —
 * which symbols to watch, what one tick raises, and the portfolio P&L the
 * band check reads. useNotifications.js keeps these in refs inside one hook;
 * here they are pure so the store only feeds them.
 *
 * Pure: no React, no network, no timers. Pinned by __tests__/stage3_chrome.logic.
 */
import type { PriceAlert } from '@/types/market';
import {
  priceAlertNotification,
  pushPriceSample,
  screenerNotification,
  screenerSign,
  volatilityNotification,
  type LocalNotificationInput,
  type PriceSample,
  type WatchedAlert,
} from '@/types/notifications';
import type { Position } from '@/types/trading';

const toNum = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
};

/**
 * The alerts the tick watcher checks — useNotifications.js:291
 * `(data?.data || []).filter((a) => a.isActive && !a.triggeredAt)`.
 */
export const watchedAlertsFrom = (alerts: readonly PriceAlert[]): WatchedAlert[] =>
  alerts
    .filter((a) => a.isActive && !a.triggeredAt && !!a.symbol)
    .map((a) => {
      const target = toNum(a.targetPrice);
      return {
        id: a.id,
        symbol: a.symbol,
        direction: a.direction,
        targetPrice: Number.isFinite(target) ? target : null,
        note: a.note,
      };
    });

/**
 * Every symbol an alert or an open position names, sorted and unique — the
 * web's 5-second `sample()` (useNotifications.js:327-342).
 */
export const watchSymbols = (
  alerts: readonly Pick<WatchedAlert, 'symbol'>[],
  positions: readonly Pick<Position, 'symbol'>[],
): string[] => {
  const next = new Set<string>();
  for (const a of alerts) if (a.symbol) next.add(a.symbol);
  for (const p of positions) if (p.symbol) next.add(p.symbol);
  return [...next].sort();
};

export const sameSymbols = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((s, i) => s === b[i]);

/** What the tick watcher remembers between ticks, per session. */
export interface TickMemory {
  /** Alerts that already rang this session (a flapping price rings once). */
  fired: Set<string>;
  history: Map<string, PriceSample[]>;
  volatilityFiredAt: Map<string, number>;
  screenerFiredAt: Map<string, number>;
  dayChangeSign: Map<string, number>;
}

export const newTickMemory = (): TickMemory => ({
  fired: new Set(),
  history: new Map(),
  volatilityFiredAt: new Map(),
  screenerFiredAt: new Map(),
  dayChangeSign: new Map(),
});

/**
 * One tick for `symbol` — useNotifications.js:351-426, in its order:
 * (1) price-alert crossings, (2) the 5-minute volatility window, (3) the
 * ±5% day-change band. Returns what to raise; `mem` is updated in place,
 * exactly as the web's refs are (the day-change sign is stored whatever
 * happens, so re-entering a band is what rings).
 */
export const processTick = (
  mem: TickMemory,
  alerts: readonly WatchedAlert[],
  symbol: string,
  price: number,
  change24h: number | null,
  now: number,
): LocalNotificationInput[] => {
  if (!Number.isFinite(price) || price <= 0) return [];
  const out: LocalNotificationInput[] = [];

  for (const a of alerts) {
    if (a.symbol !== symbol || mem.fired.has(a.id)) continue;
    const n = priceAlertNotification(a, price);
    if (!n) continue;
    mem.fired.add(a.id);
    out.push(n);
  }

  const hist = pushPriceSample(mem.history.get(symbol) ?? [], { ts: now, price });
  mem.history.set(symbol, hist);
  const vol = volatilityNotification(symbol, hist, now, mem.volatilityFiredAt.get(symbol) ?? 0);
  if (vol) {
    mem.volatilityFiredAt.set(symbol, now);
    out.push(vol);
  }

  if (change24h !== null && Number.isFinite(change24h)) {
    const prevSign = mem.dayChangeSign.get(symbol) ?? 0;
    const scr = screenerNotification(symbol, change24h, prevSign, now, mem.screenerFiredAt.get(symbol) ?? 0);
    if (scr) {
      mem.screenerFiredAt.set(symbol, now);
      out.push(scr);
    }
    mem.dayChangeSign.set(symbol, screenerSign(change24h));
  }

  return out;
};

/**
 * The portfolio's floating P&L for the band notification —
 * useNotifications.js's 5-second re-check.
 *
 * EquityHub's server pushes no live account figures (there is no
 * `user:account` METRICS channel), and the positions list's own
 * `unrealizedPnl` is only as fresh as the last `user:positions` event. So, as
 * the web does, a position whose symbol has ticked is re-marked at that last
 * tick with the server's own formula — `(last − entry) × qty` for a BUY, the
 * reverse for a SELL; one that has not ticked keeps the server's
 * `unrealizedPnl`. This feeds a threshold notification only; no screen shows
 * it as a figure (PORT-RULINGS §1-2).
 *
 * Returns null when nothing is open (the web skips the check then, or an
 * idle account would ring on every launch).
 */
export const portfolioFloatingPnl = (
  positions: readonly Pick<Position, 'symbol' | 'side' | 'entryPrice' | 'quantity' | 'unrealizedPnl'>[],
  history: ReadonlyMap<string, readonly PriceSample[]>,
): number | null => {
  if (!positions.length) return null;
  let total = 0;
  for (const p of positions) {
    const hist = history.get(p.symbol);
    const last = hist && hist.length ? hist[hist.length - 1]?.price : undefined;
    if (last === undefined) {
      const v = toNum(p.unrealizedPnl);
      total += Number.isFinite(v) ? v : 0;
      continue;
    }
    const entry = toNum(p.entryPrice);
    const qty = toNum(p.quantity);
    if (![entry, qty, last].every(Number.isFinite)) continue;
    total += p.side === 'BUY' ? (last - entry) * qty : (entry - last) * qty;
  }
  return total;
};
