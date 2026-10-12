/**
 * compare-atlas-to-live.js — before shutting Atlas down: does it hold any money
 * record the live database lacks?
 *
 * Production moved from Atlas to the local `mongo` container on 2026-09-28,
 * switching twice that day (and the first dump was interrupted with Ctrl+C),
 * so a record written to Atlas in between — a registration, a deposit, a
 * balance change — could exist ONLY there. Terminating Atlas would lose it.
 *
 * Compares EVERY document in the money collections, not a time window: a
 * window check reported SAFE in testing while an older deposit was missing
 * from the live side entirely, which is what a partial dump looks like.
 *
 *   only-atlas   on Atlas, absent from live            → must be reviewed
 *   atlas-newer  on both, Atlas's updatedAt is later   → must be reviewed
 *   (live newer is normal: live kept trading after the move)
 *
 * READ-ONLY on both sides. Never prints the Atlas URI.
 *
 *   ATLAS_URI=... node scripts/compare-atlas-to-live.js   (MONGODB_URI = live)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { MongoClient, ObjectId } = mongoose.mongo;

const MUTABLE = ['users', 'tradingaccounts', 'wallets', 'orders', 'positions', 'deposits', 'withdrawals',
  'bonuswallets', 'subscriptionwallets', 'subscriptions', 'copytrades', 'copytradeearnings', 'copyrelations',
  'commissions', 'kycdocuments', 'withdrawalmethods'];
const APPEND = ['walletledgers', 'trades', 'bonustransactions', 'subscriptiontransactions', 'margincalls'];
const SHOW = ['email', 'accountNumber', 'currency', 'balance', 'locked', 'status', 'type', 'amount',
  'symbol', 'side', 'quantity', 'realizedPnl', 'closeReason'];

const brief = (d) => SHOW.filter((k) => d[k] !== undefined && d[k] !== null).map((k) => `${k}=${d[k]}`).join(' ');
const when = (d) => (d.updatedAt ? new Date(d.updatedAt).toISOString() : d._id.getTimestamp().toISOString());

(async () => {
  if (!process.env.ATLAS_URI) { console.log('ATLAS_URI was not passed in - nothing compared.'); process.exit(1); }
  const atlas = new MongoClient(process.env.ATLAS_URI, { serverSelectionTimeoutMS: 15000, family: 4 });
  const live = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, family: 4 });
  try { await atlas.connect(); } catch (e) { console.log('Cannot reach Atlas: ' + e.message); process.exit(1); }
  await live.connect();
  const A = atlas.db();
  const L = live.db();
  const [au, lu] = await Promise.all([A.collection('users').countDocuments(), L.collection('users').countDocuments()]);
  console.log(`Atlas db "${A.databaseName}" (${au} users)  vs  live db "${L.databaseName}" (${lu} users)`);
  console.log('Every money record on Atlas is checked against the live database - all of them, not a time');
  console.log('window, because the Sept 28 dump was interrupted once and could have been partial.\n');

  let onlyTotal = 0;
  let newerTotal = 0;
  for (const coll of [...MUTABLE, ...APPEND]) {
    const mutable = MUTABLE.includes(coll);
    let aDocs;
    try { aDocs = await A.collection(coll).find({}).toArray(); } catch (_) { continue; }
    aDocs = aDocs.filter((d) => d._id instanceof ObjectId);
    if (!aDocs.length) { console.log(`  ${coll.padEnd(26)} empty on Atlas`); continue; }
    const lDocs = await L.collection(coll).find({ _id: { $in: aDocs.map((d) => d._id) } }).toArray();
    const lById = new Map(lDocs.map((d) => [String(d._id), d]));
    const only = aDocs.filter((d) => !lById.has(String(d._id)));
    const newer = mutable ? aDocs.filter((d) => {
      const l = lById.get(String(d._id));
      return l && d.updatedAt && (!l.updatedAt || new Date(d.updatedAt) > new Date(l.updatedAt));
    }) : [];
    onlyTotal += only.length;
    newerTotal += newer.length;
    console.log(`  ${coll.padEnd(26)} on Atlas: ${String(aDocs.length).padStart(5)}   ONLY on Atlas: ${String(only.length).padStart(3)}   Atlas newer: ${String(newer.length).padStart(3)}`);
    for (const d of only.slice(0, 10)) console.log(`      only-atlas  ${d._id}  ${when(d)}  ${brief(d)}`);
    for (const d of newer.slice(0, 10)) {
      const l = lById.get(String(d._id));
      console.log(`      atlas-newer ${d._id}  atlas ${when(d)} ${brief(d)}`);
      console.log(`                  ${' '.repeat(24)}  live  ${when(l)} ${brief(l)}`);
    }
    if (only.length > 10 || newer.length > 10) console.log('      (first 10 of each shown)');
  }

  console.log('');
  if (!onlyTotal && !newerTotal) {
    console.log('SAFE: every money record on Atlas is in the live database, at the same version or newer.');
  } else {
    console.log(`REVIEW BEFORE SHUTTING ATLAS DOWN: ${onlyTotal} record(s) exist only on Atlas, ${newerTotal} are newer on Atlas.`);
  }
  await atlas.close();
  await live.close();
})().catch((e) => { console.log('failed: ' + e.message); process.exit(1); });
