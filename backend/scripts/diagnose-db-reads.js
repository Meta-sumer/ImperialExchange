#!/usr/bin/env node
/**
 * diagnose-db-reads.js — which collection is serving 460 reads a second?
 *
 * diagnose-db-load.js reported the cluster running 213 queries/s and 247
 * getmore/s against a platform with 8 users, and only 10.5% writes. So the CPU
 * is going on READS, and the question is which ones.
 *
 * Everything in serverStatus and $indexStats is CUMULATIVE since the server
 * started — 120 hours here — so a burst that began yesterday is invisible in
 * the average. This takes TWO snapshots a few seconds apart and reports the
 * DIFFERENCE, which is the rate right now.
 *
 * Four views, narrowing each time:
 *   1. per-collection op rate and DB time   (top)         — names the collection
 *   2. per-index read rate                  ($indexStats) — names the query shape
 *   3. sampled in-flight operations         (currentOp)   — shows the literal filter
 *   4. connected clients by source IP       (currentOp)   — names the SERVERS
 *
 * A single currentOp snapshot almost always looks idle, because each query is
 * milliseconds long. Sampling ~100 times across the window catches them: at 460
 * ops/s even 1ms of work means something is in flight about a third of the time.
 *
 * Read-only. Every privileged command is guarded — a restricted Atlas user just
 * loses that section rather than the whole run.
 *
 *   docker compose exec backend node scripts/diagnose-db-reads.js
 *   docker compose exec backend node scripts/diagnose-db-reads.js 30   (longer window)
 */
require('dotenv').config();
const mongoose = require('mongoose');

const WINDOW_S = Math.max(5, Math.min(120, Number(process.argv[2]) || 10));
const num = (n) => Number(n || 0).toLocaleString('en-US');
const rate = (d, s) => (d / s).toFixed(1);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI is not set'); process.exit(1); }
  await mongoose.connect(uri, { maxPoolSize: 3, serverSelectionTimeoutMS: 10000, family: 4 });
  const db = mongoose.connection.db;
  const admin = db.admin();

  console.log(`Sampling for ${WINDOW_S}s — leave the app running so this sees real traffic.`);
  console.log('');

  // Snapshot helpers ---------------------------------------------------
  const takeTop = async () => {
    try { const r = await admin.command({ top: 1 }); return r.totals || null; }
    catch (_) { return null; }
  };
  const takeIdx = async (names) => {
    const out = new Map();
    for (const n of names) {
      try {
        const s = await db.collection(n).aggregate([{ $indexStats: {} }]).toArray();
        for (const i of s) out.set(`${n}|${i.name}`, Number((i.accesses && i.accesses.ops) || 0));
      } catch (_) { /* no permission on this one */ }
    }
    return out;
  };

  const colls = (await db.listCollections().toArray()).map((c) => c.name);

  // Sample currentOp across the window while the counters accumulate.
  const seen = new Map();
  let samples = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        const cur = await admin.command({ currentOp: 1, active: true });
        samples += 1;
        for (const op of cur.inprog || []) {
          if (op.op === 'none' || !op.ns) continue;
          if (/^(admin|config|local)\./.test(op.ns)) continue;
          const c = op.command || {};
          // Describe the SHAPE, not the values — two lookups for different
          // symbols are the same query and should be counted together.
          let shape = '';
          if (c.filter) shape = '{' + Object.keys(c.filter).join(',') + '}';
          else if (c.pipeline) shape = 'pipeline[' + c.pipeline.length + ']';
          else if (c.q) shape = '{' + Object.keys(c.q).join(',') + '}';
          const key = `${op.op} ${op.ns} ${shape}`;
          seen.set(key, (seen.get(key) || 0) + 1);
        }
      } catch (_) { /* keep sampling */ }
      await sleep(100);
    }
  })();

  const top1 = await takeTop();
  const idx1 = await takeIdx(colls);
  const t0 = Date.now();
  await sleep(WINDOW_S * 1000);
  const elapsed = (Date.now() - t0) / 1000;
  const top2 = await takeTop();
  const idx2 = await takeIdx(colls);
  sampling = false;
  await sampler;

  // ── 1. Per-collection ────────────────────────────────────────────────
  console.log(`Collections by activity over the last ${elapsed.toFixed(0)}s`);
  if (!top1 || !top2) {
    console.log('  top is unavailable (needs clusterMonitor) — skipping to index rates.');
  } else {
    const rows = [];
    for (const ns of Object.keys(top2)) {
      if (ns === 'note' || /^(admin|config|local)\./.test(ns)) continue;
      const a = top1[ns] || {};
      const b = top2[ns];
      const d = (k) => ({
        count: ((b[k] && b[k].count) || 0) - ((a[k] && a[k].count) || 0),
        time: ((b[k] && b[k].time) || 0) - ((a[k] && a[k].time) || 0),
      });
      const q = d('queries'); const g = d('getmore'); const tot = d('total');
      const w = d('writeLock');
      if (tot.count <= 0 && tot.time <= 0) continue;
      rows.push({ ns, q, g, w, tot });
    }
    rows.sort((x, y) => y.tot.time - x.tot.time);
    console.log('  namespace'.padEnd(34), 'query/s'.padStart(9), 'getmore/s'.padStart(11), 'write/s'.padStart(9), 'DB busy'.padStart(9));
    console.log('  ' + '-'.repeat(76));
    for (const r of rows.slice(0, 12)) {
      // time is microseconds of DB work. Divided by wall-clock microseconds this
      // is how many cores worth of the server this namespace is occupying.
      const busy = (r.tot.time / (elapsed * 1e6));
      console.log(
        '  ' + r.ns.padEnd(32),
        rate(r.q.count, elapsed).padStart(9),
        rate(r.g.count, elapsed).padStart(11),
        rate(r.w.count, elapsed).padStart(9),
        (busy * 100).toFixed(1).padStart(8) + '%'
      );
    }
    const worst = rows[0];
    if (worst) {
      console.log('');
      console.log(`  ${worst.ns} is the busiest namespace on the cluster.`);
      console.log('  "DB busy" is time the server spent inside this namespace as a share of');
      console.log('  wall clock — above 100% means several operations running at once.');
    }
  }

  // ── 2. Per-index ─────────────────────────────────────────────────────
  console.log('');
  console.log(`Index reads over the same ${elapsed.toFixed(0)}s — which access path is hot`);
  const drows = [];
  for (const [k, v2] of idx2.entries()) {
    const v1 = idx1.get(k) || 0;
    const d = v2 - v1;
    if (d > 0) drows.push({ k, d });
  }
  drows.sort((a, b) => b.d - a.d);
  if (!drows.length) {
    console.log('  (no index took a read in the window — traffic may be idle right now;');
    console.log('   re-run with a longer window while the app is being used)');
  } else {
    console.log('  collection / index'.padEnd(56), 'reads'.padStart(10), 'per sec'.padStart(9));
    console.log('  ' + '-'.repeat(76));
    for (const r of drows.slice(0, 12)) {
      const parts = r.k.split('|');
      console.log('  ' + `${parts[0]} / ${parts[1]}`.padEnd(54), num(r.d).padStart(10), rate(r.d, elapsed).padStart(9));
    }
  }

  // ── 3. What the queries literally are ────────────────────────────────
  console.log('');
  console.log(`In-flight operations, ${samples} samples over the window`);
  if (!seen.size) {
    console.log('  (nothing caught in flight — every query finished inside the 100ms gap,');
    console.log('   which means they are individually fast and the cost is their VOLUME)');
  } else {
    const ops = [...seen.entries()].sort((a, b) => b[1] - a[1]);
    console.log('  hits'.padStart(6), '  operation');
    console.log('  ' + '-'.repeat(76));
    for (const [k, n] of ops.slice(0, 15)) {
      console.log(String(n).padStart(6), ' ', k);
    }
    console.log('');
    console.log('  Hits are how many samples caught it running, so this ranks by TIME SPENT,');
    console.log('  not by call count — a slow query appears far more often than a fast one.');
  }

  // ── 4. WHO is connected ──────────────────────────────────────────────
  // Decisive for a question the op counters cannot answer: is this ONE backend,
  // or two? A second deployment still pointed at the same cluster keeps running
  // its feed pollers and its background worker against this database, and every
  // count above would then be the sum of both. Connections are grouped by source
  // IP and by the driver metadata each one announced at handshake.
  console.log('');
  console.log('Connected clients');
  try {
    const cur = await admin.command({ currentOp: 1, idleConnections: true, idleSessions: false });
    const byIp = new Map();
    for (const op of cur.inprog || []) {
      const raw = op.client || op.client_s || 'unknown';
      const ip = String(raw).split(':')[0];
      const meta = op.clientMetadata || {};
      const who = [meta.application && meta.application.name, meta.driver && meta.driver.name]
        .filter(Boolean).join(' / ');
      byIp.set(ip + '|' + who, (byIp.get(ip + '|' + who) || 0) + 1);
    }
    if (!byIp.size) {
      console.log('  (currentOp returned no client details — Atlas can redact these)');
    } else {
      const rows = [...byIp.entries()].sort((a, b) => b[1] - a[1]);
      console.log('  conns'.padStart(7), '  source IP'.padEnd(20), 'driver / app');
      console.log('  ' + '-'.repeat(76));
      const ips = new Set();
      for (const [k, n] of rows) {
        const parts = k.split('|');
        if (parts[0] && parts[0] !== 'unknown') ips.add(parts[0]);
        console.log(String(n).padStart(7), '  ' + parts[0].padEnd(18), parts[1]);
      }
      console.log('');
      if (ips.size > 1) {
        console.log(`  ${ips.size} DISTINCT SOURCE IPs are connected to this cluster.`);
        console.log('  If only one server is supposed to be running, the others are still live');
        console.log('  and still polling — every rate above is the SUM of all of them. Shutting');
        console.log('  down a forgotten deployment is the cheapest fix available here.');
      } else {
        console.log('  One source IP — this load is a single backend, so the cause is inside it.');
      }
    }
  } catch (e) { console.log('  client list unavailable:', e.message); }

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
