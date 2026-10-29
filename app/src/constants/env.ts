import Constants from 'expo-constants';

/**
 * Where this app talks to, and how it is configured.
 *
 * ── WHY THIS CANNOT BE A PORT OF THE WEB VERSION ──────────────────────
 * The web client resolves its API base from `import.meta.env.VITE_API_URL`,
 * and its PRODUCTION value is `/api` — origin-relative, so the bundle
 * follows whatever host served it. That is the right answer for a web app
 * and an impossible one here: a React Native bundle is not served from an
 * origin, so there is nothing for `/api` to be relative TO.
 *
 * The WebSocket URL has the same problem one step worse. `services/ws.js`
 * fills the origin in from `window.location` when the API base is
 * relative — and `window.location` does not exist in React Native at all.
 *
 * So both must be ABSOLUTE here, and both are validated at startup rather
 * than failing later as an opaque network error.
 * ──────────────────────────────────────────────────────────────────────
 */

type Extra = {
  apiBaseUrl?: string;
  wsUrl?: string;
  webOrigin?: string;
};

const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

const str = (value: string | undefined, fallback: string): string =>
  (value !== undefined && value.trim() !== '' ? value.trim() : fallback);

const num = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * The API root, always ending in `/api`.
 *
 * Lifted from client/src/services/api.js: it accepts a base with or without
 * the `/api` suffix and normalises, so `https://host` and `https://host/api`
 * both work. Kept identical so a value that works on the web works here.
 */
const normaliseApiBase = (raw: string): string => {
  const trimmed = raw.replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
};

/**
 * The WebSocket URL, derived from the API base when not given explicitly.
 *
 * Mirrors ws.js's derivation — strip `/api`, swap the scheme, append `/ws` —
 * minus the `window.location` branch, which has no meaning here. A base that
 * is not absolute is a configuration error, and it is reported as one at
 * startup instead of producing `new WebSocket('/ws')`, which simply throws.
 */
const deriveWsUrl = (apiBase: string): string => {
  const base = apiBase.replace(/\/api\/?$/, '');
  if (!/^https?:/i.test(base)) {
    throw new Error(
      `[env] apiBaseUrl must be absolute in a mobile build — got "${base}". `
      + 'The web client may use "/api" because a browser can resolve it against '
      + 'the page origin; this app has no origin. Set EXPO_PUBLIC_API_URL or '
      + 'expo.extra.apiBaseUrl to a full URL such as https://apitradepro.example.com',
    );
  }
  return `${base.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:')}/ws`;
};

const apiBaseRaw = str(
  process.env.EXPO_PUBLIC_API_URL,
  str(extra.apiBaseUrl, 'http://10.0.2.2:5000'),
);

export const API_URL = normaliseApiBase(apiBaseRaw);

export const WS_URL = str(
  process.env.EXPO_PUBLIC_WS_URL,
  str(extra.wsUrl, ''),
) || deriveWsUrl(API_URL);

/**
 * The web app's public origin (`https://host`, no trailing slash), or null
 * when it is not configured. One setting for both things that need it:
 * browser links that should open this app (navigation/linking) and the
 * links this app hands out to be opened in a browser (a partner's referral
 * link, api/partner). The web gets it for free from window.location; a
 * bundle has no origin, so it must be told.
 */
export const WEB_ORIGIN: string | null = ((): string | null => {
  const o = str(process.env.EXPO_PUBLIC_WEB_ORIGIN, str(extra.webOrigin, '')).replace(/\/+$/, '');
  return /^https?:\/\//i.test(o) ? o : null;
})();

export const ENV = {
  apiUrl: API_URL,
  wsUrl: WS_URL,

  /**
   * 20s, matching the web client's axios ceiling. A stuck backend must not
   * leave a screen on a spinner forever, and anything near this is a bug
   * worth surfacing rather than waiting out.
   */
  requestTimeoutMs: num(process.env.EXPO_PUBLIC_REQUEST_TIMEOUT_MS, 20_000),

  /**
   * WebSocket reconnect backoff, same shape as ws.js: 1s doubling to 30s.
   */
  wsBaseBackoffMs: 1_000,
  wsMaxBackoffMs: num(process.env.EXPO_PUBLIC_WS_MAX_BACKOFF_MS, 30_000),

  /**
   * App-level heartbeat. The web client sends NO ping — on a desktop that is
   * survivable because a dead tab is visible and a refresh is one key away.
   * A phone on a flaky mobile link holds a half-open socket for minutes,
   * showing prices that stopped arriving, which on a trading screen is the
   * dangerous kind of wrong.
   */
  wsHeartbeatMs: num(process.env.EXPO_PUBLIC_WS_HEARTBEAT_MS, 25_000),
  wsHeartbeatTimeoutMs: num(process.env.EXPO_PUBLIC_WS_HEARTBEAT_TIMEOUT_MS, 10_000),

  isDev: __DEV__,
};

if (__DEV__) {
  // A misconfigured emulator host should surface here, once, rather than as
  // a stream of opaque network failures on every screen.
  // eslint-disable-next-line no-console
  console.log(`[env] api=${API_URL} ws=${WS_URL}`);
}
