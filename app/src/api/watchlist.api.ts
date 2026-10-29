import { useCallback, useEffect, useMemo } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

import { api, errorMessage } from '@/api/client';
import { toast } from '@/components/ui/toast';
import { str } from '@/types/api';
import { adaptWatchlist, adaptWatchlistItem, type Watchlist, type WatchlistItem } from '@/types/market';

/**
 * The trader's watchlists — server-backed, shared by Watchlist, MarketWatch,
 * Trade and every ★ in the app. Ported from hooks/useWatchlists.js and the
 * useFavorites.js shim; endpoints: backend/src/routes/watchlist.js.
 *
 * Kept from the web, because each is a behaviour a trader sees:
 *   • ONE store for every consumer, so a ★ on Explore lights on Trade.
 *   • Optimistic edits with a rollback to the pre-edit snapshot and a toast
 *     when the server refuses.
 *   • The ★ ALWAYS targets the Favorites (default) list, never whichever
 *     list happens to be open — "per product spec" in the web.
 *   • The server's answer replaces the local copy after every item edit: it
 *     returns the whole list in its canonical order (pinned first).
 *
 * Not kept: the web's first-load migration seeds Favorites from a legacy
 * `localStorage` list. A phone has no such list; the part that matters — a
 * brand-new user lands on a Favorites list rather than nothing — is kept.
 */

type Raw = Record<string, unknown>;

const asRaw = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {});

const payload = (body: unknown): unknown => {
  const env = asRaw(body);
  return 'data' in env ? env.data : body;
};

const seg = (s: string): string => encodeURIComponent(s);

/* ── Endpoints ────────────────────────────────────────────────────────── */

export interface WatchlistsResponse {
  watchlists: Watchlist[];
  /** The list the trader had open last, on any device. */
  lastSelectedWatchlistId: string | null;
}

/** GET /watchlists — lists by sortOrder, items pinned-first. */
export const fetchWatchlists = async (): Promise<WatchlistsResponse> => {
  const res = await api.get('/watchlists');
  const body = payload(res.data);
  // `{ watchlists, lastSelectedWatchlistId }`; a bare array is tolerated.
  const env = asRaw(body);
  const list = Array.isArray(body) ? body : Array.isArray(env.watchlists) ? env.watchlists : [];
  return {
    watchlists: (list as unknown[]).map(adaptWatchlist).filter((w) => w.id !== ''),
    lastSelectedWatchlistId: str(env.lastSelectedWatchlistId) || null,
  };
};

export interface WatchlistFields {
  /** 1–40 characters, unique per user case-insensitively (409 DUPLICATE). */
  name: string;
  /** Up to 8 characters server-side — one emoji, in practice. */
  emoji?: string;
  color?: string;
}

/** POST /watchlists. */
export const createWatchlist = async (
  fields: WatchlistFields & { isDefault?: boolean },
): Promise<Watchlist> => {
  const res = await api.post('/watchlists', {
    name: fields.name,
    emoji: fields.emoji ?? '',
    color: fields.color ?? '',
    ...(fields.isDefault ? { isDefault: true } : {}),
  });
  return adaptWatchlist(payload(res.data));
};

/** PATCH /watchlists/:id — only the keys given are changed. */
export const updateWatchlist = async (id: string, fields: Partial<WatchlistFields>): Promise<Watchlist> => {
  const body: Record<string, string> = {};
  if (fields.name !== undefined) body.name = fields.name;
  if (fields.emoji !== undefined) body.emoji = fields.emoji;
  if (fields.color !== undefined) body.color = fields.color;
  const res = await api.patch(`/watchlists/${seg(id)}`, body);
  return adaptWatchlist(payload(res.data));
};

/** DELETE /watchlists/:id — refused for the last list (400 LAST_WATCHLIST). */
export const deleteWatchlist = async (id: string): Promise<void> => {
  await api.delete(`/watchlists/${seg(id)}`);
};

/** POST /watchlists/:id/duplicate — "<name> copy", never the default. */
export const duplicateWatchlist = async (id: string): Promise<Watchlist> => {
  const res = await api.post(`/watchlists/${seg(id)}/duplicate`);
  return adaptWatchlist(payload(res.data));
};

/** POST /watchlists/reorder — every id must be the caller's. */
export const reorderWatchlists = async (orderedIds: readonly string[]): Promise<void> => {
  await api.post('/watchlists/reorder', { orderedIds });
};

/** PATCH /watchlists/last-selected — "remember which list is open". */
export const setLastSelectedWatchlist = async (watchlistId: string | null): Promise<void> => {
  await api.patch('/watchlists/last-selected', { watchlistId });
};

/** GET /watchlists/:id/items — the items alone, in render order. */
export const fetchWatchlistItems = async (id: string): Promise<WatchlistItem[]> => {
  const res = await api.get(`/watchlists/${seg(id)}/items`);
  const body = payload(res.data);
  return (Array.isArray(body) ? body : []).map(adaptWatchlistItem);
};

/**
 * POST /watchlists/:id/items. A symbol already in the list is a no-op, not
 * an error; an unknown or inactive one is 404 UNKNOWN_SYMBOL.
 */
export const addWatchlistItem = async (id: string, symbol: string): Promise<Watchlist> => {
  const res = await api.post(`/watchlists/${seg(id)}/items`, { symbol });
  return adaptWatchlist(payload(res.data));
};

/**
 * POST /watchlists/:id/items/bulk — one validated write. ONE unknown symbol
 * fails the whole batch, so an import should filter against the catalogue
 * first (the web's importWatchlist says the same).
 */
export const bulkAddWatchlistItems = async (id: string, symbols: readonly string[]): Promise<Watchlist> => {
  const res = await api.post(`/watchlists/${seg(id)}/items/bulk`, { symbols });
  return adaptWatchlist(payload(res.data));
};

export const removeWatchlistItem = async (id: string, itemId: string): Promise<Watchlist> => {
  const res = await api.delete(`/watchlists/${seg(id)}/items/${seg(itemId)}`);
  return adaptWatchlist(payload(res.data));
};

export const reorderWatchlistItems = async (id: string, orderedItemIds: readonly string[]): Promise<Watchlist> => {
  const res = await api.post(`/watchlists/${seg(id)}/items/reorder`, { orderedItemIds });
  return adaptWatchlist(payload(res.data));
};

export const pinWatchlistItem = async (id: string, itemId: string, pinned: boolean): Promise<Watchlist> => {
  const res = await api.post(`/watchlists/${seg(id)}/items/${seg(itemId)}/pin`, { pinned });
  return adaptWatchlist(payload(res.data));
};

export interface TransferResult {
  source: Watchlist;
  target: Watchlist;
}

const adaptTransfer = (body: unknown): TransferResult => {
  const r = asRaw(payload(body));
  return { source: adaptWatchlist(r.source), target: adaptWatchlist(r.target) };
};

/** POST …/items/:itemId/move — removed from the source, added to the target. */
export const moveWatchlistItem = async (
  id: string,
  itemId: string,
  targetWatchlistId: string,
): Promise<TransferResult> => {
  const res = await api.post(`/watchlists/${seg(id)}/items/${seg(itemId)}/move`, { targetWatchlistId });
  return adaptTransfer(res.data);
};

/** POST …/items/:itemId/copy — the source keeps it. */
export const copyWatchlistItem = async (
  id: string,
  itemId: string,
  targetWatchlistId: string,
): Promise<TransferResult> => {
  const res = await api.post(`/watchlists/${seg(id)}/items/${seg(itemId)}/copy`, { targetWatchlistId });
  return adaptTransfer(res.data);
};

/* ── Pure helpers (exported for tests) ────────────────────────────────── */

/** The Favorites list: the default one, else the first. */
export const favoritesOf = (lists: readonly Watchlist[]): Watchlist | null =>
  lists.find((w) => w.isDefault) ?? lists[0] ?? null;

/** Replace a list by id, or append it. */
export const upsertWatchlist = (lists: readonly Watchlist[], wl: Watchlist): Watchlist[] => {
  if (!wl.id) return [...lists];
  const at = lists.findIndex((w) => w.id === wl.id);
  if (at === -1) return [...lists, wl];
  const next = [...lists];
  next[at] = wl;
  return next;
};

/** Is `symbol` in ANY list — the "saved" state of an instrument card. */
export const inAnyList = (lists: readonly Watchlist[], symbol: string): boolean =>
  !!symbol && lists.some((w) => w.items.some((it) => it.symbol === symbol));

/**
 * Which list opens: the remembered one while it still exists, else
 * Favorites — useWatchlists.js loadOnce.
 */
export const resolveActiveId = (lists: readonly Watchlist[], lastSelected: string | null): string | null =>
  (lastSelected && lists.some((w) => w.id === lastSelected) ? lastSelected : favoritesOf(lists)?.id ?? null);

/* ── The shared store ─────────────────────────────────────────────────── */

interface WatchlistState {
  watchlists: Watchlist[];
  activeId: string | null;
  lastSelectedWatchlistId: string | null;
  loaded: boolean;
  loading: boolean;
}

const INITIAL: WatchlistState = {
  watchlists: [],
  activeId: null,
  lastSelectedWatchlistId: null,
  loaded: false,
  loading: false,
};

export const useWatchlistStore = create<WatchlistState>(() => ({ ...INITIAL }));

const get = () => useWatchlistStore.getState();
const set = (patch: Partial<WatchlistState>) => useWatchlistStore.setState(patch);
const upsert = (wl: Watchlist) => set({ watchlists: upsertWatchlist(get().watchlists, wl) });

/** Per device, as the web's flag is per browser. Same key, same meaning. */
export const WATCHLIST_MIGRATION_KEY = 'tradepro_watchlist_migration_v1';

let inflight: Promise<WatchlistState> | null = null;
/**
 * Bumped by resetWatchlists. A load that a user switch overtook finishes
 * into nothing: its lists belong to the previous person.
 */
let generation = 0;

/**
 * Load once. The first time a user with NO lists opens the app on this
 * device, a Favorites list is created for them — the web's migration, minus
 * the localStorage symbols a phone never had.
 */
export const loadWatchlists = (): Promise<WatchlistState> => {
  if (get().loaded) return Promise.resolve(get());
  if (inflight) return inflight;
  const gen = generation;
  set({ loading: true });
  inflight = (async () => {
    try {
      const res = await fetchWatchlists();
      if (gen !== generation) return get();
      let lists = res.watchlists;
      let lastSelected = res.lastSelectedWatchlistId;

      if (lists.length === 0) {
        let migrated = false;
        try { migrated = (await AsyncStorage.getItem(WATCHLIST_MIGRATION_KEY)) !== null; } catch { /* treat as not */ }
        if (!migrated) {
          try {
            const fav = await createWatchlist({ name: 'Favorites', emoji: '⭐', isDefault: true });
            lists = [fav];
            lastSelected = fav.id;
          } catch {
            // Non-fatal, as on the web: the trader can create one by hand,
            // and the ★ creates Favorites on demand.
          }
          AsyncStorage.setItem(WATCHLIST_MIGRATION_KEY, '1').catch(() => { /* retried next launch */ });
        }
      }

      if (gen !== generation) return get();
      set({
        watchlists: lists,
        lastSelectedWatchlistId: lastSelected,
        activeId: resolveActiveId(lists, lastSelected),
        loaded: true,
        loading: false,
      });
      return get();
    } catch (err) {
      if (gen === generation) set({ loading: false });
      throw err;
    } finally {
      // After a reset, `inflight` may already be the next user's load.
      if (gen === generation) inflight = null;
    }
  })();
  return inflight;
};

/** Drop everything and load again — the web's `reload()`. */
export const reloadWatchlists = (): Promise<WatchlistState> => {
  set({ loaded: false });
  return loadWatchlists();
};

/** Sign-out: the next user must not see this one's lists. */
export const resetWatchlists = (): void => {
  generation += 1;
  inflight = null;
  useWatchlistStore.setState({ ...INITIAL });
};

/**
 * Apply locally, call the server, and on refusal restore the snapshot taken
 * BEFORE the local change and say why — useWatchlists.js `optimistic`.
 */
async function optimistic<T>(applyLocal: () => void, call: () => Promise<T>, rollbackMsg?: string): Promise<T> {
  const prev = get();
  applyLocal();
  try {
    return await call();
  } catch (err) {
    set({ watchlists: prev.watchlists, activeId: prev.activeId });
    toast.error(rollbackMsg || errorMessage(err));
    throw err;
  }
}

const findList = (id: string): Watchlist | undefined => get().watchlists.find((w) => w.id === id);

/* ── Mutations ────────────────────────────────────────────────────────── */

/** Switch lists, and remember it server-side (best effort, as the web). */
export const setActiveWatchlist = (id: string): void => {
  if (!id || id === get().activeId) return;
  set({ activeId: id });
  setLastSelectedWatchlist(id).catch(() => { /* fire-and-forget */ });
};

/** Create and open a list. A duplicate name (409) is toasted and thrown. */
export const createList = async (fields: WatchlistFields): Promise<Watchlist> => {
  try {
    const wl = await createWatchlist(fields);
    upsert(wl);
    set({ activeId: wl.id });
    setLastSelectedWatchlist(wl.id).catch(() => { /* fire-and-forget */ });
    return wl;
  } catch (err) {
    toast.error(errorMessage(err));
    throw err;
  }
};

export const renameList = (id: string, fields: Partial<WatchlistFields>): Promise<Watchlist> =>
  optimistic(
    () => {
      const wl = findList(id);
      if (!wl) return;
      upsert({
        ...wl,
        ...(fields.name !== undefined ? { name: fields.name } : {}),
        ...(fields.emoji !== undefined ? { emoji: fields.emoji } : {}),
        ...(fields.color !== undefined ? { color: fields.color } : {}),
      });
    },
    async () => {
      const wl = await updateWatchlist(id, fields);
      upsert(wl);
      return wl;
    },
  );

/**
 * Delete a list, opening the first remaining one if it was open. Rolls back
 * on refusal — including the server's "At least one watchlist must exist".
 */
export const deleteList = async (id: string): Promise<void> => {
  const prev = get();
  const remaining = prev.watchlists.filter((w) => w.id !== id);
  const nextActive = prev.activeId === id ? remaining[0]?.id ?? null : prev.activeId;
  set({ watchlists: remaining, activeId: nextActive });
  try {
    await deleteWatchlist(id);
  } catch (err) {
    set({ watchlists: prev.watchlists, activeId: prev.activeId });
    toast.error(errorMessage(err));
    throw err;
  }
};

export const duplicateList = async (id: string): Promise<Watchlist> => {
  const wl = await duplicateWatchlist(id);
  upsert(wl);
  return wl;
};

export const reorderLists = (orderedIds: readonly string[]): Promise<void> =>
  optimistic(
    () => {
      const byId = new Map(get().watchlists.map((w) => [w.id, w]));
      set({ watchlists: orderedIds.map((i) => byId.get(i)).filter((w): w is Watchlist => !!w) });
    },
    () => reorderWatchlists(orderedIds),
    'Could not reorder watchlists',
  );

export const addSymbol = (listId: string, symbol: string): Promise<Watchlist> => {
  const sym = symbol.toUpperCase();
  return optimistic(
    () => {
      const wl = findList(listId);
      if (!wl || wl.items.some((it) => it.symbol === sym)) return;
      const tmp: WatchlistItem = {
        id: `tmp-${sym}`, symbol: sym, type: '', sortOrder: wl.items.length, pinned: false, addedAt: null,
      };
      upsert({ ...wl, items: [...wl.items, tmp], itemCount: wl.items.length + 1 });
    },
    async () => {
      const wl = await addWatchlistItem(listId, sym);
      upsert(wl);
      return wl;
    },
  );
};

export const bulkAddSymbols = async (listId: string, symbols: readonly string[]): Promise<Watchlist> => {
  const wl = await bulkAddWatchlistItems(listId, symbols);
  upsert(wl);
  return wl;
};

/**
 * Create a list and bulk-add its symbols — the web's importWatchlist. Filter
 * the symbols against the catalogue first: one unknown symbol fails the bulk.
 */
export const importWatchlist = async (
  fields: WatchlistFields & { symbols?: readonly string[] },
): Promise<Watchlist> => {
  const list = await createList(fields);
  if (fields.symbols && fields.symbols.length) return bulkAddSymbols(list.id, fields.symbols);
  return list;
};

export const removeSymbol = (listId: string, itemId: string): Promise<Watchlist> =>
  optimistic(
    () => {
      const wl = findList(listId);
      if (!wl) return;
      upsert({
        ...wl,
        items: wl.items.filter((it) => it.id !== itemId),
        itemCount: Math.max(0, wl.items.length - 1),
      });
    },
    async () => {
      const wl = await removeWatchlistItem(listId, itemId);
      upsert(wl);
      return wl;
    },
  );

export const reorderSymbols = (listId: string, orderedItemIds: readonly string[]): Promise<Watchlist> =>
  optimistic(
    () => {
      const wl = findList(listId);
      if (!wl) return;
      const byId = new Map(wl.items.map((it) => [it.id, it]));
      upsert({ ...wl, items: orderedItemIds.map((i) => byId.get(i)).filter((it): it is WatchlistItem => !!it) });
    },
    async () => {
      const wl = await reorderWatchlistItems(listId, orderedItemIds);
      upsert(wl);
      return wl;
    },
    'Could not reorder symbols',
  );

export const pinSymbol = (listId: string, itemId: string, pinned: boolean): Promise<Watchlist> =>
  optimistic(
    () => {
      const wl = findList(listId);
      if (!wl) return;
      upsert({ ...wl, items: wl.items.map((it) => (it.id === itemId ? { ...it, pinned } : it)) });
    },
    async () => {
      const wl = await pinWatchlistItem(listId, itemId, pinned);
      upsert(wl);
      return wl;
    },
  );

export const moveSymbol = async (listId: string, itemId: string, targetId: string): Promise<TransferResult> => {
  const r = await moveWatchlistItem(listId, itemId, targetId);
  upsert(r.source);
  upsert(r.target);
  return r;
};

export const copySymbol = async (listId: string, itemId: string, targetId: string): Promise<TransferResult> => {
  const r = await copyWatchlistItem(listId, itemId, targetId);
  upsert(r.source);
  upsert(r.target);
  return r;
};

/* ── The ★ ────────────────────────────────────────────────────────────── */

/** Is `symbol` in Favorites (not merely in some list)? */
export const isFavorite = (symbol: string): boolean => {
  const fav = favoritesOf(get().watchlists);
  return !!fav && fav.items.some((it) => it.symbol === symbol.toUpperCase());
};

/**
 * Toggle `symbol` in Favorites, creating the list first if the user has
 * none. Toasts "Added to Favorites" / "Removed from Favorites", as the web.
 */
export const toggleFavorite = async (symbol: string): Promise<void> => {
  const sym = symbol.toUpperCase();
  await loadWatchlists().catch(() => undefined);
  let fav = favoritesOf(get().watchlists);
  if (!fav) {
    try {
      fav = await createWatchlist({ name: 'Favorites', emoji: '⭐', isDefault: true });
      upsert(fav);
    } catch (err) {
      toast.error(errorMessage(err));
      return;
    }
  }
  const existing = fav.items.find((it) => it.symbol === sym);
  if (existing) {
    await removeSymbol(fav.id, existing.id);
    toast.success('Removed from Favorites');
  } else {
    await addSymbol(fav.id, sym);
    toast.success('Added to Favorites');
  }
};

/* ── Hooks ────────────────────────────────────────────────────────────── */

/**
 * The shared watchlists plus every mutation — useWatchlists(). The first
 * consumer to mount triggers the load.
 */
export function useWatchlists() {
  const watchlists = useWatchlistStore((s) => s.watchlists);
  const activeId = useWatchlistStore((s) => s.activeId);
  const loaded = useWatchlistStore((s) => s.loaded);
  const loading = useWatchlistStore((s) => s.loading);

  useEffect(() => {
    if (!get().loaded) loadWatchlists().catch(() => { /* the screen shows the empty state */ });
  }, []);

  const favoritesList = useMemo(() => favoritesOf(watchlists), [watchlists]);
  const activeList = useMemo(
    () => watchlists.find((w) => w.id === activeId) ?? null,
    [watchlists, activeId],
  );
  // Recreated when the lists change, so every ★ and bookmark re-renders the
  // moment a symbol is added or removed.
  const has = useCallback(
    (symbol: string) => !!favoritesList && favoritesList.items.some((it) => it.symbol === symbol.toUpperCase()),
    [favoritesList],
  );
  const inAny = useCallback((symbol: string) => inAnyList(watchlists, symbol.toUpperCase()), [watchlists]);

  return {
    watchlists,
    loading,
    loaded,
    activeId,
    activeList,
    favoritesList,
    setActiveId: setActiveWatchlist,
    createList,
    renameList,
    deleteList,
    duplicateList,
    reorderLists,
    importWatchlist,
    addSymbol,
    bulkAddSymbols,
    removeSymbol,
    reorderSymbols,
    pinSymbol,
    moveSymbol,
    copySymbol,
    has,
    toggleFavorite,
    favCount: favoritesList ? favoritesList.items.length : 0,
    inAnyList: inAny,
    reload: reloadWatchlists,
  };
}

/** The retired useFavorites surface, kept for call sites written against it. */
export function useFavorites() {
  const { favoritesList, has, favCount } = useWatchlists();
  const favs = useMemo(() => new Set((favoritesList?.items ?? []).map((it) => it.symbol)), [favoritesList]);
  const add = useCallback((symbol: string) => {
    if (!has(symbol)) void toggleFavorite(symbol).catch(() => undefined);
  }, [has]);
  const remove = useCallback((symbol: string) => {
    const item = favoritesList?.items.find((it) => it.symbol === symbol.toUpperCase());
    if (favoritesList && item) removeSymbol(favoritesList.id, item.id).catch(() => undefined);
  }, [favoritesList]);
  return { favs, toggle: toggleFavorite, add, remove, has, count: favCount };
}
