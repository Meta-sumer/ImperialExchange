import axios, {
  type AxiosError,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from 'axios';

import { API_URL, ENV } from '@/constants/env';
import { getImpersonationToken, isImpersonating, isMutatingMethod } from '@/services/impersonation';
import { clearTokens, getAccessToken, getRefreshToken, setTokens } from '@/services/tokenStore';

/**
 * The HTTP client, ported from client/src/services/api.js.
 *
 * The REFRESH BEHAVIOUR is deliberately identical, down to the queue: a 401
 * carrying TOKEN_EXPIRED or INVALID_TOKEN triggers one refresh, every other
 * request that 401s while that refresh is in flight waits on it rather than
 * firing its own, and they all replay with the new token. Reimplementing
 * that from memory is how you get a refresh storm on a flaky link, which is
 * exactly the condition a phone spends most of its life in.
 *
 * Three things could not come across, and each is replaced rather than
 * dropped:
 *
 *   1. `localStorage.getItem('accessToken')` — synchronous. The token now
 *      comes from an in-memory copy held beside the keychain; see
 *      services/tokenStore.
 *   2. `window.location.href = '/login'` — there is no location to assign.
 *      A listener is notified instead, and the navigator decides what that
 *      means. The HTTP layer should not know what a login screen is.
 *   3. An origin-relative base URL. See constants/env.
 */

/**
 * Thrown when a mutating request is attempted in read-only "View As User"
 * mode. Ported verbatim — the backend enforces the same rule with a 403
 * (middleware/auth.js), and blocking here keeps the request off the wire.
 */
export class ReadOnlyError extends Error {
  code = 'IMPERSONATION_READONLY';

  constructor() {
    super('Read-only mode — this action is disabled while viewing a user account.');
    this.name = 'ReadOnlyError';
  }
}

export const api: AxiosInstance = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: ENV.requestTimeoutMs,
});

/* ── Session-ended listeners ──────────────────────────────────────────
 * The web client navigates to /login from inside the interceptor. Here the
 * interceptor announces, and whoever owns navigation reacts. That keeps
 * this module free of any screen and makes the behaviour testable without
 * a navigator.
 */
type SessionEndedReason = 'NO_REFRESH_TOKEN' | 'REFRESH_FAILED';
type SessionEndedListener = (reason: SessionEndedReason) => void;

const sessionEndedListeners = new Set<SessionEndedListener>();

export const onSessionEnded = (listener: SessionEndedListener): (() => void) => {
  sessionEndedListeners.add(listener);
  return () => sessionEndedListeners.delete(listener);
};

const announceSessionEnded = (reason: SessionEndedReason): void => {
  for (const listener of sessionEndedListeners) {
    // One listener throwing must not stop the others being told the session
    // is over — a half-notified app keeps a signed-out user on a funded
    // screen.
    try { listener(reason); } catch { /* ignore */ }
  }
};

/* ── Request ──────────────────────────────────────────────────────────── */

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  // Read-only impersonation: the tab-scoped token wins, and any mutating
  // request is refused before it leaves the app. Ending the session is the
  // one exception, or an admin could not get out. Verbatim from api.js:32-40.
  const impToken = getImpersonationToken();
  if (impToken) {
    const isEnd = /\/auth\/impersonation\/end$/.test(config.url ?? '');
    if (isMutatingMethod(config.method) && !isEnd) {
      return Promise.reject(new ReadOnlyError());
    }
    config.headers.Authorization = `Bearer ${impToken}`;
    return config;
  }

  const token = getAccessToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/* ── Response: the refresh queue ──────────────────────────────────────── */

type QueueEntry = {
  resolve: (token: string) => void;
  reject: (error: unknown) => void;
};

let isRefreshing = false;
let failedQueue: QueueEntry[] = [];

const processQueue = (error: unknown, token: string | null): void => {
  for (const p of failedQueue) {
    if (error || token === null) p.reject(error);
    else p.resolve(token);
  }
  failedQueue = [];
};

/** The error body shape the backend sends: { error: { code, message } }. */
type ApiErrorBody = { error?: { code?: string; message?: string } };

type RetriableConfig = InternalAxiosRequestConfig & { _retry?: boolean };

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError<ApiErrorBody>) => {
    const original = error.config as RetriableConfig | undefined;

    // During impersonation there is no refresh token to rotate — running the
    // admin's refresh flow here would rotate the ADMIN's session off the back
    // of a user's expired view. Let the 401 surface. Verbatim from api.js:60.
    if (isImpersonating()) return Promise.reject(error);

    if (error.response?.status === 401 && original && !original._retry) {
      const code = error.response.data?.error?.code;
      if (code === 'TOKEN_EXPIRED' || code === 'INVALID_TOKEN') {
        if (isRefreshing) {
          return new Promise<string>((resolve, reject) => {
            failedQueue.push({ resolve, reject });
          }).then((token) => {
            original.headers.Authorization = `Bearer ${token}`;
            return api(original);
          });
        }

        original._retry = true;
        isRefreshing = true;

        const refreshToken = getRefreshToken();
        if (!refreshToken) {
          isRefreshing = false;
          processQueue(error, null);
          announceSessionEnded('NO_REFRESH_TOKEN');
          return Promise.reject(error);
        }

        try {
          // A bare axios call, not `api` — routing the refresh through the
          // instance would put it back through this same interceptor and, on
          // a 401, recurse.
          const { data } = await axios.post<{
            data: { accessToken: string; refreshToken: string };
          }>(`${API_URL}/auth/refresh`, { refreshToken }, { timeout: ENV.requestTimeoutMs });

          const newAccess = data.data.accessToken;
          const newRefresh = data.data.refreshToken;
          await setTokens(newAccess, newRefresh);

          processQueue(null, newAccess);
          original.headers.Authorization = `Bearer ${newAccess}`;
          return api(original);
        } catch (err) {
          processQueue(err, null);
          await clearTokens();
          announceSessionEnded('REFRESH_FAILED');
          return Promise.reject(err);
        } finally {
          isRefreshing = false;
        }
      }
    }

    return Promise.reject(error);
  },
);

/**
 * The message to show a user. Ported verbatim from api.js:108-109 — the
 * server's own wording wins over anything this app would invent, because the
 * server is the one that knows why it refused.
 */
export const errorMessage = (err: unknown): string => {
  const e = err as AxiosError<ApiErrorBody> | undefined;
  return e?.response?.data?.error?.message || e?.message || 'Request failed';
};

/** Exported for tests — the queue is the part worth being able to inspect. */
export const _internal = {
  get isRefreshing() { return isRefreshing; },
  get queueLength() { return failedQueue.length; },
};
