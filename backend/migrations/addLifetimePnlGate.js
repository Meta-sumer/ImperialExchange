/**
 * Migration: add lifetimeBlockedSince and lastLifetimeNetPnlUsd to CopyBox.
 * Idempotent — safe to run multiple times.
 */
const mongoose = require('mongoose');

async function migrate() {
  if (!mongoose.connection.readyState) await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/trading_platform');
  const db = mongoose.connection.db;
  const coll = db.collection('copyboxes');

  const result = await coll.updateMany(
    { lifetimeBlockedSince: { $exists: false } },
    { $set: { lifetimeBlockedSince: null, lastLifetimeNetPnlUsd: null } }
  );
  console.log(`[migration] CopyBox: updated ${result.modifiedCount} documents`);
  process.exit(result.modifiedCount >= 0 ? 0 : 1);
}

migrate().catch((err) => { console.error('[migration]', err); process.exit(1); });
