/**
 * In-memory candle aggregation (CANDLE_FLUSH_MS) must store the same candles,
 * broadcast the same live candles, and serve the same charts as the per-tick
 * writer it replaces.
 *
 * One scripted tick stream is played twice — through the per-tick path and
 * through the aggregator — each in its own process against its own throwaway
 * database. The stream deliberately includes what could break a merge:
 *
 *   - a 10-minute pause (gap-filled with flat candles) and a 7-hour pause
 *     (left as a gap — longer than MAX_GAP_MS)
 *   - late, out-of-order ticks: inside the current bucket, one bucket back,
 *     and several buckets back (those take the per-tick path by design)
 *   - a candle that already exists when the stream starts (a history backfill)
 *   - an option-style symbol writing only 1m/5m/15m
 *   - a missing quantity (NaN volume — must stay "NaN" in both)
 *   - tiny prices that MongoDB formats with an exponent
 *   - a restart halfway, after a graceful flush, so the second half starts
 *     from what is stored rather than from memory
 *
 * Compared afterwards:
 *   1. every stored candle, every field, as exact strings
 *   2. every live candle broadcast, in order (numbers compared as numbers —
 *      the aggregator formats high/low with JavaScript, the per-tick path
 *      with MongoDB's $toString; clients parse them either way)
 *   3. getCandles() at checkpoints mid-stream, including while candles are
 *      still unflushed
 * and the database work each mode did.
 *
 * Needs a local MongoDB; exits 0 with SKIPPED if there is none.
 *
 *   node tests/candleCoalesce.test.js
 */
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const SYMBOLS = ['CC_A', 'CC_B', 'CC_OPT', 'CC_NAN', 'CC_TINY', 'CC_PRE'];
const T0 = Date.UTC(2026, 9, 5, 4, 0, 0); // a weekday morning (UTC)

// Deterministic PRNG so both modes see the identical stream.
const rng = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const buildStream = () => {
  const r = rng(Number(process.env.CC_SEED) || 20261005); // CC_SEED varies the stream
  const px = { CC_A: 100, CC_B: 2000, CC_OPT: 45, CC_NAN: 10, CC_TINY: 0.00000015, CC_PRE: 50 };
  const clock = Object.fromEntries(SYMBOLS.map((s) => [s, T0]));
  const ticks = [];
  let pausedA = false;
  let pausedB = false;
  for (let i = 0; i < 1600; i++) {
    const sym = SYMBOLS[Math.floor(r() * SYMBOLS.length)];
    // 2–20 s apart: ~50 minutes per symbol, several ticks per 1m bucket, many rollovers.
    let step = 2000 + Math.floor(r() * 18000);
    // The pauses fire on the first tick of that symbol past the mark, so they
    // always happen (picking a fixed index missed them — the symbol is random).
    if (sym === 'CC_A' && i >= 400 && !pausedA) { step = 10 * 60 * 1000; pausedA = true; }    // gap → flat fill
    if (sym === 'CC_B' && i >= 700 && !pausedB) { step = 7 * 3600 * 1000; pausedB = true; }   // gap > 6h → left open
    clock[sym] += step;
    let ts = clock[sym];
    const late = r();
    if (late < 0.03) ts -= 5000;              // late, same or previous bucket
    else if (late < 0.045) ts -= 70 * 1000;   // a bucket or two back
    else if (late < 0.05) ts -= 5 * 60 * 1000; // several buckets back
    px[sym] = sym === 'CC_TINY'
      ? Math.max(1e-9, px[sym] * (1 + (r() - 0.5) * 0.02))
      : Math.max(0.05, px[sym] * (1 + (r() - 0.5) * 0.004));
    const decimals = sym === 'CC_TINY' ? 12 : 2 + Math.floor(r() * 3);
    let price = px[sym].toFixed(decimals);
    if (r() < 0.1 && sym !== 'CC_TINY') price = Number(price).toFixed(decimals + 1); // trailing zero
    const qty = sym === 'CC_NAN' ? undefined : sym === 'CC_B' ? '0' : (r() < 0.3 ? '0' : (r() * 2).toFixed(3));
    const t = { symbol: sym, price, quantity: qty, ts };
    if (sym === 'CC_OPT') t.timeframes = ['1m', '5m', '15m'];
    ticks.push(t);
  }
  return ticks;
};

// ── child: play [from, to) of the stream in one mode ───────────────────
const child = async (mode, dbName, from, to, outFile) => {
  process.env.CANDLE_FLUSH_MS = mode === 'coalesced' ? '3600000' : '0'; // timer never fires; flushes are explicit
  const mongoose = require('mongoose');
  await mongoose.connect(`mongodb://127.0.0.1:27017/${dbName}`, { monitorCommands: true });
  const broadcasts = [];
  const ws = require('../src/websocket/server');
  ws.broadcastCandle = (symbol, tf, c) => broadcasts.push([symbol, tf, new Date(c.openTime).getTime(),
    c.open, Number(c.high), Number(c.low), c.close, Number(c.volume), new Date(c.closeTime).getTime()]);
  const Candle = require('../src/models/Candle');
  await Candle.init();
  const cs = require('../src/services/candleService');

  let writeOps = 0, roundTrips = 0, reads = 0, counting = true;
  mongoose.connection.getClient().on('commandStarted', (ev) => {
    if (!counting || ev.command[ev.commandName] !== 'candles') return;
    roundTrips += 1;
    if (ev.commandName === 'findAndModify') writeOps += 1;
    else if (ev.commandName === 'update') writeOps += ev.command.updates.length;
    else if (ev.commandName === 'find') reads += 1;
  });

  if (from === 0) {
    // A backfilled candle already sitting in the first buckets of CC_PRE.
    counting = false;
    await Candle.insertMany([
      { symbol: 'CC_PRE', timeframe: '1m', openTime: new Date(T0 - (T0 % 60000) + 60000), closeTime: new Date(T0 - (T0 % 60000) + 120000), open: '49.5', high: '51.25', low: '48.75', close: '50.10', volume: '12.5' },
      { symbol: 'CC_PRE', timeframe: '1d', openTime: new Date(T0 - (T0 % 864e5)), closeTime: new Date(T0 - (T0 % 864e5) + 864e5), open: '47', high: '53', low: '46', close: '49.9', volume: '1000' },
    ]);
    counting = true;
  }

  const stream = buildStream();
  const r = rng(Number(process.env.CC_FLUSH_SEED) || 77); // CC_FLUSH_SEED varies when flushes land
  const checkpoints = [];
  for (let i = from; i < to; i++) {
    await cs.updateCandlesForTrade(stream[i]);
    if (mode === 'coalesced' && r() < 0.12) await cs.flushCandles();
    if (i % 250 === 125) {
      counting = false;
      const snap = {};
      for (const s of SYMBOLS) for (const tf of ['1m', '5m', '1h']) {
        snap[`${s}|${tf}`] = (await cs.getCandles(s, tf, 6)).map((c) =>
          [new Date(c.openTime).getTime(), c.open, Number(c.high), Number(c.low), c.close, Number(c.volume)]);
      }
      checkpoints.push(snap);
      counting = true;
    }
  }
  if (mode === 'coalesced') { await cs.flushCandles(); await cs.flushCandles(); } // graceful shutdown
  counting = false;
  require('fs').writeFileSync(outFile, JSON.stringify({ broadcasts, checkpoints, writeOps, roundTrips, reads, stats: cs.coalesceStats }));
  await mongoose.disconnect();
  process.exit(0);
};

// ── parent ──────────────────────────────────────────────────────────────
const run = (mode, dbName, from, to, outFile) => {
  const res = spawnSync(process.execPath, [__filename, 'child', mode, dbName, String(from), String(to), outFile], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`${mode} child failed:\n${res.stderr || res.stdout}`);
  return JSON.parse(require('fs').readFileSync(outFile, 'utf8'));
};

const parent = async () => {
  const mongoose = require('mongoose');
  try {
    await mongoose.connect('mongodb://127.0.0.1:27017/admin', { serverSelectionTimeoutMS: 2000 });
  } catch (e) {
    console.log('SKIPPED — no local MongoDB (' + e.message + ')');
    process.exit(0);
  }
  const os = require('os');
  const stamp = Date.now();
  const dbs = { pertick: `cc_pertick_${stamp}`, coalesced: `cc_coalesced_${stamp}` };
  const N = buildStream().length;
  const HALF = Math.floor(N / 2);
  const out = (m, part) => path.join(os.tmpdir(), `cc_${m}_${part}_${stamp}.json`);

  // Each mode plays the first half, "restarts", and plays the second half.
  const result = {};
  for (const mode of ['pertick', 'coalesced']) {
    const a = run(mode, dbs[mode], 0, HALF, out(mode, 1));
    const b = run(mode, dbs[mode], HALF, N, out(mode, 2));
    result[mode] = {
      broadcasts: [...a.broadcasts, ...b.broadcasts],
      checkpoints: [...a.checkpoints, ...b.checkpoints],
      writeOps: a.writeOps + b.writeOps, roundTrips: a.roundTrips + b.roundTrips, reads: a.reads + b.reads,
      stats: [a.stats, b.stats],
    };
  }

  const dump = async (db) => (await mongoose.connection.client.db(db).collection('candles')
    .find({}, { projection: { _id: 0 } }).sort({ symbol: 1, timeframe: 1, openTime: 1 }).toArray())
    .map((c) => [c.symbol, c.timeframe, c.openTime.getTime(), c.closeTime.getTime(), c.open, c.high, c.low, c.close, c.volume]);
  const A = await dump(dbs.pertick);
  const B = await dump(dbs.coalesced);

  let pass = 0; const fails = [];
  const check = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fails.push(name); console.log('  FAIL ' + name + '\n       ' + e.message.split('\n').slice(0, 6).join('\n       ')); } };

  console.log(`\n${N} ticks, ${SYMBOLS.length} symbols, restart after tick ${HALF}`);
  check(`stored candles identical, every field as exact strings (${A.length} candles)`, () => {
    assert.strictEqual(B.length, A.length, 'candle count');
    for (let i = 0; i < A.length; i++) assert.deepStrictEqual(B[i], A[i], `candle ${i}: ${JSON.stringify(A[i].slice(0, 3))}`);
  });
  check('the gap-filled pause produced the same flat candles', () => {
    const flat = (rows) => rows.filter((c) => c[0] === 'CC_A' && c[8] === '0' && c[4] === c[5] && c[5] === c[6] && c[6] === c[7]).length;
    assert.ok(flat(A) > 0, 'expected flat fill candles in the per-tick run');
    assert.strictEqual(flat(B), flat(A));
  });
  check('NaN volume stays "NaN" in both', () => {
    assert.ok(A.some((c) => c[0] === 'CC_NAN' && c[8] === 'NaN'));
    assert.deepStrictEqual(B.filter((c) => c[0] === 'CC_NAN'), A.filter((c) => c[0] === 'CC_NAN'));
  });
  check('the option-style symbol has only 1m/5m/15m in both', () => {
    const tfs = (rows) => [...new Set(rows.filter((c) => c[0] === 'CC_OPT').map((c) => c[1]))].sort();
    assert.deepStrictEqual(tfs(A), ['15m', '1m', '5m']);
    assert.deepStrictEqual(tfs(B), tfs(A));
  });
  check('the pre-existing backfilled candle merged the same way', () => {
    const pre = (rows) => rows.filter((c) => c[0] === 'CC_PRE' && (c[1] === '1d' || c[2] === T0 - (T0 % 60000) + 60000));
    assert.deepStrictEqual(pre(B), pre(A));
  });
  check(`every live broadcast identical, in order (${result.pertick.broadcasts.length})`, () => {
    const a = result.pertick.broadcasts; const b = result.coalesced.broadcasts;
    assert.strictEqual(b.length, a.length, 'broadcast count');
    for (let i = 0; i < a.length; i++) {
      const same = a[i].every((x, k) => (typeof x === 'number' && Number.isNaN(x) ? Number.isNaN(b[i][k]) : x === b[i][k]));
      assert.ok(same, `broadcast ${i}\n per-tick  ${JSON.stringify(a[i])}\n coalesced ${JSON.stringify(b[i])}`);
    }
  });
  check(`getCandles identical at ${result.pertick.checkpoints.length} checkpoints, including unflushed candles`, () => {
    const a = result.pertick.checkpoints; const b = result.coalesced.checkpoints;
    assert.strictEqual(b.length, a.length, 'checkpoint count');
    a.forEach((snap, ci) => {
      for (const k of Object.keys(snap)) {
        const ra = snap[k]; const rb = b[ci][k] || [];
        const n = Math.max(ra.length, rb.length);
        for (let i = 0; i < n; i++) {
          assert.strictEqual(JSON.stringify(rb[i]), JSON.stringify(ra[i]),
            `checkpoint ${ci}, ${k}, row ${i}\n per-tick  ${JSON.stringify(ra[i])}\n coalesced ${JSON.stringify(rb[i])}`);
        }
      }
    });
  });

  const pt = result.pertick; const co = result.coalesced;
  console.log('\n  database work for the same stream:');
  console.log(`    per-tick:  ${pt.writeOps} candle writes, ${pt.roundTrips} round trips, ${pt.reads} reads`);
  console.log(`    coalesced: ${co.writeOps} candle writes, ${co.roundTrips} round trips, ${co.reads} reads   (flushed every ~8 ticks here; in production every CANDLE_FLUSH_MS)`);
  console.log(`    aggregator stats: ${JSON.stringify(co.stats[1])}`);

  for (const db of Object.values(dbs)) {
    await mongoose.connection.client.db(db).collection('candles').indexes().catch(() => {});
    await mongoose.connection.client.db(db).dropDatabase();
  }
  await mongoose.disconnect();
  console.log(`\n${pass}/${pass + fails.length} checks passed`);
  process.exit(fails.length ? 1 : 0);
};

if (process.argv[2] === 'child') {
  const [, , , mode, db, from, to, outFile] = process.argv;
  child(mode, db, Number(from), Number(to), outFile).catch((e) => { console.error(e); process.exit(1); });
} else {
  parent().catch((e) => { console.error(e); process.exit(1); });
}
