/**
 * diagnose-candles.js — what is in the candles collection, and is any of it wrong?
 *
 * READ-ONLY. Whole-DB table (db.stats + per collection), then for candles:
 * indexes with size and use, per-timeframe counts with oldest/newest openTime,
 * candles by market and for EXPIRED contracts, top symbols, daily growth, and
 * duplicates (unique-index proof for all data + an empirical 24h spot check).
 *
 * Per-timeframe figures come from walking the {symbol, timeframe, openTime}
 * unique index — per-symbol counts and min/max seeks — never a collection
 * scan. A $group over 15M+ candles would read ~3 GB through the cache of a
 * live server; this reads the index. 4 queries in flight (server cores).
 *
 *   docker compose exec -T backend node - < backend/scripts/diagnose-candles.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { MongoClient, ObjectId } = mongoose.mongo;

const TFS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
const MB = (b) => (b / 1e6).toFixed(1);
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '-');

(async () => {
  const t0 = Date.now();
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, family: 4 });
  await client.connect();
  const db = client.db();
  const host = client.options.hosts.map((h) => `${h.host}:${h.port}`).join(',');
  console.log(`database "${db.databaseName}" on ${host}\n`);

  // -- P. whole database --------------------------------------------------
  const s = await db.stats();
  console.log('P. Database');
  console.log(`  collections ${s.collections}, documents ${s.objects}`);
  console.log(`  data ${MB(s.dataSize)} MB uncompressed | storage ${MB(s.storageSize)} MB + indexes ${MB(s.indexSize)} MB = ${MB(s.storageSize + s.indexSize)} MB on disk\n`);

  const rows = [];
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (name.startsWith('system.')) continue;
    try {
      const [c] = await db.collection(name).aggregate([{ $collStats: { storageStats: {} } }]).toArray();
      const st = c.storageStats;
      rows.push({ name, count: st.count, size: st.size, storage: st.storageSize, index: st.totalIndexSize });
    } catch (_) { /* skip views etc. */ }
  }
  const disk = (r) => r.storage + r.index;
  const total = rows.reduce((t, r) => t + disk(r), 0);
  rows.sort((a, b) => disk(b) - disk(a));
  console.log('  ' + pad('collection', 26) + lpad('documents', 11) + lpad('data MB', 9) + lpad('storage', 9) + lpad('index', 8) + lpad('% of DB', 9));
  for (const r of rows.slice(0, 10)) {
    console.log('  ' + pad(r.name, 26) + lpad(r.count, 11) + lpad(MB(r.size), 9) + lpad(MB(r.storage), 9) + lpad(MB(r.index), 8) + lpad((100 * disk(r) / total).toFixed(1), 9));
  }
  const rest = rows.slice(10);
  console.log('  ' + pad(`(${rest.length} others)`, 26) + lpad(rest.reduce((t, r) => t + r.count, 0), 11) + lpad('', 9) + lpad('', 9) + lpad('', 8) +
    lpad((100 * rest.reduce((t, r) => t + disk(r), 0) / total).toFixed(1), 9));

  const C = db.collection('candles');
  const cand = rows.find((r) => r.name === 'candles');
  if (!cand) { console.log('\nno candles collection'); await client.close(); return; }

  // -- C1. indexes ----------------------------------------------------------
  console.log('\nC1. Candle indexes');
  const [cs] = await C.aggregate([{ $collStats: { storageStats: {} } }]).toArray();
  const usage = new Map();
  try { for (const i of await C.aggregate([{ $indexStats: {} }]).toArray()) usage.set(i.name, i.accesses); } catch (_) { /* */ }
  const idx = await C.indexes();
  for (const i of idx) {
    const u = usage.get(i.name);
    console.log(`  ${pad(i.name, 34)} ${lpad(MB(cs.storageStats.indexSizes[i.name] || 0), 8)} MB  ${lpad(u ? Number(u.ops) : '?', 12)} reads  ${i.unique ? 'UNIQUE ' : ''}${JSON.stringify(i.key)}`);
  }
  const since = [...usage.values()][0];
  if (since) console.log(`  read counts since ${new Date(since.since).toISOString()}`);
  const uniq = idx.find((i) => i.unique && JSON.stringify(i.key) === JSON.stringify({ symbol: 1, timeframe: 1, openTime: 1 }));

  // -- C2. per timeframe, from the unique index only (no collection scan) ---
  console.log('\nC2. Per timeframe (walks the {symbol, timeframe, openTime} index - no collection scan)');
  const symbols = await C.distinct('symbol');
  const perTf = Object.fromEntries(TFS.map((tf) => [tf, { docs: 0, symbols: 0, oldest: null, newest: null }]));
  const perSym = new Map();
  const queue = [...symbols];
  const worker = async () => {
    while (queue.length) {
      const sym = queue.shift();
      let symTotal = 0;
      for (const tf of TFS) {
        const n = await C.countDocuments({ symbol: sym, timeframe: tf }, { hint: uniq ? uniq.name : undefined });
        if (!n) continue;
        symTotal += n;
        const [o] = await C.find({ symbol: sym, timeframe: tf }, { projection: { openTime: 1, _id: 0 } }).sort({ openTime: 1 }).limit(1).toArray();
        const [w] = await C.find({ symbol: sym, timeframe: tf }, { projection: { openTime: 1, _id: 0 } }).sort({ openTime: -1 }).limit(1).toArray();
        const p = perTf[tf];
        p.docs += n; p.symbols += 1;
        if (o && (!p.oldest || o.openTime < p.oldest)) p.oldest = o.openTime;
        if (w && (!p.newest || w.openTime > p.newest)) p.newest = w.openTime;
      }
      perSym.set(sym, symTotal);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker)); // 4: the server's core count, shared with the live backend
  const candleDocs = TFS.reduce((t, tf) => t + perTf[tf].docs, 0);
  console.log('  ' + pad('tf', 5) + lpad('documents', 12) + lpad('% docs', 8) + lpad('symbols', 9) + lpad('avg/symbol', 11) + '   oldest openTime   newest openTime   span');
  for (const tf of TFS) {
    const p = perTf[tf];
    if (!p.docs) continue;
    const span = p.oldest ? Math.round((p.newest - p.oldest) / 864e5) + 'd' : '-';
    console.log('  ' + pad(tf, 5) + lpad(p.docs, 12) + lpad((100 * p.docs / candleDocs).toFixed(1), 8) + lpad(p.symbols, 9) + lpad(Math.round(p.docs / p.symbols), 11) +
      '   ' + pad(day(p.oldest), 18) + pad(day(p.newest), 18) + span);
  }
  console.log(`  ${symbols.length} symbols, ${candleDocs} candles counted via the index (collStats says ${cs.storageStats.count})`);

  // -- C3. by market, and expired contracts ---------------------------------
  console.log('\nC3. By market (instruments joined on symbol)');
  const insts = await db.collection('instruments').find({ symbol: { $in: symbols } }, { projection: { symbol: 1, exchange: 1, segment: 1, category: 1, expiryDate: 1, isActive: 1 } }).toArray();
  const meta = new Map(insts.map((i) => [i.symbol, i]));
  const groups = new Map();
  let expiredDocs = 0, expiredSyms = 0, unknownDocs = 0;
  const now = new Date();
  for (const [sym, n] of perSym) {
    const m = meta.get(sym);
    const key = m ? (m.exchange ? `${m.exchange} ${m.segment || ''}`.trim() : (m.category || '?')) : '(no instrument)';
    if (!m) unknownDocs += n;
    const g = groups.get(key) || { docs: 0, syms: 0 };
    g.docs += n; g.syms += 1; groups.set(key, g);
    if (m && m.expiryDate && new Date(m.expiryDate) < now) { expiredDocs += n; expiredSyms += 1; }
  }
  for (const [k, g] of [...groups].sort((a, b) => b[1].docs - a[1].docs)) {
    console.log(`  ${pad(k, 22)} ${lpad(g.docs, 11)} candles  ${lpad((100 * g.docs / candleDocs).toFixed(1), 5)}%  from ${g.syms} symbols`);
  }
  console.log(`  EXPIRED contracts (expiryDate in the past): ${expiredSyms} symbols, ${expiredDocs} candles = ${(100 * expiredDocs / candleDocs).toFixed(1)}% of all candles`);
  if (unknownDocs) console.log(`  candles for symbols with no instrument record: ${unknownDocs}`);

  // -- C4. top symbols ------------------------------------------------------
  console.log('\nC4. Top 15 symbols by candles');
  for (const [sym, n] of [...perSym].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    const m = meta.get(sym);
    console.log(`  ${pad(sym, 30)} ${lpad(n, 9)}  ${m ? `${m.exchange || ''} ${m.segment || ''}${m.expiryDate ? ' exp ' + day(m.expiryDate) : ''}` : ''}`);
  }

  // -- C5. growth -------------------------------------------------------------
  const oidAt = (ms) => ObjectId.createFromTime(Math.floor(ms / 1000));
  const d1 = await C.countDocuments({ _id: { $gte: oidAt(Date.now() - 864e5) } });
  const d7 = await C.countDocuments({ _id: { $gte: oidAt(Date.now() - 7 * 864e5) } });
  const perDoc = (cs.storageStats.storageSize + cs.storageStats.totalIndexSize) / cs.storageStats.count;
  console.log('\nC5. Growth (by document creation time)');
  console.log(`  last 24h: ${d1} candles (~${MB(d1 * perDoc)} MB on disk)   7-day average: ${Math.round(d7 / 7)}/day (~${MB(d7 / 7 * perDoc)} MB/day)   ${perDoc.toFixed(0)} bytes per candle on disk`);

  // -- C6. duplicates ---------------------------------------------------------
  console.log('\nC6. Duplicates (same symbol + timeframe + openTime)');
  console.log(uniq
    ? '  unique index present -> the database itself rejects duplicates: 0 possible across ALL candles'
    : '  WARNING: no unique {symbol, timeframe, openTime} index - duplicates are possible');
  const dups = await C.aggregate([
    { $match: { _id: { $gte: oidAt(Date.now() - 864e5) } } },
    { $group: { _id: { s: '$symbol', t: '$timeframe', o: '$openTime' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $count: 'dups' },
  ], { allowDiskUse: true }).toArray();
  console.log(`  spot check, every candle created in the last 24h: ${dups[0] ? dups[0].dups : 0} duplicate groups`);

  console.log(`\n(read-only; took ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  await client.close();
})().catch((e) => { console.log('failed: ' + e.message); process.exit(1); });
