/**
 * The session and the selected account — the two stores every screen reads.
 *
 * Driven through the real api instance with a scripted adapter, the real
 * tokenStore over an in-memory keychain, and a fake socket, so what is
 * pinned is the lifecycle: who holds a session, when tokens are kept or
 * dropped, and that a new user never sees the last one's accounts.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

import { api } from '@/api/client';
import { userApi } from '@/api/user.api';
import { clearTokens, getAccessToken, getRefreshToken, setTokens } from '@/services/tokenStore';
import { isTransientFailure, useAuthStore } from '@/store/auth';
import {
  resolveSelection,
  selectSelectedAccount,
  selectedAccountStorageKey,
  useSelectedAccountStore,
} from '@/store/selectedAccount';
import { STAFF_ACCOUNT_MESSAGE } from '@/types/user';
import { wsClient } from '@/websocket/ws';

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

/** A socket that records, and lets a test play the server. */
type MockCallback = (data: unknown) => void;
type MockAuthListener = (reason: string) => void;

jest.mock('@/websocket/ws', () => {
  const subs = new Map<string, Set<MockCallback>>();
  const authListeners = new Set<MockAuthListener>();
  return {
    wsClient: {
      connect: jest.fn(),
      disconnect: jest.fn(() => subs.clear()),
      subscribe: jest.fn((ch: string, cb: MockCallback) => {
        const set = subs.get(ch) ?? new Set<MockCallback>();
        set.add(cb);
        subs.set(ch, set);
        return () => { subs.get(ch)?.delete(cb); };
      }),
      onAuthError: jest.fn((listener: MockAuthListener) => {
        authListeners.add(listener);
        return () => { authListeners.delete(listener); };
      }),
    },
    __emit: (ch: string, data: unknown) => { for (const cb of subs.get(ch) ?? []) cb(data); },
    __authError: (reason: string) => { for (const l of authListeners) l(reason); },
    __subscribed: (ch: string) => (subs.get(ch)?.size ?? 0) > 0,
  };
});

const socket = jest.requireMock('@/websocket/ws') as {
  __emit: (ch: string, data: unknown) => void;
  __authError: (reason: string) => void;
  __subscribed: (ch: string) => boolean;
};
const ws = wsClient as unknown as { connect: jest.Mock; disconnect: jest.Mock };

/* ── The scripted server ─────────────────────────────────────────────── */

type Reply = { status?: number; body?: unknown; network?: boolean };
type Route = Reply | (() => Reply);

let routes: Record<string, Route> = {};
const hits: string[] = [];

const ok = (data: unknown): Reply => ({ body: { success: true, data } });
const fail = (status: number, code: string, message = 'Refused'): Reply =>
  ({ status, body: { success: false, error: { code, message } } });

beforeAll(() => {
  api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    const key = `${String(config.method).toUpperCase()} ${config.url}`;
    hits.push(key);
    const route = routes[key];
    const reply: Reply = typeof route === 'function' ? route() : route ?? ok({});
    if (reply.network) throw new AxiosError('Network Error', 'ERR_NETWORK', config);
    const status = reply.status ?? 200;
    const response: AxiosResponse = { data: reply.body, status, statusText: '', headers: {}, config };
    if (status >= 400) {
      throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_RESPONSE', config, null, response);
    }
    return response;
  };
});

const USER = { _id: 'u1', email: 'asha@example.com', firstName: 'Asha', role: 'USER' };
const SESSION = { user: USER, accessToken: 'AT1', refreshToken: 'RT1' };
const ACCOUNTS = [
  { _id: 'a1', accountNumber: 'TP1', accountType: 'STANDARD' },
  { _id: 'a2', accountNumber: 'TP2', accountType: 'DEMO' },
];

/** Let queued promise chains (a load kicked off by a subscription) run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(async () => {
  routes = { 'GET /user/accounts': ok(ACCOUNTS) };
  hits.length = 0;
  // Sign out whoever the last test left signed in; the account store
  // follows the user, so this resets it too.
  useAuthStore.setState({ user: null, status: 'idle', error: null });
  await clearTokens();
  await AsyncStorage.clear();
  jest.clearAllMocks();
});

/* ══ Session ═══════════════════════════════════════════════════════════ */

describe('bootstrap', () => {
  it('with no stored session, is simply signed out', async () => {
    await useAuthStore.getState().bootstrap();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(hits).not.toContain('GET /auth/me');
  });

  it('restores a customer session and connects the socket', async () => {
    await setTokens('AT0', 'RT0');
    routes['GET /auth/me'] = ok(USER);
    await useAuthStore.getState().bootstrap();
    expect(useAuthStore.getState()).toMatchObject({ status: 'authenticated', user: { id: 'u1', name: 'Asha' } });
    expect(ws.connect).toHaveBeenCalledWith('AT0');
  });

  it('drops a stored STAFF session — the role gate', async () => {
    await setTokens('AT0', 'RT0');
    routes['GET /auth/me'] = ok({ ...USER, role: 'ADMIN' });
    await useAuthStore.getState().bootstrap();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(getAccessToken()).toBeNull();
    expect(ws.connect).not.toHaveBeenCalled();
  });

  it('clears the tokens when the server refuses the session', async () => {
    await setTokens('AT0', 'RT0');
    routes['GET /auth/me'] = fail(404, 'NOT_FOUND', 'User not found');
    await useAuthStore.getState().bootstrap();
    expect(useAuthStore.getState()).toMatchObject({ status: 'unauthenticated', error: null });
    expect(getAccessToken()).toBeNull();
  });

  it('KEEPS the tokens when offline — "opened the app in a lift" is not a sign-out', async () => {
    await setTokens('AT0', 'RT0');
    routes['GET /auth/me'] = { network: true };
    await useAuthStore.getState().bootstrap();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(useAuthStore.getState().error).toBe('Network Error');
    expect(getAccessToken()).toBe('AT0');
    expect(getRefreshToken()).toBe('RT0');

    // And bootstrap again is the retry.
    routes['GET /auth/me'] = ok(USER);
    await useAuthStore.getState().bootstrap();
    expect(useAuthStore.getState().status).toBe('authenticated');
  });

  it('keeps the tokens through a server error too — a deploy is not a verdict', async () => {
    await setTokens('AT0', 'RT0');
    routes['GET /auth/me'] = fail(502, 'BAD_GATEWAY', 'Bad gateway');
    await useAuthStore.getState().bootstrap();
    expect(getAccessToken()).toBe('AT0');
  });
});

describe('isTransientFailure', () => {
  it('separates "could not ask" from "was refused"', () => {
    const cfg = { headers: {} } as InternalAxiosRequestConfig;
    const res = (status: number) => ({ data: {}, status, statusText: '', headers: {}, config: cfg }) as AxiosResponse;
    expect(isTransientFailure(new AxiosError('Network Error', 'ERR_NETWORK', cfg))).toBe(true);
    expect(isTransientFailure(new AxiosError('x', 'E', cfg, null, res(503)))).toBe(true);
    expect(isTransientFailure(new AxiosError('x', 'E', cfg, null, res(401)))).toBe(false);
    expect(isTransientFailure(new Error('plain'))).toBe(false);
  });
});

describe('login', () => {
  it('stores the session and signs in', async () => {
    routes['POST /auth/login'] = ok(SESSION);
    await expect(useAuthStore.getState().login('asha@example.com', 'pw')).resolves.toBeUndefined();
    expect(useAuthStore.getState()).toMatchObject({ status: 'authenticated', error: null, user: { id: 'u1' } });
    expect(getAccessToken()).toBe('AT1');
    expect(getRefreshToken()).toBe('RT1');
    expect(ws.connect).toHaveBeenCalledWith('AT1');
  });

  it('signs in on a single attempt — EquityHub has no 2FA step', async () => {
    routes['POST /auth/login'] = ok(SESSION);
    await useAuthStore.getState().login('asha@example.com', 'pw');
    expect(hits).toContain('POST /auth/login');
    expect(useAuthStore.getState().status).toBe('authenticated');
  });

  it('refuses a staff account BEFORE storing a single token', async () => {
    routes['POST /auth/login'] = ok({ ...SESSION, user: { ...USER, role: 'MANAGER' } });
    await expect(useAuthStore.getState().login('boss@example.com', 'pw')).rejects.toThrow(STAFF_ACCOUNT_MESSAGE);
    expect(getAccessToken()).toBeNull();
    expect(useAuthStore.getState()).toMatchObject({ user: null, error: STAFF_ACCOUNT_MESSAGE });
  });

  it('reports a refusal in the server’s words', async () => {
    routes['POST /auth/login'] = fail(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
    await expect(useAuthStore.getState().login('asha@example.com', 'bad')).rejects.toBeTruthy();
    expect(useAuthStore.getState().error).toBe('Invalid credentials');
    expect(getAccessToken()).toBeNull();
  });
});

describe('register', () => {
  it('signs the new customer in', async () => {
    routes['POST /auth/register'] = ok(SESSION);
    await useAuthStore.getState().register({ email: 'asha@example.com', password: 'pw' });
    expect(useAuthStore.getState().status).toBe('authenticated');
    expect(getRefreshToken()).toBe('RT1');
  });
});

describe('logout and the end of a session', () => {
  const signIn = async (): Promise<void> => {
    routes['POST /auth/login'] = ok(SESSION);
    await useAuthStore.getState().login('asha@example.com', 'pw');
    await settle();
  };

  it('removes the push registration, revokes the refresh token, then forgets everything', async () => {
    await signIn();
    await userApi.registerPushToken('ExponentPushToken[x]', 'android');
    await useAuthStore.getState().logout();
    const del = hits.indexOf('DELETE /user/push-tokens/ExponentPushToken%5Bx%5D');
    const out = hits.indexOf('POST /auth/logout');
    expect(del).toBeGreaterThanOrEqual(0);
    expect(out).toBeGreaterThan(del);
    expect(getAccessToken()).toBeNull();
    expect(ws.disconnect).toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ user: null, status: 'unauthenticated' });
  });

  it('signs out locally even when the server cannot be reached', async () => {
    await signIn();
    routes['POST /auth/logout'] = { network: true };
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(getAccessToken()).toBeNull();
  });

  it('ends the session when the HTTP layer gives up on it', async () => {
    await signIn();
    // An expired access token with no refresh token to trade: api/client
    // announces NO_REFRESH_TOKEN, and the store must follow.
    await setTokens('AT-expired', '');
    routes['GET /auth/me'] = fail(401, 'TOKEN_EXPIRED', 'Token expired');
    await useAuthStore.getState().refreshUser();
    expect(useAuthStore.getState()).toMatchObject({ user: null, status: 'unauthenticated' });
    expect(getAccessToken()).toBeNull();
    expect(ws.disconnect).toHaveBeenCalled();
  });

  it('keeps the user on a failed refreshUser that is not the end of the session', async () => {
    await signIn();
    routes['GET /auth/me'] = { network: true };
    await useAuthStore.getState().refreshUser();
    expect(useAuthStore.getState().user?.id).toBe('u1');
  });

  it('setUser publishes a profile the server returned', async () => {
    await signIn();
    const current = useAuthStore.getState().user;
    if (!current) throw new Error('signed in');
    useAuthStore.getState().setUser({ ...current, firstName: 'A.', name: 'A. Rao' });
    expect(useAuthStore.getState().user?.name).toBe('A. Rao');
    useAuthStore.getState().setUser(null);
    expect(useAuthStore.getState().status).toBe('unauthenticated');
  });
});

describe('socket auth_error', () => {
  it('re-checks the session once and reconnects with the token that leaves', async () => {
    routes['POST /auth/login'] = ok(SESSION);
    await useAuthStore.getState().login('asha@example.com', 'pw');
    ws.connect.mockClear();
    routes['GET /auth/me'] = ok(USER);

    socket.__authError('expired');
    await settle();
    expect(hits.filter((h) => h === 'GET /auth/me')).toHaveLength(1);
    expect(ws.connect).toHaveBeenCalledWith('AT1');

    // A second refusal straight after is not chased — no reconnect loop.
    socket.__authError('expired');
    await settle();
    expect(hits.filter((h) => h === 'GET /auth/me')).toHaveLength(1);
  });
});

/* ══ Selected account ══════════════════════════════════════════════════ */

describe('resolveSelection — Layout.jsx:249-253', () => {
  const list = [{ id: 'a1' }, { id: 'a2' }];
  it('defaults to the first account', () => expect(resolveSelection(list, null)).toBe('a1'));
  it('keeps a choice that still exists', () => expect(resolveSelection(list, 'a2')).toBe('a2'));
  it('snaps a vanished choice to the first', () => expect(resolveSelection(list, 'gone')).toBe('a1'));
  it('leaves the choice alone when the list is empty', () => expect(resolveSelection([], 'a2')).toBe('a2'));
});

describe('selected account store', () => {
  const signIn = async (user = USER): Promise<void> => {
    routes['POST /auth/login'] = ok({ ...SESSION, user });
    await useAuthStore.getState().login(user.email, 'pw');
    await settle();
  };

  it('loads on sign-in and lands on the first account', async () => {
    await signIn();
    const s = useSelectedAccountStore.getState();
    expect(s.accounts.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(s.selectedId).toBe('a1');
    expect(s.userId).toBe('u1');
    expect(selectSelectedAccount(s)?.accountNumber).toBe('TP1');
    expect(await AsyncStorage.getItem(selectedAccountStorageKey('u1'))).toBe('a1');
  });

  it('restores the account this user left on', async () => {
    await AsyncStorage.setItem(selectedAccountStorageKey('u1'), 'a2');
    await signIn();
    expect(useSelectedAccountStore.getState().selectedId).toBe('a2');
  });

  it('does not hand one user another user’s saved choice', async () => {
    await AsyncStorage.setItem(selectedAccountStorageKey('someone-else'), 'a2');
    await signIn();
    expect(useSelectedAccountStore.getState().selectedId).toBe('a1');
  });

  it('snaps a saved account that is gone to the first', async () => {
    await AsyncStorage.setItem(selectedAccountStorageKey('u1'), 'closed-account');
    await signIn();
    expect(useSelectedAccountStore.getState().selectedId).toBe('a1');
    expect(await AsyncStorage.getItem(selectedAccountStorageKey('u1'))).toBe('a1');
  });

  it('remembers a choice', async () => {
    await signIn();
    useSelectedAccountStore.getState().select('a2');
    expect(selectSelectedAccount(useSelectedAccountStore.getState())?.id).toBe('a2');
    await settle();
    expect(await AsyncStorage.getItem(selectedAccountStorageKey('u1'))).toBe('a2');
  });

  it('falls back to the first account while nothing is selected — Trade.jsx:653', () => {
    const accounts = useSelectedAccountStore.getState().accounts;
    expect(selectSelectedAccount({ accounts, selectedId: null })).toBeNull();
    const two = [{ id: 'x' }, { id: 'y' }] as unknown as Parameters<typeof selectSelectedAccount>[0]['accounts'];
    expect(selectSelectedAccount({ accounts: two, selectedId: 'nope' })?.id).toBe('x');
  });

  it('keeps the list it had when a reload fails', async () => {
    await signIn();
    routes['GET /user/accounts'] = { network: true };
    await useSelectedAccountStore.getState().load();
    const s = useSelectedAccountStore.getState();
    expect(s.accounts).toHaveLength(2);
    expect(s.error).toBe('Network Error');
    expect(s.loading).toBe(false);
  });

  it('forgets the list and the choice on sign-out, but not on disk', async () => {
    await signIn();
    await useAuthStore.getState().logout();
    expect(useSelectedAccountStore.getState()).toMatchObject({ accounts: [], selectedId: null, userId: null });
    expect(await AsyncStorage.getItem(selectedAccountStorageKey('u1'))).toBe('a1');
  });

  it('never shows the next user the previous one’s accounts', async () => {
    await signIn();
    await useAuthStore.getState().logout();
    routes['GET /user/accounts'] = ok([{ _id: 'b1', accountNumber: 'TP9' }]);
    await signIn({ ...USER, _id: 'u2', email: 'ravi@example.com' });
    const s = useSelectedAccountStore.getState();
    expect(s.userId).toBe('u2');
    expect(s.accounts.map((a) => a.id)).toEqual(['b1']);
    expect(s.selectedId).toBe('b1');
  });

  it('drops a load that a sign-out overtook', async () => {
    await signIn();
    let release: (r: Reply) => void = () => undefined;
    const pending = new Promise<Reply>((r) => { release = r; });
    const original = api.defaults.adapter as (c: InternalAxiosRequestConfig) => Promise<AxiosResponse>;
    api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      if (config.url !== '/user/accounts') return original(config);
      const r = await pending;
      return { data: r.body, status: 200, statusText: '', headers: {}, config };
    };
    try {
      const inFlight = useSelectedAccountStore.getState().load();
      useSelectedAccountStore.getState().reset();
      release(ok([{ _id: 'late', accountNumber: 'LATE' }]));
      await inFlight;
      expect(useSelectedAccountStore.getState().accounts).toEqual([]);
    } finally {
      api.defaults.adapter = original;
    }
  });
});

describe('selected account — live reloads', () => {
  it('subscribes to wallet and account events for the signed-in user, and reloads on them', async () => {
    // Fresh adapter state for this block (the previous test wrapped it).
    routes = { 'GET /user/accounts': ok(ACCOUNTS), 'POST /auth/login': ok(SESSION) };
    await useAuthStore.getState().login('asha@example.com', 'pw');
    await settle();
    expect(socket.__subscribed('user:wallet')).toBe(true);
    expect(socket.__subscribed('user:accounts')).toBe(true);

    routes['GET /user/accounts'] = ok([...ACCOUNTS, { _id: 'a3', accountNumber: 'TP3' }]);
    const before = hits.filter((h) => h === 'GET /user/accounts').length;
    // A burst — a close-all settles several positions — is one reload.
    socket.__emit('user:wallet', { action: 'credited' });
    socket.__emit('user:wallet', { action: 'credited' });
    socket.__emit('user:accounts', { type: 'PLAN_ENFORCED' });
    await new Promise((r) => setTimeout(r, 650));
    await settle();
    expect(hits.filter((h) => h === 'GET /user/accounts').length - before).toBe(1);
    expect(useSelectedAccountStore.getState().accounts.map((a) => a.id)).toEqual(['a1', 'a2', 'a3']);
  });
});
