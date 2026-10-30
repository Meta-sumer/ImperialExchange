import { useEffect } from 'react';
import { AppState } from 'react-native';
import { create } from 'zustand';

import { api } from '@/api/client';
import { cmsApi, type NewsQuery } from '@/api/cms.api';
import { rows } from '@/types/api';
import {
  fmtEconomicValue,
  type EconomicEvent as AdminCalendarEvent,
  type NewsArticle,
  type NewsPage,
} from '@/types/cms';
import {
  adaptCalendarEvent,
  adaptInstrumentNews,
  adaptMarketNews,
  type CalendarEvent,
  type InstrumentNewsItem,
  type MarketNewsItem,
} from '@/types/market';

/**
 * Everything news-shaped: a stock's headlines, the Market News feed, the
 * Daily News Updates articles and the economic-calendar data the price chart
 * marks.
 *
 * Call sites: StockDetail.jsx (News tab), components/MarketNews.jsx (Explore
 * and the market list), News.jsx, NewsArticle.jsx and
 * utils/economicCalendar.js (the chart's calendar markers). Endpoints:
 * routes/instrument.js (/market-news, /economic-calendar, /:symbol/news) and
 * routes/cms.js (/cms/news*, /cms/economic-calendar).
 *
 * The CMS reads are cms.api's — one implementation of those endpoints in the
 * app — and are re-exported here under the names a news screen looks for.
 */

type Raw = Record<string, unknown>;

const payload = (body: unknown): unknown => {
  const env = body && typeof body === 'object' ? (body as Raw) : {};
  return 'data' in env ? env.data : body;
};

/* ── Headlines ────────────────────────────────────────────────────────── */

/**
 * GET /instruments/:symbol/news — Yahoo Finance search, cached 5 min
 * server-side. An empty list is normal (Yahoo has little for NSE tickers);
 * StockDetail says "No recent news for <name>."
 */
export const fetchInstrumentNews = async (symbol: string): Promise<InstrumentNewsItem[]> => {
  const res = await api.get(`/instruments/${encodeURIComponent(symbol.toUpperCase())}/news`);
  return rows<unknown>(payload(res.data))
    .map(adaptInstrumentNews)
    .filter((n): n is InstrumentNewsItem => n !== null);
};

/* ── Market News (components/MarketNews.jsx) ──────────────────────────── */

/** How many headlines the feed asks for — `params: { limit: 60 }`. */
export const MARKET_NEWS_LIMIT = 60;

/** MarketNews.jsx REFRESH_MS — the client cache and the re-pull interval. */
export const MARKET_NEWS_REFRESH_MS = 5 * 60_000;

/**
 * GET /instruments/market-news?limit=&symbol= — Indian market headlines
 * (Economic Times, Mint, Business Standard, BusinessLine), newest first,
 * each tagged with the stocks it mentions. Cached 5 min server-side.
 */
export const fetchMarketNews = async (
  q: { limit?: number; symbol?: string | null } = {},
): Promise<MarketNewsItem[]> => {
  const params: Record<string, string | number> = { limit: q.limit ?? MARKET_NEWS_LIMIT };
  if (q.symbol) params.symbol = q.symbol.toUpperCase();
  const res = await api.get('/instruments/market-news', { params });
  return rows<unknown>(payload(res.data))
    .map(adaptMarketNews)
    .filter((n): n is MarketNewsItem => n !== null);
};

interface MarketNewsState {
  /** null until the first answer — the web's "Loading news…". */
  items: MarketNewsItem[] | null;
  at: number;
  /** The backend has no market-news route (404): the sections render nothing. */
  unavailable: boolean;
}

/** One feed for the whole app, as MarketNews.jsx keeps one module cache. */
export const useMarketNewsStore = create<MarketNewsState>(() => ({ items: null, at: 0, unavailable: false }));

let newsInflight: Promise<MarketNewsItem[]> | null = null;

/**
 * MarketNews.jsx `loadNews`: the cached list while it is fresh, else one
 * shared request. A failure answers what was held, or an empty list — the
 * section then says "No news right now", never spins forever.
 */
export const loadMarketNews = (force = false): Promise<MarketNewsItem[]> => {
  const s = useMarketNewsStore.getState();
  if (s.unavailable) return Promise.resolve([]);
  if (!force && s.items && Date.now() - s.at < MARKET_NEWS_REFRESH_MS) return Promise.resolve(s.items);
  if (newsInflight) return newsInflight;
  newsInflight = fetchMarketNews()
    .then((items) => {
      useMarketNewsStore.setState({ items, at: Date.now() });
      return items;
    })
    .catch((err: unknown) => {
      const status = (err as { response?: { status?: number } } | null)?.response?.status;
      if (status === 404) {
        // Not a feed outage — this backend never had the route. Remember it
        // for the session so the sections hide and nothing re-polls.
        useMarketNewsStore.setState({ items: [], at: Date.now(), unavailable: true });
        return [];
      }
      const held = useMarketNewsStore.getState().items ?? [];
      useMarketNewsStore.setState({ items: held });
      return held;
    })
    .finally(() => { newsInflight = null; });
  return newsInflight;
};

/**
 * MarketNews.jsx `useNews`: the feed, pulled on mount (from the cache when
 * fresh) and re-pulled every 5 minutes while the app is in the foreground
 * (the web's `!document.hidden`). `refreshKey` (pull-to-refresh) forces one.
 */
export function useMarketNews(refreshKey = 0): MarketNewsItem[] | null {
  const items = useMarketNewsStore((s) => s.items);
  useEffect(() => {
    void loadMarketNews(refreshKey > 0);
  }, [refreshKey]);
  useEffect(() => {
    const id = setInterval(() => {
      if (AppState.currentState === 'active') void loadMarketNews(true);
    }, MARKET_NEWS_REFRESH_MS);
    return () => clearInterval(id);
  }, []);
  return items;
}

/**
 * MarketNews.jsx `timeAgo`, wording and thresholds kept: "Just now",
 * "5 min ago", "1 hr ago" / "3 hrs ago", "Yesterday", "4 days ago". An
 * undatable story reads nothing.
 */
export const marketNewsTimeAgo = (iso: string | null | undefined, nowMs: number = Date.now()): string => {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (nowMs - t) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr${s >= 7200 ? 's' : ''} ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'Yesterday' : `${d} days ago`;
};

/**
 * MarketNewsSection's tabs: "All news", and "Stocks in news" — the stories
 * that name a listed stock or index.
 */
export type MarketNewsTab = 'all' | 'stocks';

export const MARKET_NEWS_TABS: readonly [MarketNewsTab, string][] = [['all', 'All news'], ['stocks', 'Stocks in news']];

export const marketNewsForTab = (items: readonly MarketNewsItem[] | null, tab: MarketNewsTab): MarketNewsItem[] =>
  (items ?? []).filter((it) => tab === 'all' || it.tags.length > 0);

/* ── Daily News Updates (CMS) ─────────────────────────────────────────── */

export type { NewsArticle, NewsPage, NewsQuery };

/** GET /cms/news — published, newest first, without bodies. 12 a page on the web. */
export const fetchNewsPage = (q: NewsQuery = {}): Promise<NewsPage> => cmsApi.news(q);

/** GET /cms/news/categories — the filter chips. */
export const fetchNewsCategories = (): Promise<string[]> => cmsApi.newsCategories();

/** GET /cms/news/:slug — one article with its sanitised HTML body. */
export const fetchNewsArticle = (slug: string): Promise<NewsArticle> => cmsApi.newsArticle(slug);

/* ── Economic calendar ────────────────────────────────────────────────── */

/**
 * GET /instruments/economic-calendar — the Indian schedule and official
 * MoSPI prints (services/indiaCalendar) merged with the global feed, which
 * India-only mode cuts down to what moves Indian markets (high-impact US /
 * China, crude); normalised and cached by the backend. Empty when every feed
 * is down and nothing is cached. EquityHub shows no calendar page; the
 * price chart marks these events (utils/economicCalendar.js).
 */
export const fetchLiveCalendar = async (): Promise<CalendarEvent[]> => {
  const res = await api.get('/instruments/economic-calendar');
  return rows<unknown>(payload(res.data))
    .map(adaptCalendarEvent)
    .filter((e): e is CalendarEvent => e !== null);
};

/** An admin-entered event (types/cms) as a calendar row. Null when undatable. */
export const adminToCalendarEvent = (e: AdminCalendarEvent): CalendarEvent | null => {
  const ts = Date.parse(e.date);
  if (Number.isNaN(ts) || !e.event) return null;
  const date = new Date(ts).toISOString();
  return {
    id: e.id || `adm-${e.date}-${e.event}`,
    date,
    ts,
    country: e.country,
    currency: e.currency,
    impact: e.impact,
    event: e.event,
    period: '',
    unit: e.unit,
    previous: e.previous,
    consensus: e.consensus,
    forecast: e.forecast,
    actual: e.actual,
    // EquityHub stores these figures as text ("175K"); the number is null then.
    previousLabel: fmtEconomicValue(e.previousText ?? e.previous, e.unit),
    consensusLabel: fmtEconomicValue(e.consensusText ?? e.consensus, e.unit),
    forecastLabel: fmtEconomicValue(e.forecastText ?? e.forecast, e.unit),
    actualLabel: fmtEconomicValue(e.actualText ?? e.actual, e.unit),
    isAdmin: true,
  };
};

const DAY_MS = 86_400_000;

/**
 * The calendar's order, anchored on today (UTC): today and the future first,
 * soonest first; then the past, newest first — economicCalendar.js.
 */
export const sortAroundToday = (events: readonly CalendarEvent[], nowMs: number): CalendarEvent[] => {
  const today = new Date(nowMs);
  today.setUTCHours(0, 0, 0, 0);
  const startMs = today.getTime();
  return [...events].sort((a, b) => {
    const aPast = a.ts < startMs;
    const bPast = b.ts < startMs;
    if (aPast !== bPast) return aPast ? 1 : -1;
    return aPast ? b.ts - a.ts : a.ts - b.ts;
  });
};

export interface CalendarWindow {
  lookbackDays: number;
  lookaheadDays: number;
  max: number;
}

/** economicCalendar.js `windowize`: the window, sorted, capped. */
export const windowCalendar = (
  events: readonly CalendarEvent[],
  nowMs: number,
  w: CalendarWindow,
): CalendarEvent[] => {
  const start = nowMs - w.lookbackDays * DAY_MS;
  const end = nowMs + w.lookaheadDays * DAY_MS;
  return sortAroundToday(events.filter((e) => e.ts >= start && e.ts <= end), nowMs).slice(0, w.max);
};

/**
 * EconomicCalendar.jsx `_mergeEvents`: the admin's events join the live
 * window UNWINDOWED — an admin row is shown whatever its date — re-sorted
 * and capped. With no admin events the live list is returned as it was.
 */
export const mergeAdminEvents = (
  live: readonly CalendarEvent[],
  admin: readonly AdminCalendarEvent[],
  nowMs: number,
  max: number,
): CalendarEvent[] => {
  const extra = admin.map(adminToCalendarEvent).filter((e): e is CalendarEvent => e !== null);
  if (!extra.length) return [...live];
  return sortAroundToday([...live, ...extra], nowMs).slice(0, max);
};

/** The full calendar (EconomicCalendarSection): 3 days back, 14 ahead. */
export const calendarSectionEvents = (
  live: readonly CalendarEvent[],
  admin: readonly AdminCalendarEvent[],
  nowMs: number,
  max = 40,
): CalendarEvent[] =>
  mergeAdminEvents(windowCalendar(live, nowMs, { lookbackDays: 3, lookaheadDays: 14, max }), admin, nowMs, max);

/** The sidebar card (EconomicCalendarCard): the next `max` events, nothing past. */
export const calendarUpcomingEvents = (
  live: readonly CalendarEvent[],
  admin: readonly AdminCalendarEvent[],
  nowMs: number,
  max = 4,
): CalendarEvent[] => {
  // getUpcomingEvents(now, max * 3): a 30-day window, strictly future.
  const upcoming = windowCalendar(live, nowMs, { lookbackDays: 0, lookaheadDays: 30, max: max * 12 })
    .filter((e) => e.ts > nowMs)
    .slice(0, max * 3);
  return mergeAdminEvents(upcoming, admin, nowMs, max * 5)
    .filter((e) => e.ts >= nowMs)
    .slice(0, max);
};

/** Rows grouped under their UTC day (YYYY-MM-DD), order kept — the section's day headers. */
export const groupCalendarByDay = (
  events: readonly CalendarEvent[],
): { day: string; events: CalendarEvent[] }[] => {
  const map = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const key = e.date.slice(0, 10);
    const list = map.get(key);
    if (list) list.push(e);
    else map.set(key, [e]);
  }
  return [...map.entries()].map(([day, list]) => ({ day, events: list }));
};

/**
 * How the Actual print reads against consensus — EconomicCalendar.jsx
 * `actualColor`, without the colours: jobless claims and unemployment are
 * better LOWER. Null when either figure is missing (the web's neutral ink).
 */
export const actualTone = (e: Pick<CalendarEvent, 'actual' | 'consensus' | 'event'>): 'beat' | 'miss' | null => {
  if (e.actual === null || e.consensus === null) return null;
  const lowerBetter = /Claims|Unemployment Rate/i.test(e.event);
  const beat = lowerBetter ? e.actual < e.consensus : e.actual > e.consensus;
  return beat ? 'beat' : 'miss';
};

/* ── Calendar state ───────────────────────────────────────────────────── */

/** The web's client-side TTL on the live feed. */
export const LIVE_CALENDAR_TTL_MS = 30 * 60_000;

interface CalendarState {
  live: CalendarEvent[];
  liveAt: number;
  liveLoaded: boolean;
  /** The admin's switch; false hides the calendar everywhere. */
  enabled: boolean;
  adminEvents: AdminCalendarEvent[];
  configLoaded: boolean;
}

export const useCalendarStore = create<CalendarState>(() => ({
  live: [],
  liveAt: 0,
  liveLoaded: false,
  enabled: true,
  adminEvents: [],
  configLoaded: false,
}));

let liveInflight: Promise<void> | null = null;

/**
 * Load the live feed unless it is fresh. Only a NON-EMPTY answer replaces
 * what is held — a feed hiccup must not blank a calendar that had rows.
 */
export const loadLiveCalendar = ({ force = false } = {}): Promise<void> => {
  const s = useCalendarStore.getState();
  if (!force && s.live.length && Date.now() - s.liveAt < LIVE_CALENDAR_TTL_MS) return Promise.resolve();
  if (liveInflight) return liveInflight;
  liveInflight = fetchLiveCalendar()
    .then((events) => {
      if (events.length) useCalendarStore.setState({ live: events, liveAt: Date.now() });
    })
    .catch(() => { /* keep what we had */ })
    .finally(() => {
      useCalendarStore.setState({ liveLoaded: true });
      liveInflight = null;
    });
  return liveInflight;
};

let configInflight: Promise<void> | null = null;

/** The admin config. A failure keeps the defaults: shown, no admin events. */
export const loadCalendarConfig = (): Promise<void> => {
  if (configInflight) return configInflight;
  configInflight = cmsApi.economicCalendar()
    .then((cfg) => { useCalendarStore.setState({ enabled: cfg.enabled, adminEvents: cfg.events }); })
    .catch(() => { /* keep defaults */ })
    .finally(() => {
      useCalendarStore.setState({ configLoaded: true });
      configInflight = null;
    });
  return configInflight;
};
