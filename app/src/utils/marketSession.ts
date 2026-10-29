/**
 * Lightweight market-session detection — client/src/utils/marketSession.js,
 * rule for rule. The order form shows its "Market Closed" banner from this;
 * the server's own session gate (services/marketHours) is what actually
 * refuses an order, so this is display only, as it is on the web.
 *
 * The schedules are approximate (no holidays, no DST) — the web's own note.
 *
 * Two platform notes, neither a change of behaviour:
 *   • `now` is a parameter (default: the current time) so the rules can be
 *     pinned by a test. The web reads `new Date()` inside; so does this when
 *     no `now` is passed.
 *   • India time is UTC+05:30 all year (India keeps no daylight saving), so
 *     IST is computed by offset instead of through Intl's `Asia/Kolkata`
 *     time zone — Hermes' Intl time-zone support differs by platform, and a
 *     banner that says "NSE open" at 3 a.m. on one phone is worse than
 *     arithmetic that cannot drift. Same answer as the web's Intl path.
 */

export interface MarketSession {
  isOpen: boolean;
  label: string;
  /** Why it is closed / when it opens. Absent while open. */
  detail?: string;
  tz: string;
}

/** A category string (legacy callers) or an instrument-like row. */
export type MarketSessionArg =
  | string
  | { exchange?: string | null; category?: string | null }
  | null
  | undefined;

const TZ_UTC = 'UTC';

const utcParts = (now: Date): { day: number; hour: number; minute: number } => ({
  day: now.getUTCDay(), // 0=Sun … 6=Sat
  hour: now.getUTCHours(),
  minute: now.getUTCMinutes(),
});

// ── CRYPTO — always open
const cryptoSession = (): MarketSession => ({ isOpen: true, label: 'Open 24/7', tz: TZ_UTC });

// ── FOREX — Sunday 22:00 UTC → Friday 22:00 UTC (NY close)
const forexSession = (now: Date): MarketSession => {
  const { day, hour } = utcParts(now);
  if (day === 6) return { isOpen: false, label: 'Market Closed', detail: 'Forex re-opens Sunday 22:00 UTC', tz: TZ_UTC };
  if (day === 0 && hour < 22) return { isOpen: false, label: 'Market Closed', detail: 'Opens at 22:00 UTC', tz: TZ_UTC };
  if (day === 5 && hour >= 22) return { isOpen: false, label: 'Market Closed', detail: 'Re-opens Sunday 22:00 UTC', tz: TZ_UTC };
  return { isOpen: true, label: 'Forex session open', tz: TZ_UTC };
};

// ── STOCKS / US equities — Mon-Fri 13:30-20:00 UTC (= 09:30-16:00 ET)
const stockSession = (now: Date): MarketSession => {
  const { day, hour, minute } = utcParts(now);
  if (day === 0 || day === 6) return { isOpen: false, label: 'Market Closed', detail: 'Stocks closed on weekends', tz: TZ_UTC };
  const mins = hour * 60 + minute;
  const open = 13 * 60 + 30;
  const close = 20 * 60;
  if (mins < open) return { isOpen: false, label: 'Pre-market', detail: 'Regular session opens 13:30 UTC', tz: TZ_UTC };
  if (mins >= close) return { isOpen: false, label: 'After-hours', detail: 'Regular session closes 20:00 UTC', tz: TZ_UTC };
  return { isOpen: true, label: 'NYSE / NASDAQ open', tz: TZ_UTC };
};

// ── COMMODITIES — most CFD commodity desks follow Sun 22-Fri 22 UTC like forex
const commoditySession = (now: Date): MarketSession => {
  const fx = forexSession(now);
  return fx.isOpen ? { isOpen: true, label: 'Commodity session open', tz: TZ_UTC } : fx;
};

/** IST weekday and minute-of-day. UTC+05:30, no daylight saving. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
export const istParts = (now: Date): { day: number; mins: number } => {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return { day: ist.getUTCDay(), mins: ist.getUTCHours() * 60 + ist.getUTCMinutes() };
};

// ── NSE / BSE (Indian equity) — Mon-Fri 09:15-15:30 IST.
const nseSession = (now: Date): MarketSession => {
  const { day, mins } = istParts(now);
  if (day === 0 || day === 6) return { isOpen: false, label: 'Market Closed', detail: 'NSE closed on weekends', tz: 'IST' };
  const open = 9 * 60 + 15;
  const close = 15 * 60 + 30;
  if (mins < open) return { isOpen: false, label: 'Pre-open', detail: 'NSE opens 09:15 IST', tz: 'IST' };
  if (mins >= close) return { isOpen: false, label: 'Market Closed', detail: 'NSE closes 15:30 IST', tz: 'IST' };
  return { isOpen: true, label: 'NSE open', tz: 'IST' };
};

// ── MCX commodity futures & options — 09:00–23:30 IST, Mon–Fri. (The evening
// close moves to 23:55 while US daylight saving is in force; the server-side
// gate in marketHours.js is authoritative — this is UI-only.)
const mcxSession = (now: Date): MarketSession => {
  const { day, mins } = istParts(now);
  if (day === 0 || day === 6) return { isOpen: false, label: 'Market Closed', detail: 'MCX closed on weekends', tz: 'IST' };
  const open = 9 * 60;
  const close = 23 * 60 + 30;
  if (mins < open) return { isOpen: false, label: 'Pre-open', detail: 'MCX opens 09:00 IST', tz: 'IST' };
  if (mins >= close) return { isOpen: false, label: 'Market Closed', detail: 'MCX closes 23:30 IST', tz: 'IST' };
  return { isOpen: true, label: 'MCX open', tz: 'IST' };
};

// ── INDICES — index CFDs typically Mon-Fri with short overnight break
const indexSession = (now: Date): MarketSession => {
  const { day, hour } = utcParts(now);
  if (day === 0 && hour < 22) return { isOpen: false, label: 'Market Closed', detail: 'Opens Sunday 22:00 UTC', tz: TZ_UTC };
  if (day === 6) return { isOpen: false, label: 'Market Closed', detail: 'Indices closed Saturday', tz: TZ_UTC };
  if (day === 5 && hour >= 22) return { isOpen: false, label: 'Market Closed', detail: 'Re-opens Sunday 22:00 UTC', tz: TZ_UTC };
  return { isOpen: true, label: 'Index session open', tz: TZ_UTC };
};

/** Exchanges that follow NSE equity hours (F&O included). MCX keeps its own (mcxSession). */
const NSE_HOURS_EXCHANGES = ['NSE', 'BSE', 'NFO', 'BFO'];

/**
 * Dispatch by instrument. Accepts either a category string (legacy callers)
 * or an instrument `{ exchange, category }`. Exchange-bound instruments
 * (NSE/BSE/NFO/BFO) use Indian equity hours, MCX its own; everything else
 * dispatches by category; anything unknown is "Market open".
 */
export function getMarketSession(arg: MarketSessionArg, now: Date = new Date()): MarketSession {
  const isObj = !!arg && typeof arg === 'object';
  const exchange = isObj ? String((arg as { exchange?: string | null }).exchange || '').toUpperCase() : '';
  if (NSE_HOURS_EXCHANGES.includes(exchange)) return nseSession(now);
  if (exchange === 'MCX') return mcxSession(now);
  // `String(obj.category)` on purpose: an object without a category reads as
  // "UNDEFINED" and falls to the default, exactly as the web's expression does.
  const cat = String(isObj ? (arg as { category?: string | null }).category : (arg || '')).toUpperCase();
  switch (cat) {
    case 'CRYPTO': return cryptoSession();
    case 'FOREX': return forexSession(now);
    case 'STOCK':
    case 'STOCKS': return stockSession(now);
    case 'COMMODITY': return commoditySession(now);
    case 'INDEX':
    case 'INDICES': return indexSession(now);
    default: return { isOpen: true, label: 'Market open', tz: TZ_UTC };
  }
}

/** The order form's banner text: "Market Closed — Opens at 22:00 UTC". Null while open. */
export const marketClosedBanner = (s: MarketSession): string | null =>
  (s.isOpen ? null : `${s.label}${s.detail ? ` — ${s.detail}` : ''}`);
