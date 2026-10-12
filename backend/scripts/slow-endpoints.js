#!/usr/bin/env node
/**
 * slow-endpoints.js — rank API endpoints by how much wall-clock they actually
 * cost in production, from the logs the server is already writing.
 *
 * server.js runs morgan('dev'), which emits one line per request:
 *   GET /api/instruments 200 107.123 ms - 450000
 * so the timings exist already; they are just buried and per-request. This
 * folds them together so you can see which endpoints deserve attention instead
 * of guessing.
 *
 * Usage (on the server):
 *   docker compose logs --no-color --tail=20000 backend | docker compose exec -T backend node scripts/slow-endpoints.js
 *
 * or, if node is on the host:
 *   docker compose logs --no-color --tail=20000 backend | node backend/scripts/slow-endpoints.js
 *
 * Ranked by TOTAL time (count x mean), because an endpoint taking 40 ms called
 * 200 times on a page load hurts more than a 900 ms one called once — and the
 * cheap-looking one is the one you would otherwise never look at.
 */
const readline = require('readline');

// morgan('dev') colours its output, so strip ANSI before matching. Docker log
// lines are additionally prefixed with a container name and timestamp.
const ANSI = /\[[0-9;]*m/g;
// GET /api/x 200 12.345 ms - 678
const LINE = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\S+)\s+(\d{3})\s+([\d.]+)\s*ms/;

// Collapse the variable parts of a path so /orders/<id> aggregates as one row.
const normalise = (url) => url
  .split('?')[0]
  .replace(/\/[0-9a-f]{24}(?=\/|$)/gi, '/:id')          // mongo ObjectIds
  .replace(/\/\d+(?=\/|$)/g, '/:n')                      // bare numbers
  .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/:uuid');

const stats = new Map();
let parsed = 0;
let skipped = 0;

readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on('line', (raw) => {
    const m = raw.replace(ANSI, '').match(LINE);
    if (!m) { skipped += 1; return; }
    const [, method, url, status, msStr] = m;
    const ms = Number(msStr);
    if (!Number.isFinite(ms)) { skipped += 1; return; }
    parsed += 1;
    const key = `${method} ${normalise(url)}`;
    const s = stats.get(key) || { n: 0, total: 0, max: 0, samples: [], errors: 0 };
    s.n += 1;
    s.total += ms;
    if (ms > s.max) s.max = ms;
    if (Number(status) >= 400) s.errors += 1;
    // Keep a bounded reservoir so p95 stays honest without unbounded memory.
    if (s.samples.length < 2000) s.samples.push(ms);
    stats.set(key, s);
  })
  .on('close', () => {
    if (!parsed) {
      console.log('No morgan request lines found.');
      console.log('Check the logs actually reach stdin, e.g.:');
      console.log('  docker compose logs --no-color --tail=20000 backend | node scripts/slow-endpoints.js');
      return;
    }

    const rows = [...stats.entries()].map(([key, s]) => {
      s.samples.sort((a, b) => a - b);
      const p = (q) => s.samples[Math.min(s.samples.length - 1, Math.floor((q / 100) * s.samples.length))];
      return { key, n: s.n, mean: s.total / s.n, p50: p(50), p95: p(95), max: s.max, total: s.total, errors: s.errors };
    });

    const wallTotal = rows.reduce((a, r) => a + r.total, 0);
    const f = (n) => n.toFixed(0).padStart(6);

    console.log(`\nParsed ${parsed} requests across ${rows.length} endpoints (${skipped} non-request lines ignored).\n`);
    console.log('Ranked by TOTAL time — the sum of every call, which is what a page actually waits on.\n');
    console.log('   total     share   calls    mean     p50     p95     max  endpoint');
    console.log('   ' + '-'.repeat(92));
    for (const r of rows.sort((a, b) => b.total - a.total).slice(0, 25)) {
      const share = ((r.total / wallTotal) * 100).toFixed(1).padStart(5);
      console.log(
        `${f(r.total)}ms  ${share}%  ${String(r.n).padStart(6)}  ${f(r.mean)}  ${f(r.p50)}  ${f(r.p95)}  ${f(r.max)}  ${r.key}` +
        (r.errors ? `   (${r.errors} errored)` : '')
      );
    }

    console.log('\nSlowest single responses (p95), regardless of how often they are called:\n');
    console.log('     p95     max   calls  endpoint');
    console.log('   ' + '-'.repeat(60));
    for (const r of rows.filter((x) => x.n >= 3).sort((a, b) => b.p95 - a.p95).slice(0, 12)) {
      console.log(`${f(r.p95)}ms ${f(r.max)}ms  ${String(r.n).padStart(6)}  ${r.key}`);
    }
  });
