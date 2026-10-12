/**
 * upstoxAuth.js — automatic Upstox access-token refresh so the Indian feed's
 * token NEVER silently dies again (see indianFeedSupervisor.js for the outage
 * that motivated this).
 *
 * WHY: Upstox market-quote tokens die (the "1-year Analytics token" got
 * server-side-invalidated at ~44 days). There is NO refresh_token grant in
 * Upstox v2 — you must re-run the login → auth-code → token exchange. The only
 * step that normally needs a human is the browser login; we automate it with
 * the account's TOTP (2FA) secret.
 *
 * WHAT this does:
 *   - refreshToken(): TOTP auto-login → get OAuth `code` → exchange for a fresh
 *     access_token → hot-reload it into process.env.UPSTOX_ACCESS_TOKEN (the
 *     feed reads that var every poll, so NO restart needed) + persist to disk.
 *   - loadPersistedToken(): on boot, load the last good token from disk (so a
 *     restart keeps the fresh token, not the stale .env one).
 *   - refreshDaily(): once/day after 03:30 IST (Upstox's daily invalidation).
 *   - maybeReactiveRefresh(): throttled trigger fired by upstoxFeed on a 401,
 *     so a mid-day invalidation self-heals within a minute.
 *
 * REQUIRED .env (all needed for auto-login; without them auto-refresh is off
 * and you fall back to a manually-set UPSTOX_ACCESS_TOKEN):
 *   UPSTOX_API_KEY, UPSTOX_API_SECRET, UPSTOX_REDIRECT_URI  (from the Upstox app)
 *   UPSTOX_TOTP_SECRET   base32 secret shown when you enabled TOTP 2FA on Upstox
 *   UPSTOX_MOBILE        10-digit registered mobile
 *   UPSTOX_PIN           6-digit account PIN
 * Optional:
 *   UPSTOX_TOKEN_FILE    where to persist the token (default backend/.upstox-token.json)
 *
 * ⚠️ The auto-login hits Upstox's *login-service* endpoints, which are NOT part
 * of the public API contract and can change. The token EXCHANGE (final step) is
 * the documented, stable endpoint. If auto-login breaks, `scripts/upstox-login.js`
 * (one browser login) is the always-works fallback — and the step logs below
 * make the broken step obvious so the endpoint can be adjusted.
 */
const fs = require('fs');
const path = require('path');
const { authenticator } = require('otplib');

const AUTH_BASE = 'https://api.upstox.com/v2/login/authorization';
const LOGIN_BASE = 'https://service.upstox.com/login/open'; // login-service (undocumented)
const TIMEOUT_MS = 12000;

const TOKEN_FILE = process.env.UPSTOX_TOKEN_FILE
  || path.join(__dirname, '..', '..', '.upstox-token.json');

let _refreshing = false;       // guard against concurrent refreshes
let _lastAttemptAt = 0;        // throttle reactive refreshes
const REACTIVE_MIN_GAP_MS = 10 * 60 * 1000; // at most one reactive refresh / 10 min

const isConfigured = () => Boolean(
  process.env.UPSTOX_API_KEY && process.env.UPSTOX_API_SECRET
  && process.env.UPSTOX_REDIRECT_URI && process.env.UPSTOX_TOTP_SECRET
  && process.env.UPSTOX_MOBILE && process.env.UPSTOX_PIN,
);

// ── small fetch helpers (manual redirect + cookie jar) ──────────────────
async function _fetch(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { redirect: 'manual', signal: ctl.signal, ...opts });
  } finally { clearTimeout(t); }
}
const _cookies = (res, jar) => {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const c of list) { const kv = c.split(';')[0]; const i = kv.indexOf('='); if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
};
const _cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

const _totp = () => authenticator.generate(process.env.UPSTOX_TOTP_SECRET);

// ── the automated login → OAuth authorization `code` ────────────────────
// NOTE: login-service endpoints/shapes are undocumented. Each step logs its
// status so a break is diagnosable; the final exchange is the documented API.
async function _getAuthCode() {
  const jar = {};
  const H = { 'Content-Type': 'application/json', Accept: 'application/json', 'x-device-details': 'platform=WEB' };

  // 1FA — register the mobile, obtain the validateOTPToken (TOTP-based accounts
  // don't need an SMS OTP send; the token carries into 2FA).
  let r = await _fetch(`${LOGIN_BASE}/v6/auth/1fa`, {
    method: 'POST', headers: H, body: JSON.stringify({ data: { mobileNumber: String(process.env.UPSTOX_MOBILE) } }),
  });
  _cookies(r, jar);
  let j = await r.json().catch(() => ({}));
  console.log(`[UpstoxAuth] 1fa: HTTP ${r.status}`);
  const validateOTPToken = j?.data?.validateOTPToken || j?.data?.validateOtpToken || null;
  if (!r.ok && !validateOTPToken) throw new Error(`1fa failed: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);

  // 2FA — submit the TOTP.
  r = await _fetch(`${LOGIN_BASE}/v3/auth/2fa`, {
    method: 'POST',
    headers: { ...H, Cookie: _cookieHeader(jar) },
    body: JSON.stringify({ data: { twoFAMethod: 'SECRET', inputText: _totp() }, validateOTPToken }),
  });
  _cookies(r, jar);
  j = await r.json().catch(() => ({}));
  console.log(`[UpstoxAuth] 2fa(totp): HTTP ${r.status}`);
  if (!r.ok) throw new Error(`2fa failed: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);

  // PIN — submit the account PIN (some accounts require this 3rd factor).
  r = await _fetch(`${LOGIN_BASE}/v3/auth/2fa`, {
    method: 'POST',
    headers: { ...H, Cookie: _cookieHeader(jar) },
    body: JSON.stringify({ data: { twoFAMethod: 'PIN', inputText: String(process.env.UPSTOX_PIN) }, validateOTPToken }),
  });
  _cookies(r, jar);
  console.log(`[UpstoxAuth] pin: HTTP ${r.status}`);

  // Authorize — with the session cookies, hit the OAuth dialog. It 302-redirects
  // to <redirect_uri>?code=<CODE>; we read the Location header (don't follow).
  const dialog = `${AUTH_BASE}/dialog?response_type=code`
    + `&client_id=${encodeURIComponent(process.env.UPSTOX_API_KEY)}`
    + `&redirect_uri=${encodeURIComponent(process.env.UPSTOX_REDIRECT_URI)}`;
  r = await _fetch(dialog, { method: 'GET', headers: { Cookie: _cookieHeader(jar), Accept: 'application/json' } });
  const loc = r.headers.get('location') || '';
  console.log(`[UpstoxAuth] dialog: HTTP ${r.status} -> ${loc ? loc.split('?')[0] + '?…' : '(no redirect)'}`);
  const code = (loc.match(/[?&]code=([^&]+)/) || [])[1];
  if (!code) throw new Error(`no auth code in redirect (HTTP ${r.status}). Session/login step likely failed.`);
  return decodeURIComponent(code);
}

// ── documented, stable token exchange: auth code → access_token ─────────
async function exchangeCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: process.env.UPSTOX_API_KEY,
    client_secret: process.env.UPSTOX_API_SECRET,
    redirect_uri: process.env.UPSTOX_REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  const r = await _fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`token exchange failed: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j.access_token;
}

// ── persistence + hot-reload ────────────────────────────────────────────
function _persist(token) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ access_token: token, obtainedAt: new Date().toISOString() }), 'utf8');
  } catch (e) { console.error('[UpstoxAuth] could not persist token file:', e.message); }
}
const _apply = (token) => { process.env.UPSTOX_ACCESS_TOKEN = token; };

// Load the last good token from disk on boot so a restart keeps the FRESH token
// (the one in .env may be the old dead one). Returns true if a token was loaded.
function loadPersistedToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return false;
    const { access_token: tok } = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (tok) { _apply(tok); console.log('[UpstoxAuth] loaded persisted access token from disk'); return true; }
  } catch (e) { console.error('[UpstoxAuth] could not read token file:', e.message); }
  return false;
}

/**
 * Full refresh: TOTP auto-login → code → exchange → apply + persist.
 * Returns true on success. Never throws (logs + returns false) so callers/cron
 * stay simple.
 */
async function refreshToken() {
  if (!isConfigured()) return false;
  if (_refreshing) return false;
  _refreshing = true;
  _lastAttemptAt = Date.now();
  try {
    console.log('[UpstoxAuth] refreshing access token via TOTP auto-login…');
    const code = await _getAuthCode();
    const token = await exchangeCode(code);
    _apply(token);
    _persist(token);
    console.log('[UpstoxAuth] ✅ access token refreshed + applied (feed picks it up next poll).');
    return true;
  } catch (e) {
    console.error('[UpstoxAuth] ❌ refresh failed:', e.message,
      '\n   → auto-login may need adjustment; use scripts/upstox-login.js (browser once) meanwhile.');
    return false;
  } finally { _refreshing = false; }
}

// Once/day, shortly after Upstox's 03:30 IST invalidation. IST day-guarded so a
// success won't re-run; a failure clears the guard to retry next slow-tick.
let _lastRefreshDay = null;
async function refreshDaily() {
  if (!isConfigured()) return;
  if ((process.env.INDIAN_FEED || '').toLowerCase() !== 'upstox') return;
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' });
  const p = {}; for (const x of f.formatToParts(new Date())) p[x.type] = x.value;
  const day = `${p.year}-${p.month}-${p.day}`;
  const hour = Number(p.hour) === 24 ? 0 : Number(p.hour);
  if (hour < 3 || hour >= 9) return;         // 03:xx–08:xx IST window (post 03:30 reset, pre-market)
  if (_lastRefreshDay === day) return;       // already refreshed today
  const ok = await refreshToken();
  if (ok) _lastRefreshDay = day; // only latch on success → retries until it works
}

// Fired by upstoxFeed on a 401. Throttled so a storm of 401s → one refresh.
async function maybeReactiveRefresh() {
  if (!isConfigured()) return;
  if (_refreshing) return;
  if (Date.now() - _lastAttemptAt < REACTIVE_MIN_GAP_MS) return;
  console.log('[UpstoxAuth] 401 detected — attempting reactive token refresh…');
  await refreshToken();
}

module.exports = {
  isConfigured, loadPersistedToken, refreshToken, refreshDaily, maybeReactiveRefresh,
  exchangeCode, saveToken: _persist, TOKEN_FILE,
};
