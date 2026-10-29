/**
 * Read-only "View As User" impersonation, ported from
 * client/src/services/impersonation.js.
 *
 * An admin views a user's account without being able to change anything.
 * While a session is active:
 *   - every request carries THIS token instead of the signed-in one,
 *   - every mutating method is refused before it leaves the app,
 *   - a fixed READ-ONLY banner is shown.
 *
 * The authoritative guard is the backend (middleware/auth.js returns 403
 * IMPERSONATION_READONLY on any non-GET/HEAD/OPTIONS except the end call).
 * This layer is UX plus defence in depth, exactly as on the web.
 *
 * ── TWO DELIBERATE DIFFERENCES ────────────────────────────────────────
 * 1. ENTRY. The web captures `#imp=<token>&info=<base64>` from the URL hash
 *    at module-import time, then rewrites the URL. There is no URL bar here,
 *    so the app takes it from a deep link (equityhub://imp?token=…)
 *    which the navigator hands to `beginImpersonation`. Capturing at import
 *    time was also a hazard on the web — the module had to be imported early
 *    or the token was lost — and an explicit call removes that ordering trap.
 *
 * 2. STORAGE. The web uses sessionStorage, which is TAB-SCOPED: it cannot
 *    leak into a real login in another tab and it dies with the tab. An app
 *    has no tabs and no equivalent, so this is held in MEMORY ONLY. That is
 *    the closest match to the web's intent — a session that cannot outlive
 *    the process and can never be confused with a real login — and it is
 *    strictly safer than persisting an admin-issued token to disk.
 * ──────────────────────────────────────────────────────────────────────
 */

export interface ImpersonationInfo {
  userId?: string;
  email?: string;
  name?: string;
  [key: string]: unknown;
}

let token: string | null = null;
let info: ImpersonationInfo | null = null;

/**
 * Start a read-only session. Called by the navigator when a deep link
 * carrying an admin-issued impersonation token opens the app.
 */
export const beginImpersonation = (
  impersonationToken: string,
  impersonationInfo?: ImpersonationInfo | null,
): void => {
  token = impersonationToken || null;
  info = impersonationInfo ?? null;
};

export const isImpersonating = (): boolean => !!token;

export const getImpersonationToken = (): string | null => token;

export const getImpersonationInfo = (): ImpersonationInfo | null => info;

/**
 * Methods that change state — refused entirely during impersonation.
 * Ported verbatim; the allow-list, not a block-list, so a method nobody
 * thought of is refused rather than let through.
 */
export const isMutatingMethod = (method?: string): boolean =>
  !['get', 'head', 'options'].includes(String(method || 'get').toLowerCase());

/** "Return to Admin" — ends the local read-only session. */
export const clearImpersonation = (): void => {
  token = null;
  info = null;
};

/**
 * Parse the deep link the admin app opens.
 *
 * Accepts the app scheme (`equityhub://imp?token=…&info=…`) and the
 * web form (`…/#imp=…&info=…`), so a link generated for the web client still
 * works if it reaches the app. `info` is base64 JSON on both.
 */
export const parseImpersonationLink = (
  url: string,
): { token: string; info: ImpersonationInfo | null } | null => {
  try {
    const m = /[#&?]imp(?:ersonationToken)?=([^&]+)/.exec(url)
      ?? /[#&?]token=([^&]+)/.exec(url);
    if (!m?.[1]) return null;

    let parsed: ImpersonationInfo | null = null;
    const im = /[#&?]info=([^&]+)/.exec(url);
    if (im?.[1]) {
      // `atob` does not exist in React Native; Buffer does. The web reads
      // this with JSON.parse over a decoded base64 string, and a malformed
      // one must not stop the session starting — the token is what matters,
      // the info is only what the banner shows.
      try {
        const json = Buffer.from(decodeURIComponent(im[1]), 'base64').toString('utf8');
        parsed = JSON.parse(json) as ImpersonationInfo;
      } catch {
        parsed = null;
      }
    }

    return { token: decodeURIComponent(m[1]), info: parsed };
  } catch {
    return null;
  }
};
