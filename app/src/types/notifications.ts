/**
 * The notification bell — server notifications, the bell's own entries,
 * and the merge between them.
 *
 * Server shape: the Notification model (backend/src/models/index.js) as
 * returned by GET /api/user/notifications and pushed on
 * `user:notifications`. Bell behaviour: client/src/hooks/useNotifications.js
 * and components/NotificationCenter.jsx.
 *
 * ── TWO KINDS OF ENTRY, ONE LIST ──────────────────────────────────────
 * The bell holds SERVER notifications (admin announcements, persisted
 * system events) and LOCAL ones the app raises itself from socket events
 * (order filled, price alert crossed…). Server entries carry the id
 * `srv:<_id>` so a live push and a later fetch reconcile to one entry, and
 * so only they are marked read on the server — a local entry has nothing
 * there to mark.
 * ──────────────────────────────────────────────────────────────────────
 */
import { id, str, strOrNull } from '@/types/api';
import { fmtMoney } from '@/utils/money';

type Raw = Record<string, unknown>;

const obj = (v: unknown): Raw =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

export type NotificationTab = 'Trading' | 'Markets' | 'Account';

export type BellType =
  | 'ORDER' | 'TRADING' | 'PORTFOLIO'
  | 'PRICE_ALERT' | 'VOLATILITY' | 'SCREENER'
  | 'ACCOUNT' | 'ANNOUNCEMENT';

export interface NotificationMeta {
  tab: NotificationTab;
  icon: 'order' | 'signal' | 'pie' | 'bell' | 'bolt' | 'filter' | 'user';
  tint: string;
  label: string;
}

/** Category → tab, icon and tint. Verbatim from useNotifications.js. */
export const NOTIFICATION_META: Record<BellType, NotificationMeta> = {
  ORDER: { tab: 'Trading', icon: 'order', tint: '#1D4ED8', label: 'Order update' },
  TRADING: { tab: 'Trading', icon: 'signal', tint: '#0EA5E9', label: 'Trade alert' },
  PORTFOLIO: { tab: 'Trading', icon: 'pie', tint: '#10B981', label: 'Portfolio update' },
  PRICE_ALERT: { tab: 'Markets', icon: 'bell', tint: '#3B82F6', label: 'Price alert' },
  VOLATILITY: { tab: 'Markets', icon: 'bolt', tint: '#8B5CF6', label: 'Volatility alert' },
  SCREENER: { tab: 'Markets', icon: 'filter', tint: '#EC4899', label: 'Screener alert' },
  ACCOUNT: { tab: 'Account', icon: 'user', tint: '#475569', label: 'Account' },
  ANNOUNCEMENT: { tab: 'Account', icon: 'bell', tint: '#1D4ED8', label: 'Announcement' },
};

export const isBellType = (t: unknown): t is BellType =>
  typeof t === 'string' && Object.prototype.hasOwnProperty.call(NOTIFICATION_META, t);

export type BellStatus = 'info' | 'success' | 'warning' | 'error' | (string & {});

/** A server Notification document. */
export interface ServerNotification {
  id: string;
  /** Free-form on the server ('TRADE', 'MARGIN_CALL', 'PARTNER_BONUS', …). */
  type: string;
  title: string | null;
  message: string | null;
  data: Record<string, unknown>;
  /** `data.status`, else a top-level `status` (live pushes carry either). */
  status: string | null;
  /** `data.link`, else a top-level `link`. */
  link: string | null;
  isRead: boolean;
  createdAt: string | null;
}

export const toServerNotification = (raw: unknown): ServerNotification => {
  const r = obj(raw);
  const data = obj(r.data);
  return {
    id: id(r),
    type: str(r.type),
    title: strOrNull(r.title),
    message: strOrNull(r.message),
    data,
    status: strOrNull(data.status) ?? strOrNull(r.status),
    link: strOrNull(data.link) ?? strOrNull(r.link),
    isRead: r.isRead === true,
    createdAt: strOrNull(r.createdAt),
  };
};

/** One row in the bell. */
export interface BellNotification {
  /** `srv:<_id>` for server entries; anything else is local. */
  id: string;
  type: BellType;
  title: string;
  message: string;
  /** Epoch ms. */
  timestamp: number;
  status: BellStatus;
  /**
   * Where tapping goes, as the WEB path the event named ('/wallet',
   * '/trade?symbol=…'). Navigation maps it to a screen.
   */
  link: string | null;
  symbol: string | null;
  read: boolean;
}

export const MAX_NOTIFICATIONS = 50;
export const SERVER_ID_PREFIX = 'srv:';

export const isServerEntry = (bellId: string): boolean => bellId.startsWith(SERVER_ID_PREFIX);

/** `srv:<_id>` → `<_id>`; null for a local entry. */
export const serverIdOf = (bellId: string): string | null =>
  (isServerEntry(bellId) ? bellId.slice(SERVER_ID_PREFIX.length) : null);

/**
 * A server notification → a bell entry (useNotifications mapServerNotification).
 * An unknown server type files under ACCOUNT, where admin sends belong.
 */
export const toBellNotification = (n: ServerNotification, now: number = Date.now()): BellNotification => {
  const ts = n.createdAt ? new Date(n.createdAt).getTime() : NaN;
  return {
    id: `${SERVER_ID_PREFIX}${n.id}`,
    type: isBellType(n.type) ? n.type : 'ACCOUNT',
    title: n.title || 'Notification',
    message: n.message || '',
    timestamp: Number.isFinite(ts) ? ts : now,
    status: n.status ?? 'info',
    link: n.link,
    symbol: null,
    read: n.isRead,
  };
};

/**
 * Fold a fresh server list into the bell (useNotifications mergeServer).
 *
 *  - Entries at or before `clearedAt` stay hidden — "Clear all" has no
 *    server delete, so the cutoff is what makes it stick.
 *  - A fresh server entry REPLACES the held one with the same id, so a read
 *    elsewhere shows as read here.
 *  - Local entries are kept as they are.
 *  - Newest first, capped.
 */
export const mergeServerNotifications = (
  prev: readonly BellNotification[],
  serverList: readonly ServerNotification[],
  clearedAt: number,
  now: number = Date.now(),
): BellNotification[] => {
  const fresh = serverList.map((n) => toBellNotification(n, now)).filter((e) => e.timestamp > clearedAt);
  const local = prev.filter((n) => !isServerEntry(n.id));
  const heldServer = prev.filter((n) => isServerEntry(n.id));
  const byId = new Map<string, BellNotification>();
  for (const e of [...fresh, ...heldServer]) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values(), ...local]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_NOTIFICATIONS);
};

/**
 * A live `user:notifications` push → prepend, unless it is already held or
 * falls before the clear cutoff. Pushes are unread by definition.
 */
export const applyNotificationPush = (
  prev: readonly BellNotification[],
  payload: unknown,
  clearedAt: number,
  now: number = Date.now(),
): BellNotification[] => {
  if (!payload || typeof payload !== 'object') return [...prev];
  const entry = toBellNotification({ ...toServerNotification(payload), isRead: false }, now);
  if (entry.id === SERVER_ID_PREFIX || entry.timestamp <= clearedAt) return [...prev];
  if (prev.some((n) => n.id === entry.id)) return [...prev];
  return [entry, ...prev].slice(0, MAX_NOTIFICATIONS);
};

export const unreadCount = (list: readonly BellNotification[]): number =>
  list.reduce((n, e) => (e.read ? n : n + 1), 0);

/* ── Preferences ──────────────────────────────────────────────────────── */

export interface NotificationPrefs {
  /** Kept for backward compatibility; the product plays no sounds. */
  muteSounds: boolean;
  enableTrading: boolean;
  enableMarkets: boolean;
  enableAccount: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  muteSounds: true,
  enableTrading: true,
  enableMarkets: true,
  enableAccount: true,
};

/** Does this category raise a local notification under these prefs? */
export const allowedByPrefs = (type: BellType, prefs: NotificationPrefs): boolean => {
  const tab = NOTIFICATION_META[type].tab;
  if (tab === 'Trading') return prefs.enableTrading;
  if (tab === 'Markets') return prefs.enableMarkets;
  return prefs.enableAccount;
};

/** Same type + title within this window is dropped — the server re-emits state ticks. */
export const NOTIFICATION_DEDUPE_MS = 30_000;

/** How often the web re-pulls the server list as a fallback for missed pushes. */
export const NOTIFICATION_POLL_MS = 20_000;

/* ── Push tokens (mobile only — the web never registers one) ──────────── */

export type PushPlatform = 'ios' | 'android' | 'web' | 'unknown';

/* ── Local notifications: the bell's own generators ───────────────────── *
 * useNotifications.js raises bell entries from socket events and ticks.
 * The rules are pure and live here; the hook that owns the subscriptions
 * only feeds them. Each returns null when the event is not worth a bell. */

/** What a generator produces; `addLocalNotification` turns it into a row. */
export interface LocalNotificationInput {
  type: BellType;
  title: string;
  message?: string;
  status?: BellStatus;
  link?: string | null;
  symbol?: string | null;
}

const numOr = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

/** The web's link for a symbol — the navigator maps web paths to screens. */
const tradeLink = (sym: string | null): string =>
  `/trade${sym ? `?symbol=${encodeURIComponent(sym)}` : ''}`;

/**
 * Account scoping — useNotifications.js `isForCurrentAccount`. Notifications
 * are pushed per USER, but a user can hold several trading accounts; the
 * server stamps `accountId` on every bell-worthy push, and an event for an
 * account other than the selected one is dropped. An event with NO accountId
 * is still shown (anything untagged), and so is everything while no account
 * is selected — this can only remove wrong entries, never hide right ones.
 */
export const isForAccount = (data: unknown, selectedAccountId: string | null | undefined): boolean => {
  const evAcct = obj(data).accountId;
  if (evAcct === null || evAcct === undefined || evAcct === '') return true;
  if (!selectedAccountId) return true;
  return String(evAcct) === String(selectedAccountId);
};

/**
 * The server tags order / position events with `event` (uppercase) or, for
 * manual / admin closes, `reason`. These map to a bell-worthy action; the
 * generic `UPDATED` (emitted on every price refresh) has no mapping and is
 * ignored, so the bell does not ring on every tick.
 */
export const ORDER_EVENT_ACTION: Readonly<Record<string, string>> = {
  FILLED: 'filled',
  PLACED: 'placed',
  CANCELLED: 'cancelled',
  OCO_CANCELLED: 'cancelled',
  REJECTED: 'rejected',
  STOP_TRIGGERED: 'triggered',
  LIMIT_TRIGGERED: 'triggered',
};

export const POSITION_EVENT_ACTION: Readonly<Record<string, string>> = {
  STOP_LOSS: 'closed',
  TAKE_PROFIT: 'closed',
  TRAILING_STOP_HIT: 'closed',
  EXPIRY: 'closed',
  INTRADAY_SQUAREOFF: 'closed',
  MARGIN_STOPOUT: 'closed',
  NEGATIVE_BALANCE: 'closed',
  POSITION_CLOSED: 'closed',
};

const POSITION_EVENT_STATUS: Readonly<Record<string, BellStatus>> = {
  TAKE_PROFIT: 'success',
  STOP_LOSS: 'warning',
  TRAILING_STOP_HIT: 'warning',
  MARGIN_STOPOUT: 'error',
  NEGATIVE_BALANCE: 'error',
};

/** `String(data?.event || data?.reason || '').toUpperCase()` */
const eventOf = (d: Raw): string => (str(d.event) || str(d.reason)).toUpperCase();

/** A `user:orders` frame. */
export const orderEventNotification = (data: unknown): LocalNotificationInput | null => {
  const d = obj(data);
  const action = ORDER_EVENT_ACTION[eventOf(d)];
  if (!action) return null;
  const sym = strOrNull(d.symbol) ?? strOrNull(obj(d.order).symbol);
  return {
    type: 'ORDER',
    title: `Order ${action}${sym ? ` · ${sym}` : ''}`,
    message: 'Your order status changed',
    status: action === 'filled' ? 'success' : action === 'cancelled' || action === 'rejected' ? 'warning' : 'info',
    link: '/reports',
    symbol: sym,
  };
};

/** A `user:positions` frame — only a close speaks; `UPDATED` ticks do not. */
export const positionEventNotification = (data: unknown): LocalNotificationInput | null => {
  const d = obj(data);
  const ev = eventOf(d);
  const action = POSITION_EVENT_ACTION[ev];
  if (!action) return null;
  const sym = strOrNull(d.symbol) ?? strOrNull(obj(d.position).symbol);
  return {
    type: 'TRADING',
    title: `Position ${action}${sym ? ` · ${sym}` : ''}`,
    message: 'Your position closed',
    status: POSITION_EVENT_STATUS[ev] ?? 'info',
    link: tradeLink(sym),
    symbol: sym,
  };
};

/** `+₹1,250.00` / `-₹40.00` — the web's `toLocaleString('en-IN', 2dp)` with the sign first. */
const signedRupees = (n: number): string => `${n > 0 ? '+' : '-'}${fmtMoney(Math.abs(n), 'INR')}`;

/** A `user:wallet` frame — only a real transaction amount speaks, not a rebalance tick. */
export const walletEventNotification = (data: unknown): LocalNotificationInput | null => {
  const d = obj(data);
  const amount = numOr(d.amount, 0);
  if (amount === 0) return null;
  const action = (str(d.action) || 'updated').toLowerCase();
  return {
    type: 'ACCOUNT',
    title: `Wallet ${action}`,
    message: signedRupees(amount),
    status: amount >= 0 ? 'success' : 'info',
    link: '/wallet',
  };
};

/** A price alert, as much of it as the crossing check needs (`/reports/alerts`). */
export interface WatchedAlert {
  id: string;
  symbol: string;
  direction: 'ABOVE' | 'BELOW' | (string & {});
  targetPrice: number | null;
  note: string | null;
}

/**
 * Has the tick crossed the alert's target? The caller remembers which alerts
 * fired this session, so a price flapping around the line rings once.
 */
export const priceAlertNotification = (a: WatchedAlert, price: number): LocalNotificationInput | null => {
  if (a.targetPrice === null || !Number.isFinite(a.targetPrice) || !(price > 0)) return null;
  const crossed = (a.direction === 'ABOVE' && price >= a.targetPrice)
    || (a.direction === 'BELOW' && price <= a.targetPrice);
  if (!crossed) return null;
  const at = price.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
  return {
    type: 'PRICE_ALERT',
    title: `${a.symbol} crossed ${a.direction === 'ABOVE' ? 'above' : 'below'} ${a.targetPrice}`,
    message: `Now at ${at}${a.note ? ` · ${a.note}` : ''}`,
    status: 'success',
    link: tradeLink(a.symbol),
    symbol: a.symbol,
  };
};

export interface PriceSample { ts: number; price: number }

export const VOLATILITY_WINDOW_MS = 5 * 60_000;
export const VOLATILITY_MIN_SAMPLES = 5;
export const VOLATILITY_THRESHOLD_PCT = 2;
export const VOLATILITY_COOLDOWN_MS = 10 * 60_000;
export const SCREENER_THRESHOLD_PCT = 5;
export const SCREENER_COOLDOWN_MS = 30 * 60_000;

/** Append a tick and drop what has left the 5-minute window. Returns a new array. */
export const pushPriceSample = (hist: readonly PriceSample[], sample: PriceSample): PriceSample[] => {
  const cutoff = sample.ts - VOLATILITY_WINDOW_MS;
  return [...hist, sample].filter((s) => s.ts >= cutoff);
};

/**
 * ±2% across the window, from at least five samples, at most once per 10
 * minutes per symbol (`lastFiredAt` is the caller's per-symbol memory).
 */
export const volatilityNotification = (
  symbol: string,
  hist: readonly PriceSample[],
  now: number,
  lastFiredAt: number,
): LocalNotificationInput | null => {
  if (hist.length < VOLATILITY_MIN_SAMPLES) return null;
  const oldest = hist[0]?.price;
  const latest = hist[hist.length - 1]?.price;
  if (!oldest || latest === undefined) return null;
  const pct = ((latest - oldest) / oldest) * 100;
  if (Math.abs(pct) < VOLATILITY_THRESHOLD_PCT || now - lastFiredAt <= VOLATILITY_COOLDOWN_MS) return null;
  return {
    type: 'VOLATILITY',
    title: `${symbol} ${pct >= 0 ? 'surged' : 'dropped'} ${Math.abs(pct).toFixed(2)}% in 5 min`,
    message: `Live: ${latest}`,
    status: pct >= 0 ? 'success' : 'error',
    link: tradeLink(symbol),
    symbol,
  };
};

/** Which ±5% band the day's change sits in: 1, -1, or 0 between them. */
export const screenerSign = (change24h: number): 1 | -1 | 0 =>
  (change24h >= SCREENER_THRESHOLD_PCT ? 1 : change24h <= -SCREENER_THRESHOLD_PCT ? -1 : 0);

/**
 * Entering a band (from outside it) rings, at most once per 30 minutes per
 * symbol. The caller stores the new sign whatever this returns.
 */
export const screenerNotification = (
  symbol: string,
  change24h: number,
  prevSign: number,
  now: number,
  lastFiredAt: number,
): LocalNotificationInput | null => {
  if (!Number.isFinite(change24h)) return null;
  const sign = screenerSign(change24h);
  if (sign === 0 || sign === prevSign || now - lastFiredAt <= SCREENER_COOLDOWN_MS) return null;
  return {
    type: 'SCREENER',
    title: `${symbol} on the ${sign > 0 ? 'top gainers' : 'top losers'} list`,
    message: `${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}% today`,
    status: sign > 0 ? 'success' : 'error',
    link: tradeLink(symbol),
    symbol,
  };
};

/** The portfolio P&L thresholds: ₹10k / ₹50k / ₹1L each way. */
const PNL_BANDS_UP = [10000, 50000, 100000];
const PNL_BANDS_DOWN = [-10000, -50000, -100000];

/** The furthest band crossed, or 0 inside ±₹10,000. */
export const pnlBand = (totalPnl: number): number => {
  let band = 0;
  for (const b of PNL_BANDS_UP) if (totalPnl >= b) band = b;
  for (const b of PNL_BANDS_DOWN) if (totalPnl <= b) band = b;
  return band;
};

/**
 * A crossing into a new P&L band. The caller skips this entirely when no
 * position is open, or an idle account would ring on every launch.
 */
export const portfolioPnlNotification = (totalPnl: number, lastBand: number): LocalNotificationInput | null => {
  const band = pnlBand(totalPnl);
  if (band === 0 || band === lastBand) return null;
  return {
    type: 'PORTFOLIO',
    title: `Portfolio PnL crossed ${band > 0 ? '+' : '-'}${fmtMoney(Math.abs(band), 'INR', 0)}`,
    message: `Live total: ${totalPnl >= 0 ? '+' : '-'}${fmtMoney(Math.abs(totalPnl), 'INR')}`,
    status: band > 0 ? 'success' : 'error',
    link: '/dashboard',
  };
};

/**
 * Which sound, if any, a new entry asks for — each gated by its own trade
 * setting: 'alert' (price / volatility / screener) or 'tpsl' (a close).
 */
export const notificationSound = (n: LocalNotificationInput): 'alert' | 'tpsl' | null => {
  if (n.type === 'PRICE_ALERT' || n.type === 'VOLATILITY' || n.type === 'SCREENER') return 'alert';
  const text = n.title || n.message || '';
  if (n.type === 'ORDER' && /closed|filled|liquidat/i.test(text)) return 'tpsl';
  if (n.type === 'TRADING' && /closed|tp hit|sl hit|stop[\s-]?out/i.test(text)) return 'tpsl';
  return null;
};

/**
 * Raise a local entry: category switch, then the 30-second type+title
 * dedupe (`lastSeen` is the caller's map, updated here), then prepend and
 * cap. Returns the list unchanged when the entry is dropped.
 */
export const addLocalNotification = (
  prev: readonly BellNotification[],
  n: LocalNotificationInput,
  prefs: NotificationPrefs,
  lastSeen: Map<string, number>,
  now: number = Date.now(),
  rand: () => number = Math.random,
): BellNotification[] => {
  if (!allowedByPrefs(n.type, prefs)) return [...prev];
  const key = `${n.type}|${n.title}`;
  const last = lastSeen.get(key);
  if (last !== undefined && now - last < NOTIFICATION_DEDUPE_MS) return [...prev];
  lastSeen.set(key, now);
  const entry: BellNotification = {
    id: `${now}-${rand().toString(36).slice(2, 8)}`,
    type: n.type,
    title: n.title,
    message: n.message ?? '',
    timestamp: now,
    status: n.status ?? 'info',
    link: n.link ?? null,
    symbol: n.symbol ?? null,
    read: false,
  };
  return [entry, ...prev].slice(0, MAX_NOTIFICATIONS);
};

/** The bell's tabs, in order — 'All' first, as the dropdown opens on it. */
export const NOTIFICATION_TABS: readonly (NotificationTab | 'All')[] = ['All', 'Trading', 'Markets', 'Account'];

/** The status dot's colour (NotificationCenter STATUS_DOT); unknown statuses read as info. */
export const STATUS_DOT: Record<string, string> = {
  success: '#16A34A',
  error: '#DC2626',
  warning: '#3B82F6',
  info: '#94A3B8',
};

export const statusDot = (status: BellStatus): string => STATUS_DOT[status] ?? (STATUS_DOT.info as string);

/** "12s ago" … "3d ago". The bell re-renders it every 30s while open. */
export const bellRelativeTime = (ts: number, now: number = Date.now()): string => {
  const s = Math.floor(Math.max(0, now - ts) / 1000);
  if (s < 60) return `${s || 1}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

/** The empty-list line per tab. */
export const bellEmptyText = (tab: NotificationTab | 'All'): string =>
  (tab === 'All' ? 'New alerts will appear here.' : `No ${tab.toLowerCase()} notifications yet.`);

export const notificationsForTab = (
  list: readonly BellNotification[],
  tab: NotificationTab | 'All',
): BellNotification[] =>
  (tab === 'All' ? [...list] : list.filter((n) => NOTIFICATION_META[n.type].tab === tab));
