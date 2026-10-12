import { useEffect, useState } from 'react';
import { api } from '../services/api';

// Module-level cache: instruments rarely change during a session, and we
// have several consumers (Explore, MarketList, InstrumentStrip, SearchModal).
// We fetch the base catalog AND the watchlist enrichment (change24h,
// dayHigh/Low) once, merge by symbol, and share the result.
let _cache = null;
let _cacheAt = 0;      // when _cache was last (re)built — drives revalidation
// Whether _cache carries the /instruments/watchlist enrichment (bid/ask/
// change24h/dayHigh/dayLow) or is the bare catalogue. Callers that only need
// symbol + name can skip that request entirely — it is the slowest endpoint the
// API has, and making a symbol picker wait on it was pure waste.
let _cacheEnriched = false;
let _inflight = null;
let _inflightEnriched = false;
const _listeners = new Set();
// Revalidate the shared catalog after this long so admin-side edits (a new
// logo, a renamed instrument, a newly-added symbol) surface without needing a
// hard page refresh. Cached rows still render instantly; the refresh is background.
const TTL_MS = 30000;

const notify = () => _listeners.forEach((fn) => fn(_cache));

async function _load({ enrich = true } = {}) {
  if (!enrich) {
    const catRes = await api.get('/instruments');
    _cache = catRes.data?.data || [];
    _cacheAt = Date.now();
    _cacheEnriched = false;
    notify();
    return _cache;
  }
  // Pull both in parallel:
  //  • /instruments        — full catalog: baseCurrency, leverage, logoUrl, etc.
  //  • /instruments/watchlist — live enrichment: change24h, dayHigh/Low.
  // The watchlist response trims some catalog fields, so we merge BY
  // symbol with the catalog row as the base so consumers (e.g. Trade)
  // still see everything they need.
  const [catRes, wlRes] = await Promise.all([
    api.get('/instruments'),
    api.get('/instruments/watchlist').catch(() => ({ data: { data: [] } })),
  ]);
  const catalog = catRes.data?.data || [];
  const watch = wlRes.data?.data || [];
  const wlBySymbol = new Map(watch.map((r) => [r.symbol, r]));

  _cache = catalog.map((r) => {
    const wl = wlBySymbol.get(r.symbol);
    if (!wl) return r;
    // Watchlist provides the live-ish derived fields; everything else
    // stays from the catalog row (baseCurrency, leverage, logoUrl, …).
    return {
      ...r,
      lastPrice: wl.lastPrice ?? r.lastPrice,
      bid: wl.bid,
      ask: wl.ask,
      spread: wl.spread,
      dayHigh: wl.dayHigh,
      dayLow: wl.dayLow,
      change24h: wl.change24h,
      volume24h: wl.volume24h ?? r.volume24h,
    };
  });
  _cacheAt = Date.now();
  _cacheEnriched = true;
  notify();
  return _cache;
}

function fetchOnce({ force = false, enrich = true } = {}) {
  const fresh = _cache && (Date.now() - _cacheAt < TTL_MS);
  // A bare-catalogue cache does NOT satisfy a caller that needs enrichment.
  if (fresh && !force && (!enrich || _cacheEnriched)) return Promise.resolve(_cache);
  // Likewise an in-flight bare load cannot be shared with an enriching caller.
  if (_inflight && (_inflightEnriched || !enrich)) return _inflight;
  _inflightEnriched = enrich;
  _inflight = _load({ enrich }).finally(() => { _inflight = null; });
  return _inflight;
}

// Force a background revalidation of the shared catalog. Call this when a view
// opens that must reflect the latest admin edits promptly (e.g. the search
// modal) — cached rows keep showing until the fresh data arrives.
/**
 * Non-hook accessor for the SAME shared catalog the hook serves: resolves from
 * the module cache when it is warm, joins the in-flight request when one is
 * already running, and only then issues a fetch.
 *
 * Several call sites used to hit api.get('/instruments') directly and so
 * bypassed all of that — the Trade page alone pulled the whole catalogue twice
 * on mount (once itself, once via MarketWatch), and that response is the
 * largest the app makes. Async code paths cannot call the hook, which is why
 * they reached for the raw request; this gives them the cached path instead.
 */
export function loadInstruments({ catalogOnly = false } = {}) {
  return fetchOnce({ enrich: !catalogOnly });
}

export function refreshInstruments() {
  return fetchOnce({ force: true }).catch(() => {});
}

/**
 * Returns { rows, loading, error } for the platform's full instrument list,
 * each row merged with the watchlist enrichment so `change24h`,
 * `dayHigh`/`dayLow` are populated where available.
 */
export function useInstruments() {
  const [rows, setRows] = useState(_cache || []);
  const [loading, setLoading] = useState(!_cache);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const onCache = (next) => { if (!cancelled) setRows(next || []); };
    _listeners.add(onCache);

    if (_cache) {
      setRows(_cache);
      setLoading(false);
      // Stale-while-revalidate: render cached rows instantly, but refresh in the
      // background when they're old so admin edits (logos, new instruments…) show.
      if (Date.now() - _cacheAt > TTL_MS) fetchOnce({ force: true }).catch(() => {});
    } else {
      fetchOnce()
        .then((data) => { if (!cancelled) { setRows(data); setLoading(false); } })
        .catch((err) => {
          if (cancelled) return;
          setError(err?.response?.data?.error?.message || 'Failed to load instruments');
          setLoading(false);
        });
    }

    return () => {
      cancelled = true;
      _listeners.delete(onCache);
    };
  }, []);

  return { rows, loading, error };
}
