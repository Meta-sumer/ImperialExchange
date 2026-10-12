import { WS_BASE_URL } from '../config';
import { tokens } from './api';

/**
 * WebSocket client — mirrors the web `wsClient` protocol:
 *   connect:     ws://host:5000/ws?token=<jwt>
 *   subscribe:   send { action: 'subscribe', channel }
 *   message:     { type: 'event', channel: 'ticker:BTCUSD', data: { lastPrice, ts } }
 * Auto-reconnects with backoff and re-subscribes all channels.
 */
class WSClient {
  constructor() {
    this.ws = null;
    this.subs = new Map(); // channel -> Set<cb>
    this.connected = false;
    this.reconnectAttempts = 0;
    this.token = null;
    this._timer = null;
  }

  async connect() {
    this.token = await tokens.getAccess();
    this._open();
  }

  _open() {
    const url = this.token ? `${WS_BASE_URL}/ws?token=${this.token}` : `${WS_BASE_URL}/ws`;
    if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch {} }
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.reconnectAttempts = 0;
      for (const ch of this.subs.keys()) this._send({ action: 'subscribe', channel: ch });
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'event' && msg.channel) {
          // User-scoped topics arrive as `user:<channel>:<userId>` but callers
          // subscribe to the base `user:<channel>`. Match either (mirrors web
          // ws.js) — without this, user:positions/user:orders never fire.
          const baseChannel = String(msg.channel).replace(/^(user:[^:]+):.*$/, '$1');
          const cbs = this.subs.get(msg.channel) || this.subs.get(baseChannel);
          if (cbs) cbs.forEach((cb) => cb(msg.data));
        }
      } catch {}
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.connected = false;
      const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
      this.reconnectAttempts++;
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._reconnect(), delay);
    };
    ws.onerror = () => {};
  }

  async _reconnect() {
    this.token = await tokens.getAccess();
    this._open();
  }

  _send(obj) {
    try { if (this.ws && this.connected) this.ws.send(JSON.stringify(obj)); } catch {}
  }

  subscribe(channel, cb) {
    if (!this.subs.has(channel)) {
      this.subs.set(channel, new Set());
      if (this.connected) this._send({ action: 'subscribe', channel });
    }
    this.subs.get(channel).add(cb);
    return () => this.unsubscribe(channel, cb);
  }

  unsubscribe(channel, cb) {
    const set = this.subs.get(channel);
    if (!set) return;
    set.delete(cb);
    if (set.size === 0) {
      this.subs.delete(channel);
      if (this.connected) this._send({ action: 'unsubscribe', channel });
    }
  }

  disconnect() {
    clearTimeout(this._timer);
    try { if (this.ws) { this.ws.onclose = null; this.ws.close(); } } catch {}
    this.ws = null;
    this.connected = false;
    this.subs.clear();
  }
}

export const wsClient = new WSClient();
