/**
 * refreshUser's ordering guard (store/auth.ts), added while integrating
 * stage 2.
 *
 * Profile re-reads /auth/me on mount, on focus, on return from the mail
 * app or the camera, and after every change it saves (a KYC upload, a
 * profile save), and it lays the server-confirmed fields over the held user
 * first (setUser), so a lost re-read cannot put the old state back on
 * screen. That only holds if a
 * re-read that was already in flight cannot land afterwards with the old
 * document — nor after a sign-out or a "View As User" switch, where it would
 * write the previous person back into the store.
 *
 * Driven through the real api instance with a scripted adapter whose
 * replies the test releases by hand.
 */
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

import { api } from '@/api/client';
import { clearTokens } from '@/services/tokenStore';
import { useAuthStore } from '@/store/auth';

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
  },
}));

/* ── A server whose /auth/me answers wait for the test ───────────────── */

type Reply = { status?: number; body?: unknown; network?: boolean };
const ok = (data: unknown): Reply => ({ body: { success: true, data } });

let meQueue: { release: (r: Reply) => void }[] = [];
let routes: Record<string, Reply> = {};

beforeAll(() => {
  api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    const key = `${String(config.method).toUpperCase()} ${config.url}`;
    const reply: Reply = key === 'GET /auth/me'
      ? await new Promise<Reply>((release) => { meQueue.push({ release }); })
      : routes[key] ?? ok({});
    if (reply.network) throw new AxiosError('Network Error', 'ERR_NETWORK', config);
    const status = reply.status ?? 200;
    const response: AxiosResponse = { data: reply.body, status, statusText: '', headers: {}, config };
    if (status >= 400) throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_RESPONSE', config, null, response);
    return response;
  };
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

const ASHA = { _id: 'u1', email: 'asha@example.com', firstName: 'Asha', role: 'USER', kycStatus: 'NOT_SUBMITTED' };
const RAVI = { _id: 'u2', email: 'ravi@example.com', firstName: 'Ravi', role: 'USER', kycStatus: 'NOT_SUBMITTED' };

const signIn = async (user = ASHA): Promise<void> => {
  routes['POST /auth/login'] = ok({ user, accessToken: 'AT1', refreshToken: 'RT1' });
  await useAuthStore.getState().login(user.email, 'pw');
  await flush();
};

/** The n-th /auth/me still waiting, released with `user`. */
const answer = async (n: number, user: object): Promise<void> => {
  const pending = meQueue[n];
  if (!pending) throw new Error(`no /auth/me #${n} in flight`);
  pending.release(ok(user));
  await flush();
};

beforeEach(async () => {
  meQueue = [];
  routes = { 'GET /user/accounts': ok([]) };
  useAuthStore.setState({ user: null, status: 'idle', error: null });
  await clearTokens();
});

describe('refreshUser applies only the newest answer, and nothing older than a write', () => {
  it('a single re-read still lands', async () => {
    await signIn();
    const done = useAuthStore.getState().refreshUser();
    await flush();
    await answer(0, { ...ASHA, firstName: 'Asha R.' });
    await done;
    expect(useAuthStore.getState().user?.firstName).toBe('Asha R.');
  });

  it('an older re-read answering LAST does not undo the newer one (KYC stays PENDING)', async () => {
    await signIn();
    const first = useAuthStore.getState().refreshUser(); // e.g. the focus re-read, sent before the upload
    await flush();
    const second = useAuthStore.getState().refreshUser(); // the re-read after the PAN card upload
    await flush();
    await answer(1, { ...ASHA, kycStatus: 'PENDING' });
    await answer(0, { ...ASHA, kycStatus: 'NOT_SUBMITTED' });
    await Promise.all([first, second]);
    expect(useAuthStore.getState().user?.kycStatus).toBe('PENDING');
  });

  it('a re-read sent before a confirmed local write (setUser) cannot put the old value back', async () => {
    await signIn();
    const stale = useAuthStore.getState().refreshUser();
    await flush();
    const held = useAuthStore.getState().user;
    if (!held) throw new Error('signed in');
    useAuthStore.getState().setUser({ ...held, firstName: 'Asha R.' }); // ProfileDetailsTab's applyToSignedInUser
    await answer(0, { ...ASHA, firstName: 'Asha' });
    await stale;
    expect(useAuthStore.getState().user?.firstName).toBe('Asha R.');
  });

  it('signs in with email and password only — the body authController.login reads', async () => {
    const seen: unknown[] = [];
    const spy = api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
      if (config.url === '/auth/login') seen.push(config.data);
      return config;
    });
    routes['POST /auth/login'] = ok({ user: ASHA, accessToken: 'AT1', refreshToken: 'RT1' });
    try {
      await useAuthStore.getState().login('asha@example.com', 'pw');
    } finally {
      api.interceptors.request.eject(spy);
    }
    expect(seen).toEqual([{ email: 'asha@example.com', password: 'pw' }]);
    expect(useAuthStore.getState().status).toBe('authenticated');
  });

  it('a re-read in flight across a sign-out does not put the user back', async () => {
    await signIn();
    const pending = useAuthStore.getState().refreshUser();
    await flush();
    await useAuthStore.getState().logout();
    await answer(0, ASHA);
    await pending;
    expect(useAuthStore.getState()).toMatchObject({ user: null, status: 'unauthenticated' });
  });

  it('a re-read in flight across a change of person does not bring the previous one back', async () => {
    await signIn(ASHA);
    const pending = useAuthStore.getState().refreshUser();
    await flush();
    await useAuthStore.getState().logout();
    await signIn(RAVI);
    await answer(0, ASHA);
    await pending;
    expect(useAuthStore.getState().user?.id).toBe('u2');
  });

  it('a failed re-read still keeps the user (auth.js:97-101)', async () => {
    await signIn();
    const pending = useAuthStore.getState().refreshUser();
    await flush();
    meQueue[0]?.release({ network: true });
    await pending;
    expect(useAuthStore.getState().user?.id).toBe('u1');
  });
});
