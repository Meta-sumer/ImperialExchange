import { create } from 'zustand';

import { authApi } from '@/api/auth.api';
import { errorMessage, onSessionEnded } from '@/api/client';
import { userApi } from '@/api/user.api';
import {
  clearImpersonation,
  getImpersonationToken,
  isImpersonating,
} from '@/services/impersonation';
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  hydrate,
  setTokens,
} from '@/services/tokenStore';
import {
  STAFF_ACCOUNT_MESSAGE,
  isClientRole,
  type AuthUser,
} from '@/types/user';
import { wsClient } from '@/websocket/ws';

/**
 * The session, ported from client/src/store/auth.js.
 *
 * ── WHAT IS KEPT ──────────────────────────────────────────────────────
 * The ROLE GATE. This is the customer app; only role USER may hold a
 * session here (auth.js:6-9). Login refuses a staff account BEFORE any token
 * is stored, so no session is ever established for one; bootstrap drops a
 * stored staff session. Impersonation is exempt — its tokens carry USER, and
 * the admin behind one must not be signed out by the gate.
 *
 * ── WHAT IS DIFFERENT, AND WHY ────────────────────────────────────────
 * 1. `loading: true` on the web meant "init has not finished". Here that is
 *    `status: 'loading'`, set ONLY by bootstrap. Login and register do not
 *    touch status while in flight: a navigator that swaps to a splash on
 *    'loading' would unmount the form mid-submit and lose what was typed
 *    the moment the server refused it. The screen owns its spinner.
 *
 * 2. The web clears the stored tokens when /auth/me fails for ANY reason.
 *    On a phone that turns "opened the app in a lift" into "signed out", and
 *    a lost refresh token cannot be recovered. So a failure that is not a
 *    verdict on the session — no HTTP response at all (offline, timeout), or
 *    a 5xx (the server mid-deploy) — keeps the tokens and reports the error;
 *    `bootstrap()` again is the retry. A 4xx refusal still clears them.
 *    An expired token never reaches here as a failure — api/client refreshes
 *    it first, and only a failed refresh ends the session.
 *
 * 3. Sign-out also removes this device's push registration, before the
 *    tokens go (the call needs the session it is ending). A signed-out phone
 *    that stays registered keeps getting the last user's margin calls.
 *
 * 4. The socket's `auth_error` is acted on. The web discarded that frame, so
 *    an access token that expired while the socket was up left it connected
 *    and deaf until a reload. Here it triggers one /auth/me — which runs
 *    api/client's refresh when the token has expired — and a reconnect with
 *    whatever token that leaves.
 * ──────────────────────────────────────────────────────────────────────
 */

export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'unauthenticated';

interface AuthState {
  user: AuthUser | null;
  status: AuthStatus;
  /** The last bootstrap / login / register failure, in the server's words. */
  error: string | null;

  /** Restore the session at launch. Safe to call again as a retry. */
  bootstrap(): Promise<void>;
  /** Sign in (auth.js `login(email, password)`). Rejects on refusal, with `error` set. */
  login(email: string, password: string): Promise<void>;
  /** Sign up and sign in. Rejects on refusal, with `error` set. */
  register(body: Record<string, unknown>): Promise<void>;
  logout(): Promise<void>;
  /** Re-read /auth/me after a profile, KYC or email change. Silent on failure. */
  refreshUser(): Promise<void>;
  setUser(u: AuthUser | null): void;

  /** "Return to Admin": close a read-only View-As-User session. */
  exitImpersonation(): Promise<void>;
}

/**
 * A failure that says nothing about whether the session is good: no HTTP
 * response at all (offline, DNS, timeout) or the server failing (5xx). Only
 * a 4xx is the server refusing THIS session.
 */
export const isTransientFailure = (err: unknown): boolean => {
  const e = err as { isAxiosError?: boolean; response?: { status?: number } } | null;
  if (!e?.isAxiosError) return false;
  if (!e.response) return true;
  return (e.response.status ?? 0) >= 500;
};

/** refreshUser's ordering guard: the newest re-read, and writes since. */
let refreshSeq = 0;
let userVersion = 0;

export const useAuthStore = create<AuthState>()((set, get) => {
  /** Common tail of a login or register: persist, publish, connect. */
  const establish = async (user: AuthUser, accessToken: string, refreshToken: string): Promise<void> => {
    await setTokens(accessToken, refreshToken);
    set({ user, status: 'authenticated', error: null });
    wsClient.connect(accessToken);
  };

  return {
    user: null,
    status: 'idle',
    error: null,

    bootstrap: async () => {
      set({ status: 'loading', error: null });
      await hydrate();

      // Read-only "View As User": the impersonation token wins over any real
      // login, so /auth/me resolves to the target and the app renders as they
      // see it. auth.js:17-20.
      const impersonating = isImpersonating();
      const token = getImpersonationToken() ?? getAccessToken();
      if (!token) {
        set({ user: null, status: 'unauthenticated' });
        return;
      }

      try {
        const user = await authApi.me();
        if (!impersonating && !isClientRole(user)) {
          await clearTokens();
          set({ user: null, status: 'unauthenticated' });
          return;
        }
        set({ user, status: 'authenticated', error: null });
        wsClient.connect(token);
      } catch (err) {
        const transient = isTransientFailure(err);
        if (!impersonating && !transient) await clearTokens();
        set({
          user: null,
          status: 'unauthenticated',
          error: transient ? errorMessage(err) : null,
        });
      }
    },

    login: async (email, password) => {
      set({ error: null });
      try {
        const res = await authApi.login({ email, password });
        // Refused before a single token is stored. auth.js login.
        if (!isClientRole(res.user)) throw new Error(STAFF_ACCOUNT_MESSAGE);
        await establish(res.user, res.accessToken, res.refreshToken);
      } catch (err) {
        set({ error: errorMessage(err) });
        throw err;
      }
    },

    register: async (body) => {
      set({ error: null });
      try {
        const res = await authApi.register(body);
        // Registration always creates a USER. The gate costs nothing here and
        // keeps "only a customer holds a session" true on every path in.
        if (!isClientRole(res.user)) throw new Error(STAFF_ACCOUNT_MESSAGE);
        await establish(res.user, res.accessToken, res.refreshToken);
      } catch (err) {
        set({ error: errorMessage(err) });
        throw err;
      }
    },

    logout: async () => {
      try { await userApi.unregisterCurrentPushToken(); } catch { /* best-effort */ }
      try { await authApi.logout(getRefreshToken()); } catch { /* best-effort */ }
      await clearTokens();
      wsClient.disconnect();
      set({ user: null, status: 'unauthenticated', error: null });
    },

    refreshUser: async () => {
      // Re-reads overlap here (a screen's mount, a focus, the return from
      // the mail app, the re-read after a change), and the JS context
      // outlives a sign-out or a "View As User" switch. An answer lands only
      // if it is the newest re-read AND nothing else wrote the user since it
      // was sent — otherwise a late pre-change answer puts a just-saved
      // profile back, or the previous person back after a switch.
      const seq = ++refreshSeq;
      const version = userVersion;
      try {
        const user = await authApi.me();
        if (seq !== refreshSeq || version !== userVersion) return;
        if (get().status !== 'authenticated') return;
        set({ user });
      } catch { /* keep the user we have — auth.js:97-101 */ }
    },

    setUser: (u) => {
      set(u
        ? { user: u, status: 'authenticated' }
        : { user: null, status: 'unauthenticated' });
    },

    exitImpersonation: async () => {
      // Best-effort: close + audit the session server-side. The interceptor
      // lets exactly this POST through for an impersonation token.
      try { await authApi.endImpersonation(); } catch { /* ignore */ }
      clearImpersonation();
      wsClient.disconnect();
      set({ user: null });
      // The web navigates to /admin/. There is no admin app here, so fall
      // back to whatever session this device holds of its own, if any.
      await get().bootstrap();
    },
  };
});

/**
 * A session the HTTP layer gave up on — no refresh token, or the refresh
 * was refused. api/client has already cleared the tokens on a refused
 * refresh; on NO_REFRESH_TOKEN the dead access token is still stored, so it
 * is cleared here. The navigator reacts to status, as the web reacted to
 * `window.location = '/login'`.
 */
// Every write of `user` (sign-in, sign-out, a switch, setUser, a re-read)
// supersedes a re-read that was already in flight — see refreshUser.
useAuthStore.subscribe((s, prev) => {
  if (s.user !== prev.user) userVersion += 1;
});

onSessionEnded(() => {
  if (isImpersonating()) return;
  void clearTokens();
  wsClient.disconnect();
  useAuthStore.setState({ user: null, status: 'unauthenticated' });
});

/**
 * The socket refused its token. See note 4 above.
 *
 * Throttled: if HTTP still accepts the token the socket refused, /auth/me
 * succeeds without a refresh, the reconnect is refused again, and without a
 * floor this would loop as fast as the server can answer. An impersonation
 * token has nothing to refresh with, so it is left alone.
 */
const WS_RECOVERY_FLOOR_MS = 30_000;
let lastWsRecovery = 0;

wsClient.onAuthError(() => {
  if (isImpersonating() || useAuthStore.getState().status !== 'authenticated') return;
  const now = Date.now();
  if (now - lastWsRecovery < WS_RECOVERY_FLOOR_MS) return;
  lastWsRecovery = now;
  void (async () => {
    try {
      const user = await authApi.me();
      if (useAuthStore.getState().status !== 'authenticated') return;
      useAuthStore.setState({ user });
      wsClient.connect(getAccessToken());
    } catch {
      // A refused refresh has already ended the session (onSessionEnded
      // above). Anything else — offline — the socket's own backoff retries.
    }
  })();
});
