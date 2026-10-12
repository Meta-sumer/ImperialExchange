#!/usr/bin/env node
/**
 * diagnose-upstox-poll.js — why does the Indian feed flap DOWN/RECOVERED?
 *
 * The supervisor logs a repeating DOWN -> RECOVERED cycle all session. The DOWN
 * message reads "no successful poll", and that string is `lastErr || 'no
 * successful poll'` — so lastErr is EMPTY, which means reportUpstox(false, msg)
 * never ran. No poll reported a failure. The feed is not erroring; it is not
 * reporting anything at all for long enough that the supervisor gives up.
 *
 *   indianFeedSupervisor.HEALTHY_MS = 45s   no success within this -> not healthy
 *   indianFeedSupervisor.DOWN_MS    = 3min  market open this long with no success -> DOWN
 *
 * upstoxFeed reports health ONCE, after the whole poll finishes. So if a single
 * _pollOnce() takes longer than 45s, the supervisor times out mid-poll, engages
 * the Yahoo fallback, and then the poll completes and reports success — which
 * disengages it again. That is the flap, and it costs the chart its price
 * source twice per cycle.
 *
 * This measures the poll instead of assuming:
 *   1. token shape and expiry   (never prints the token itself)
 *   2. the instrument query      — one round trip over every Indian instrument
 *   3. ONE real quote request    — latency and, crucially, the HTTP status
 *   4. a short burst             — detects 429 rate limiting, which a single
 *                                  request cannot show
 *   5. extrapolated poll time vs the supervisor's thresholds
 *
 * Deliberately capped at a handful of requests. Upstox rate limits are the
 * thing being tested, so hammering it here would both distort the reading and
 * make production worse while it runs.
 *
 *   docker compose exec backend node scripts/diagnose-upstox-poll.js
 *
 * Read-only. Never prints UPSTOX_ACCESS_TOKEN.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const BASE = 'https://api.upstox.com';
const CHUNK = 500;                 // must match upstoxFeed.CHUNK
const BURST = 5;                   // how many requests to fire when probing for 429
const HEALTHY_MS = 45000;          // must match indianFeedSupervisor
const DOWN_MS = 180000;

const ms = (n) => `${n.toFixed(0)} ms`;
const sec = (n) => `${(n / 1000).toFixed(1)}s`;

const timed = async (fn) => {
  const t = process.hrtime.bigint();
  const v = await fn();
  return [v, Number(process.hrtime.bigint() - t) / 1e6];
};

(async () => {
  // ── 1. Token shape ───────────────────────────────────────────────────
  // Shape and expiry only. A JWT's payload is not a secret, but the token is —
  // so nothing here echoes it, not even truncated.
  const tok = process.env.UPSTOX_ACCESS_TOKEN || '';
  console.log('Token');
  console.log('  present             :', tok ? 'yes' : 'NO — the feed never starts without it');
  if (!tok) process.exit(0);
  const parts = tok.split('.');
  console.log('  length              :', tok.length, 'chars');
  console.log('  segments            :', parts.length, parts.length === 3 ? '(well-formed JWT)' : '(NOT a JWT — a truncated paste looks exactly like this)');
  if (parts.length === 3) {
    try {
      const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (p.exp) {
        const left = (p.exp * 1000 - Date.now()) / 1000;
        console.log('  expires             :', new Date(p.exp * 1000).toISOString(),
          left > 0 ? `(${sec(left * 1000)} left)` : '(EXPIRED — every request will 401)');
      }
    } catch (_) { console.log('  payload             : could not decode'); }
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI is not set'); process.exit(1); }
  await mongoose.connect(uri, { maxPoolSize: 3, serverSelectionTimeoutMS: 10000, family: 4 });
  const Instrument = require('../src/models/Instrument');
  // The REAL key resolver, not a copy of it. The request count is the whole
  // verdict here, and an approximation that treats EQ differently would skew it.
  const { feedKeyFor } = require('../src/services/upstoxFeed');

  // Fail loudly if it is not there. This script is usually copied into a
  // running container on its own, so it can easily be NEWER than the service it
  // imports from — and an undefined import throws per instrument, which, if
  // caught quietly, reports every instrument as unresolved and reads exactly
  // like a real data outage. That already happened once.
  if (typeof feedKeyFor !== 'function') {
    console.error('');
    console.error('feedKeyFor is not exported by the upstoxFeed.js in THIS container.');
    console.error('The container is running an older copy of the service than this script');
    console.error('expects, so nothing below would be trustworthy. Copy the service in too:');
    console.error('');
    console.error('  docker compose cp backend/src/services/upstoxFeed.js \\');
    console.error('    backend:/app/src/services/upstoxFeed.js');
    console.error('');
    console.error('or rebuild: docker compose build backend && docker compose up -d backend');
    process.exit(1);
  }

  // ── 2. The instrument query, exactly as the poll issues it ───────────
  console.log('');
  console.log('Poll phase 1 — load instruments');
  const [insts, tQuery] = await timed(() => Instrument.find({
    exchange: { $in: ['NSE', 'BSE', 'NFO', 'BFO', 'MCX'] }, isActive: true, marketDataEnabled: { $ne: false },
  }).select('_id symbol exchange segment underlying strike optionType isin upstoxKey pricePrecision tickSize lastPrice').lean());
  console.log('  instruments         :', insts.length.toLocaleString('en-US'));
  console.log('  query took          :', ms(tQuery));

  const isinBySym = new Map();
  for (const i of insts) if (i.segment === 'EQ' && i.isin) isinBySym.set(i.symbol, i.isin);
  const uniq = new Set();
  let direct = 0; let viaSpot = 0; let unresolved = 0; let threw = 0; let firstErr = '';
  for (const i of insts) {
    let m = { key: null };
    try {
      m = feedKeyFor(i, isinBySym) || { key: null };
    } catch (e) {
      // Counted and reported, never swallowed. A resolver that THROWS and a
      // resolver that legitimately returns null mean completely different
      // things, and collapsing them together is how a broken import gets
      // reported as missing market data.
      threw += 1;
      if (!firstErr) firstErr = e.message;
    }
    if (!m.key) { unresolved += 1; continue; }
    if (m.mode === 'spot') viaSpot += 1; else direct += 1;
    uniq.add(m.key);
  }
  if (threw) {
    console.log('');
    console.log(`  WARNING: feedKeyFor THREW for ${threw.toLocaleString('en-US')} instruments — "${firstErr}"`);
    console.log('  Those are counted as unresolved below, but the cause is the resolver, not');
    console.log('  the data. Fix this before reading anything else here.');
  }
  const keys = [...uniq];
  const chunks = Math.ceil(keys.length / CHUNK);
  console.log('  unique quote keys   :', keys.length.toLocaleString('en-US'));
  // A derivative resolved "via spot" is priced off its underlying rather than
  // its own contract, so it never shows a real premium even when Upstox is
  // perfectly healthy. Worth knowing before blaming the feed for bad F&O prices.
  console.log('  resolved direct     :', direct.toLocaleString('en-US'));
  console.log('  resolved via spot   :', viaSpot.toLocaleString('en-US'), '(priced off the underlying — no real premium)');
  console.log('  unresolved          :', unresolved.toLocaleString('en-US'), '(never priced by Upstox at all)');
  console.log('  requests per poll   :', chunks, `(CHUNK=${CHUNK}, issued SEQUENTIALLY)`);
  const perMin = Math.round(chunks * (60000 / (Number(process.env.UPSTOX_POLL_MS) || 1500)));
  console.log('  request rate        :', perMin.toLocaleString('en-US'), 'requests/minute at the configured poll interval');

  // ── 2b. WHY resolution failed ────────────────────────────────────────
  // Every key path needs one of three fields. Knowing which one is missing is
  // the difference between running a mapping script, a seed fix, or neither.
  //
  //   EQ      -> isin            (NSE_EQ|<isin>)
  //   F&O     -> upstoxKey       (the contract's own key, real premium)
  //           -> else underlying resolves via INDEX_UP, or via another EQ row's
  //              isin — so if NO equity carries an isin, stock derivatives
  //              cannot resolve either, even when their own data is fine
  //   index   -> underlying present in INDEX_UP
  if (unresolved) {
    const bySeg = new Map();
    let withIsin = 0; let withKey = 0; let withUnderlying = 0;
    for (const i of insts) {
      const s = i.segment || '(cash/index)';
      bySeg.set(s, (bySeg.get(s) || 0) + 1);
      if (i.isin) withIsin += 1;
      if (i.upstoxKey) withKey += 1;
      if (i.underlying) withUnderlying += 1;
    }
    console.log('');
    console.log('Why no key resolved — field coverage across all', insts.length.toLocaleString('en-US'), 'instruments');
    console.log('  have isin           :', withIsin.toLocaleString('en-US'), '(equities need this)');
    console.log('  have upstoxKey      :', withKey.toLocaleString('en-US'), '(F&O contracts need this for a real premium)');
    console.log('  have underlying     :', withUnderlying.toLocaleString('en-US'), '(indices resolve through it)');
    console.log('  isinBySym entries   :', isinBySym.size.toLocaleString('en-US'), '(stock derivatives borrow an equity isin — empty means they cannot)');
    console.log('');
    console.log('  by segment:');
    for (const [s, n] of [...bySeg.entries()].sort((a, b) => b[1] - a[1])) {
      console.log('   ', String(s).padEnd(14), n.toLocaleString('en-US'));
    }

    // Headline symbols by name, not by slicing an alphabetical list — a sample
    // taken off the front cuts off around "B" and NIFTY never appears.
    const HEAD = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX', 'RELIANCE', 'TCS'];
    console.log('');
    console.log('  headline instruments, as stored:');
    for (const name of HEAD) {
      const i = insts.find((x) => x.symbol === name);
      if (!i) { console.log('   ', name.padEnd(12), '(not in the active set)'); continue; }
      let m = { key: null };
      try { m = feedKeyFor(i, isinBySym) || { key: null }; } catch (_) { /* */ }
      console.log('   ', name.padEnd(12),
        'seg=' + String(i.segment || 'null').padEnd(6),
        'underlying=' + String(i.underlying || '—').padEnd(12),
        'isin=' + String(i.isin || '—').padEnd(14),
        'upstoxKey=' + String(i.upstoxKey || '—').padEnd(22),
        '=> ' + (m.key || 'NO KEY'));
    }
  }

  if (!keys.length) {
    console.log('');
    console.log('  No quote keys resolved, so the feed has never fetched a single price.');
    console.log('  _pollOnce returns early at `if (!uniq.size) return;` WITHOUT throwing, and');
    console.log('  the loop then calls reportUpstox(true) — a poll that fetched nothing counts');
    console.log('  as a healthy poll. That is the phantom RECOVERED in the log.');
    console.log('');
    console.log('  This is a DATA problem, not a token problem. Fix the missing field above');
    console.log('  before changing any feed code.');
    await mongoose.disconnect();
    return;
  }

  // ── 3. One real request ──────────────────────────────────────────────
  console.log('');
  console.log('Poll phase 2 — one quote request');
  const ask = async (slice) => {
    const url = `${BASE}/v2/market-quote/ltp?instrument_key=${encodeURIComponent(slice.join(','))}`;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' },
        signal: ctl.signal,
      });
      const body = await res.text().catch(() => '');
      return { status: res.status, ok: res.ok, body };
    } catch (e) {
      return { status: 0, ok: false, body: e.name === 'AbortError' ? 'timed out after 10s' : e.message };
    } finally { clearTimeout(t); }
  };

  const first = keys.slice(0, CHUNK);
  const [r1, t1] = await timed(() => ask(first));
  console.log('  HTTP                :', r1.status || '(no response)', 'in', ms(t1));
  if (r1.ok) {
    let n = 0;
    try { n = Object.keys(JSON.parse(r1.body).data || {}).length; } catch (_) { /* shape */ }
    console.log('  prices returned     :', n, 'of', first.length, 'asked');
    if (n === 0) {
      console.log('  NOTE                : accepted but returned nothing. _ltp counts that as a');
      console.log('                        SUCCESS, so the poll reports healthy while no price moves.');
    }
  } else {
    console.log('  body                :', String(r1.body).slice(0, 300));
    if (r1.status === 401) console.log('  >>> token rejected. Every chunk will fail, so the poll DOES throw.');
    if (r1.status === 429) console.log('  >>> RATE LIMITED on the very first request.');
  }

  // ── 4. Burst — is it rate limited? ───────────────────────────────────
  // One request cannot reveal a per-minute cap. The real poll fires `chunks`
  // requests back to back, every POLL_MS, so what matters is what happens to
  // request 2, 3, 4 — not request 1.
  console.log('');
  console.log(`Poll phase 3 — ${BURST} back-to-back requests (the poll fires ${chunks})`);
  const codes = [];
  for (let i = 0; i < BURST; i += 1) {
    const slice = keys.slice((i * CHUNK) % keys.length, (i * CHUNK) % keys.length + CHUNK);
    const [r, t] = await timed(() => ask(slice.length ? slice : first));
    codes.push(r.status);
    console.log(`  #${i + 1}  HTTP ${String(r.status || '---').padEnd(4)} ${ms(t).padStart(9)}`);
  }
  const limited = codes.filter((c) => c === 429).length;
  const okCount = codes.filter((c) => c >= 200 && c < 300).length;

  // ── 5. The verdict ───────────────────────────────────────────────────
  const avg = t1;
  const projected = chunks * avg;
  console.log('');
  console.log('Projected full poll');
  console.log(`  ${chunks} requests × ~${ms(avg)} each, sequential  =  ${sec(projected)}`);
  console.log('  plus candle writes for every changed instrument, which run after.');
  console.log('');
  console.log('  supervisor HEALTHY_MS :', sec(HEALTHY_MS), '— no success reported within this and it is "not healthy"');
  console.log('  supervisor DOWN_MS    :', sec(DOWN_MS), '— open this long with no success and it declares DOWN');
  console.log('');
  if (limited) {
    console.log(`  >>> RATE LIMITED: ${limited} of ${BURST} requests returned 429.`);
    console.log('      The poll fires', chunks, `requests every ${process.env.UPSTOX_POLL_MS || 1500}ms, which is far`);
    console.log('      above what Upstox allows per minute. Chunks fail, and because _ltp only');
    console.log('      throws when EVERY chunk fails, a partly-rate-limited poll still reports');
    console.log('      success — so prices are stale but the feed looks healthy.');
  } else if (okCount === 0) {
    console.log('  >>> Every request failed. That is a real outage and _ltp does throw, so the');
    console.log('      supervisor would log a reason. The observed DOWN said "no successful');
    console.log('      poll" with no reason attached, which is a DIFFERENT failure — see below.');
  }
  if (projected > HEALTHY_MS) {
    console.log('');
    console.log(`  >>> THIS IS THE FLAP. One poll takes ~${sec(projected)}, longer than the ${sec(HEALTHY_MS)}`);
    console.log('      health window. upstoxFeed reports health only ONCE, after the whole poll');
    console.log('      finishes, so the supervisor sees no success for the entire duration,');
    console.log('      declares DOWN and engages Yahoo — then the poll ends, reports success,');
    console.log('      and the fallback disengages. Repeat forever.');
  }

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
