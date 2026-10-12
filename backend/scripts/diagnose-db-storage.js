/**
 * diagnose-db-storage.js — what is filling the database, how fast, and why?
 *
 * READ-ONLY. Deletes nothing, creates no index, changes no setting. Every
 * privileged command is guarded — a restricted user loses that section, not
 * the run.
 *
 * Six views:
 *   1. every collection: documents, data / storage / index size
 *   2. growth: documents and bytes added in the last 24h and 7d
 *   3. candles in detail: what the last 24h of growth is made of (per
 *      timeframe and per symbol), the oldest candle, whether duplicates can
 *      exist
 *   4. writes per minute RIGHT NOW, per collection (two `top` snapshots diffed)
 *   5. indexes on the large collections: size and use since the server started
 *   6. a category for each collection: financial record (never expire),
 *      market data (retention candidate), operational log, configuration
 *
 * Cost on a large production collection is kept low on purpose:
 *   - growth is counted with an _id range, which walks the _id index — an
 *     ObjectId begins with its creation time, so "_id ≥ ObjectId(24h ago)" is
 *     exactly "created in the last 24h"
 *   - the candle breakdown groups ONLY the last 24h of documents (same _id
 *     range), never the whole collection
 *   - nothing scans a collection end to end
 *
 *   docker compose cp backend/scripts/diagnose-db-storage.js backend:/app/scripts/diagnose-db-storage.js
 *   docker compose exec backend node scripts/diagnose-db-storage.js        (30s write sample)
 *   docker compose exec backend node scripts/diagnose-db-storage.js 120    (longer sample)
 */
require('dotenv').config();
const mongoose = require('mongoose');

const WINDOW_S = Math.max(5, Number(process.argv[2]) || 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = (b) => (b == null ? '—' : (b / 1e6).toFixed(1));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

// What each collection IS — decides whether it may ever expire. Anything not
// listed is reported as "unclassified" so it gets a human look.
const CATEGORY = {
  // Money and trading records: permanent. Never a TTL candidate.
  orders: 'FINANCIAL', positions: 'FINANCIAL', trades: 'FINANCIAL', wallets: 'FINANCIAL',
  walletledgers: 'FINANCIAL', deposits: 'FINANCIAL', withdrawals: 'FINANCIAL',
  bonuswallets: 'FINANCIAL', bonustransactions: 'FINANCIAL', subscriptionwallets: 'FINANCIAL',
  subscriptiontransactions: 'FINANCIAL', commissions: 'FINANCIAL', copytrades: 'FINANCIAL',
  copytradeearnings: 'FINANCIAL', margincalls: 'FINANCIAL', corporateactions: 'FINANCIAL',
  // Market data: derived from feeds, rebuildable, the usual retention candidate.
  candles: 'MARKET DATA',
  // Operational trails: useful for a while; retention is a business call.
  auditlogs: 'LOG', notifications: 'LOG', routingdecisions: 'LOG', enginejournals: 'LOG',
  tradefeedevents: 'LOG', leveragelogs: 'LOG', assignmentlogs: 'LOG', alertacknowledgements: 'LOG',
  passwordresetotps: 'LOG', chats: 'LOG', feedbacks: 'LOG',
};

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI is not set'); process.exit(1); }
  await mongoose.connect(uri, { maxPoolSize: 3, serverSelectionTimeoutMS: 10000, family: 4 });
  const db = mongoose.connection.db;
  const admin = db.admin();
  const now = Date.now();
  // Which database this backend is really using — host only, never credentials.
  // "…mongodb.net" is Atlas; "mongo" is the container on this server.
  console.log(`database: ${db.databaseName} on ${mongoose.connection.host}:${mongoose.connection.port}\n`);
  const oidAt = (ms) => mongoose.Types.ObjectId.createFromTime(Math.floor(ms / 1000));
  const DAY = 24 * 3600 * 1000;

  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name).filter((n) => !n.startsWith('system.'));

  // ── 1 + 2. size and growth ────────────────────────────────────────────
  const rows = [];
  for (const name of names) {
    const r = { name, category: CATEGORY[name] || 'unclassified' };
    try {
      const [s] = await db.collection(name).aggregate([{ $collStats: { storageStats: {} } }]).toArray();
      const st = s.storageStats;
      Object.assign(r, {
        count: st.count, size: st.size, storageSize: st.storageSize,
        indexSize: st.totalIndexSize, avgObj: st.avgObjSize || 0, indexSizes: st.indexSizes || {},
      });
    } catch (_) {
      try { r.count = await db.collection(name).estimatedDocumentCount(); } catch (__) { /* */ }
    }
    // Growth by _id time — only meaningful when _id is an ObjectId.
    try {
      const sample = await db.collection(name).findOne({}, { projection: { _id: 1 } });
      if (sample && sample._id instanceof mongoose.Types.ObjectId) {
        r.day = await db.collection(name).countDocuments({ _id: { $gte: oidAt(now - DAY) } });
        r.week = await db.collection(name).countDocuments({ _id: { $gte: oidAt(now - 7 * DAY) } });
        const oldest = await db.collection(name).find({}, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(1).next();
        r.oldest = oldest ? oldest._id.getTimestamp() : null;
        // Bytes a day: data plus this collection's average index cost per doc.
        const perDoc = (r.avgObj || 0) + (r.count ? (r.indexSize || 0) / r.count : 0);
        r.dayBytes = r.day * perDoc;
      }
    } catch (_) { /* leave growth blank */ }
    rows.push(r);
  }
  rows.sort((a, b) => ((b.storageSize || 0) + (b.indexSize || 0)) - ((a.storageSize || 0) + (a.indexSize || 0)));

  const totalOnDisk = rows.reduce((t, r) => t + (r.storageSize || 0) + (r.indexSize || 0), 0);
  const totalDay = rows.reduce((t, r) => t + (r.dayBytes || 0), 0);

  console.log('1–2. Collections by space used (MB) and growth');
  console.log('     data = uncompressed BSON; storage + index = what is actually on disk\n');
  console.log('  ' + pad('collection', 26) + lpad('docs', 11) + lpad('data', 9) + lpad('storage', 9) + lpad('index', 8) +
    lpad('% disk', 8) + lpad('+docs/24h', 11) + lpad('avg/day 7d', 11) + lpad('MB/day', 8) + '  ' + pad('category', 13) + 'oldest');
  for (const r of rows) {
    const disk = (r.storageSize || 0) + (r.indexSize || 0);
    console.log('  ' + pad(r.name, 26) + lpad(r.count ?? '—', 11) + lpad(MB(r.size), 9) + lpad(MB(r.storageSize), 9) +
      lpad(MB(r.indexSize), 8) + lpad(totalOnDisk ? (100 * disk / totalOnDisk).toFixed(1) : '—', 8) +
      lpad(r.day ?? '—', 11) + lpad(r.week != null ? Math.round(r.week / 7) : '—', 11) +
      lpad(r.dayBytes != null ? MB(r.dayBytes) : '—', 8) + '  ' + pad(r.category, 13) +
      (r.oldest ? r.oldest.toISOString().slice(0, 10) : '—'));
  }
  console.log(`\n  on disk: ${MB(totalOnDisk)} MB   growing ~${MB(totalDay)} MB/day at the last 24h's rate`);
  const top = rows.filter((r) => r.dayBytes).sort((a, b) => b.dayBytes - a.dayBytes).slice(0, 3);
  if (totalDay > 0) {
    console.log('  growth by collection: ' + top.map((r) => `${r.name} ${(100 * r.dayBytes / totalDay).toFixed(0)}%`).join(', '));
  }

  // ── 3. candles ────────────────────────────────────────────────────────
  if (names.includes('candles')) {
    const C = db.collection('candles');
    console.log('\n3. Candles — what the last 24h of growth is made of');
    try {
      const idx = await C.indexes();
      const uniq = idx.find((i) => i.unique && JSON.stringify(i.key) === JSON.stringify({ symbol: 1, timeframe: 1, openTime: 1 }));
      console.log(uniq
        ? '  duplicates: impossible — unique index on {symbol, timeframe, openTime} is present'
        : '  duplicates: POSSIBLE — the unique {symbol, timeframe, openTime} index is MISSING');
    } catch (_) { /* */ }
    try {
      const since = { _id: { $gte: oidAt(now - DAY) } };
      const byTf = await C.aggregate([{ $match: since }, { $group: { _id: '$timeframe', n: { $sum: 1 } } }, { $sort: { n: -1 } }], { allowDiskUse: true }).toArray();
      const total = byTf.reduce((t, x) => t + x.n, 0);
      console.log(`  new candles in 24h: ${total}`);
      for (const t of byTf) console.log(`    ${pad(t._id, 5)} ${lpad(t.n, 10)}  ${(100 * t.n / (total || 1)).toFixed(1)}%`);

      const bySym = await C.aggregate([
        { $match: since },
        { $group: { _id: '$symbol', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ], { allowDiskUse: true }).toArray();
      console.log(`  symbols that created candles in 24h: ${bySym.length}`);
      for (const s of bySym.slice(0, 15)) console.log(`    ${pad(s._id, 28)} ${lpad(s.n, 8)}`);
      if (bySym.length > 15) {
        const rest = bySym.slice(15).reduce((t, s) => t + s.n, 0);
        console.log(`    … ${bySym.length - 15} more symbols: ${rest} candles (${(100 * rest / (total || 1)).toFixed(1)}%)`);
      }
    } catch (e) { console.log('  (breakdown unavailable: ' + e.message + ')'); }
  }

  // ── 4. writes per minute, right now ───────────────────────────────────
  console.log(`\n4. Writes per minute right now — sampling ${WINDOW_S}s (leave the app running)`);
  const takeTop = async () => {
    try { const r = await admin.command({ top: 1 }); return r.totals || null; } catch (_) { return null; }
  };
  const t1 = await takeTop();
  const s0 = Date.now();
  await sleep(WINDOW_S * 1000);
  const t2 = await takeTop();
  const mins = (Date.now() - s0) / 60000;
  if (!t1 || !t2) {
    console.log('  `top` is not permitted for this user — run diagnose-db-reads.js as a user that has it.');
  } else {
    const dbName = db.databaseName;
    const out = [];
    for (const [ns, v2] of Object.entries(t2)) {
      if (!ns.startsWith(dbName + '.')) continue;
      const v1 = t1[ns] || {};
      const d = (k) => ((v2[k] && v2[k].count) || 0) - ((v1[k] && v1[k].count) || 0);
      // writeLock / readLock count EVERY operation once. insert+update+remove
      // alone misses findOneAndUpdate — which `top` files under `commands` —
      // and that is how candles and trade settlements are written: the first
      // production run reported zero candle writes while 20k candles a day
      // were being created. Verified: a pipeline findOneAndUpdate moves
      // writeLock and commands, never update.
      const w = { wr: d('writeLock'), ins: d('insert'), upd: d('update'), rem: d('remove'), rd: d('readLock') };
      w.fam = Math.max(0, w.wr - w.ins - w.upd - w.rem); // findAndModify and other write commands
      if (w.wr + w.rd === 0) continue;
      out.push({ coll: ns.slice(dbName.length + 1), ...w });
    }
    out.sort((a, b) => b.wr - a.wr);
    const totalW = out.reduce((t, x) => t + x.wr, 0);
    console.log('  ' + pad('collection', 26) + lpad('writes/min', 12) + lpad('findAndMod', 12) + lpad('inserts', 10) +
      lpad('updates', 10) + lpad('deletes', 10) + lpad('reads/min', 11) + lpad('% writes', 10));
    for (const x of out.slice(0, 20)) {
      const m = (v) => lpad((v / mins).toFixed(0), 10);
      console.log('  ' + pad(x.coll, 26) + lpad((x.wr / mins).toFixed(0), 12) + lpad((x.fam / mins).toFixed(0), 12) +
        m(x.ins) + m(x.upd) + m(x.rem) + lpad((x.rd / mins).toFixed(0), 11) +
        lpad(totalW ? (100 * x.wr / totalW).toFixed(1) : '0', 10));
    }
    console.log(`  total writes: ${(totalW / mins).toFixed(0)}/min`);
  }

  // ── 5. indexes on the large collections ───────────────────────────────
  console.log('\n5. Indexes on the largest collections — size, and reads since the server started');
  console.log('   0 reads is a CANDIDATE only: the count resets on restart, and a rare report may use it.');
  let since = null;
  for (const r of rows.slice(0, 8)) {
    try {
      const st = await db.collection(r.name).aggregate([{ $indexStats: {} }]).toArray();
      console.log(`  ${r.name}`);
      for (const i of st) {
        if (!since && i.accesses && i.accesses.since) since = i.accesses.since;
        const size = r.indexSizes ? r.indexSizes[i.name] : null;
        console.log(`    ${pad(i.name, 44)} ${lpad(MB(size), 8)} MB  ${lpad(Number(i.accesses.ops), 12)} reads   ${JSON.stringify(i.key)}`);
      }
    } catch (_) { console.log(`  ${r.name}: $indexStats not permitted`); }
  }
  if (since) console.log(`  read counts cover ${new Date(since).toISOString()} → now`);

  // ── 6. what may expire ────────────────────────────────────────────────
  console.log('\n6. Categories');
  console.log('  FINANCIAL     permanent — never a TTL or delete candidate');
  console.log('  MARKET DATA   rebuildable from feeds — the usual retention candidate (needs sign-off)');
  console.log('  LOG           operational trail — retention is a business decision');
  const unc = rows.filter((r) => r.category === 'unclassified').map((r) => r.name);
  if (unc.length) console.log('  unclassified (needs a human look): ' + unc.join(', '));

  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('diagnose-db-storage failed:', e.message);
  try { await mongoose.disconnect(); } catch (_) { /* */ }
  process.exit(1);
});
