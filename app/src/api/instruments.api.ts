import { useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AxiosError } from 'axios';
import { create } from 'zustand';

import { api } from '@/api/client';
import { bool, id, num, one, rows, str, strOrNull } from '@/types/api';
import { decOrNull, isoOrNull } from '@/types/market';
import type { Instrument } from '@/types/trading';
import { subscribeForeground, subscribeRecommendedRefresh } from '@/websocket/channels';

/**
 * The instrument catalogue: list, search, detail, the admin's "Recommended"
 * strip and the trader's recently-viewed symbols.
 *
 * Ported from hooks/useInstruments.js, hooks/useRecommendedMarkets.js and
 * hooks/useRecentlyViewed.js, and from the call sites in SearchModal,
 * Watchlist, StockDetail and Trade. Endpoints: backend/src/routes/instrument.js.
 *
 * Options are NOT in the catalogue. The server excludes segment=OPT unless
 * asked (thousands of contracts would flood every list); they are reached
 * through the option chain (market.api) or an option-like search.
 */

type Raw = Record<string, unknown>;

const asRaw = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {});

/** `res.data.data`, tolerating a bare body. */
const payload = (body: unknown): unknown => {
  const env = asRaw(body);
  return 'data' in env ? env.data : body;
};

/* ── Adapter ──────────────────────────────────────────────────────────── */

const numList = (v: unknown): number[] =>
  (Array.isArray(v) ? v : []).map((x) => num(x)).filter((x): x is number => x !== null);

/**
 * One row from /instruments, /instruments/watchlist, /instruments/search or
 * /instruments/:symbol. They carry different subsets — the watchlist row
 * trims the catalogue's config, search selects a dozen fields — so every
 * field is optional and absent reads as null, never as a zero.
 */
export const adaptInstrument = (rawIn: unknown): Instrument => {
  const r = asRaw(rawIn);
  const symbol = str(r.symbol).toUpperCase();
  const lev = asRaw(r.leverageOverride);
  const fv = asRaw(r.fixedVolume);
  const hours = asRaw(r.tradingHours);
  const optionType = str(r.optionType).toUpperCase();
  const spreadType = strOrNull(r.spreadType);
  const fvSource = strOrNull(fv.source);
  return {
    id: id(r),
    symbol,
    name: str(r.name) || symbol,
    category: str(r.category).toUpperCase(),
    exchange: strOrNull(r.exchange),
    segment: strOrNull(r.segment),
    lastPrice: decOrNull(r.lastPrice),
    bid: decOrNull(r.bid),
    ask: decOrNull(r.ask),
    change24h: num(r.change24h),
    // The model's default; a search row omits it.
    pricePrecision: num(r.pricePrecision) ?? 2,
    lotSize: num(r.lotSize),
    // MCX: the unit one lot is quoted in ("1 lot = 100 bbl") — OrderForm's Volume label.
    contractUnit: strOrNull(r.contractUnit),
    // Per-account-tier spread overrides; the order form prices from these first.
    accountSpreads: Array.isArray(r.accountSpreads)
      ? (r.accountSpreads as unknown[]).map((o) => {
        const x = asRaw(o);
        return { accountType: str(x.accountType).toUpperCase(), spreadValue: decOrNull(x.spreadValue), spreadType: strOrNull(x.spreadType) };
      })
      : [],
    minOrderSize: decOrNull(r.minOrderSize),
    quoteCurrency: strOrNull(r.quoteCurrency),
    logoUrl: strOrNull(r.logoUrl),
    underlying: strOrNull(r.underlying),
    expiryDate: isoOrNull(r.expiryDate),
    strike: decOrNull(r.strike),
    optionType: optionType === 'CE' || optionType === 'PE' ? optionType : null,
    baseCurrency: strOrNull(r.baseCurrency),
    spread: decOrNull(r.spread),
    spreadType,
    spreadValue: decOrNull(r.spreadValue),
    dayHigh: decOrNull(r.dayHigh),
    dayLow: decOrNull(r.dayLow),
    volume24h: decOrNull(r.volume24h),
    tickSize: decOrNull(r.tickSize),
    quantityPrecision: num(r.quantityPrecision),
    maxOrderSize: decOrNull(r.maxOrderSize),
    maxLeverage: num(r.maxLeverage),
    effectiveLeverage: num(r.effectiveLeverage),
    leverageOverride: r.leverageOverride && typeof r.leverageOverride === 'object'
      ? {
        leverage: num(lev.leverage) ?? 0,
        normalLeverage: num(lev.normalLeverage) ?? 0,
        startAt: isoOrNull(lev.startAt),
        endAt: isoOrNull(lev.endAt),
        reason: strOrNull(lev.reason),
      }
      : null,
    fixedVolume: r.fixedVolume && typeof r.fixedVolume === 'object'
      ? {
        enabled: bool(fv.enabled),
        value: decOrNull(fv.value),
        source: fvSource,
        endAt: isoOrNull(fv.endAt),
        reason: strOrNull(fv.reason),
      }
      : null,
    leverageLadder: numList(r.leverageLadder),
    upperCircuit: decOrNull(r.upperCircuit),
    lowerCircuit: decOrNull(r.lowerCircuit),
    freezeQty: decOrNull(r.freezeQty),
    commissionType: strOrNull(r.commissionType),
    commissionPercent: decOrNull(r.commissionPercent),
    commissionPerTrade: decOrNull(r.commissionPerTrade),
    // Absent means the server did not say — the list is active-only anyway.
    isActive: r.isActive !== false,
    tradingEnabled: r.tradingEnabled !== false,
    tradingHours: r.tradingHours && typeof r.tradingHours === 'object'
      ? { start: str(hours.start, '00:00'), end: str(hours.end, '23:59'), days: numList(hours.days) }
      : null,
    dailyVolumeLimitEnabled: bool(r.dailyVolumeLimitEnabled),
    dailyBuyLimit: num(r.dailyBuyLimit),
    dailySellLimit: num(r.dailySellLimit),
    dailyBuyUsed: num(r.dailyBuyUsed),
    dailySellUsed: num(r.dailySellUsed),
    lifetimeVolumeLimitEnabled: bool(r.lifetimeVolumeLimitEnabled),
    lifetimeBuyLimit: num(r.lifetimeBuyLimit),
    lifetimeSellLimit: num(r.lifetimeSellLimit),
    lastPriceUpdatedAt: isoOrNull(r.lastPriceUpdatedAt),
    instrumentToken: strOrNull(r.instrumentToken),
    isin: strOrNull(r.isin),
    raw: r,
  };
};

const adaptList = (body: unknown): Instrument[] =>
  rows<unknown>(payload(body)).map(adaptInstrument).filter((i) => i.symbol !== '');

/* ── Endpoints ────────────────────────────────────────────────────────── */

export interface InstrumentListQuery {
  category?: string;
  /** e.g. 'OPT' — the only way options come back from the list. */
  segment?: string;
  includeOptions?: boolean;
}

const listParams = (q: InstrumentListQuery): Record<string, string> => {
  const p: Record<string, string> = {};
  if (q.category) p.category = q.category;
  if (q.segment) p.segment = q.segment;
  if (q.includeOptions) p.includeOptions = 'true';
  return p;
};

/** GET /instruments — the full catalogue row (leverage, lot, logo, caps…). */
export const fetchInstruments = async (q: InstrumentListQuery = {}): Promise<Instrument[]> => {
  const res = await api.get('/instruments', { params: listParams(q) });
  return adaptList(res.data);
};

/**
 * GET /instruments/watchlist — the live-ish enrichment: bid/ask from the
 * spread rule, today's high/low, 24h change and volume. Not the user's
 * watchlists; that is watchlist.api.
 */
export const fetchMarketWatch = async (q: InstrumentListQuery = {}): Promise<Instrument[]> => {
  const res = await api.get('/instruments/watchlist', { params: listParams(q) });
  return adaptList(res.data);
};

/**
 * Catalogue rows with the enrichment laid over them, by symbol — verbatim
 * from useInstruments.js:32-49. The catalogue row is the base (it has the
 * config the enrichment trims); the enrichment wins for the derived fields,
 * including when it says null, because null there means "no data" and the
 * catalogue has nothing better.
 */
export const mergeCatalogWithMarketWatch = (
  catalog: readonly Instrument[],
  watch: readonly Instrument[],
): Instrument[] => {
  const bySymbol = new Map(watch.map((w) => [w.symbol, w]));
  return catalog.map((r) => {
    const wl = bySymbol.get(r.symbol);
    if (!wl) return r;
    return {
      ...r,
      lastPrice: wl.lastPrice ?? r.lastPrice ?? null,
      bid: wl.bid ?? null,
      ask: wl.ask ?? null,
      spread: wl.spread ?? null,
      dayHigh: wl.dayHigh ?? null,
      dayLow: wl.dayLow ?? null,
      change24h: wl.change24h ?? null,
      volume24h: wl.volume24h ?? r.volume24h ?? null,
    };
  });
};

/** GET /instruments/:symbol — the full document, for Trade and StockDetail. */
export const fetchInstrument = async (symbol: string): Promise<Instrument | null> => {
  const res = await api.get(`/instruments/${encodeURIComponent(symbol.toUpperCase())}`);
  const row = one<Raw>(payload(res.data));
  return row && str(row.symbol) ? adaptInstrument(row) : null;
};

/**
 * GET /instruments/search?q= — stocks, indices and futures within the
 * admin's market-segment switches; options only when the query is option-
 * like (a digit, or ending CE/PE), so a normal search is not drowned in
 * contracts. An empty query answers [] without a request, as the server
 * would.
 */
export const searchInstruments = async (
  q: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<Instrument[]> => {
  const term = q.trim();
  if (!term) return [];
  const params: Record<string, string | number> = { q: term };
  if (opts.limit) params.limit = opts.limit;
  const res = await api.get('/instruments/search', { params, signal: opts.signal });
  return adaptList(res.data);
};

/**
 * A strike number or CE/PE in the query — the only searches that should
 * surface option contracts (SearchModal.jsx, Watchlist.jsx), so a normal
 * search is not flooded with them.
 */
export const isOptionLikeQuery = (q: string): boolean => {
  const t = q.trim();
  return !!t && (/\d{3,}/.test(t) || /(^|[^a-z])(ce|pe)([^a-z]|$)/i.test(t));
};

/**
 * The option contracts for an option-like query, from the server search —
 * they are not in the cached catalogue. [] (and no request) otherwise.
 */
export const searchOptionContracts = async (
  q: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Instrument[]> => {
  if (!isOptionLikeQuery(q)) return [];
  const rows = await searchInstruments(q, opts);
  return rows.filter((r) => r.segment === 'OPT');
};

/* ── Search-sheet catalogue filtering (SearchModal.jsx) ───────────────── */

type SegRow = Pick<Instrument, 'category' | 'exchange' | 'segment'>;

const segOf = (r: Pick<Instrument, 'segment'>): string => String(r.segment ?? '').toUpperCase();
const isDerivativeRow = (r: Pick<Instrument, 'segment'>): boolean => segOf(r) === 'FUT' || segOf(r) === 'OPT';
const catOf = (r: Pick<Instrument, 'category'>): string => String(r.category ?? '').toUpperCase();

export interface SearchCategory {
  key: string;
  label: string;
  /** Absent for All (everything matches). */
  match?: (r: SegRow) => boolean;
}

/**
 * The search tabs — Indian market segments, in the web's order and wording.
 * Indices / Stocks are spot only (index tiles, NSE/BSE cash equities); every
 * future (NFO/BFO/MCX) sits under Futures, and MCX contracts also show under
 * Commodities — so a crude-oil future is reachable from either tab.
 * RECOMMENDED sits after All when configured.
 */
export const SEARCH_CATEGORIES: readonly SearchCategory[] = [
  { key: 'ALL', label: 'All' },
  { key: 'INDEX', label: 'Indices', match: (r) => catOf(r) === 'INDEX' && !isDerivativeRow(r) },
  { key: 'STOCK', label: 'Stocks', match: (r) => catOf(r) === 'STOCK' && !isDerivativeRow(r) },
  { key: 'FUT', label: 'Futures', match: (r) => segOf(r) === 'FUT' },
  { key: 'COMMODITY', label: 'Commodities', match: (r) => String(r.exchange ?? '').toUpperCase() === 'MCX' || catOf(r) === 'COMMODITY' },
];

const CATEGORY_BY_KEY = new Map(SEARCH_CATEGORIES.map((c) => [c.key, c]));

/** Does a row belong on a tab? Segments overlap (an MCX future is Futures AND Commodities). */
export const inSearchCategory = (r: SegRow, category: string): boolean => {
  const match = CATEGORY_BY_KEY.get(category)?.match;
  return !match || match(r);
};

/**
 * The search sheet's list. RECOMMENDED keeps the admin's order (alphabetised
 * only on request); every other tab is alphabetical by name. The query
 * matches symbol or name, case-insensitively.
 */
export const filterCatalog = (
  catalog: readonly Instrument[],
  opts: { category: string; query?: string; recommended?: readonly string[]; sortAlpha?: boolean },
): Instrument[] => {
  const byName = (a: Instrument, b: Instrument) =>
    (a.name || a.symbol).localeCompare(b.name || b.symbol, undefined, { sensitivity: 'base' });
  let base: Instrument[];
  if (opts.category === 'RECOMMENDED') {
    const bySym = new Map(catalog.map((r) => [r.symbol, r]));
    base = (opts.recommended ?? []).map((s) => bySym.get(s)).filter((r): r is Instrument => !!r);
    if (opts.sortAlpha) base = [...base].sort(byName);
  } else {
    base = catalog.filter((r) => inSearchCategory(r, opts.category)).sort(byName);
  }
  const q = (opts.query ?? '').trim().toUpperCase();
  if (!q) return base;
  return base.filter((r) => r.symbol.toUpperCase().includes(q) || (r.name || '').toUpperCase().includes(q));
};

/**
 * Per-tab counts for the pill badges (a tab shows only when > 0). Segments
 * overlap, so the counts can add up to more than All. RECOMMENDED counts
 * only symbols the catalogue has.
 */
export const catalogCounts = (
  catalog: readonly Instrument[],
  recommended: readonly string[] = [],
): Record<string, number> => {
  const out: Record<string, number> = { ALL: catalog.length };
  for (const c of SEARCH_CATEGORIES) {
    if (c.match) out[c.key] = catalog.filter(c.match).length;
  }
  const have = new Set(catalog.map((r) => r.symbol));
  out.RECOMMENDED = recommended.filter((s) => have.has(s)).length;
  return out;
};

/**
 * GET /instruments/recommended — the admin-curated symbols, in order. The
 * rows are either bare symbols or `{ symbol }` objects (useRecommendedMarkets
 * accepts both, so this does too).
 */
export const fetchRecommended = async (): Promise<string[]> => {
  const res = await api.get('/instruments/recommended');
  return rows<unknown>(payload(res.data))
    .map((r) => (typeof r === 'string' ? r : str(asRaw(r).symbol)))
    .filter(Boolean);
};

/* ── Shared catalogue store ───────────────────────────────────────────── */

/**
 * One catalogue for the whole app, as useInstruments.js keeps one module
 * cache for Explore, MarketList, the strip and search. Rows render from the
 * cache instantly and revalidate in the background once older than the TTL,
 * so an admin's new logo or symbol shows without a restart.
 */
export const INSTRUMENTS_TTL_MS = 30_000;

interface InstrumentsState {
  rows: Instrument[];
  loaded: boolean;
  loadedAt: number;
  error: string | null;
}

export const useInstrumentStore = create<InstrumentsState>(() => ({
  rows: [],
  loaded: false,
  loadedAt: 0,
  error: null,
}));

let catalogInflight: Promise<Instrument[]> | null = null;

/** The server's words, else the web's fallback wording. */
const loadError = (err: unknown): string =>
  (err as AxiosError<{ error?: { message?: string } }> | undefined)?.response?.data?.error?.message
  || 'Failed to load instruments';

/**
 * Fetch the catalogue AND the enrichment in parallel and merge. A failed
 * enrichment degrades to the bare catalogue, as the web's `.catch` does; a
 * failed catalogue is an error.
 *
 * `catalogOnly` (useInstruments.js `loadInstruments({ catalogOnly: true })`):
 * a caller that needs only symbol + name — the bell's alert form — is
 * answered from whatever is held, fresh or not, and otherwise by the plain
 * catalogue, skipping /instruments/watchlist, the slowest endpoint the API
 * has. The bare rows are not stored, so the next enriched caller still
 * fetches the enrichment.
 */
export const loadInstruments = ({ force = false, catalogOnly = false } = {}): Promise<Instrument[]> => {
  const s = useInstrumentStore.getState();
  if (catalogOnly && !force) {
    if (s.loaded) return Promise.resolve(s.rows);
    if (catalogInflight) return catalogInflight;
    return fetchInstruments();
  }
  if (s.loaded && !force && Date.now() - s.loadedAt < INSTRUMENTS_TTL_MS) {
    return Promise.resolve(s.rows);
  }
  if (catalogInflight) return catalogInflight;
  // A retry after a failed first load is loading again, not still failed.
  if (!s.loaded && s.error) useInstrumentStore.setState({ error: null });
  catalogInflight = (async () => {
    try {
      const [catalog, watch] = await Promise.all([
        fetchInstruments(),
        fetchMarketWatch().catch(() => [] as Instrument[]),
      ]);
      const merged = mergeCatalogWithMarketWatch(catalog, watch);
      useInstrumentStore.setState({ rows: merged, loaded: true, loadedAt: Date.now(), error: null });
      return merged;
    } catch (err) {
      // Keep whatever rows we had: a failed revalidation must not blank a
      // list the trader is looking at.
      useInstrumentStore.setState({ error: loadError(err) });
      throw err;
    } finally {
      catalogInflight = null;
    }
  })();
  return catalogInflight;
};

/**
 * Force a background revalidation — for a view that must show the latest
 * admin edits promptly, such as the search sheet opening. Cached rows keep
 * showing meanwhile. Never rejects.
 */
export const refreshInstruments = (): Promise<void> =>
  loadInstruments({ force: true }).then(() => undefined, () => undefined);

/** The cached row for a symbol, if the catalogue has loaded. */
export const findInstrument = (symbol: string): Instrument | undefined => {
  const sym = symbol.toUpperCase();
  return useInstrumentStore.getState().rows.find((r) => r.symbol === sym);
};

/**
 * `{ rows, loading, error }` for the merged catalogue, ported from
 * useInstruments(). Loading is true only while there is nothing to show.
 */
export function useInstruments(): { rows: Instrument[]; loading: boolean; error: string | null } {
  const catalog = useInstrumentStore((s) => s.rows);
  const loaded = useInstrumentStore((s) => s.loaded);
  const error = useInstrumentStore((s) => s.error);

  useEffect(() => {
    // Fresh cache: nothing. Stale: revalidate in the background. None: load.
    loadInstruments().catch(() => { /* surfaced through `error` */ });
  }, []);

  return { rows: catalog, loading: !loaded && error === null, error: loaded ? null : error };
}

/* ── Recommended ──────────────────────────────────────────────────────── */

/**
 * Near-real-time: the admin's add/remove/reorder publishes
 * `recommended:refresh`; a 60s poll and coming back to the foreground are
 * the safety net for a missed frame, as in useRecommendedMarkets.js.
 */
export const RECOMMENDED_TTL_MS = 60_000;

interface RecommendedState {
  symbols: string[];
  loaded: boolean;
  fetchedAt: number;
}

export const useRecommendedStore = create<RecommendedState>(() => ({
  symbols: [],
  loaded: false,
  fetchedAt: 0,
}));

let recommendedInflight: Promise<string[]> | null = null;

export const loadRecommended = (): Promise<string[]> => {
  if (recommendedInflight) return recommendedInflight;
  recommendedInflight = fetchRecommended()
    .then((symbols) => {
      useRecommendedStore.setState({ symbols, loaded: true, fetchedAt: Date.now() });
      return symbols;
    })
    .catch((err: unknown) => {
      // Loaded-with-nothing rather than a spinner forever; the strip hides.
      useRecommendedStore.setState({ loaded: true });
      throw err;
    })
    .finally(() => { recommendedInflight = null; });
  return recommendedInflight;
};

/*
 * The web starts a poll, a focus listener and a socket subscription in EVERY
 * mounted consumer — the strip and the selector together poll twice. Here the
 * first consumer starts them and the last one stops them.
 */
let recommendedUsers = 0;
let recommendedStop: (() => void) | null = null;

const startRecommendedLive = (): void => {
  const refetch = () => { loadRecommended().catch(() => { /* keep last list */ }); };
  const poll = setInterval(refetch, RECOMMENDED_TTL_MS);
  const offWs = subscribeRecommendedRefresh(refetch);
  const offFg = subscribeForeground(refetch);
  recommendedStop = () => { clearInterval(poll); offWs(); offFg(); };
};

export function useRecommendedMarkets(): { symbols: string[]; loading: boolean } {
  const symbols = useRecommendedStore((s) => s.symbols);
  const loaded = useRecommendedStore((s) => s.loaded);

  useEffect(() => {
    const s = useRecommendedStore.getState();
    if (!s.loaded || Date.now() - s.fetchedAt >= RECOMMENDED_TTL_MS) {
      loadRecommended().catch(() => { /* hidden strip, not an error screen */ });
    }
    recommendedUsers += 1;
    if (recommendedUsers === 1) startRecommendedLive();
    return () => {
      recommendedUsers -= 1;
      if (recommendedUsers === 0 && recommendedStop) {
        recommendedStop();
        recommendedStop = null;
      }
    };
  }, []);

  return { symbols, loading: !loaded };
}

/* ── Recently viewed ──────────────────────────────────────────────────── */

/**
 * Device-local, like the web's localStorage list — this was never
 * server-side. Same key, so the meaning is unambiguous if it is ever
 * migrated. A symbol list is not a secret, so AsyncStorage is right here;
 * tokens are what go in the keychain.
 */
export const RECENTLY_VIEWED_KEY = 'tradepro:recently-viewed';
export const RECENTLY_VIEWED_MAX = 5;

/** Promote to the front, de-duplicate, cap. Pure; exported for tests. */
export const pushRecent = (
  list: readonly string[],
  symbol: string,
  max = RECENTLY_VIEWED_MAX,
): string[] => {
  if (!symbol) return [...list];
  if (list[0] === symbol) return [...list];
  return [symbol, ...list.filter((s) => s !== symbol)].slice(0, max);
};

interface RecentState {
  items: string[];
  hydrated: boolean;
}

export const useRecentlyViewedStore = create<RecentState>(() => ({ items: [], hydrated: false }));

let recentHydration: Promise<void> | null = null;

const hydrateRecent = (): Promise<void> => {
  if (recentHydration) return recentHydration;
  recentHydration = (async () => {
    let stored: string[] = [];
    try {
      const raw = await AsyncStorage.getItem(RECENTLY_VIEWED_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      stored = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      stored = [];
    }
    // Anything recorded before hydration finished stays in front.
    const current = useRecentlyViewedStore.getState().items;
    const merged = current.reduceRight((acc, sym) => pushRecent(acc, sym), stored);
    useRecentlyViewedStore.setState({ items: merged, hydrated: true });
  })();
  return recentHydration;
};

/** Record a symbol as viewed. Safe to call on every render. */
export const recordRecentlyViewed = (symbol: string): void => {
  if (!symbol) return;
  const sym = symbol.toUpperCase();
  const { items } = useRecentlyViewedStore.getState();
  if (items[0] === sym) return;
  const next = pushRecent(items, sym);
  useRecentlyViewedStore.setState({ items: next });
  hydrateRecent()
    .then(() => AsyncStorage.setItem(
      RECENTLY_VIEWED_KEY,
      JSON.stringify(useRecentlyViewedStore.getState().items),
    ))
    .catch(() => { /* storage full or unavailable — the in-memory list holds */ });
};

export function useRecentlyViewed(): string[] {
  const items = useRecentlyViewedStore((s) => s.items);
  useEffect(() => { hydrateRecent().catch(() => { /* empty list */ }); }, []);
  return items;
}
