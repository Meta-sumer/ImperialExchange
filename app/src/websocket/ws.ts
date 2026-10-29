import { AppState, type AppStateStatus } from 'react-native';

import { ENV, WS_URL } from '@/constants/env';
import { getImpersonationToken } from '@/services/impersonation';
import { getAccessToken } from '@/services/tokenStore';

/**
 * The live feed, ported from client/src/services/ws.js.
 *
 * What is kept verbatim, because it is load-bearing and subtle:
 *   • the stale-socket guards (`if (this.ws !== ws) return`) in onopen,
 *     onmessage and onclose. Without them a late event from a socket that
 *     was already replaced schedules a second reconnect, and that snowballs
 *     into a herd of sockets;
 *   • exponential backoff, 1s doubling to 30s;
 *   • subscription replay on open;
 *   • reconnecting with the FRESHEST token rather than the one first
 *     connected with — after a refresh the original is stale, and a
 *     reconnect that reused it would come back anonymous with every private
 *     channel silently rejected;
 *   • the `user:<id>:thing` → `user:<id>` base-channel fallback, so a
 *     subscriber to the base channel still receives scoped events.
 *
 * ── WHAT THIS FIXES, AND WHY IT HAD TO ────────────────────────────────
 * The audit of ws.js turned up three things that are survivable in a
 * browser and are not on a phone:
 *
 * 1. THE CLIENT HANDLES ONE FRAME TYPE. `ws.js:61` acts only on
 *    `{type:'event'}` and silently discards the other six the server sends —
 *    including `{type:'auth_error'}`. So an expired token produced a socket
 *    that was connected, subscribed to nothing, and looked healthy. On the
 *    web a reload fixes it; here the app can be foregrounded for hours.
 *    Every frame type is handled now, and auth_error is reported.
 *
 * 2. NO HEARTBEAT ANYWHERE. The web sends no ping. A half-open mobile link —
 *    the normal outcome of moving between cells or losing Wi-Fi — holds a
 *    socket that will never deliver another byte and never fires onclose.
 *    The screen keeps showing the last price it got. On a trading app that
 *    is the dangerous kind of wrong, so there is a ping here and a socket
 *    that hears NOTHING back is terminated rather than trusted.
 *
 *    EquityHub's server has no `ping` action: it answers the app's ping with
 *    `{type:'error', message:'channel required'}`. That reply is still the
 *    server reading and dispatching, which is exactly what the ping asks, so
 *    ANY frame after a ping — a pong, that error, an event — counts as the
 *    answer. Waiting for a `pong` the server never sends would kill a healthy
 *    socket every heartbeat.
 *
 * 3. THE SAFETY NET WAS THE BROWSER. Thirteen focus/visibility listeners
 *    across the web client quietly refetch when a tab is re-focused, which
 *    is what hides a missed event. None exist here. AppState takes that job:
 *    coming back to the foreground re-checks the socket.
 * ──────────────────────────────────────────────────────────────────────
 */

/** Frame types the server sends — backend/src/websocket/server.js. */
type ServerFrame =
  | { type: 'event'; channel: string; data: unknown }
  | { type: 'connected'; authenticated?: boolean }
  | { type: 'auth_error'; reason?: 'expired' | 'invalid' | string }
  | { type: 'subscribed'; channel: string }
  | { type: 'unsubscribed'; channel: string }
  | { type: 'error'; message?: string }
  | { type: 'pong'; ts?: number };

export type ConnectionState = 'idle' | 'connecting' | 'live' | 'reconnecting';

type Callback = (data: unknown) => void;
type StateListener = (state: ConnectionState) => void;
type AuthErrorListener = (reason: string) => void;

class WSClient {
  private ws: WebSocket | null = null;

  private subscriptions = new Map<string, Set<Callback>>();

  private reconnectAttempts = 0;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  private appStateSub: { remove: () => void } | null = null;

  private state: ConnectionState = 'idle';

  private stateListeners = new Set<StateListener>();

  private authErrorListeners = new Set<AuthErrorListener>();

  /** Set once the app has a session; cleared on sign-out. */
  private wanted = false;

  /* ── Observability ─────────────────────────────────────────────────── */

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  /**
   * The server told us the token is no good. The web client discarded this
   * frame entirely; here it is the signal to refresh or sign out.
   */
  onAuthError(listener: AuthErrorListener): () => void {
    this.authErrorListeners.add(listener);
    return () => this.authErrorListeners.delete(listener);
  }

  getState(): ConnectionState {
    return this.state;
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    for (const l of this.stateListeners) {
      try { l(next); } catch { /* one listener must not silence the rest */ }
    }
  }

  /* ── Connection ────────────────────────────────────────────────────── */

  connect(token?: string | null): void {
    this.wanted = true;
    const live = token ?? this.currentToken();
    const url = live ? `${WS_URL}?token=${encodeURIComponent(live)}` : WS_URL;

    // Close any prior socket before swapping the reference, so a late
    // onclose from the old one cannot trigger a second reconnect race.
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.close();
      } catch { /* already gone */ }
    }

    this.setState(this.reconnectAttempts === 0 ? 'connecting' : 'reconnecting');

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectAttempts = 0;
      this.setState('live');
      for (const channel of this.subscriptions.keys()) {
        this.send({ action: 'subscribe', channel });
      }
      this.startHeartbeat();
      this.watchAppState();
    };

    ws.onmessage = (e: WebSocketMessageEvent) => {
      if (this.ws !== ws) return;
      // Any inbound frame proves the server is alive and reading (see 2.).
      this.clearPongTimer();
      let msg: ServerFrame;
      try {
        msg = JSON.parse(String(e.data)) as ServerFrame;
      } catch {
        return;
      }
      this.handleFrame(msg);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.stopHeartbeat();
      if (!this.wanted) {
        this.setState('idle');
        return;
      }
      this.setState('reconnecting');
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose always follows; reconnecting from both would double-schedule.
    };
  }

  /**
   * Every frame the server can send. The web client had a branch for one of
   * these and dropped the rest on the floor.
   */
  private handleFrame(msg: ServerFrame): void {
    switch (msg.type) {
      case 'event': {
        if (!msg.channel) return;
        // A subscriber to `user:<id>` also receives `user:<id>:orders` etc.
        const base = msg.channel.replace(/^(user:[^:]+):.*$/, '$1');
        const cbs = this.subscriptions.get(msg.channel) ?? this.subscriptions.get(base);
        if (!cbs) return;
        for (const cb of cbs) {
          try { cb(msg.data); } catch { /* a bad subscriber must not kill the feed */ }
        }
        return;
      }

      case 'pong':
        // A server that does answer pings. The kill timer was already
        // cancelled when the frame arrived.
        return;

      case 'auth_error': {
        // The one the web client threw away. Without it an expired token
        // leaves a socket that is connected and deaf.
        const reason = msg.reason ?? 'invalid';
        for (const l of this.authErrorListeners) {
          try { l(reason); } catch { /* ignore */ }
        }
        return;
      }

      case 'connected':
      case 'subscribed':
      case 'unsubscribed':
      case 'error':
        // Acknowledgements and server-side complaints. Logged in development
        // because "my channel is not arriving" is otherwise unanswerable.
        if (ENV.isDev) {
          // eslint-disable-next-line no-console
          console.log('[ws]', msg.type, JSON.stringify(msg));
        }
        return;

      default:
        return;
    }
  }

  /* ── Heartbeat ─────────────────────────────────────────────────────── */

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.send({ action: 'ping', ts: Date.now() });
      // If no pong arrives, the link is half-open: the socket will never
      // deliver another byte and will never fire onclose by itself.
      // Terminate so the normal reconnect path runs.
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        try { this.ws?.close(); } catch { /* ignore */ }
      }, ENV.wsHeartbeatTimeoutMs);
    }, ENV.wsHeartbeatMs);
  }

  private clearPongTimer(): void {
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.clearPongTimer();
  }

  /* ── Foreground ────────────────────────────────────────────────────── */

  /**
   * The web app's safety net was the browser: thirteen focus and visibility
   * listeners refetch when a tab is re-focused, which is what covers a
   * missed event. This is the app's equivalent — a phone that has been in a
   * pocket has almost certainly missed something.
   */
  private watchAppState(): void {
    if (this.appStateSub) return;
    this.appStateSub = AppState.addEventListener('change', (status: AppStateStatus) => {
      if (status !== 'active' || !this.wanted) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.reconnectAttempts = 0; // a deliberate return deserves a fast retry
        this.connect();
      }
    });
  }

  /* ── Reconnect ─────────────────────────────────────────────────────── */

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      ENV.wsBaseBackoffMs * 2 ** this.reconnectAttempts,
      ENV.wsMaxBackoffMs,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wanted) this.connect(this.currentToken());
    }, delay);
  }

  /**
   * The live token. Impersonation wins over a real login, matching how the
   * web picks the token for the first connect.
   *
   * Synchronous, as it must be — this is called from inside `onclose`. The
   * web read localStorage here; a keychain read is async, which is why
   * tokenStore keeps an in-memory copy.
   */
  private currentToken(): string | null {
    return getImpersonationToken() ?? getAccessToken();
  }

  /* ── Subscriptions ─────────────────────────────────────────────────── */

  private send(obj: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch { /* network race — the reconnect will replay */ }
  }

  subscribe(channel: string, callback: Callback): () => void {
    let set = this.subscriptions.get(channel);
    if (!set) {
      set = new Set();
      this.subscriptions.set(channel, set);
      this.send({ action: 'subscribe', channel });
    }
    set.add(callback);
    return () => this.unsubscribe(channel, callback);
  }

  unsubscribe(channel: string, callback: Callback): void {
    const set = this.subscriptions.get(channel);
    if (!set) return;
    set.delete(callback);
    if (set.size === 0) {
      this.subscriptions.delete(channel);
      this.send({ action: 'unsubscribe', channel });
    }
  }

  /**
   * Sign-out. Clears subscriptions, as the web does.
   *
   * Note what the web got wrong here and this keeps: ws.js:126-134 clears
   * `subscriptions` on disconnect and nothing re-registers them — only
   * `connect()`'s onopen replays, and it replays an empty map. That is
   * correct ONLY because disconnect means sign-out. It is kept as sign-out
   * and nothing else calls it, so the reconnect path never loses a channel.
   */
  disconnect(): void {
    this.wanted = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.appStateSub) { this.appStateSub.remove(); this.appStateSub = null; }
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.close();
      } catch { /* ignore */ }
      this.ws = null;
    }
    this.subscriptions.clear();
    this.reconnectAttempts = 0;
    this.setState('idle');
  }
}

export const wsClient = new WSClient();
