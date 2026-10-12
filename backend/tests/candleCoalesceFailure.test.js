/**
 * When a candle flush fails, nothing may be corrupted, double-counted, or
 * retried forever.
 *
 *   A. the database reports WHICH writes failed (a bulk write error with
 *      indexes): exactly those are retried, volume included — the result is
 *      the same as if nothing had failed
 *   B. the outcome is UNKNOWN (connection dropped mid-write): prices are
 *      retried (re-applying them is harmless) but that interval's volume is
 *      dropped rather than risk adding it twice. A failed per-tick write lost
 *      the whole tick, so this is no worse than before
 *   C. the write keeps failing: after 3 attempts it is dropped and counted,
 *      never retried forever, and the next tick for that candle works
 *
 * Needs a local MongoDB; exits 0 with SKIPPED if there is none.
 *
 *   node tests/candleCoalesceFailure.test.js
 */
process.env.CANDLE_FLUSH_MS = '3600000'; // coalescing on; the timer never fires — flushes are explicit
const assert = require('assert');
const mongoose = require('mongoose');

(async () => {
  const db = `ccfail_${Date.now()}`;
  try {
    await mongoose.connect(`mongodb://127.0.0.1:27017/${db}`, { serverSelectionTimeoutMS: 2000 });
  } catch (e) {
    console.log('SKIPPED — no local MongoDB (' + e.message + ')');
    process.exit(0);
  }
  require('../src/websocket/server').broadcastCandle = () => {};
  const Candle = require('../src/models/Candle');
  await Candle.init();
  const cs = require('../src/services/candleService');
  const realBulkWrite = Candle.bulkWrite.bind(Candle);

  let pass = 0; const fails = [];
  const check = async (name, fn) => {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fails.push(name); console.log('  FAIL ' + name + '\n       ' + e.message); }
    finally { Candle.bulkWrite = realBulkWrite; }
  };

  const B = Date.UTC(2026, 9, 5, 5, 0, 0); // every tick below lands in this one 1m bucket
  const play = async (symbol, ticks) => {
    for (const [i, [price, qty]] of ticks.entries()) {
      await cs.updateCandlesForTrade({ symbol, price, quantity: qty, ts: B + 1000 + i * 1000, timeframes: ['1m'] });
    }
  };
  const stored = (symbol) => Candle.findOne({ symbol, timeframe: '1m', openTime: new Date(B) }).lean();
  const TICKS = [['100.5', '1'], ['101.25', '2'], ['99.75', '0.5'], ['100', '1.5'], ['100.8', '3']];
  const want = { open: '100.5', high: '101.25', low: '99.75', close: '100.8', volume: '8' };
  const ohlcv = (c) => c && { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };

  console.log('\n— failure handling in the candle aggregator —');

  await check('A. reported failure: only the failed write is retried, volume intact', async () => {
    await play('CF_A1', TICKS);
    await play('CF_A2', TICKS);
    // Apply every write except one, and report that one as failed by index.
    Candle.bulkWrite = async (ops, opts) => {
      const failIdx = ops.findIndex((o) => o.updateOne.filter.symbol === 'CF_A2');
      await realBulkWrite(ops.filter((_, i) => i !== failIdx), opts);
      const err = new Error('simulated write error'); err.writeErrors = [{ index: failIdx }];
      throw err;
    };
    await cs.flushCandles();
    Candle.bulkWrite = realBulkWrite;
    assert.deepStrictEqual(ohlcv(await stored('CF_A1')), want, 'the write that succeeded');
    assert.strictEqual(await stored('CF_A2'), null, 'the failed write has not landed yet');
    await cs.flushCandles(); // the retry
    assert.deepStrictEqual(ohlcv(await stored('CF_A2')), want, 'after the retry: same as no failure, volume included');
  });

  await check('B. unknown outcome: prices retried, the interval\'s volume dropped (never doubled)', async () => {
    await play('CF_B', TICKS);
    Candle.bulkWrite = async () => { throw new Error('simulated: connection lost'); };
    await cs.flushCandles();
    Candle.bulkWrite = realBulkWrite;
    await cs.flushCandles();
    const c = ohlcv(await stored('CF_B'));
    assert.deepStrictEqual({ ...c, volume: undefined }, { ...want, volume: undefined }, 'open/high/low/close intact');
    assert.strictEqual(c.volume, '0', 'volume of the failed interval dropped');
  });

  await check('C. persistent failure: dropped after 3 attempts, counted, and the next tick works', async () => {
    await play('CF_C', TICKS.slice(0, 2));
    const before = cs.coalesceStats.droppedOps;
    Candle.bulkWrite = async () => { throw new Error('simulated: still down'); };
    await cs.flushCandles(); await cs.flushCandles(); await cs.flushCandles();
    Candle.bulkWrite = realBulkWrite;
    assert.strictEqual(cs.coalesceStats.droppedOps - before, 1, 'one write dropped');
    await cs.flushCandles();
    assert.strictEqual(await stored('CF_C'), null, 'nothing written for the dropped interval');
    await cs.updateCandlesForTrade({ symbol: 'CF_C', price: '102', quantity: '1', ts: B + 30000, timeframes: ['1m'] });
    await cs.flushCandles();
    const c = await stored('CF_C');
    assert.ok(c && c.close === '102', 'the next tick is written normally');
  });

  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init().catch(() => {})));
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  console.log(`\n${pass}/${pass + fails.length} checks passed`);
  process.exit(fails.length ? 1 : 0);
})().catch(async (e) => { console.error(e); process.exit(1); });
