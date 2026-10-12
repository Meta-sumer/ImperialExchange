#!/usr/bin/env node
/**
 * dropRedundantCandleIndex.js — drop candles.symbol_1, which costs writes and
 * serves no reads.
 *
 * Mongoose creates indexes it declares but NEVER drops one it no longer
 * declares, so removing `index: true` from the schema is not enough — the index
 * stays on the cluster, and keeps being maintained, until something drops it.
 *
 * Why it is safe:
 *   candles already has a unique {symbol, timeframe, openTime}. A compound index
 *   serves any query whose filter starts with its leading field, so that one
 *   covers everything {symbol:1} could — and every Candle query in this codebase
 *   filters by symbol, usually with timeframe alongside. $indexStats on the live
 *   cluster confirmed symbol_1 had served ZERO reads.
 *
 * Why it matters:
 *   candles is by far the largest collection here (2.6M docs, ~483MB data,
 *   ~159MB of indexes — everything else is in the tens of documents) and it takes
 *   continuous writes: candleService updates EIGHT timeframes per trade, so one
 *   tick on one symbol is up to eight upserts. Every one of those maintained this
 *   index for nothing.
 *
 *   docker compose exec backend node migrations/dropRedundantCandleIndex.js --dry-run
 *   docker compose exec backend node migrations/dropRedundantCandleIndex.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const DRY = process.argv.includes('--dry-run');
const TARGET = 'symbol_1';
const mb = (b) => (Number(b || 0) / 1024 / 1024).toFixed(1) + ' MB';

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI is not set'); process.exit(1); }
  await mongoose.connect(uri, { maxPoolSize: 3, serverSelectionTimeoutMS: 10000, family: 4 });
  const col = mongoose.connection.db.collection('candles');

  const before = await col.indexes();
  console.log('candles indexes before:');
  for (const i of before) console.log('   ', i.name.padEnd(36), JSON.stringify(i.key), i.unique ? '(unique)' : '');

  const target = before.find((i) => i.name === TARGET);
  if (!target) {
    console.log(`\n${TARGET} is not present — nothing to do.`);
    await mongoose.disconnect();
    return;
  }

  // Refuse to drop unless the covering compound index is actually there. Dropping
  // the only index that serves symbol lookups would turn every chart load into a
  // collection scan over 2.6M documents.
  const covering = before.find((i) => {
    const k = Object.keys(i.key || {});
    return k[0] === 'symbol' && k.length > 1;
  });
  if (!covering) {
    console.error('\nREFUSING: no compound index starting with `symbol` exists, so symbol_1 is');
    console.error('the only thing serving symbol lookups. Dropping it would force a collection');
    console.error('scan over every candle. Create {symbol, timeframe, openTime} first.');
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`\ncovering index present: ${covering.name} — ${TARGET} is redundant against it`);

  try {
    const stats = await mongoose.connection.db.command({ collStats: 'candles' });
    const sz = stats.indexSizes && stats.indexSizes[TARGET];
    if (sz) console.log(`${TARGET} currently occupies ${mb(sz)} of the ${mb(stats.totalIndexSize)} index total`);
    console.log(`collection holds ${Number(stats.count || 0).toLocaleString('en-US')} documents`);
  } catch (_) { /* stats are a nicety */ }

  if (DRY) {
    console.log(`\n--dry-run: would drop ${TARGET}. Re-run without the flag to apply.`);
    await mongoose.disconnect();
    return;
  }

  console.log(`\ndropping ${TARGET} …`);
  await col.dropIndex(TARGET);
  const after = await col.indexes();
  console.log('candles indexes after:');
  for (const i of after) console.log('   ', i.name.padEnd(36), JSON.stringify(i.key), i.unique ? '(unique)' : '');
  console.log('\nDone. Every write to candles now maintains one fewer index.');

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
