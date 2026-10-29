import AsyncStorage from '@react-native-async-storage/async-storage';
import { useMemo } from 'react';
import { AppState } from 'react-native';
import { create } from 'zustand';

import { fetchPriceAlerts } from '@/api/alerts.api';
import { notificationsApi } from '@/api/notifications.api';
import { fetchPositions } from '@/api/trading.api';
import { startPush } from '@/services/push';
import { useAuthStore } from '@/store/auth';
import { useSelectedAccountStore } from '@/store/selectedAccount';
import {
  DEFAULT_NOTIFICATION_PREFS,
  MAX_NOTIFICATIONS,
  NOTIFICATION_POLL_MS,
  addLocalNotification,
  applyNotificationPush,
  isBellType,
  isForAccount,
  isServerEntry,
  mergeServerNotifications,
  orderEventNotification,
  pnlBand,
  portfolioPnlNotification,
  positionEventNotification,
  unreadCount as countUnread,
  walletEventNotification,
  type BellNotification,
  type LocalNotificationInput,
  type NotificationPrefs,
  type WatchedAlert,
} from '@/types/notifications';
import type { Ticker } from '@/types/market';
import type { Position } from '@/types/trading';
import {
  subscribeForeground,
  subscribeNotifications,
  subscribeOrders,
  subscribePositions,
  subscribeTickers,
  subscribeWallet,
  type Unsubscribe,
} from '@/websocket/channels';

import {
  newTickMemory,
  portfolioFloatingPnl,
  processTick,
  sameSymbols,
  watchedAlertsFrom,
  watchSymbols,
} from './notificationEngineLogic';

/**
 * The bell — client/src/hooks/useNotifications.js — as one app-wide store.
 *
 * The web calls the hook inside NotificationCenter, which Layout mounts once.
 * Here native-stack draws a header per screen, so every screen in the stack
 * has a bell; the list and the engine behind it must exist once. The first
 * bell to mount starts the engine and the last one to unmount stops it
 * (`retainNotificationEngine`), so a stack of screens holds one set of
 * socket subscriptions, one poll and one ticker subscription per watched
 * symbol — never one per header.
 *
 * What the engine does, as the web's hook does:
 *   • server notifications: fetched on start, re-pulled every 20s (while the
 *     app is in the foreground) and on return to it, and taken live from
 *     `user:notifications`; merged by `srv:<id>`, hidden before "Clear all";
 *   • local entries from `user:orders`, `user:positions`, `user:wallet` —
 *     order / position events only for the SELECTED account (an event the
 *     server tagged with another account is dropped, an untagged one shown);
 *   • price-alert crossings, 5-minute volatility and the ±5% day-change band
 *     from the tickers of every alert and open-position symbol (EquityHub's
 *     server has no alert engine — the bell is where alerts are judged);
 *   • the portfolio P&L band (±₹10k / ₹50k / ₹1L), checked every 5s.
 *
 * Differences, on purpose:
 *   • PER USER. The web keeps the list, prefs and clear cutoff in
 *     localStorage under fixed keys, so the next person to sign in on that
 *     browser sees the last one's notifications. Here the keys carry the user
 *     id and the store resets when the signed-in person changes.
 *   • The portfolio P&L re-marks a position only once its symbol has
 *     ticked; until then it is the positions list's own server figure
 *     (notificationEngineLogic portfolioFloatingPnl).
 *   • Alerts and positions are also re-read on return to the foreground and
 *     after a price alert is created from the bell — a phone session outlives
 *     the page loads that refreshed the web's copy.
 *   • No sound: the web's ping is a Web Audio oscillator; there is no audio
 *     module in this app (see `notificationSound` for the rule, ready to wire).
 */

/* ── Storage ──────────────────────────────────────────────────────────── */

/** The web's keys, with the user id appended. */
export const STORAGE_KEY = 'tradepro:notifications:v1';
export const PREFS_KEY = 'tradepro:notifications:prefs:v1';
export const CLEARED_KEY = 'tradepro:notifications:clearedAt:v1';

export const storageKeys = (userId: string): { list: string; prefs: string; cleared: string } => ({
  list: `${STORAGE_KEY}:${userId}`,
  prefs: `${PREFS_KEY}:${userId}`,
  cleared: `${CLEARED_KEY}:${userId}`,
});

/** A stored list, tolerating anything — a bad row is dropped, not fatal. */
export const parseStoredList = (raw: string | null): BellNotification[] => {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: BellNotification[] = [];
  for (const x of parsed) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id || !isBellType(r.type)) continue;
    const ts = Number(r.timestamp);
    if (!Number.isFinite(ts)) continue;
    out.push({
      id: r.id,
      type: r.type,
      title: typeof r.title === 'string' ? r.title : 'Notification',
      message: typeof r.message === 'string' ? r.message : '',
      timestamp: ts,
      status: typeof r.status === 'string' ? r.status : 'info',
      link: typeof r.link === 'string' && r.link ? r.link : null,
      symbol: typeof r.symbol === 'string' && r.symbol ? r.symbol : null,
      read: r.read === true,
    });
  }
  return out.slice(0, MAX_NOTIFICATIONS);
};

/** `{ ...DEFAULT_PREFS, ...stored }`, as the web's readPrefs, keeping only booleans. */
export const parseStoredPrefs = (raw: string | null): NotificationPrefs => {
  const out = { ...DEFAULT_NOTIFICATION_PREFS };
  if (!raw) return out;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    for (const k of Object.keys(out) as (keyof NotificationPrefs)[]) {
      if (typeof p[k] === 'boolean') out[k] = p[k] as boolean;
    }
  } catch { /* defaults */ }
  return out;
};

/* ── State ────────────────────────────────────────────────────────────── */

export interface BellState {
  /** Whose bell this is; null signed out. */
  userId: string | null;
  notifications: BellNotification[];
  prefs: NotificationPrefs;
  /** "Clear all" cutoff, epoch ms — server entries at or before it stay hidden. */
  clearedAt: number;
  /** The stored list for `userId` has been read. */
  hydrated: boolean;
}

const initial = (userId: string | null): BellState => ({
  userId,
  notifications: [],
  prefs: { ...DEFAULT_NOTIFICATION_PREFS },
  clearedAt: 0,
  hydrated: false,
});

export const useBellStore = create<BellState>(() => initial(null));

/** Bumped when the person changes, so work begun for the last one lands nowhere. */
let generation = 0;
/** Type+title → last raised, for the 30-second dedupe. Per session. */
let lastSeen = new Map<string, number>();

let hydration: { userId: string; promise: Promise<void> } | null = null;

const hydrate = (userId: string): Promise<void> => {
  if (hydration && hydration.userId === userId) return hydration.promise;
  const gen = generation;
  const keys = storageKeys(userId);
  const read = (k: string): Promise<string | null> => AsyncStorage.getItem(k).catch(() => null);
  const promise = Promise.all([read(keys.list), read(keys.prefs), read(keys.cleared)]).then(([list, prefs, cleared]) => {
    if (gen !== generation) return;
    useBellStore.setState((s) => ({
      // Anything raised while the stored list was loading stays in front.
      notifications: [...s.notifications, ...parseStoredList(list).filter((e) => !s.notifications.some((n) => n.id === e.id))]
        .slice(0, MAX_NOTIFICATIONS),
      prefs: parseStoredPrefs(prefs),
      clearedAt: Math.max(s.clearedAt, Number(cleared) || 0),
      hydrated: true,
    }));
  });
  hydration = { userId, promise };
  return promise;
};

/* Write-through, like the web's effects on `notifications` and `prefs`. */
let writeTimer: ReturnType<typeof setTimeout> | null = null;
useBellStore.subscribe((s, prev) => {
  if (!s.userId || !s.hydrated || s.userId !== prev.userId) return;
  const keys = storageKeys(s.userId);
  if (s.prefs !== prev.prefs) AsyncStorage.setItem(keys.prefs, JSON.stringify(s.prefs)).catch(() => undefined);
  if (s.clearedAt !== prev.clearedAt) AsyncStorage.setItem(keys.cleared, String(s.clearedAt)).catch(() => undefined);
  if (s.notifications !== prev.notifications) {
    if (writeTimer) clearTimeout(writeTimer);
    const uid = s.userId;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      const now = useBellStore.getState();
      if (now.userId !== uid) return;
      AsyncStorage.setItem(storageKeys(uid).list, JSON.stringify(now.notifications.slice(0, MAX_NOTIFICATIONS)))
        .catch(() => undefined);
    }, 250);
  }
});

/* ── Actions (the hook's markRead / markAllRead / clear / updatePrefs / add) ── */

/** Raise a local entry: category switch, 30s dedupe, prepend, cap. */
export const addNotification = (n: LocalNotificationInput): void => {
  const s = useBellStore.getState();
  if (!s.userId) return;
  const next = addLocalNotification(s.notifications, n, s.prefs, lastSeen);
  if (next.length === s.notifications.length && next[0] === s.notifications[0]) return;
  useBellStore.setState({ notifications: next });
};

/** One entry read; a server entry is also marked on the server (best-effort, as on the web). */
export const markRead = (id: string): void => {
  useBellStore.setState((s) => ({
    notifications: s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
  }));
  if (isServerEntry(id)) notificationsApi.markRead([id]).catch(() => undefined);
};

export const markAllRead = (): void => {
  useBellStore.setState((s) => ({ notifications: s.notifications.map((n) => ({ ...n, read: true })) }));
  notificationsApi.markAllRead().catch(() => undefined);
};

/**
 * "Clear all": hide everything. The cutoff keeps server entries from coming
 * back on the next fetch; marking them read clears the badge everywhere.
 */
export const clearNotifications = (): void => {
  useBellStore.setState({ clearedAt: Date.now(), notifications: [] });
  notificationsApi.markAllRead().catch(() => undefined);
};

export const updatePrefs = (patch: Partial<NotificationPrefs>): void => {
  useBellStore.setState((s) => ({ prefs: { ...s.prefs, ...patch } }));
};

/** The web hook's return, for the bell. */
export function useNotifications(): {
  notifications: BellNotification[];
  unreadCount: number;
  prefs: NotificationPrefs;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clear: () => void;
  updatePrefs: (patch: Partial<NotificationPrefs>) => void;
} {
  const notifications = useBellStore((s) => s.notifications);
  const prefs = useBellStore((s) => s.prefs);
  const unread = useMemo(() => countUnread(notifications), [notifications]);
  return {
    notifications,
    unreadCount: unread,
    prefs,
    markRead,
    markAllRead,
    clear: clearNotifications,
    updatePrefs,
  };
}

/** The badge alone — every header's bell reads just this. */
export const useUnreadCount = (): number => useBellStore((s) => countUnread(s.notifications));

/* ── The engine ───────────────────────────────────────────────────────── */

/** The P&L band re-check — useNotifications.js:452. */
export const PNL_CHECK_MS = 5_000;

const signedInUserId = (): string | null => {
  const a = useAuthStore.getState();
  return a.user ? a.user.id : null;
};

/** Set while the engine runs: re-read the price alerts it watches. */
let refreshAlertsHook: (() => void) | null = null;

/** After a price alert is created, so its crossing rings in this session too. */
export const refreshWatchedAlerts = (): void => { refreshAlertsHook?.(); };

const startEngine = (): (() => void) => {
  const userId = signedInUserId();
  if (!userId) return () => undefined;
  if (useBellStore.getState().userId !== userId) {
    generation += 1;
    lastSeen = new Map();
    hydration = null;
    useBellStore.setState(initial(userId));
  }
  const gen = generation;
  let stopped = false;
  const live = (): boolean => !stopped && gen === generation;

  const offs: Unsubscribe[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];

  const add = (n: LocalNotificationInput | null): void => { if (n && live()) addNotification(n); };

  /* Tickers for every alert and open-position symbol. */
  const mem = newTickMemory();
  let alerts: WatchedAlert[] = [];
  let positions: Position[] = [];
  let watched: string[] = [];
  let offTickers: Unsubscribe | null = null;

  const onTick = (t: Ticker): void => {
    if (!live()) return;
    const price = t.lastPrice === null ? NaN : Number(t.lastPrice);
    for (const n of processTick(mem, alerts, t.symbol, price, t.change24h, Date.now())) add(n);
  };

  const resample = (): void => {
    const next = watchSymbols(alerts, positions);
    if (sameSymbols(next, watched)) return;
    watched = next;
    offTickers?.();
    offTickers = next.length ? subscribeTickers(next, onTick) : null;
  };

  const loadAlerts = async (): Promise<void> => {
    try {
      const list = await fetchPriceAlerts();
      if (!live()) return;
      alerts = watchedAlertsFrom(list);
      resample();
    } catch { /* keep the last list */ }
  };

  const loadPositions = async (): Promise<void> => {
    try {
      const list = await fetchPositions();
      if (!live()) return;
      positions = list;
      resample();
    } catch { /* keep the last list */ }
  };

  /* Portfolio P&L bands. */
  let lastBand = 0;
  const forSelected = (e: unknown): boolean => isForAccount(e, useSelectedAccountStore.getState().selectedId);

  /* Server notifications. */
  const fetchServer = async (): Promise<void> => {
    try {
      const list = await notificationsApi.list(MAX_NOTIFICATIONS);
      if (!live()) return;
      useBellStore.setState((s) => ({ notifications: mergeServerNotifications(s.notifications, list, s.clearedAt) }));
    } catch { /* best-effort, as on the web */ }
  };

  const begin = (): void => {
    if (!live()) return;

    offs.push(subscribeNotifications((payload) => {
      if (!live()) return;
      useBellStore.setState((s) => ({ notifications: applyNotificationPush(s.notifications, payload, s.clearedAt) }));
    }));
    offs.push(subscribeOrders((e) => { if (forSelected(e)) add(orderEventNotification(e)); void loadPositions(); }));
    offs.push(subscribePositions((e) => { if (forSelected(e)) add(positionEventNotification(e)); void loadPositions(); }));
    offs.push(subscribeWallet((e) => { add(walletEventNotification(e)); }));
    offs.push(subscribeForeground(() => {
      void fetchServer();
      void loadAlerts();
      void loadPositions();
    }));

    timers.push(setInterval(() => {
      if (AppState.currentState === 'active') void fetchServer();
    }, NOTIFICATION_POLL_MS));
    timers.push(setInterval(() => {
      const total = portfolioFloatingPnl(positions, mem.history);
      if (total === null) return;
      const n = portfolioPnlNotification(total, lastBand);
      if (!n) return;
      lastBand = pnlBand(total);
      add(n);
    }, PNL_CHECK_MS));

    refreshAlertsHook = () => { void loadAlerts(); };
    offs.push(startPush());

    void fetchServer();
    void loadAlerts();
    void loadPositions();
  };

  void hydrate(userId).then(begin, begin);

  return () => {
    stopped = true;
    for (const off of offs) off();
    offTickers?.();
    offTickers = null;
    for (const id of timers) clearInterval(id);
    if (refreshAlertsHook) refreshAlertsHook = null;
  };
};

let retainCount = 0;
let engineStop: (() => void) | null = null;
let pendingStop: ReturnType<typeof setTimeout> | null = null;

/**
 * Keep the engine running until the release is called. Every mounted bell
 * holds one; the engine starts with the first and stops (a tick after) the
 * last, so a header re-mounting during navigation does not restart it.
 */
export const retainNotificationEngine = (): (() => void) => {
  retainCount += 1;
  if (pendingStop) { clearTimeout(pendingStop); pendingStop = null; }
  if (!engineStop) engineStop = startEngine();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    retainCount -= 1;
    if (retainCount > 0) return;
    if (pendingStop) clearTimeout(pendingStop);
    pendingStop = setTimeout(() => {
      pendingStop = null;
      if (retainCount === 0 && engineStop) {
        engineStop();
        engineStop = null;
      }
    }, 0);
  };
};

/** Is the engine running? For tests. */
export const engineRunning = (): boolean => engineStop !== null;

/* ── Following the signed-in person ───────────────────────────────────── */

/**
 * A different person (sign-out, sign-in, "View As User") drops the list, the
 * prefs and the dedupe memory, and restarts a running engine for them — the
 * previous user's notifications must never show under the next one's bell.
 */
export const resetBellForUser = (userId: string | null): void => {
  generation += 1;
  lastSeen = new Map();
  hydration = null;
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  useBellStore.setState(initial(userId));
  if (engineStop) {
    engineStop();
    engineStop = retainCount > 0 && userId ? startEngine() : null;
  }
};

useAuthStore.subscribe((state, prev) => {
  const next = state.user?.id ?? null;
  if (next === (prev.user?.id ?? null)) return;
  resetBellForUser(next);
});
