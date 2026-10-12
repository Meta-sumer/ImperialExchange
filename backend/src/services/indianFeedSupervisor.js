/**
 * indianFeedSupervisor.js — keeps Indian prices alive when the primary Upstox
 * feed's DAILY token silently expires.
 *
 * Background: Upstox market-quote uses an access token that expires ~03:30 IST
 * every day. It's updated manually, has no auto-refresh, and nothing alerted on
 * failure — so on 2026-06/07 it died and the ENTIRE Indian market (NSE equity +
 * F&O + MCX) went dark for ~44 days unnoticed. This supervisor makes that
 * impossible to miss again.
 *
 * Roles:
 *   Upstox = primary  (real F&O premiums, but fragile daily token)
 *   Yahoo  = hot standby (no token; equity + index real, F&O = intrinsic only)
 *
 * Yahoo is ALREADY running (server starts it unconditionally) but only prices
 * Indian instruments when it's the active provider. This supervisor flips that
 * gate on/off via yahooFeed.setIndianFallback():
 *
 *   Upstox failing during Indian market hours → Yahoo starts pricing Indian
 *     instruments + a "feed down" alert email fires (once).
 *   Upstox healthy again → Yahoo stops pricing Indian + a "recovered" alert.
 *
 * Only supervises when INDIAN_FEED=upstox (i.e. Upstox is the intended primary).
 * Off-hours it does nothing, so it never false-alerts when the market is closed.
 *
 * Env:
 *   FEED_ALERT_EMAIL=ops@you.com   where to send down/recovery alerts (optional;
 *                                  falls back to ALERT_EMAIL, else console-only)
 */

const email = require('./emailService');

const CHECK_MS = 30 * 1000;        // evaluate health every 30s
const HEALTHY_MS = 45 * 1000;      // a successful Upstox poll within 45s = healthy
const DOWN_MS = 3 * 60 * 1000;     // no success for 3 min while market open = down
const FAIL_FAST = 40;              // 40 consecutive failed polls (~1 min @1.5s) = down now

let lastOkAt = 0;                  // last successful Upstox poll (ms)
let lastErr = '';                  // last Upstox error message (for the alert)
let consecutiveFails = 0;          // failed polls since the last success
let fallbackEngaged = false;       // is Yahoo currently pricing Indian instruments?
let _marketOpenSeenAt = 0;         // when we first saw the market open this session
let _timer = null;

/**
 * Called by upstoxFeed after EVERY poll — the supervisor's only health signal.
 *   ok=true  → a poll succeeded
 *   ok=false → a poll threw (401 token dead, network, etc.)
 */
const reportUpstox = (ok, errMsg) => {
  if (ok) {
    lastOkAt = Date.now();
    consecutiveFails = 0;
  } else {
    consecutiveFails += 1;
    if (errMsg) lastErr = String(errMsg);
  }
};

const _isIndianMarketOpen = () => {
  try {
    const mh = require('./marketHours');
    return mh.isExchangeOpen('NSE') || mh.isExchangeOpen('MCX');
  } catch (_) { return false; }
};

const _setFallback = (on) => {
  try { require('./yahooFeed').setIndianFallback(on); } catch (_) { /* yahoo optional */ }
};

const _evaluate = () => {
  const marketOpen = _isIndianMarketOpen();
  // Outside Indian market hours nothing ticks anyway — reset the open-timer and
  // leave state as-is (don't disengage a fallback mid-close; it re-checks at open).
  if (!marketOpen) { _marketOpenSeenAt = 0; return; }
  if (!_marketOpenSeenAt) _marketOpenSeenAt = Date.now();

  const now = Date.now();
  const okRecently = lastOkAt && (now - lastOkAt) < HEALTHY_MS;
  // Two independent "down" signals:
  //  - activelyFailing: Upstox IS polling but every poll errors (dead token now)
  //  - silentlyDead:    market's been open a while with zero successes (loop never
  //                     started / no token / crashed) — grace-timed off market-open
  const activelyFailing = consecutiveFails >= FAIL_FAST;
  const silentlyDead = (now - _marketOpenSeenAt > DOWN_MS) && !okRecently;
  const upstoxDown = !okRecently && (activelyFailing || silentlyDead);

  if (upstoxDown && !fallbackEngaged) {
    fallbackEngaged = true;
    _setFallback(true);
    _alertDown();
  } else if (okRecently && fallbackEngaged) {
    fallbackEngaged = false;
    _setFallback(false);
    _alertRecovered();
  }
};

const _to = () => process.env.FEED_ALERT_EMAIL || process.env.ALERT_EMAIL || '';

async function _alertDown() {
  const reason = lastErr || 'no successful poll';
  const msg = `Upstox Indian price feed is DOWN (${reason}). Indian prices have been auto-switched to the Yahoo fallback — NSE/BSE equity + indices stay live; F&O shows intrinsic value only (no real premium). ACTION: regenerate UPSTOX_ACCESS_TOKEN and restart the backend to restore real F&O premiums.`;
  console.error(`[IndianFeedSup] 🔴 ${msg}`);
  const to = _to();
  if (!to) return;
  try {
    await email.send({
      to,
      subject: '🔴 Indian price feed DOWN — Yahoo fallback engaged',
      html: `<div style="font-family:Segoe UI,Roboto,sans-serif;color:#111"><h2 style="color:#b91c1c">🔴 Upstox Indian feed down</h2><p>${msg}</p><p style="color:#666;font-size:13px"><b>Detected:</b> ${new Date().toISOString()}</p></div>`,
      text: `${msg}\n\nDetected: ${new Date().toISOString()}`,
    });
  } catch (_) { /* alert is best-effort; the fallback already saved trading */ }
}

async function _alertRecovered() {
  const msg = 'Upstox Indian price feed has RECOVERED. Indian prices are back on Upstox (real F&O premiums restored); the Yahoo fallback has been disengaged.';
  console.log(`[IndianFeedSup] 🟢 ${msg}`);
  const to = _to();
  if (!to) return;
  try {
    await email.send({
      to,
      subject: '🟢 Indian price feed recovered — back on Upstox',
      html: `<div style="font-family:Segoe UI,Roboto,sans-serif;color:#111"><h2 style="color:#15803d">🟢 Upstox Indian feed recovered</h2><p>${msg}</p><p style="color:#666;font-size:13px"><b>Recovered:</b> ${new Date().toISOString()}</p></div>`,
      text: `${msg}\n\nRecovered: ${new Date().toISOString()}`,
    });
  } catch (_) { /* best-effort */ }
}

const start = () => {
  if ((process.env.INDIAN_FEED || '').toLowerCase() !== 'upstox') return; // only guards an Upstox primary
  if (_timer) return;
  _timer = setInterval(_evaluate, CHECK_MS);
  console.log('[IndianFeedSup] Watching Upstox — auto-fallback to Yahoo + email alert on failure (set FEED_ALERT_EMAIL to receive alerts).');
};

const stop = () => { if (_timer) { clearInterval(_timer); _timer = null; } };

const getStatus = () => ({
  primary: 'UPSTOX',
  fallbackEngaged,
  activeIndianFeed: fallbackEngaged ? 'YAHOO (fallback)' : 'UPSTOX',
  lastUpstoxOkAt: lastOkAt ? new Date(lastOkAt).toISOString() : null,
  lastUpstoxOkAgeSec: lastOkAt ? Math.round((Date.now() - lastOkAt) / 1000) : null,
  consecutiveFails,
  lastError: lastErr || null,
});

module.exports = { start, stop, reportUpstox, getStatus };
