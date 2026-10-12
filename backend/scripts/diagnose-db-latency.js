#!/usr/bin/env node
/**
 * diagnose-db-latency.js — how far away is the database, and what does that
 * cost per request?
 *
 * Why this exists: the platform used to run MongoDB as a container on the same
 * host, where a round trip is ~0.3 ms and nobody had to think about how many
 * queries an endpoint made. It now talks to Atlas over the public internet. The
 * application code did not change, but every sequential `await` on a query went
 * from free to one network round trip — and several endpoints make a dozen of
 * them in a row. /partner/volume-dashboard makes ~12.
 *
 * This script measures the round trip and multiplies it out, so "the new server
 * feels slow" becomes a number you can act on.
 *
 * Run it ON the server, so it measures that host's path to the cluster:
 *   docker compose exec backend node scripts/diagnose-db-latency.js
 *
 * Never prints credentials — the URI is redacted to host names only.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const PINGS = Number(process.env.PINGS) || 30;

// Strip everything before '@' so a password can never reach the terminal,
// a screenshot, or a pasted log.
const redact = (uri) => {
  if (!uri) return '(MONGODB_URI not set)';
  return uri.replace(/\/\/[^@]*@/, '//<credentials>@').replace(/([?&])(\w*[Pp]ass\w*)=[^&]*/g, '$1$2=<redacted>');
};

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const ms = (n) => `${n.toFixed(1)} ms`;

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI is not set'); process.exit(1); }

  console.log('URI     :', redact(uri));
  console.log('Kind    :', /mongodb\+srv|\.mongodb\.net/.test(uri) ? 'Atlas (remote, over the network)' : 'direct / local');

  const t0 = Date.now();
  await mongoose.connect(uri, {
    maxPoolSize: 5, minPoolSize: 1, serverSelectionTimeoutMS: 10000, family: 4,
  });
  console.log('Connect :', ms(Date.now() - t0), '(includes DNS + TCP + TLS + auth)');

  const admin = mongoose.connection.db.admin();
  try {
    const { hosts, setName } = await admin.command({ hello: 1 });
    if (setName) console.log('ReplSet :', setName);
    if (hosts) console.log('Hosts   :', hosts.join(', '));
  } catch (_) { /* not fatal */ }

  // ── Round-trip time: the number that actually matters ────────────────
  const pings = [];
  for (let i = 0; i < PINGS; i++) {
    const t = process.hrtime.bigint();
    await admin.command({ ping: 1 });
    pings.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  pings.sort((a, b) => a - b);
  const p50 = pct(pings, 50);
  console.log(`\nRound trip over ${PINGS} pings`);
  console.log('  min / p50 / p95 / max :', ms(pings[0]), '/', ms(p50), '/', ms(pct(pings, 95)), '/', ms(pings[pings.length - 1]));

  // Judge DISTANCE by the floor, not the median.
  //
  // A packet cannot travel faster than the network allows, so the minimum is the
  // one figure contention cannot inflate — it IS the round trip. The median rises
  // the moment anything competes for the connection pool or the cluster, which is
  // exactly what a freshly restarted backend does: it opens feeds, warms caches
  // and builds any newly-declared indexes.
  //
  // Measured on this very server across three runs, the floor held at ~18ms while
  // the median moved 18.7 -> 61 -> 79.7ms purely with load. Reading the median as
  // distance produced a confident "DIFFERENT CONTINENT" verdict twice, and it was
  // wrong both times. Hence: floor for distance, ratio for load.
  const floor = pings[0];
  const contention = floor > 0 ? p50 / floor : 1;

  let verdict;
  if (floor < 2)       verdict = 'same host — effectively free, query count does not matter';
  else if (floor < 15) verdict = 'same region — fine';
  else if (floor < 60) verdict = 'nearby region — sequential queries cost real time';
  else                 verdict = 'DIFFERENT CONTINENT — moving the cluster beats any code change';
  console.log('  network floor (min)   :', ms(floor), '->', verdict);

  if (contention >= 2) {
    console.log('  load                  : BUSY —', `the median is ${contention.toFixed(1)}x the floor.`);
    console.log('                          Something is competing for the pool or the cluster.');
    console.log('                          Just restarted? Index builds and feed startup inflate');
    console.log('                          this — wait ~2 minutes and re-run before judging.');
  } else {
    console.log('  load                  : quiet —', `median within ${contention.toFixed(1)}x of the floor,`);
    console.log('                          so these numbers reflect the network, not queueing.');
  }

  // ── What that costs the endpoints that chain queries ─────────────────
  // Counted from the source: getDashboardData makes 7 sequential awaits and
  // getVolumeDashboard adds 5 more, none of them batched.
  console.log(`\nCost of sequential round trips at the network floor (${ms(floor)})`);
  console.log('  Under load the real cost is higher — compare the median above.');
  for (const [name, n] of [['/partner/volume-dashboard', 12], ['a 6-query endpoint', 6], ['a 3-query endpoint', 3]]) {
    console.log(`  ${name.padEnd(28)} ${String(n).padStart(2)} round trips = ${ms(n * floor)} of pure waiting`);
  }

  // ── Real query timings, so it is not just ping ────────────────────────
  console.log('\nActual queries');
  const time = async (label, fn) => {
    const t = process.hrtime.bigint();
    let extra = '';
    try { extra = (await fn()) ?? ''; }
    catch (e) { extra = 'FAILED: ' + e.message; }
    console.log(`  ${label.padEnd(38)} ${ms(Number(process.hrtime.bigint() - t) / 1e6)} ${extra}`);
  };

  const Instrument = require('../src/models/Instrument');
  await time('Instrument.countDocuments({})', async () => {
    const n = await Instrument.countDocuments({});
    return `(${n} docs)`;
  });
  await time('the /instruments catalogue query', async () => {
    const rows = await Instrument.find({ isActive: true, userVisible: { $ne: false }, segment: { $ne: 'OPT' } }).lean();
    return `(${rows.length} rows, ~${(JSON.stringify(rows).length / 1024 / 1024).toFixed(2)} MB of JSON)`;
  });
  await time('.explain() on that query', async () => {
    const ex = await Instrument.find({ isActive: true, userVisible: { $ne: false }, segment: { $ne: 'OPT' } }).explain('executionStats');
    const st = ex.executionStats || {};
    const stage = (ex.queryPlanner?.winningPlan?.inputStage?.stage) || ex.queryPlanner?.winningPlan?.stage;
    return `[${stage}] examined ${st.totalDocsExamined} docs to return ${st.nReturned}`;
  });


  // ── Indexes ──────────────────────────────────────────────────────────
  // A background index build does not block, so a query issued moments after
  // connect can still report COLLSCAN while the build is in flight. Check what
  // actually exists, and create anything the schema declares but the cluster
  // lacks. createIndexes() only ADDS — unlike syncIndexes() it never drops an
  // index someone created by hand in the Atlas UI.
  console.log('\nIndexes on `instruments`');
  const listIdx = async () => (await Instrument.collection.indexes()).map((i) => i.name + ' ' + JSON.stringify(i.key));
  for (const l of await listIdx()) console.log('  have:', l);

  const wanted = 'isActive_1_segment_1_userVisible_1';
  const has = (await Instrument.collection.indexes()).some((i) => i.name === wanted);
  if (!has) {
    process.stdout.write(`  building ${wanted} … `);
    const tb = Date.now();
    try { await Instrument.createIndexes(); console.log(`done in ${ms(Date.now() - tb)}`); }
    catch (e) { console.log('FAILED:', e.message); }
    for (const l of await listIdx()) console.log('  have:', l);
  } else {
    console.log('  the catalogue index is present');
  }

  console.log('\nThe catalogue query, AFTER the index exists');
  await time('re-run the query', async () => {
    const rows = await Instrument.find({ isActive: true, userVisible: { $ne: false }, segment: { $ne: 'OPT' } }).lean();
    return `(${rows.length} rows)`;
  });
  await time('re-run with the projection now shipped', async () => {
    const rows = await Instrument.find({ isActive: true, userVisible: { $ne: false }, segment: { $ne: 'OPT' } })
      .select('-instrumentToken -upstoxKey -isin -priceSimulator -autoSwitchRules -mode -bBookEnabled -bBookDisableMode -routingOverride -profitSharePercent -commissionOverrides -disabledReason -disabledAt -disabledBy -marketDataEnabled -createdAt -updatedAt -__v')
      .lean();
    return `(${rows.length} rows, ~${(JSON.stringify(rows).length / 1024 / 1024).toFixed(2)} MB — this is what Atlas now ships to the backend)`;
  });
  await time('re-explain', async () => {
    const ex = await Instrument.find({ isActive: true, userVisible: { $ne: false }, segment: { $ne: 'OPT' } }).explain('executionStats');
    const st = ex.executionStats || {};
    const stage = (ex.queryPlanner?.winningPlan?.inputStage?.stage) || ex.queryPlanner?.winningPlan?.stage;
    return `[${stage}] examined ${st.totalDocsExamined} docs to return ${st.nReturned}`;
  });

  await mongoose.disconnect();
  console.log('\nIf the network FLOOR says a different continent, moving the cluster to the');
  console.log('same region as the app server is worth more than any code change.');
})().catch((e) => { console.error(e); process.exit(1); });
