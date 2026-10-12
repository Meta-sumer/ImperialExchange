/**
 * candle-retention.js — apply the candle retention policy, once, by hand.
 *
 * DRY RUN by default: prints what would be deleted and deletes nothing.
 * Deletes only with --apply. Touches only the `candles` collection.
 *
 * Windows come from env (defaults = the approved proposal):
 *   CANDLE_KEEP_1M=7 CANDLE_KEEP_5M=30 CANDLE_KEEP_15M=30 CANDLE_KEEP_30M=30
 *   CANDLE_KEEP_1H=90 CANDLE_KEEP_4H=365 CANDLE_EXPIRED_GRACE_DAYS=30
 * 1d and 1w are always kept. A window below its floor is refused.
 *
 *   docker compose exec backend node scripts/candle-retention.js            # dry run
 *   docker compose exec backend node scripts/candle-retention.js --apply    # delete
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { runCandleRetention, readConfig } = require('../src/services/candleRetention');

(async () => {
  const apply = process.argv.includes('--apply');
  const cfg = readConfig(); // throws on a window below its floor, before connecting
  await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 3, serverSelectionTimeoutMS: 10000, family: 4 });
  const C = mongoose.connection.db.collection('candles');
  const before = await C.estimatedDocumentCount();
  console.log(`database "${mongoose.connection.db.databaseName}" - ${before} candles`);
  console.log(`windows (days): ${Object.entries(cfg.keep).map(([tf, d]) => `${tf}=${d}`).join(' ')} | expired contracts: ${cfg.graceDays}d grace | 1d/1w kept`);
  console.log(apply ? 'APPLYING - deleting now\n' : 'DRY RUN - nothing will be deleted (add --apply to delete)\n');
  const t0 = Date.now();
  const r = await runCandleRetention({ apply, ...cfg, pauseMs: apply ? 5 : 0 });
  const verb = apply ? 'deleted' : 'would delete';
  console.log(`  expired contracts (> ${cfg.graceDays}d past expiry): ${verb} ${r.expired.docs} from ${r.expired.symbols} symbols`);
  for (const [tf, x] of Object.entries(r.byTf)) console.log(`  ${tf.padEnd(4)} older than ${String(cfg.keep[tf]).padStart(3)}d: ${verb} ${x.docs}`);
  console.log(`  TOTAL ${verb}: ${r.total}`);
  if (apply) console.log(`  candles now: ${await C.estimatedDocumentCount()} (were ${before}); space is reused by MongoDB, the file shrinks only after a compact`);
  console.log(`(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('candle-retention failed:', e.message);
  try { await mongoose.disconnect(); } catch (_) { /* */ }
  process.exit(1);
});
