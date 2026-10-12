/**
 * Regression: the Indian feed flapped DOWN -> RECOVERED all session, and every
 * flip changed where NSE prices came from, which chopped up the charts.
 *
 * Two independent defects, both about WHEN health was reported.
 *
 * 1. Reported too LATE. _loop reported success only after _pollOnce had fully
 *    finished — and that includes a candle write for every instrument whose
 *    price moved. Measured against the live cluster that phase ran tens of
 *    seconds, past the supervisor's 45s HEALTHY_MS, so it declared the feed
 *    dead in the middle of a poll that was going fine, engaged the Yahoo
 *    fallback, then disengaged it when the poll finally reported in.
 *
 * 2. Reported when NOTHING was fetched. _pollOnce returns early if there are no
 *    instruments or no resolvable quote keys. _loop reported those as healthy
 *    polls, so a feed fetching nothing was indistinguishable from a working
 *    one. That is the phantom RECOVERED.
 *
 * Health is now reported inside _pollOnce, the moment Upstox answers. These
 * tests pin that ordering, and cover the instrument cache added alongside it —
 * whose real risk is lastPrice going stale and making every instrument look
 * changed on every poll.
 *
 *   node tests/upstoxFeedHealth.test.js
 */
const assert = require('assert');
const Module = require('module');
const path = require('path');

// ── Stubs ────────────────────────────────────────────────────────────
const calls = [];                 // ordered log of everything that happened
let instruments = [];
let findCalls = 0;
let fetchStatus = 200;
let priceToReturn = 101;

const chain = (v) => ({ select: () => chain(v), lean: async () => v });
let heartbeatIds = null;
const InstrumentStub = {
  find: () => { findCalls += 1; calls.push('find'); return chain(instruments); },
  bulkWrite: async () => { calls.push('bulkWrite'); return { ok: 1 }; },
  updateMany: async (filter, update) => {
    calls.push('heartbeat');
    heartbeatIds = filter && filter._id && filter._id.$in;
    heartbeatFields = Object.keys((update && update.$set) || {});
    return { ok: 1 };
  },
};
let heartbeatFields = [];

const candleStub = {
  TF_MS: { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
    '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000 },
  updateCandlesForTrade: async () => {
    calls.push('candle');
    // Deliberately yields. The whole point of the fix is that health is
    // reported BEFORE this phase drains, so it must not run synchronously.
    await new Promise((r) => setImmediate(r));
  },
};

const supervisorStub = {
  reportUpstox: (ok) => { calls.push(ok ? 'report:ok' : 'report:fail'); },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../models/Instrument') return InstrumentStub;
  if (request === './candleService') return candleStub;
  if (request === './indianFeedSupervisor') return supervisorStub;
  if (request === './feedOrchestrator') return { recordTick: () => {}, recordConnection: () => {}, recordError: () => {} };
  return origLoad.apply(this, arguments);
};
const feed = require(path.join(__dirname, '../src/services/upstoxFeed.js'));
// The override STAYS in place. upstoxFeed requires the supervisor lazily, from
// inside the poll — `require('./indianFeedSupervisor')` at call time, not at
// load time — so restoring the loader here would hand it the real module and
// every health assertion below would silently observe nothing.

// Upstox echoes the key we sent back as instrument_token.
global.fetch = async (url) => {
  calls.push('http');
  const key = decodeURIComponent(String(url).split('instrument_key=')[1] || '').split(',')[0];
  return {
    ok: fetchStatus >= 200 && fetchStatus < 300,
    status: fetchStatus,
    json: async () => ({ data: { x: { instrument_token: key, last_price: priceToReturn } } }),
  };
};

process.env.UPSTOX_ACCESS_TOKEN = 'test.test.test';

const EQ = (over = {}) => ({
  _id: 'id1', symbol: 'RELIANCE', exchange: 'NSE', segment: 'EQ',
  isin: 'INE002A01018', pricePrecision: 2, lastPrice: '100', ...over,
});

const reset = (insts) => {
  calls.length = 0;
  findCalls = 0;
  fetchStatus = 200;
  priceToReturn = 101;
  instruments = insts;
  feed.invalidateInstruments();
};

let passed = 0;
let total = 0;
// Counted, not hard-coded. A literal in the summary drifts the moment a check
// is added or split, and a test run that misreports its own total is worth less
// than one that says nothing.
const check = (label, fn) => {
  total += 1;
  try { fn(); console.log('  ok   ' + label); passed += 1; }
  catch (e) { console.log('  FAIL ' + label); console.log('       ' + e.message); process.exitCode = 1; }
};

(async () => {
  console.log('upstox feed health reporting');

  // ── 1. A poll that fetched nothing is NOT healthy ──────────────────
  reset([]);
  await feed._pollOnce();
  check('no instruments -> health is never reported', () => {
    assert.ok(!calls.includes('report:ok'), `reported healthy: ${calls.join(',')}`);
  });

  // An equity with no isin resolves no key, so the poll cannot fetch anything.
  reset([EQ({ isin: null })]);
  await feed._pollOnce();
  check('no resolvable quote key -> health is never reported', () => {
    assert.ok(!calls.includes('report:ok'), `reported healthy: ${calls.join(',')}`);
    assert.ok(!calls.includes('http'), 'should not have called Upstox at all');
  });

  // ── 2. Health is reported as soon as Upstox answers ────────────────
  reset([EQ()]);
  await feed._pollOnce();
  check('a successful fetch reports health', () => {
    assert.ok(calls.includes('report:ok'), `never reported: ${calls.join(',')}`);
  });
  check('health is reported BEFORE any candle is written', () => {
    const r = calls.indexOf('report:ok');
    const c = calls.indexOf('candle');
    // Both must be PRESENT before comparing. indexOf returns -1 when absent,
    // and -1 < anything is true — so without these two assertions this passes
    // most loudly in exactly the case where health was never reported at all.
    assert.notStrictEqual(r, -1, `health was never reported: ${calls.join(',')}`);
    assert.notStrictEqual(c, -1, `expected a candle write in this poll: ${calls.join(',')}`);
    assert.ok(r < c, `report at ${r} must precede first candle at ${c}: ${calls.join(',')}`);
  });
  check('...and after the HTTP call, so it reflects a real answer', () => {
    const h = calls.indexOf('http');
    const r = calls.indexOf('report:ok');
    assert.notStrictEqual(h, -1, `no HTTP call was made: ${calls.join(',')}`);
    assert.notStrictEqual(r, -1, `health was never reported: ${calls.join(',')}`);
    assert.ok(h < r, `http at ${h} must precede report at ${r}: ${calls.join(',')}`);
  });

  // ── 3. A dead token still fails loudly ─────────────────────────────
  // _ltp throws when every chunk fails, so _pollOnce propagates and _loop
  // reports the failure. The fix must not have swallowed that path.
  reset([EQ()]);
  fetchStatus = 401;
  let threw = false;
  try { await feed._pollOnce(); } catch (_) { threw = true; }
  check('a 401 from Upstox still throws, so _loop can report a failure', () => {
    assert.ok(threw, 'expected _pollOnce to propagate the 401');
    assert.ok(!calls.includes('report:ok'), `must not report healthy: ${calls.join(',')}`);
  });

  // ── 4. The instrument cache ────────────────────────────────────────
  reset([EQ()]);
  await feed._pollOnce();
  const firstFinds = findCalls;
  priceToReturn = 102;                       // move the price so work still happens
  await feed._pollOnce();
  check('a second poll inside the TTL does not re-query instruments', () => {
    assert.strictEqual(firstFinds, 1, `expected 1 query on the first poll, got ${firstFinds}`);
    assert.strictEqual(findCalls, 1, `expected no second query, got ${findCalls}`);
  });

  // The real hazard of caching: if lastPrice is not mirrored onto the cached
  // document, every instrument looks changed on every poll and the entire
  // candle universe is rewritten each cycle.
  calls.length = 0;
  await feed._pollOnce();                    // same price as the poll before
  check('an unchanged price writes no candle, so cached lastPrice is current', () => {
    assert.ok(!calls.includes('candle'), `wrote a candle for an unchanged price: ${calls.join(',')}`);
    assert.ok(!calls.includes('bulkWrite'), 'should not have written prices either');
  });

  check('an unchanged poll still reports health', () => {
    assert.ok(calls.includes('report:ok'), `a quiet market is not an outage: ${calls.join(',')}`);
  });

  // ── 5. The feed heartbeat ──────────────────────────────────────────
  // feedUpdatedAt means "a feed answered for this instrument", not "the price
  // moved". utils/feedGuard rejects a B-book fill with STALE_FEED once it is
  // older than FEED_STALE_MS (10s), so an instrument that simply isn't moving
  // must still have it refreshed or it becomes untradeable while the feed is
  // perfectly healthy.
  // reset() calls invalidateInstruments(), which also clears the heartbeat
  // clock — otherwise an earlier test in this file has already tripped the
  // throttle and the heartbeat would be suppressed here for reasons that have
  // nothing to do with what is being tested.
  reset([EQ()]);
  await feed._pollOnce();                      // first poll: price moves
  calls.length = 0; heartbeatIds = null; heartbeatFields = [];
  await feed._pollOnce();                      // second poll: same price
  check('an unchanged price still refreshes feedUpdatedAt', () => {
    assert.ok(calls.includes('heartbeat'), `no heartbeat: ${calls.join(',')}`);
    assert.deepStrictEqual(heartbeatFields, ['feedUpdatedAt'],
      `heartbeat must touch ONLY feedUpdatedAt, got ${heartbeatFields.join(',')}`);
  });
  check('...for exactly the instruments that did not move', () => {
    assert.ok(Array.isArray(heartbeatIds) && heartbeatIds.length === 1, 'expected one quiet instrument');
  });
  check('...and writes no price and no candle', () => {
    assert.ok(!calls.includes('candle'), `wrote a candle: ${calls.join(',')}`);
    assert.ok(!calls.includes('bulkWrite'), `wrote a price: ${calls.join(',')}`);
  });

  // Immediately after one fires, another must not — otherwise a 1500ms poll
  // would rewrite every quiet instrument on every cycle.
  calls.length = 0;
  await feed._pollOnce();
  check('the heartbeat is throttled between polls', () => {
    assert.ok(!calls.includes('heartbeat'), `heartbeat ignored its throttle: ${calls.join(',')}`);
  });

  // The case the heartbeat exists for: nothing moved at all, so `bulk` is empty
  // and the early return would skip straight past it. Cleared throttle so this
  // tests the RETURN ordering rather than the throttle again.
  feed.invalidateInstruments();
  calls.length = 0;
  await feed._pollOnce();
  check('a completely still market still heartbeats (the early return)', () => {
    assert.ok(calls.includes('heartbeat'), `no heartbeat on a still market: ${calls.join(',')}`);
    assert.ok(!calls.includes('bulkWrite'), 'nothing moved, so no price should be written');
  });

  // ── 6. Invalidation forces a fresh read ────────────────────────────
  feed.invalidateInstruments();
  findCalls = 0;
  priceToReturn = 103;
  await feed._pollOnce();
  check('invalidateInstruments() forces the next poll to re-query', () => {
    assert.strictEqual(findCalls, 1, `expected a fresh query, got ${findCalls}`);
  });

  Module._load = origLoad;
  console.log(`\n${passed}/${total} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
