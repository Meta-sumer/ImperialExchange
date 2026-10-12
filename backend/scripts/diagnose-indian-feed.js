#!/usr/bin/env node
/**
 * diagnose-indian-feed.js — where do NIFTY / NSE prices come from, and why have
 * they stopped?
 *
 * Indian instruments can be priced by one of three providers, chosen by the
 * INDIAN_FEED env var, and the choice is not obvious from the outside:
 *
 *   INDIAN_FEED=yahoo   → Yahoo Finance, free, no key        (yahooFeed)
 *   INDIAN_FEED=upstox  → Upstox (upstoxFeed). Upstox advertises a 1-year
 *                         "Analytics" token, but this platform had one killed
 *                         server-side at ~44 days, and v2 has no refresh_token
 *                         grant — so upstoxAuth re-does the whole TOTP login
 *                         daily after 03:30 IST and reactively on any 401.
 *                         indianFeedSupervisor watches it and flips Yahoo on
 *                         when Upstox goes dark — but it ONLY supervises when
 *                         INDIAN_FEED is exactly 'upstox'
 *   INDIAN_FEED=dhan    → Dhan paid Data API                 (dhanFeed)
 *   unset               → Yahoo, unless Dhan credentials are present
 *
 * All of them are additionally SESSION-GATED: Indian instruments are only
 * polled while NSE is actually open (09:15-15:30 IST, weekdays, minus
 * holidays). A stale price is therefore normal outside those hours and only a
 * problem during them.
 *
 * Run it ON the server, during market hours for the most useful answer:
 *   docker compose exec backend node scripts/diagnose-indian-feed.js
 *
 * Only ever prints WHETHER a credential is set, never its value.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const has = (v) => (v ? 'set' : 'NOT set');
const ms = (n) => `${n.toFixed(0)} ms`;
const ago = (d) => {
  if (!d) return 'never';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} hours ago`;
  return `${(s / 86400).toFixed(1)} DAYS ago`;
};

(async () => {
  // ── 1. Which provider is configured ──────────────────────────────────
  const f = String(process.env.INDIAN_FEED || '').toLowerCase();
  const dhanCreds = !!(process.env.DHAN_CLIENT_ID && process.env.DHAN_ACCESS_TOKEN);

  console.log('Configuration');
  console.log('  INDIAN_FEED           :', f || '(unset -> auto)');
  console.log('  DHAN_CLIENT_ID        :', has(process.env.DHAN_CLIENT_ID));
  console.log('  DHAN_ACCESS_TOKEN     :', has(process.env.DHAN_ACCESS_TOKEN));
  console.log('  UPSTOX_ACCESS_TOKEN   :', has(process.env.UPSTOX_ACCESS_TOKEN));

  // Decode the token expiry. Upstox issues BOTH a daily token (dies ~03:30 IST
  // the next morning) and long-lived ones running months out, and they look
  // identical from the outside — the only way to tell is the exp claim. Doing it
  // here rather than in a shell one-liner because quoting a JWT through
  // docker exec truncates the payload and JSON.parse then dies mid-object.
  // Prints ONLY the timestamps, never any part of the token itself.
  const tok = process.env.UPSTOX_ACCESS_TOKEN;
  if (tok) {
    try {
      const parts = String(tok).split('.');
      if (parts.length < 2) throw new Error('not a JWT (no payload segment)');
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (!claims.exp) {
        console.log('  token expiry          : no exp claim — cannot tell daily from long-lived');
      } else {
        const exp = new Date(claims.exp * 1000);
        const days = (exp - Date.now()) / 86400000;
        const kind = days < 0 ? 'EXPIRED'
          : days < 1.5 ? 'DAILY — dies ~03:30 IST tomorrow, needs renewing every morning'
          : `long-lived — ${Math.round(days)} days left`;
        console.log('  token expiry          :', exp.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), 'IST');
        console.log('  token kind            :', kind);
        if (days < 0) {
          console.log('                          THIS is why nothing is arriving. Every poll 401s.');
        }
      }
    } catch (e) {
      console.log('  token expiry          : could not decode —', e.message);
      // A decode failure INSIDE this script (no shell to mangle it) means the
      // stored value itself is malformed — almost always a JWT that was pasted
      // into .env incomplete. Upstox then rejects every request with 401, which
      // looks exactly like an expired token. Report the SHAPE so the difference
      // is obvious, without ever printing the token.
      const parts = String(tok).split('.');
      console.log('  token shape           :', parts.length, 'segments,', String(tok).length, 'chars total');
      parts.forEach((p, n) => {
        let state;
        try {
          const dec = Buffer.from(p, 'base64url').toString('utf8');
          JSON.parse(dec);
          state = 'decodes to valid JSON';
        } catch (_) {
          state = n === 2 ? 'signature (not JSON — expected)' : 'TRUNCATED / not valid JSON';
        }
        console.log(`    segment ${n} (${String(p.length).padStart(4)} chars)  : ${state}`);
      });
      if (parts.length === 3) {
        console.log('                          A JWT with 3 segments whose PAYLOAD will not decode is');
        console.log('                          a truncated paste. Re-copy the whole token into .env');
        console.log('                          (watch for line wrapping) and recreate the container.');
      }
    }
  }

  // The decisive Upstox question. Upstox advertises a 1-year "Analytics"
  // token, but this platform had one invalidated server-side at ~44 days, and
  // Upstox v2 has no refresh_token grant — recovering means redoing the whole
  // login -> auth-code -> exchange. upstoxAuth automates that with the account
  // TOTP (daily after 03:30 IST, plus reactively on any 401). Without all six
  // vars there is NO auto-refresh and the feed dies whenever the manual token
  // does, silently, until someone notices the chart has stopped.
  let upstoxAuto = false;
  try { upstoxAuto = require('../src/services/upstoxAuth').isConfigured(); } catch (_) {}
  console.log('  upstox auto-refresh   :', upstoxAuto ? 'CONFIGURED (token renews itself)' : 'NOT configured — manual token only');
  if (!upstoxAuto && f === 'upstox') {
    for (const v of ['UPSTOX_API_KEY', 'UPSTOX_API_SECRET', 'UPSTOX_REDIRECT_URI', 'UPSTOX_TOTP_SECRET', 'UPSTOX_MOBILE', 'UPSTOX_PIN']) {
      if (!process.env[v]) console.log('      missing           :', v);
    }
  }

  // A persisted token means auto-refresh has succeeded at least once; its age
  // says whether it is still doing so.
  try {
    const tf = process.env.UPSTOX_TOKEN_FILE || require('path').join(__dirname, '..', '.upstox-token.json');
    if (require('fs').existsSync(tf)) {
      const j = JSON.parse(require('fs').readFileSync(tf, 'utf8'));
      console.log('  last auto-refresh     :', ago(j.obtainedAt));
    } else if (upstoxAuto) {
      console.log('  last auto-refresh     : never — the token file does not exist yet');
    }
  } catch (_) { /* best effort */ }

  let intended;
  if (f === 'yahoo') intended = 'YAHOO';
  else if (f === 'upstox') intended = 'UPSTOX';
  else if (f === 'dhan') intended = 'DHAN';
  else intended = dhanCreds ? 'DHAN (auto — Dhan creds present)' : 'YAHOO (auto — no Dhan creds)';
  console.log('  intended provider     :', intended);

  const yahooFeed = require('../src/services/yahooFeed');
  console.log('  yahooFeed._enabled()  :', yahooFeed._enabled());
  if (f === 'upstox') {
    console.log('  supervisor            : ACTIVE — will flip Yahoo on if Upstox goes dark');
  } else {
    console.log('  supervisor            : INACTIVE — it only guards INDIAN_FEED=upstox.');
    if (f === 'dhan' && !dhanCreds) {
      console.log('                          WARNING: Dhan is forced but has no credentials, and');
      console.log('                          nothing will fall back. This prices nothing.');
    }
  }

  // ── 2. Is the market even open? ──────────────────────────────────────
  const mh = require('../src/services/marketHours');
  const now = new Date();
  console.log('\nSession');
  console.log('  now (IST)             :', now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
  for (const ex of ['NSE', 'NFO', 'MCX']) {
    let s = {};
    try { s = mh.getSession(ex, now); } catch (e) { s = { state: 'ERR ' + e.message }; }
    console.log(`  ${ex.padEnd(22)}:`, s.state, s.reason ? `(${s.reason})` : '');
  }
  const nseOpen = (() => { try { return mh.isExchangeOpen('NSE'); } catch (_) { return false; } })();
  if (!nseOpen) {
    console.log('  NOTE                  : NSE is CLOSED. Indian instruments are session-gated,');
    console.log('                          so a frozen price right now is EXPECTED, not a fault.');
    console.log('                          Re-run between 09:15 and 15:30 IST on a weekday.');
  }

  // ── 3. How stale is the stored price? ────────────────────────────────
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('\nMONGODB_URI is not set — cannot check stored prices.'); process.exit(1); }
  await mongoose.connect(uri, { maxPoolSize: 3, serverSelectionTimeoutMS: 10000, family: 4 });
  const Instrument = require('../src/models/Instrument');

  const sel = 'symbol exchange segment underlying lastPrice lastPriceUpdatedAt priceChangedAt externalProvider priceSimulator';
  const HEADLINE = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX', 'RELIANCE', 'TCS'];

  // Fetch the headline indices BY NAME. Sorting the whole universe
  // alphabetically and taking the first 400 is not a sample — with ~11k mostly
  // option rows it cut off at "B", so BANKNIFTY showed and NIFTY did not, which
  // is exactly the symbol you are looking at when you run this.
  const named = await Instrument.find({ symbol: { $in: HEADLINE }, isActive: true }).select(sel).lean();
  const rows = await Instrument.find({ exchange: { $in: ['NSE', 'NFO', 'BSE'] }, isActive: true })
    .select(sel)
    .limit(400)
    .lean();

  console.log(`\nStored Indian prices (${rows.length} active instruments)`);
  const byHeadline = (a, b) => HEADLINE.indexOf(a.symbol) - HEADLINE.indexOf(b.symbol);
  const show = (named.length ? named.sort(byHeadline) : rows).slice(0, 8);
  console.log('  symbol'.padEnd(20), 'lastPrice'.padStart(12), '  written'.padEnd(16), 'CHANGED');
  console.log('  ' + '-'.repeat(70));
  for (const r of show) {
    console.log(
      '  ' + String(r.symbol).padEnd(18),
      String(r.lastPrice ?? '—').padStart(12),
      '  ' + ago(r.lastPriceUpdatedAt).padEnd(14),
      ago(r.priceChangedAt)
    );
  }

  // The honest signal: a feed can keep WRITING the same value. priceChangedAt
  // only moves when the number actually moved.
  const fresh = rows.filter((r) => r.priceChangedAt && Date.now() - new Date(r.priceChangedAt).getTime() < 10 * 60 * 1000);
  console.log(`\n  moved in the last 10 min: ${fresh.length} of ${rows.length}`);
  if (nseOpen && fresh.length === 0) {
    console.log('  => NSE is open but NOTHING has moved. The Indian feed is not delivering.');
  }

  // SOME instruments moving while the provider is down is the dangerous case,
  // not the reassuring one: priceSimulator writes a synthetic price and the real
  // provider overlays its own on top. When the provider dies the numbers keep
  // ticking, high/low keeps forming and the chart keeps drawing — so "prices are
  // arriving" does NOT prove the feed is alive. Name what is actually moving.
  if (fresh.length) {
    const simulated = fresh.filter((r) => r.priceSimulator && r.priceSimulator.enabled);
    const real = fresh.filter((r) => !(r.priceSimulator && r.priceSimulator.enabled));
    console.log(`  of those: ${simulated.length} SIMULATED, ${real.length} from a real provider`);
    if (simulated.length) {
      console.log('  WARNING: these are synthetic prices — priceSimulator.enabled is true.');
      console.log('           They move, form candles and look live while the feed is dead:');
      console.log('          ', simulated.slice(0, 10).map((r) => r.symbol).join(', ') + (simulated.length > 10 ? ` …+${simulated.length - 10}` : ''));
    }
    if (real.length) {
      const byProv = new Map();
      for (const r of real) byProv.set(r.externalProvider || '(none)', (byProv.get(r.externalProvider || '(none)') || 0) + 1);
      console.log('  real movers by externalProvider:', [...byProv].map(([p, n]) => `${p}=${n}`).join(', '));
      console.log('          ', real.slice(0, 10).map((r) => r.symbol).join(', ') + (real.length > 10 ? ` …+${real.length - 10}` : ''));
    }
  }

  // ── 4. Can we reach Yahoo right now? ─────────────────────────────────
  // Proves whether the free fallback would work if it were engaged.
  console.log('\nLive reachability test — Yahoo ^NSEI (NIFTY 50 spot)');
  const t0 = process.hrtime.bigint();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=1d&interval=1m', {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
    });
    clearTimeout(timer);
    const took = Number(process.hrtime.bigint() - t0) / 1e6;
    if (!res.ok) {
      console.log('  HTTP', res.status, '— Yahoo refused the request.', ms(took));
    } else {
      const j = await res.json();
      const meta = j?.chart?.result?.[0]?.meta;
      console.log('  HTTP 200 in', ms(took));
      console.log('  live NIFTY spot       :', meta?.regularMarketPrice ?? '(absent)');
      console.log('  Yahoo market state    :', meta?.marketState ?? '(absent)');
      const stored = named.find((r) => String(r.symbol).toUpperCase() === 'NIFTY');
      if (stored && meta?.regularMarketPrice) {
        const drift = Number(stored.lastPrice) - Number(meta.regularMarketPrice);
        console.log('  stored NIFTY          :', stored.lastPrice, `(off by ${drift.toFixed(2)} vs live)`);
      }
    }
  } catch (e) {
    console.log('  FAILED:', e.message);
    console.log('  => The server cannot reach Yahoo. Even the free fallback cannot price');
    console.log('     Indian instruments from here — check egress/DNS/firewall.');
  }

  await mongoose.disconnect();
  console.log('\nReading this: if NSE is OPEN, nothing has moved in 10 minutes, and the');
  console.log('Yahoo test above succeeded, then the provider is configured but not running —');
  console.log('check `docker compose logs backend | grep -iE "yahoo|upstox|dhan"`.');
})().catch((e) => { console.error(e); process.exit(1); });
