import * as SecureStore from 'expo-secure-store';

/**
 * Where the session lives.
 *
 * ── WHY THIS IS NOT localStorage ──────────────────────────────────────
 * The web client keeps `accessToken` and `refreshToken` in localStorage and
 * reads them SYNCHRONOUSLY, in two places that matter:
 *
 *   api.js:42        config.headers.Authorization = localStorage.getItem(…)
 *   ws.js:_currentToken()   the token used for every reconnect
 *
 * Neither survives the move. Secure storage on a device is asynchronous, and
 * it has to be secure storage: an access token in AsyncStorage sits in plain
 * text in the app sandbox, readable on a rooted or jailbroken phone and by
 * anything that can read a backup.
 *
 * So the tokens are held in MEMORY as well as in the keychain, and the
 * in-memory copy is what the interceptors read. That is not a cache for
 * speed — it is the only way a synchronous read site can exist at all. The
 * keychain is the durable copy; memory is the one the request path uses.
 * `hydrate()` fills memory from the keychain once, at startup, before
 * anything is allowed to make a request.
 * ──────────────────────────────────────────────────────────────────────
 */

const ACCESS_KEY = 'accessToken';
const REFRESH_KEY = 'refreshToken';

let accessToken: string | null = null;
let refreshToken: string | null = null;
let hydrated = false;

/**
 * SecureStore throws on some devices rather than returning null — a locked
 * keychain, a corrupted entry, a simulator quirk. A failure to read a token
 * means "not signed in", which is recoverable; letting it throw would take
 * the whole app down at launch, which is not.
 */
const readKey = async (key: string): Promise<string | null> => {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
};

const writeKey = async (key: string, value: string | null): Promise<void> => {
  try {
    if (value === null) await SecureStore.deleteItemAsync(key);
    else await SecureStore.setItemAsync(key, value);
  } catch {
    // The in-memory copy still holds, so the current session keeps working.
    // It simply will not survive a restart, which is the right failure: the
    // user is asked to sign in again rather than silently losing the session
    // mid-trade.
  }
};

/**
 * Load the session from the keychain. Call once, before the first request.
 * Idempotent — a second call is a no-op, so a race between the navigator and
 * a screen cannot double-read.
 */
export const hydrate = async (): Promise<void> => {
  if (hydrated) return;
  const [a, r] = await Promise.all([readKey(ACCESS_KEY), readKey(REFRESH_KEY)]);
  accessToken = a;
  refreshToken = r;
  hydrated = true;
};

/** True once hydrate() has run. A request before this would go out anonymous. */
export const isHydrated = (): boolean => hydrated;

/** The live access token. Synchronous on purpose — see the note above. */
export const getAccessToken = (): string | null => accessToken;

export const getRefreshToken = (): string | null => refreshToken;

/**
 * Store a fresh pair. Memory first so the very next request already carries
 * it, then the keychain — a refresh that persisted before updating memory
 * would leave one in-flight request using the token that just expired.
 */
export const setTokens = async (access: string, refresh: string): Promise<void> => {
  accessToken = access;
  refreshToken = refresh;
  hydrated = true;
  await Promise.all([writeKey(ACCESS_KEY, access), writeKey(REFRESH_KEY, refresh)]);
};

/** Sign out. Clears memory immediately, then the keychain. */
export const clearTokens = async (): Promise<void> => {
  accessToken = null;
  refreshToken = null;
  await Promise.all([writeKey(ACCESS_KEY, null), writeKey(REFRESH_KEY, null)]);
};
