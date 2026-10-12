/**
 * preview-candle-retention.js - what WOULD a candle retention policy remove?
 *
 * READ-ONLY. Deletes nothing. Shows, per rule, how many candles it would
 * remove and roughly how much storage that frees, so the policy can be
 * approved (or changed) on real numbers before anything is deleted.
 *
 * Rules (defaults = the proposal; override with env, days):
 *   EXPIRED_GRACE_DAYS=30   every candle of a contract that expired more than N days ago
 *   KEEP_1M=7  KEEP_5M=30  KEEP_15M=30  KEEP_30M=30  KEEP_1H=90  KEEP_4H=365
 *                            candles older than N days, for contracts still live
 *   1d and 1w are always kept (the stock page reads up to 5 years of weekly)
 *
 * The windows come from what the app reads: no endpoint pages back in time,
 * and no screen asks for more than 500 candles of any timeframe (1m: ~8 hours,
 * 1h: ~21 days, 4h: ~83 days). Backfill only needs >= 120 per timeframe.
 *
 * Counting walks the {symbol, timeframe, openTime} unique index - per-symbol
 * range counts, never a collection scan. A candle matched by the expired rule
 * is not counted again by the age rules.
 *
 *   docker compose exec -T backend node - < backend/scripts/preview-candle-retention.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { MongoClient } = mongoose.mongo;

const DAY = 864e5;
const num = (k, d) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);
const GRACE = num('EXPIRED_GRACE_DAYS', 30);
const KEEP = { '1m': num('KEEP_1M', 7), '5m': num('KEEP_5M', 30), '15m': num('KEEP_15M', 30), '30m': num('KEEP_30M', 30), '1h': num('KEEP_1H', 90), '4h': num('KEEP_4H', 365) };
const MB = (b) => (b / 1e6).toFixed(1);
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

(async () => {
  const t0 = Date.now();
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, family: 4 });
  await client.connect();
  const db = client.db();
  const C = db.collection('candles');
  const [cs] = await C.aggregate([{ $collStats: { storageStats: {} } }]).toArray();
  const st = cs.storageStats;
  const perCandle = (st.storageSize + st.totalIndexSize) / st.count; // bytes on disk incl. indexes
  const now = Date.now();

  const symbols = await C.distinct('symbol');
  const insts = await db.collection('instruments').find({ symbol: { $in: symbols } }, { projection: { symbol: 1, expiryDate: 1, exchange: 1, segment: 1, category: 1 } }).toArray();
  const meta = new Map(insts.map((i) => [i.symbol, i]));
  const expiredCut = now - GRACE * DAY;
  const isExpired = (s) => { const m = meta.get(s); return !!(m && m.expiryDate && new Date(m.expiryDate).getTime() < expiredCut); };

  const res = { expired: { docs: 0, syms: 0 } };
  for (const tf of Object.keys(KEEP)) res[tf] = { docs: 0, syms: 0 };
  let inGrace = 0;

  const queue = [...symbols];
  const worker = async () => {
    while (queue.length) {
      const sym = queue.shift();
      if (isExpired(sym)) {
        const n = await C.countDocuments({ symbol: sym });
        res.expired.docs += n; res.expired.syms += 1;
        continue;
      }
      const m = meta.get(sym);
      if (m && m.expiryDate && new Date(m.expiryDate).getTime() < now) inGrace += 1;
      for (const [tf, days] of Object.entries(KEEP)) {
        const n = await C.countDocuments({ symbol: sym, timeframe: tf, openTime: { $lt: new Date(now - days * DAY) } });
        if (n) { res[tf].docs += n; res[tf].syms += 1; }
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker)); // 4 in flight: the server's cores, shared with the live backend

  const total = Object.values(res).reduce((t, r) => t + r.docs, 0);
  console.log(`database "${db.databaseName}" - candles: ${st.count} documents, ${MB(st.storageSize + st.totalIndexSize)} MB on disk (${perCandle.toFixed(0)} bytes each)\n`);
  console.log('  ' + pad('collection', 11) + pad('retention rule', 53) + lpad('documents', 11) + lpad('% candles', 10) + lpad('~MB freed', 11));
  const row = (rule, r) => console.log('  ' + pad('candles', 11) + pad(rule, 53) + lpad(r.docs, 11) + lpad((100 * r.docs / st.count).toFixed(1), 10) + lpad(MB(r.docs * perCandle), 11));
  row(`expired contracts, > ${GRACE} days past expiry (${res.expired.syms} symbols)`, res.expired);
  for (const [tf, days] of Object.entries(KEEP)) row(`${tf} older than ${days} days (live contracts)`, res[tf]);
  console.log('  ' + '-'.repeat(96));
  console.log('  ' + pad('TOTAL', 64) + lpad(total, 11) + lpad((100 * total / st.count).toFixed(1), 10) + lpad(MB(total * perCandle), 11));
  console.log(`\n  remaining after the policy: ${st.count - total} candles (~${MB((st.count - total) * perCandle)} MB)`);
  console.log(`  contracts expired less than ${GRACE} days ago (kept, still viewable): ${inGrace}`);
  console.log('  1d and 1w candles: always kept');
  console.log('\n  "MB freed" is space MongoDB can reuse for new data. The data file only');
  console.log('  shrinks on disk after a compact of the collection, a separate step.');
  console.log(`\n(read-only; nothing deleted; took ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  await client.close();
})().catch((e) => { console.log('failed: ' + e.message); process.exit(1); });
