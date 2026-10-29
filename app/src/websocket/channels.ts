import { useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import {
  adaptCandle,
  adaptOrderBook,
  adaptTicker,
  timeframeSeconds,
  type OrderBook,
  type Ticker,
} from '@/types/market';
import { adaptAccountMetrics, type AccountMetrics, type Candle } from '@/types/trading';
import { num, str } from '@/types/api';
import { wsClient, type ConnectionState } from '@/websocket/ws';

/**
 * Every channel the web client subscribes to, typed, on top of wsClient.
 *
 * The web calls `wsClient.subscribe('user:wallet', cb)` with a bare string
 * and reads `data.lastPrice` off whatever arrives. Here the channel name is
 * built by a function, the payload is adapted once — the same adapter the
 * REST snapshot uses, so a tick and a fetch cannot disagree about a field —
 * and each helper returns its unsubscribe.
 *
 * ── THE CHANNELS, FROM backend/src/websocket/server.js ────────────────
 * Public, high-frequency and COALESCED server-side (latest value per flush,
 * so a burst of ticks arrives as one):
 *   ticker:SYM · orderbook:SYM · candles:SYM:TF
 * Public nudges ("something changed — re-pull"):
 *   recommended:refresh · alerts:refresh
 * Private (need the token the socket connected with). The client subscribes
 * to `user:wallet`; the server scopes it to `user:wallet:<userId>` and
 * ws.ts routes the scoped event back to the base name:
 *   user:wallet · user:positions · user:orders
 *   user:notifications · user:bonusWallet · user:leverage
 *   user:subscription · user:copytrading · user:tickets · user:chat
 *
 * And `user:account`, which EquityHub's backend does NOT publish (no risk-
 * worker METRICS push — notifyUser is never called with 'account'). It stays
 * typed so a subscriber is harmless; it simply never fires, and anything
 * that needs live account figures must re-read them.
 *
 * Plus `user:accounts`, which the server publishes (PLAN_ENFORCED, when a
 * plan cap suspends an account) and the web never subscribes to — so a web
 * user's account list goes stale until reload. It is typed here so the app
 * can listen.
 *
 * Deliberately NOT here:
 *   • `alerts` — useNotifications.js subscribes to it, but nothing in the
 *     backend publishes it. EquityHub's backend has no alert engine either:
 *     price alerts are judged in the bell's own tick watcher, as on the web
 *     (components/chrome/notificationStore).
 *   • `trades:SYM` — published, never read by the web.
 * ──────────────────────────────────────────────────────────────────────
 */

export type Unsubscribe = () => void;

/* ── Channel names ────────────────────────────────────────────────────── */

export type TickerChannel = `ticker:${string}`;
export type OrderBookChannel = `orderbook:${string}`;
export type CandleChannel = `candles:${string}:${string}`;

export const PRIVATE_CHANNELS = [
  'user:wallet',
  'user:positions',
  'user:orders',
  'user:account',
  'user:accounts',
  'user:notifications',
  'user:bonusWallet',
  'user:leverage',
  'user:subscription',
  'user:copytrading',
  'user:tickets',
  'user:chat',
] as const;
export type PrivateChannel = (typeof PRIVATE_CHANNELS)[number];

export type NudgeChannel = 'recommended:refresh' | 'alerts:refresh';

export type Channel = TickerChannel | OrderBookChannel | CandleChannel | PrivateChannel | NudgeChannel;

/** Symbols are stored uppercase (Instrument.symbol is `uppercase: true`). */
export const CHANNEL = {
  ticker: (symbol: string): TickerChannel => `ticker:${symbol.toUpperCase()}`,
  orderbook: (symbol: string): OrderBookChannel => `orderbook:${symbol.toUpperCase()}`,
  candles: (symbol: string, timeframe: string): CandleChannel =>
    `candles:${symbol.toUpperCase()}:${timeframe}`,
} as const;

/* ── Payloads ─────────────────────────────────────────────────────────── */

/**
 * A private event body. Most are nudges — `{ event: 'UPDATED' }`,
 * `{ reason: 'POSITION_SETTLEMENT', positionId }` — whose job is to say
 * "re-fetch". They are passed through as sent; the REST endpoint is the
 * source of truth, not the nudge.
 */
export type ChannelEvent = Record<string, unknown>;

/** `candles:SYM:TF` — the forming candle, already snapped to its bucket. */
export interface CandleEvent {
  symbol: string;
  timeframe: string;
  candle: Candle;
}

/**
 * `user:account`. The risk worker pushes METRICS every sweep while the
 * account holds open positions — the same riskService figures as
 * GET /trading/account-metrics. Anything else is passed through untyped.
 */
export type AccountEvent =
  | {
    type: 'METRICS';
    metrics: AccountMetrics;
    /** Open position count at the sweep. */
    openPositions: number | null;
    /** e.g. 'STOPPED_OUT' — stop rendering it as a live account. */
    status: string | null;
  }
  | { type: 'OTHER'; raw: ChannelEvent };

type NamedPayloads = {
  'user:account': AccountEvent;
} & { [K in Exclude<PrivateChannel, 'user:account'> | NudgeChannel]: ChannelEvent };

export type PayloadOf<C extends Channel> =
  C extends CandleChannel ? CandleEvent
    : C extends OrderBookChannel ? OrderBook
      : C extends TickerChannel ? Ticker
        : C extends keyof NamedPayloads ? NamedPayloads[C]
          : never;

/* ── Adapting a frame ─────────────────────────────────────────────────── */

const asEvent = (data: unknown): ChannelEvent =>
  (data && typeof data === 'object' && !Array.isArray(data) ? (data as ChannelEvent) : {});

export const adaptAccountEvent = (data: unknown): AccountEvent => {
  const raw = asEvent(data);
  if (raw.type !== 'METRICS' || !str(raw.accountId)) return { type: 'OTHER', raw };
  return {
    type: 'METRICS',
    metrics: adaptAccountMetrics(raw),
    openPositions: num(raw.openPositions),
    status: str(raw.status) || null,
  };
};

/**
 * The adapted payload for a channel, or null when the frame is unusable and
 * the subscriber should not be called at all (a candle with no prices).
 * Exported for tests.
 */
export const adaptFrame = (channel: string, data: unknown): unknown => {
  if (channel.startsWith('ticker:')) return adaptTicker(channel.slice('ticker:'.length), data);
  if (channel.startsWith('orderbook:')) return adaptOrderBook(data, channel.slice('orderbook:'.length));
  if (channel.startsWith('candles:')) {
    // candles:SYM:TF — the timeframe is the last segment, the symbol the rest.
    const rest = channel.slice('candles:'.length);
    const cut = rest.lastIndexOf(':');
    const symbol = cut > 0 ? rest.slice(0, cut) : rest;
    const timeframe = cut > 0 ? rest.slice(cut + 1) : '';
    const candle = adaptCandle(data, timeframeSeconds(timeframe));
    return candle ? { symbol, timeframe, candle } : null;
  }
  if (channel === 'user:account') return adaptAccountEvent(data);
  return asEvent(data);
};

/* ── Subscribing ──────────────────────────────────────────────────────── */

/**
 * Subscribe to any channel with its adapted payload. A throwing subscriber is
 * contained by wsClient; one that throws here is contained too, so the
 * adapter cannot take the feed down either.
 */
export const subscribeChannel = <C extends Channel>(
  channel: C,
  callback: (data: PayloadOf<C>) => void,
): Unsubscribe =>
  wsClient.subscribe(channel, (raw) => {
    const adapted = adaptFrame(channel, raw);
    if (adapted === null) return;
    callback(adapted as PayloadOf<C>);
  });

export const subscribeTicker = (symbol: string, cb: (t: Ticker) => void): Unsubscribe =>
  subscribeChannel(CHANNEL.ticker(symbol), cb);

/** Many tickers, one unsubscribe. Duplicate symbols are subscribed once. */
export const subscribeTickers = (symbols: readonly string[], cb: (t: Ticker) => void): Unsubscribe => {
  const unique = [...new Set(symbols.filter(Boolean).map((sym) => sym.toUpperCase()))];
  const offs = unique.map((sym) => subscribeTicker(sym, cb));
  return () => { for (const off of offs) off(); };
};

export const subscribeOrderBook = (symbol: string, cb: (b: OrderBook) => void): Unsubscribe =>
  subscribeChannel(CHANNEL.orderbook(symbol), cb);

export const subscribeCandles = (
  symbol: string,
  timeframe: string,
  cb: (e: CandleEvent) => void,
): Unsubscribe => subscribeChannel(CHANNEL.candles(symbol, timeframe), cb);

export const subscribeWallet = (cb: (e: ChannelEvent) => void): Unsubscribe =>
  subscribeChannel('user:wallet', cb);

export const subscribePositions = (cb: (e: ChannelEvent) => void): Unsubscribe =>
  subscribeChannel('user:positions', cb);

export const subscribeOrders = (cb: (e: ChannelEvent) => void): Unsubscribe =>
  subscribeChannel('user:orders', cb);

/** METRICS pushes only; other `user:account` frames are dropped. */
export const subscribeAccountMetrics = (
  cb: (m: AccountMetrics, meta: { openPositions: number | null; status: string | null }) => void,
): Unsubscribe =>
  subscribeChannel('user:account', (e) => {
    if (e.type === 'METRICS') cb(e.metrics, { openPositions: e.openPositions, status: e.status });
  });

export const subscribeAccounts = (cb: (e: ChannelEvent) => void): Unsubscribe =>
  subscribeChannel('user:accounts', cb);

export const subscribeNotifications = (cb: (e: ChannelEvent) => void): Unsubscribe =>
  subscribeChannel('user:notifications', cb);

export const subscribeBonusWallet = (cb: (e: ChannelEvent) => void): Unsubscribe =>
  subscribeChannel('user:bonusWallet', cb);

export const subscribeLeverage = (cb: (e: ChannelEvent) => void): Unsubscribe =>
  subscribeChannel('user:leverage', cb);

export const subscribeSubscription = (cb: (e: ChannelEvent) => void): Unsubscribe =>
  subscribeChannel('user:subscription', cb);

export const subscribeCopyTrading = (cb: (e: ChannelEvent) => void): Unsubscribe =>
  subscribeChannel('user:copytrading', cb);

export const subscribeTickets = (cb: (e: ChannelEvent) => void): Unsubscribe =>
  subscribeChannel('user:tickets', cb);

export const subscribeChat = (cb: (e: ChannelEvent) => void): Unsubscribe =>
  subscribeChannel('user:chat', cb);

export const subscribeRecommendedRefresh = (cb: (e: ChannelEvent) => void): Unsubscribe =>
  subscribeChannel('recommended:refresh', cb);

export const subscribeAlertsRefresh = (cb: (e: ChannelEvent) => void): Unsubscribe =>
  subscribeChannel('alerts:refresh', cb);

/**
 * The app's `window.addEventListener('focus', …)`.
 *
 * The web refetches on tab focus in thirteen places; that is its safety net
 * for a missed event. Coming back to the foreground is the phone's
 * equivalent — and a phone that has been in a pocket has almost certainly
 * missed something.
 */
export const subscribeForeground = (cb: () => void): Unsubscribe => {
  let last: AppStateStatus = AppState.currentState;
  const sub = AppState.addEventListener('change', (next) => {
    const wasAway = last !== 'active';
    last = next;
    if (next === 'active' && wasAway) cb();
  });
  return () => sub.remove();
};

/* ── Hooks ────────────────────────────────────────────────────────────── */

/**
 * Subscribe while mounted, ported from hooks/useWebSocketChannel.js. The
 * callback is held in a ref, so a new closure every render does NOT
 * resubscribe — only a change of channel does. Pass null to skip.
 */
export function useChannel<C extends Channel>(
  channel: C | null | undefined | false,
  onMessage: (data: PayloadOf<C>) => void,
): void {
  const cbRef = useRef(onMessage);
  cbRef.current = onMessage;

  useEffect(() => {
    if (!channel) return undefined;
    return subscribeChannel(channel, (data) => cbRef.current(data));
  }, [channel]);
}

/** Run `onForeground` each time the app returns to the foreground. */
export function useForeground(onForeground: () => void, enabled = true): void {
  const cbRef = useRef(onForeground);
  cbRef.current = onForeground;

  useEffect(() => {
    if (!enabled) return undefined;
    return subscribeForeground(() => cbRef.current());
  }, [enabled]);
}

/**
 * The socket's state — 'live' | 'connecting' | 'reconnecting' | 'idle'.
 * A price screen should say when its prices are not live rather than show
 * the last tick as if it were current.
 */
export function useConnectionState(): ConnectionState {
  const [state, setState] = useState<ConnectionState>(() => wsClient.getState());
  useEffect(() => wsClient.onStateChange(setState), []);
  return state;
}
