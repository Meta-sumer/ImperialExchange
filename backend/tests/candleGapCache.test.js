/**
 * Regression: the candle gap check asked the database what it had just written.
 *
 * updateCandlesForTrade calls _backfillGaps before every upsert, and that began
 * with a findOne for the newest candle of (symbol, timeframe). With eight
 * timeframes, one tick was 16 sequential round trips instead of 8 — and the
 * answer to the query was nearly always the candle the previous tick had
 * written moments earlier. On the live cluster this collection was taking 331
 * writes/s and holding 851% DB busy, about 95% of all the work on it.
 *
 * The fix remembers the newest bucket per (symbol, timeframe) in memory and
 * skips the query when the jump is one bucket or less. These tests pin the two
 * halves of that: the query really is skipped in the common case, and it is
 * still made — with gap filling intact — in every case where a hole is possible.
 *
 *   node tests/candleGapCache.test.js
 */
const assert = require('assert');
const Module = require('module');
const path = require('path');

// ── Stub the two modules candleService pulls in ──────────────────────
// It needs a Candle model and a broadcaster; neither should touch a database
// or a socket here. Everything else loads for real.
let findOneCalls = 0;
let bulkWrites = [];
let upserts = [];
let upsertThrows = false;
let newestDoc = null;          // what the stubbed findOne reports as the last candle

const chain = (value) => ({
  sort: () => chain(value),
  limit: () => chain(value),
  lean: async () => value,
});

const CandleStub = {
  findOne: () => { findOneCalls += 1; return chain(newestDoc); },
  bulkWrite: async (ops) => { bulkWrites.push(ops); return { ok: 1 }; },
  findOneAndUpdate: async (filter) => {
    if (upsertThrows) throw new Error('write failed');
    upserts.push(filter);
    return {
      openTime: filter.openTime,
      closeTime: filter.openTime,
      open: '1', high: '1', low: '1', close: '1', volume: '0',
    };
  },
};
const broadcasterStub = { broadcastCandle: () => {} };

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../models/Candle') return CandleStub;
  if (request === '../websocket/server') return broadcasterStub;
  return origLoad.apply(this, arguments);
};
const candleService = require(path.join(__dirname, '../src/services/candleService.js'));
Module._load = origLoad;

const { updateCandlesForTrade, TF_MS } = candleService;
const MIN = TF_MS['1m'];

// Every tick in these tests is for one timeframe, so "round trips" stays
// readable: one findOne is one gap check.
const tick = (symbol, bucketTs, tf) => updateCandlesForTrade({
  symbol, price: '100', quantity: '0', ts: bucketTs, timeframes: [tf || '1m'],
});

const reset = () => { findOneCalls = 0; bulkWrites = []; upserts = []; upsertThrows = false; };

let passed = 0;
const check = (label, fn) => {
  try { fn(); console.log('  ok   ' + label); passed += 1; }
  catch (e) { console.log('  FAIL ' + label); console.log('       ' + e.message); process.exitCode = 1; }
};

(async () => {
  console.log('candle gap-check cache');

  // A base time far from any real clock so buckets are predictable.
  const T0 = 1750000000000 - (1750000000000 % MIN);

  // ── 1. Cold cache still asks the database ──────────────────────────
  reset();
  newestDoc = null;
  await tick('COLD', T0);
  check('first tick for a symbol still queries for the last candle', () => {
    assert.strictEqual(findOneCalls, 1, `expected 1 query, got ${findOneCalls}`);
  });

  // ── 2. Same bucket, and the next one, skip the query ───────────────
  reset();
  await tick('COLD', T0);              // same bucket as the tick above
  check('a second tick in the SAME bucket makes no query', () => {
    assert.strictEqual(findOneCalls, 0, `expected 0 queries, got ${findOneCalls}`);
  });

  reset();
  await tick('COLD', T0 + MIN);        // exactly the next bucket — no hole
  check('a tick in the NEXT bucket makes no query', () => {
    assert.strictEqual(findOneCalls, 0, `expected 0 queries, got ${findOneCalls}`);
  });

  // ── 3. A real jump falls through to the database ───────────────────
  reset();
  newestDoc = { openTime: new Date(T0 + MIN), close: '100' };
  await tick('COLD', T0 + (3 * MIN));  // two buckets skipped
  check('a tick that skips buckets DOES query, so a gap can be filled', () => {
    assert.strictEqual(findOneCalls, 1, `expected 1 query, got ${findOneCalls}`);
  });
  check('and the skipped buckets are actually written', () => {
    assert.strictEqual(bulkWrites.length, 1, 'expected one gap-fill bulkWrite');
    assert.strictEqual(bulkWrites[0].length, 1, `expected 1 filled bucket, got ${bulkWrites[0].length}`);
  });

  // ── 4. Out-of-order ticks do not trigger a query ───────────────────
  // The cache now holds T0+3m. A late tick for an older bucket has no gap
  // ahead of it, so there is nothing to fill and nothing to ask.
  reset();
  await tick('COLD', T0 + (2 * MIN));
  check('a late tick for an older bucket makes no query', () => {
    assert.strictEqual(findOneCalls, 0, `expected 0 queries, got ${findOneCalls}`);
  });

  // ── 5. The cache is keyed per symbol AND per timeframe ─────────────
  reset();
  newestDoc = null;
  await tick('OTHER', T0);
  check('a different symbol is cached separately, so it queries', () => {
    assert.strictEqual(findOneCalls, 1, `expected 1 query, got ${findOneCalls}`);
  });

  reset();
  await tick('OTHER', T0, '5m');
  check('a different timeframe on the same symbol also queries', () => {
    assert.strictEqual(findOneCalls, 1, `expected 1 query, got ${findOneCalls}`);
  });

  reset();
  await tick('OTHER', T0);
  check('...and the original timeframe is still cached', () => {
    assert.strictEqual(findOneCalls, 0, `expected 0 queries, got ${findOneCalls}`);
  });

  // ── 6. A failed write must not be remembered ───────────────────────
  // Otherwise a dropped upsert would suppress the gap fill that should have
  // covered its bucket, leaving a permanent hole in the chart.
  reset();
  newestDoc = null;
  upsertThrows = true;
  try { await tick('FAILED', T0); } catch (_) { /* expected */ }
  reset();
  newestDoc = null;
  await tick('FAILED', T0 + MIN);
  check('a bucket whose upsert threw is NOT remembered', () => {
    assert.strictEqual(findOneCalls, 1, `expected 1 query, got ${findOneCalls}`);
  });

  // ── 7. The large-gap rule is untouched ─────────────────────────────
  // Anything past MAX_GAP_MS (6h) must stay a real gap rather than become a
  // flat plateau at the stale price.
  reset();
  newestDoc = { openTime: new Date(T0), close: '100' };
  await tick('GAPPY', T0 + (8 * 60 * 60 * 1000));   // 8 hours later
  check('an 8-hour hole is still left unfilled', () => {
    assert.strictEqual(findOneCalls, 1, 'the jump should reach the database');
    assert.strictEqual(bulkWrites.length, 0, 'nothing should be back-filled across 8 hours');
  });

  // ── 8. The saving is real, measured the way production ticks ───────
  // Eight timeframes, then a second tick in the same buckets. Before the fix
  // that second tick cost eight more queries; now it costs none.
  reset();
  newestDoc = null;
  await updateCandlesForTrade({ symbol: 'BUSY', price: '100', quantity: '0', ts: T0 });
  const cold = findOneCalls;
  reset();
  await updateCandlesForTrade({ symbol: 'BUSY', price: '101', quantity: '0', ts: T0 });
  const warm = findOneCalls;
  check('a full 8-timeframe tick drops from 8 gap queries to 0 when warm', () => {
    assert.strictEqual(cold, 8, `expected 8 queries on the cold tick, got ${cold}`);
    assert.strictEqual(warm, 0, `expected 0 queries on the warm tick, got ${warm}`);
  });

  console.log(`\n${passed}/12 checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
