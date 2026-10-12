#!/usr/bin/env node
/**
 * diagnose-db-load.js — what is actually burning CPU on the cluster?
 *
 * Written after Atlas reported Cluster0 sustained >75% CPU for an hour and had
 * already auto-scaled M10 -> M20. Guessing at the cause of a cost increase is
 * not good enough, so this asks the server.
 *
 *   docker compose exec backend node scripts/diagnose-db-load.js
 *
 * Reports, in the order worth reading:
 *   1. write vs read rate         — a write-heavy cluster pays for every index
 *   2. operations running NOW     — anything slow enough to still be in flight
 *   3. index builds in progress   — these are CPU-expensive and time-boxed
 *   4. collections by size        — where the data and the index bytes are
 *   5. INDEX USAGE                — the important one. Every index is paid for on
 *      every insert and update to its collection, whether or not a query ever
 *      uses it. An index with zero accesses is pure cost.
 *   6. CANDLES BY TIMEFRAME       — candles is the only collection here big enough
 *      to matter, and candleService writes eight timeframes per tick. This says
 *      which of those eight are actually carrying the weight.
 *
 * Read-only throughout. Some commands need elevated privileges; each is guarded
 * so a restricted Atlas user still gets the sections it can see.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const kb = (b) => (b / 1024 / 1024).toFixed(1) + ' MB';
const num = (n) => Number(n || 0).toLocaleString('en-US');

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI is not set'); process.exit(1); }
  await mongoose.connect(uri, { maxPoolSize: 3, serverSelectionTimeoutMS: 10000, family: 4 });
  const db = mongoose.connection.db;
  const admin = db.admin();

  // ── 1. Read/write mix ────────────────────────────────────────────────
  try {
    const st = await admin.serverStatus();
    const o = st.opcounters || {};
    const total = (o.query || 0) + (o.insert || 0) + (o.update || 0) + (o.delete || 0) + (o.getmore || 0);
    const writes = (o.insert || 0) + (o.update || 0) + (o.delete || 0);
    console.log('Operation mix since the server last started');
    console.log('  uptime              :', ((st.uptime || 0) / 3600).toFixed(1), 'hours');
    for (const k of ['query', 'getmore', 'insert', 'update', 'delete']) {
      const v = o[k] || 0;
      const perSec = st.uptime ? (v / st.uptime).toFixed(1) : '—';
      console.log(`  ${k.padEnd(18)}: ${num(v).padStart(14)}   ${perSec}/s`);
    }
    if (total) {
      console.log('  write share         :', ((writes / total) * 100).toFixed(1) + '%');
      if (writes / total > 0.5) {
        console.log('                        Write-dominated. EVERY index on a hot collection is');
        console.log('                        maintained on every one of those writes, so an unused');
        console.log('                        index here is a direct CPU cost — see section 5.');
      }
    }
    const conn = st.connections || {};
    console.log('  connections         :', conn.current, 'current /', conn.available, 'available');
  } catch (e) { console.log('serverStatus unavailable:', e.message); }

  // ── 2. What is running right now ─────────────────────────────────────
  try {
    const cur = await admin.command({ currentOp: 1, active: true, secs_running: { $gte: 1 } });
    const ops = (cur.inprog || []).filter((op) => op.op !== 'none');
    console.log(`\nOperations running longer than 1s right now: ${ops.length}`);
    for (const op of ops.slice(0, 8)) {
      console.log(`  ${String(op.secs_running).padStart(5)}s  ${op.op.padEnd(8)} ${op.ns || ''}`);
      if (op.command) {
        const c = JSON.stringify(op.command);
        console.log('         ', c.length > 160 ? c.slice(0, 160) + '…' : c);
      }
    }
    if (!ops.length) console.log('  (nothing slow in flight — the spike is not happening this second)');
  } catch (e) { console.log('\ncurrentOp unavailable:', e.message); }

  // ── 3. Index builds ──────────────────────────────────────────────────
  // A build pins CPU for its duration. Five indexes were added in one day here,
  // and every backend restart re-issues createIndex for all of them.
  try {
    const cur = await admin.command({ currentOp: 1 });
    const builds = (cur.inprog || []).filter((op) => /createIndex|IndexBuild/i.test(JSON.stringify(op.command || op.desc || '')));
    console.log(`\nIndex builds in progress: ${builds.length}`);
    for (const b of builds) console.log(`  ${b.ns || ''}  ${b.msg || ''} (${b.secs_running || 0}s)`);
    if (!builds.length) console.log('  (none — so builds are not what is burning CPU now)');
  } catch (_) { /* covered by the section above */ }

  // ── 4 + 5. Per-collection size and INDEX USAGE ───────────────────────
  // Progress is printed as it goes. Everything below is one round trip per
  // collection, so on a loaded cluster this is the slow part of the script —
  // without a marker a long pause looks like a hang, and there is no way to
  // tell which collection it stopped on.
  const cols = (await db.listCollections().toArray()).map((c) => c.name).sort();
  console.log('');
  console.log(`reading stats for ${cols.length} collections …`);
  const rows = [];
  for (const name of cols) {
    try {
      const s = await db.command({ collStats: name });
      rows.push({ name, count: s.count || 0, size: s.size || 0, idxSize: s.totalIndexSize || 0, nIdx: s.nindexes || 0 });
    } catch (_) { /* skip */ }
  }
  rows.sort((a, b) => b.size - a.size);
  console.log('\nLargest collections');
  console.log('  collection'.padEnd(26), 'docs'.padStart(12), 'data'.padStart(11), 'indexes'.padStart(11), '  #');
  console.log('  ' + '-'.repeat(70));
  for (const r of rows.slice(0, 10)) {
    console.log('  ' + r.name.padEnd(24), num(r.count).padStart(12), kb(r.size).padStart(11), kb(r.idxSize).padStart(11), String(r.nIdx).padStart(4));
  }

  console.log('');
  console.log('reading index usage …');
  console.log('\nIndex usage — an index with 0 reads still costs every write');
  let unused = 0;
  for (const r of rows.slice(0, 12)) {
    let stats;
    try { stats = await db.collection(r.name).aggregate([{ $indexStats: {} }]).toArray(); }
    catch (_) { continue; }
    const cold = stats.filter((s) => !(s.accesses && Number(s.accesses.ops) > 0) && s.name !== '_id_');
    if (!cold.length) continue;
    console.log(`\n  ${r.name}  (${num(r.count)} docs)`);
    for (const s of cold) {
      unused += 1;
      console.log('    NEVER READ :', s.name, JSON.stringify(s.key));
    }
  }
  if (!unused) {
    console.log('  (every index is being read — none is pure write overhead)');
  } else {
    console.log(`\n  ${unused} index(es) have served zero reads since the server started.`);
    console.log('  Counters reset on restart, so give it a full day before dropping anything —');
    console.log('  an index used only by a nightly job will look cold at midday.');
  }

  // ── 6. Where the candles actually are ────────────────────────────────
  // candles dwarfs every other collection here, and candleService writes EIGHT
  // timeframes per trade — so this breakdown is what decides whether the fix is
  // a TTL on old intraday bars, or simply not writing the daily/weekly ones on
  // every tick.
  //
  // SAMPLED, not scanned. Grouping all 2.6M documents means a full collection
  // scan, which is a lot of load to put on a cluster you are running this
  // script to take load OFF. No index starts with `timeframe`, so there is no
  // cheap exact path. A sample answers the only question being asked — which
  // timeframes hold the bulk — and the proportions converge long before the
  // count does.
  //
  // Size stays under 5% of the collection on purpose: above that threshold
  // $sample abandons its random-cursor path and scans anyway, which is the
  // exact cost being avoided.
  console.log('');
  console.log('sampling candles …');
  try {
    const candleRow = rows.find((r) => r.name === 'candles');
    const totalDocs = candleRow ? candleRow.count : 0;
    const SAMPLE = Math.max(1, Math.min(100000, Math.floor(totalDocs * 0.04)));
    const agg = await db.collection('candles').aggregate([
      { $sample: { size: SAMPLE } },
      { $group: { _id: '$timeframe', n: { $sum: 1 },
                  oldest: { $min: '$openTime' }, newest: { $max: '$openTime' } } },
      { $sort: { n: -1 } },
    ], { allowDiskUse: true }).toArray();
    const sampled = agg.reduce((a, r) => a + r.n, 0) || 1;
    // Scale the sample back up to the real collection size, so the numbers are
    // comparable to the document count printed above.
    const scale = totalDocs ? totalDocs / sampled : 1;
    for (const r of agg) r.n = Math.round(r.n * scale);
    const total = agg.reduce((a, r) => a + r.n, 0);
    console.log(`  (${num(sampled)} of ${num(totalDocs)} documents sampled — counts below are estimates,`);
    console.log('   and the date span is the range SEEN IN THE SAMPLE, so the true range is wider)');
    console.log('');
    console.log('Candles by timeframe');
    console.log('  tf'.padEnd(8), 'docs'.padStart(12), 'share'.padStart(8), '  oldest', '     span');
    console.log('  ' + '-'.repeat(60));
    for (const r of agg) {
      const days = r.oldest && r.newest
        ? ((new Date(r.newest) - new Date(r.oldest)) / 86400000).toFixed(0) + 'd'
        : '—';
      console.log(
        '  ' + String(r._id).padEnd(6),
        num(r.n).padStart(12),
        ((r.n / total) * 100).toFixed(1).padStart(7) + '%',
        ' ' + (r.oldest ? new Date(r.oldest).toISOString().slice(0, 10) : '—'),
        days.padStart(8)
      );
    }
    // Split the eight into the two groups that call for different fixes. Every
    // timeframe candleService knows about is listed, so the shares add to 100 and
    // nothing is quietly left out of the picture.
    const FAST = ['1m', '5m', '15m', '30m', '1h'];   // churn fastest, age out fastest
    const SLOW = ['4h', '1d', '1w'];                 // change once a day at most
    const sum = (list) => agg.filter((r) => list.includes(r._id)).reduce((a, r) => a + r.n, 0);
    const intraday = sum(FAST);
    const slow = sum(SLOW);
    const other = total - intraday - slow;
    const pc = (n) => ((n / (total || 1)) * 100).toFixed(0) + '%';
    console.log('');
    console.log(`  ${FAST.join('+')} : ${num(intraday)} (${pc(intraday)})`);
    console.log('       nobody charts a 1m bar from three months ago. A TTL index on');
    console.log('       these caps the collection instead of letting it grow forever.');
    console.log(`  ${SLOW.join('+')} : ${num(slow)} (${pc(slow)})`);
    console.log('       few rows, but rewritten on EVERY tick like the rest. A daily');
    console.log('       candle does not need updating hundreds of times a minute —');
    console.log('       upstoxFeed already passes a `timeframes` filter for options');
    console.log('       (see upstoxFeed.js), so the mechanism is there to reuse.');
    if (other > 0) {
      console.log(`  other     : ${num(other)} (${pc(other)}) — timeframes candleService does not`);
      console.log('       write today. Leftovers from an older set; safe to delete outright.');
    }
  } catch (e) { console.log('candle breakdown unavailable:', e.message); }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
