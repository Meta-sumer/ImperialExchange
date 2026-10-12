/**
 * Candle retention must delete exactly what the rules say — and nothing else.
 *
 * Seeds a throwaway database with candles across every timeframe and age,
 * for: a live equity, a contract expired long ago, a contract expired
 * recently (inside its grace period), and a symbol with no instrument record
 * (instrument symbols are unique in the schema, so expiry per symbol is
 * unambiguous) — plus orders, wallets
 * and positions that must never be touched. Then checks:
 *
 *   - the dry run deletes nothing and its counts equal the real deletion
 *   - exactly the expected candles go; 1d/1w and everything in-window stay
 *   - a symbol with no instrument record is never treated as expired
 *   - financial collections are untouched
 *   - a second run deletes nothing (idempotent)
 *   - a window below its floor is refused before anything runs
 *   - the daily slot runs only when switched on, in its hour, once a day
 *
 * Needs a local MongoDB; exits 0 with SKIPPED if there is none.
 *
 *   node tests/candleRetention.test.js
 */
const assert = require('assert');
const mongoose = require('mongoose');

(async () => {
  try {
    await mongoose.connect(`mongodb://127.0.0.1:27017/cret_test_${Date.now()}`, { serverSelectionTimeoutMS: 2000 });
  } catch (e) {
    console.log('SKIPPED — no local MongoDB (' + e.message + ')');
    process.exit(0);
  }
  const Candle = require('../src/models/Candle');
  const Instrument = require('../src/models/Instrument');
  await Candle.init();
  const ret = require('../src/services/candleRetention');
  const db = mongoose.connection.db;

  let pass = 0; const fails = [];
  const check = async (name, fn) => {
    try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fails.push(name); console.log('  FAIL ' + name + '\n       ' + e.message); }
  };

  const DAY = 864e5;
  const NOW = Date.UTC(2026, 9, 10, 0, 0, 0);
  const TF_MS = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '4h': 144e5, '1d': DAY, '1w': 7 * DAY };
  const mkInst = (symbol, expiryDate) => Instrument.collection.insertOne({ symbol, name: symbol, category: 'X', baseCurrency: 'X', quoteCurrency: 'INR', isActive: true, ...(expiryDate ? { expiryDate } : {}) });
  await mkInst('R_LIVE');
  await mkInst('R_OLDEXP', new Date(NOW - 60 * DAY));     // expired 60d ago -> all candles go
  await mkInst('R_NEWEXP', new Date(NOW - 5 * DAY));      // expired 5d ago -> inside grace, age rules only
  // R_ORPHAN has candles but no instrument -> age rules only

  // Candles at fixed ages (days) per timeframe; bucket-aligned openTimes.
  const AGES = [0.2, 2, 6, 8, 20, 40, 100, 400, 2000];
  const docs = [];
  const seen = new Set(); // several ages can share one 1d/1w bucket; the unique index allows one
  for (const sym of ['R_LIVE', 'R_OLDEXP', 'R_NEWEXP', 'R_ORPHAN']) {
    for (const [tf, ms] of Object.entries(TF_MS)) {
      for (const age of AGES) {
        const ot = Math.floor((NOW - age * DAY) / ms) * ms;
        if (seen.has(sym + tf + ot)) continue;
        seen.add(sym + tf + ot);
        docs.push({ symbol: sym, timeframe: tf, openTime: new Date(ot), closeTime: new Date(ot + ms), open: '1', high: '1', low: '1', close: '1', volume: '0' });
      }
    }
  }
  await Candle.insertMany(docs);
  await db.collection('orders').insertMany([{ symbol: 'R_OLDEXP', status: 'FILLED' }, { symbol: 'R_LIVE', status: 'FILLED' }]);
  await db.collection('positions').insertOne({ symbol: 'R_OLDEXP', status: 'CLOSED' });
  await db.collection('wallets').insertOne({ currency: 'INR', balance: '100' });

  // What the rules must remove, computed independently of the module.
  const KEEP = ret.DEFAULT_KEEP_DAYS; const GRACE = ret.DEFAULT_GRACE_DAYS;
  const shouldGo = (d) => {
    if (d.symbol === 'R_OLDEXP') return true;
    const days = KEEP[d.timeframe];
    return days != null && d.openTime.getTime() < NOW - days * DAY;
  };
  const expectedGone = docs.filter(shouldGo).length;
  const expectedLeft = docs.length - expectedGone;

  console.log(`\n${docs.length} candles seeded; the rules should remove ${expectedGone}`);
  let dry;
  await check('dry run deletes nothing', async () => {
    dry = await ret.runCandleRetention({ apply: false, keep: KEEP, graceDays: GRACE, now: NOW });
    assert.strictEqual(await Candle.countDocuments(), docs.length);
  });
  await check('dry-run count equals the independently computed expectation', async () => {
    assert.strictEqual(dry.total, expectedGone);
  });
  let applied;
  await check('apply removes exactly the expected candles, and the same number the dry run reported', async () => {
    applied = await ret.runCandleRetention({ apply: true, keep: KEEP, graceDays: GRACE, now: NOW });
    assert.strictEqual(applied.total, dry.total);
    assert.strictEqual(await Candle.countDocuments(), expectedLeft);
    const left = await Candle.find({}).lean();
    for (const d of left) assert.ok(!shouldGo(d), `kept a candle that should have gone: ${d.symbol} ${d.timeframe} ${d.openTime.toISOString()}`);
  });
  await check('1d and 1w are kept for every live symbol, at every age', async () => {
    for (const sym of ['R_LIVE', 'R_NEWEXP', 'R_ORPHAN']) {
      for (const tf of ['1d', '1w']) assert.strictEqual(await Candle.countDocuments({ symbol: sym, timeframe: tf }), docs.filter((d) => d.symbol === sym && d.timeframe === tf).length, `${sym} ${tf}`);
    }
  });
  await check('a contract past its grace loses everything; one inside grace keeps its in-window candles', async () => {
    assert.strictEqual(await Candle.countDocuments({ symbol: 'R_OLDEXP' }), 0);
    assert.ok(await Candle.countDocuments({ symbol: 'R_NEWEXP', timeframe: '1m' }) > 0);
  });
  await check('a symbol with no instrument record keeps its in-window candles (age rules only)', async () => {
    assert.strictEqual(await Candle.countDocuments({ symbol: 'R_ORPHAN' }), await Candle.countDocuments({ symbol: 'R_LIVE' }));
  });
  await check('orders, positions and wallets untouched', async () => {
    assert.strictEqual(await db.collection('orders').countDocuments(), 2);
    assert.strictEqual(await db.collection('positions').countDocuments(), 1);
    assert.strictEqual(await db.collection('wallets').countDocuments(), 1);
  });
  await check('a second run deletes nothing', async () => {
    const again = await ret.runCandleRetention({ apply: true, keep: KEEP, graceDays: GRACE, now: NOW });
    assert.strictEqual(again.total, 0);
  });
  await check('a window below its floor is refused before anything runs', async () => {
    const before = await Candle.countDocuments();
    await assert.rejects(() => ret.runCandleRetention({ apply: true, keep: { ...KEEP, '1h': 7 }, graceDays: GRACE, now: NOW }), /floor/);
    assert.throws(() => ret.readConfig({ CANDLE_KEEP_1M: '0.5' }), /floor/);
    assert.strictEqual(await Candle.countDocuments(), before);
  });
  await check('env config: defaults when unset, overrides when valid', async () => {
    assert.deepStrictEqual(ret.readConfig({}).keep, KEEP);
    assert.strictEqual(ret.readConfig({ CANDLE_KEEP_1M: '14', CANDLE_EXPIRED_GRACE_DAYS: '7' }).keep['1m'], 14);
    assert.strictEqual(ret.readConfig({ CANDLE_EXPIRED_GRACE_DAYS: '7' }).graceDays, 7);
  });
  await check('daily slot: off unless CANDLE_RETENTION=on; then only in its hour, once a day', async () => {
    delete process.env.CANDLE_RETENTION;
    assert.strictEqual(await ret.runDailyIfDue(new Date(Date.UTC(2026, 9, 10, 22, 5))), null, 'off by default');
    process.env.CANDLE_RETENTION = 'on';
    process.env.CANDLE_RETENTION_HOUR_UTC = '22';
    assert.strictEqual(await ret.runDailyIfDue(new Date(Date.UTC(2026, 9, 10, 21, 5))), null, 'wrong hour');
    const first = await ret.runDailyIfDue(new Date(Date.UTC(2026, 9, 10, 22, 5)));
    assert.ok(first && first.apply === true, 'runs in its hour');
    assert.strictEqual(await ret.runDailyIfDue(new Date(Date.UTC(2026, 9, 10, 22, 50))), null, 'once a day');
    delete process.env.CANDLE_RETENTION;
  });

  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init().catch(() => {})));
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  console.log(`\n${pass}/${pass + fails.length} checks passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
