/**
 * Stage-1 reconciliation: per-user caches follow the signed-in PERSON, and
 * there is one push registration the sign-out can remove.
 *
 * Driven through the real api instance with a scripted adapter — nothing
 * reaches the network — and the real stores.
 */
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

import { loadGlobalAlerts, resetGlobalAlerts, useGlobalAlertStore } from '@/api/alerts.api';
import { api } from '@/api/client';
import { notificationsApi } from '@/api/notifications.api';
import { applyMetricsPush, useAccountMetricsStore } from '@/api/trading.api';
import { userApi } from '@/api/user.api';
import { loadWatchlists, resetWatchlists, useWatchlistStore } from '@/api/watchlist.api';
import { useAuthStore } from '@/store/auth';
import '@/store/sessionScope';
import { toAuthUser, type AuthUser } from '@/types/user';

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));

jest.mock('@/websocket/ws', () => ({
  wsClient: {
    connect: jest.fn(),
    disconnect: jest.fn(),
    subscribe: jest.fn(() => () => {}),
    onAuthError: jest.fn(() => () => {}),
    onStateChange: jest.fn(() => () => {}),
  },
}));

/* ── The scripted server: each request waits until the test releases it ── */

type Pending = { key: string; config: InternalAxiosRequestConfig; resolve: (body: unknown) => void; fail: () => void };
const pending: Pending[] = [];
const hits: Array<{ key: string; data: unknown }> = [];

beforeAll(() => {
  api.defaults.adapter = (config: InternalAxiosRequestConfig) => new Promise<AxiosResponse>((resolve, reject) => {
    const key = `${String(config.method).toUpperCase()} ${config.url}`;
    hits.push({ key, data: config.data ? JSON.parse(String(config.data)) : undefined });
    // Push registration answers at once; the loads under test are held.
    if (key.includes('/user/push-tokens') || key === 'GET /user/accounts') {
      resolve({ data: { success: true, data: [] }, status: 200, statusText: '', headers: {}, config });
      return;
    }
    pending.push({
      key,
      config,
      resolve: (body) => resolve({ data: { success: true, data: body }, status: 200, statusText: '', headers: {}, config }),
      fail: () => reject(new AxiosError('Network Error', 'ERR_NETWORK', config)),
    });
  });
});

const release = (key: string, body: unknown): void => {
  const i = pending.findIndex((p) => p.key === key);
  if (i < 0) throw new Error(`no pending ${key}`);
  const [p] = pending.splice(i, 1);
  p?.resolve(body);
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

const user = (id: string): AuthUser => {
  const u = toAuthUser({ _id: id, email: `${id}@example.com`, role: 'USER' });
  if (!u) throw new Error('fixture');
  return u;
};

const LIST_A = [{ _id: 'wA', name: 'Favorites', isDefault: true, items: [{ symbol: 'RELIANCE' }] }];
const LIST_B = [{ _id: 'wB', name: 'Favorites', isDefault: true, items: [] }];

beforeEach(async () => {
  pending.length = 0;
  hits.length = 0;
  useAuthStore.setState({ user: null, status: 'idle', error: null });
  resetWatchlists();
  resetGlobalAlerts();
  await settle();
});

describe('sessionScope — per-user caches follow the signed-in person', () => {
  const seed = (): void => {
    useWatchlistStore.setState({
      watchlists: [{ id: 'wA', name: 'Favorites', emoji: '', color: '', isDefault: true, sortOrder: 0, items: [], itemCount: 0 }],
      activeId: 'wA',
      loaded: true,
    });
    useGlobalAlertStore.setState({
      pending: [{
        id: 'g1', title: 'Maintenance', message: 'Tonight', priority: 'INFO',
        requireAcknowledgement: true, repeatDisplay: false, createdAt: null,
      }],
      dismissed: ['g0'],
    });
    applyMetricsPush(
      { accountId: 'acc-A' } as Parameters<typeof applyMetricsPush>[0],
      { openPositions: 1, status: null },
    );
  };

  it('keeps everything when the same person is re-read (refreshUser)', () => {
    useAuthStore.setState({ user: user('u1'), status: 'authenticated' });
    seed();
    useAuthStore.setState({ user: user('u1') });
    expect(useWatchlistStore.getState().watchlists).toHaveLength(1);
    expect(useGlobalAlertStore.getState().pending).toHaveLength(1);
    expect(useAccountMetricsStore.getState().byAccount['acc-A']).toBeDefined();
  });

  it('drops watchlists, alert popups and account figures on sign-out', () => {
    useAuthStore.setState({ user: user('u1'), status: 'authenticated' });
    seed();
    useAuthStore.setState({ user: null, status: 'unauthenticated' });
    expect(useWatchlistStore.getState()).toMatchObject({ watchlists: [], activeId: null, loaded: false });
    expect(useGlobalAlertStore.getState()).toMatchObject({ pending: [], dismissed: [] });
    expect(useAccountMetricsStore.getState().byAccount).toEqual({});
  });

  it('drops them on a switch between two people that never passes through signed-out', () => {
    useAuthStore.setState({ user: user('u1'), status: 'authenticated' });
    seed();
    // "View As User" ending and the admin's own session resuming, say.
    useAuthStore.setState({ user: user('u2') });
    expect(useWatchlistStore.getState().watchlists).toEqual([]);
    expect(useGlobalAlertStore.getState().pending).toEqual([]);
    expect(useAccountMetricsStore.getState().byAccount).toEqual({});
  });
});

describe('a load overtaken by a user switch lands nowhere', () => {
  it('watchlists: the old load is dropped and does not clobber the next one', async () => {
    useAuthStore.setState({ user: user('u1'), status: 'authenticated' });
    const first = loadWatchlists();
    await settle();

    useAuthStore.setState({ user: user('u2') });          // reset
    const second = loadWatchlists();                       // the next person's load
    await settle();
    expect(pending.filter((p) => p.key === 'GET /watchlists')).toHaveLength(2);

    release('GET /watchlists', { watchlists: LIST_A });    // u1's answer arrives late
    await first;
    expect(useWatchlistStore.getState().watchlists).toEqual([]);
    // Still in flight: a third caller joins u2's load, not a fresh request.
    expect(loadWatchlists()).toBe(second);

    release('GET /watchlists', { watchlists: LIST_B });
    await second;
    expect(useWatchlistStore.getState().watchlists.map((w) => w.id)).toEqual(['wB']);
    expect(useWatchlistStore.getState().loaded).toBe(true);
  });

  it('global alerts: a pending fetch for the previous person is discarded', async () => {
    useAuthStore.setState({ user: user('u1'), status: 'authenticated' });
    const p = loadGlobalAlerts();
    await settle();
    useAuthStore.setState({ user: null, status: 'unauthenticated' });
    release('GET /alerts/pending', [{ _id: 'g9', title: 'For u1', message: 'x' }]);
    await p;
    expect(useGlobalAlertStore.getState().pending).toEqual([]);
  });
});

describe('push registration has one owner', () => {
  it('a token registered through notificationsApi is the one sign-out removes', async () => {
    await userApi.unregisterCurrentPushToken();
    await notificationsApi.registerPushToken('ExponentPushToken[z]', 'android');
    expect(userApi.currentPushToken()).toBe('ExponentPushToken[z]');
    expect(hits.at(-1)).toEqual({ key: 'POST /user/push-tokens', data: { token: 'ExponentPushToken[z]', platform: 'android' } });

    await notificationsApi.unregisterPushToken('ExponentPushToken[z]');
    expect(userApi.currentPushToken()).toBeNull();
    expect(hits.at(-1)?.key).toBe(`DELETE /user/push-tokens/${encodeURIComponent('ExponentPushToken[z]')}`);
  });
});
