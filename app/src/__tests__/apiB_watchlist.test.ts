/**
 * The watchlist store: the first-run Favorites list, the ★ always going to
 * Favorites, and an optimistic edit that the server refuses rolling back.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';

import { api } from '@/api/client';
import {
  addSymbol,
  deleteList,
  favoritesOf,
  inAnyList,
  isFavorite,
  loadWatchlists,
  moveSymbol,
  resetWatchlists,
  resolveActiveId,
  toggleFavorite,
  upsertWatchlist,
  useWatchlistStore,
  WATCHLIST_MIGRATION_KEY,
} from '@/api/watchlist.api';
import { toast, toastStore } from '@/components/ui/toast';
import { adaptWatchlist } from '@/types/market';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

type Reply = { status?: number; data: unknown };
let calls: InternalAxiosRequestConfig[] = [];

const serve = (handler: (c: InternalAxiosRequestConfig) => Reply): void => {
  calls = [];
  api.defaults.adapter = async (config) => {
    calls.push(config);
    const r = handler(config);
    const response = { data: r.data, status: r.status ?? 200, statusText: '', headers: {}, config };
    if (response.status >= 400) {
      throw new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, null, response);
    }
    return response;
  };
};

const body = (c: InternalAxiosRequestConfig | undefined): Record<string, unknown> =>
  (typeof c?.data === 'string' ? JSON.parse(c.data) : c?.data) as Record<string, unknown>;

const raw = (id: string, name: string, symbols: string[], isDefault = false) => ({
  _id: id, name, isDefault, items: symbols.map((s, i) => ({ _id: `${id}-${s}`, symbol: s, sortOrder: i })),
});

const lastToast = () => toastStore.getState().toasts[0];

// Toasts arm dismiss timers; clear them so the run can exit.
afterAll(() => toast.dismiss());

beforeEach(async () => {
  resetWatchlists();
  toastStore.setState({ toasts: [] });
  await AsyncStorage.clear();
});

describe('pure helpers', () => {
  const fav = adaptWatchlist(raw('f', 'Favorites', ['BTCUSDT'], true));
  const other = adaptWatchlist(raw('o', 'Tech', ['TCS']));

  it('Favorites is the default list, else the first', () => {
    expect(favoritesOf([other, fav])?.id).toBe('f');
    expect(favoritesOf([other])?.id).toBe('o');
    expect(favoritesOf([])).toBeNull();
  });

  it('the remembered list opens while it exists, else Favorites', () => {
    expect(resolveActiveId([fav, other], 'o')).toBe('o');
    expect(resolveActiveId([fav, other], 'gone')).toBe('f');
  });

  it('"saved" means in ANY list', () => {
    expect(inAnyList([fav, other], 'TCS')).toBe(true);
    expect(inAnyList([fav, other], 'INFY')).toBe(false);
  });

  it('upsert replaces in place or appends', () => {
    const renamed = { ...other, name: 'Tech 2' };
    expect(upsertWatchlist([fav, other], renamed).map((w) => w.name)).toEqual(['Favorites', 'Tech 2']);
    expect(upsertWatchlist([fav], other)).toHaveLength(2);
  });
});

describe('store', () => {
  it('a brand-new user gets a Favorites list, once per device', async () => {
    serve((c) => {
      if (c.method === 'get') return { data: { success: true, data: { watchlists: [], lastSelectedWatchlistId: null } } };
      return { status: 201, data: { success: true, data: raw('f', 'Favorites', [], true) } };
    });
    const s = await loadWatchlists();
    expect(body(calls[1])).toEqual({ name: 'Favorites', emoji: '⭐', color: '', isDefault: true });
    expect(s.activeId).toBe('f');
    expect(await AsyncStorage.getItem(WATCHLIST_MIGRATION_KEY)).toBe('1');

    // Second launch, lists deleted server-side: no second Favorites.
    resetWatchlists();
    serve(() => ({ data: { success: true, data: { watchlists: [] } } }));
    await loadWatchlists();
    expect(calls).toHaveLength(1);
  });

  it('opens the list remembered server-side', async () => {
    serve(() => ({ data: { success: true, data: { watchlists: [raw('f', 'Favorites', [], true), raw('o', 'Tech', [])], lastSelectedWatchlistId: 'o' } } }));
    expect((await loadWatchlists()).activeId).toBe('o');
  });

  it('the ★ goes to Favorites even when another list is open', async () => {
    serve((c) => {
      if (c.method === 'get') {
        return { data: { data: { watchlists: [raw('f', 'Favorites', [], true), raw('o', 'Tech', [])], lastSelectedWatchlistId: 'o' } } };
      }
      return { status: 201, data: { data: raw('f', 'Favorites', ['EURUSD'], true) } };
    });
    await toggleFavorite('eurusd');
    const post = calls.find((c) => c.method === 'post');
    expect(post?.url).toBe('/watchlists/f/items');
    expect(body(post)).toEqual({ symbol: 'EURUSD' });
    expect(isFavorite('EURUSD')).toBe(true);
    expect(lastToast()?.message).toBe('Added to Favorites');
  });

  it('a refused add rolls back to the snapshot and says why', async () => {
    serve(() => ({ data: { data: { watchlists: [raw('f', 'Favorites', [], true)] } } }));
    await loadWatchlists();
    serve(() => ({ status: 404, data: { error: { code: 'UNKNOWN_SYMBOL', message: 'Unknown or inactive symbol: ZZZ' } } }));
    await expect(addSymbol('f', 'ZZZ')).rejects.toBeTruthy();
    expect(useWatchlistStore.getState().watchlists[0]?.items).toEqual([]);
    expect(lastToast()).toMatchObject({ type: 'error', message: 'Unknown or inactive symbol: ZZZ' });
  });

  it('deleting the last list is refused server-side and restored', async () => {
    serve(() => ({ data: { data: { watchlists: [raw('f', 'Favorites', ['A'], true)] } } }));
    await loadWatchlists();
    serve(() => ({ status: 400, data: { error: { code: 'LAST_WATCHLIST', message: 'At least one watchlist must exist' } } }));
    await expect(deleteList('f')).rejects.toBeTruthy();
    expect(useWatchlistStore.getState()).toMatchObject({ activeId: 'f', watchlists: [{ id: 'f' }] });
  });

  it('a move updates both lists from the server answer', async () => {
    serve(() => ({ data: { data: { watchlists: [raw('f', 'Favorites', ['A'], true), raw('o', 'Tech', [])] } } }));
    await loadWatchlists();
    serve(() => ({ data: { data: { source: raw('f', 'Favorites', [], true), target: raw('o', 'Tech', ['A']) } } }));
    await moveSymbol('f', 'f-A', 'o');
    expect(body(calls[0])).toEqual({ targetWatchlistId: 'o' });
    const [f, o] = useWatchlistStore.getState().watchlists;
    expect(f?.items).toHaveLength(0);
    expect(o?.items.map((i) => i.symbol)).toEqual(['A']);
  });
});
