/**
 * Regression: the trade-history summary rendered all zeros when filtered by account.
 *
 * Mongoose casts a query filter against the schema for find(), but NOT inside
 * aggregate() — a pipeline is sent to the server verbatim. positionHistory builds
 * one filter and uses it for both, and `accountId` arrives off req.query as a
 * STRING. So Position.find(filter) matched (cast to ObjectId) while
 * Position.aggregate([{ $match: filter }]) compared a String against an ObjectId
 * and matched nothing — the paged rows were right, every summary total was zero.
 *
 * These tests pin both halves: that the casting asymmetry is real (so nobody
 * "simplifies" the fix away), and that the fix casts every form the filter can take.
 */
const assert = require('assert');
const path = require('path');
const mongoose = require(path.join(__dirname, '..', 'node_modules', 'mongoose'));
const Position = require('../src/models/Position');

let pass = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  PASS  ${name}`); pass += 1; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
};

const OID = '66f1a2b3c4d5e6f701234567';
const OID2 = '66f1a2b3c4d5e6f701234999';

console.log('\nThe asymmetry that caused it');
check('find() casts a string accountId to ObjectId', () => {
  const cast = Position.find({ accountId: OID }).cast(Position);
  assert.strictEqual(cast.accountId.constructor.name, 'ObjectId');
});
check('aggregate() does NOT cast — it sends the string through', () => {
  const sent = Position.aggregate([{ $match: { accountId: OID } }]).pipeline()[0].$match;
  assert.strictEqual(sent.accountId.constructor.name, 'String');
});

// The fix, exactly as it appears in positionHistory.
const _oid = (v) => (mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(String(v)) : v);
const buildMatch = (filter) => {
  const matchStage = { ...filter };
  if (matchStage.accountId) {
    matchStage.accountId = matchStage.accountId.$in
      ? { $in: matchStage.accountId.$in.map(_oid) }
      : _oid(matchStage.accountId);
  }
  return matchStage;
};

console.log('\nThe fix covers every shape the filter can take');
check('single ?accountId= becomes an ObjectId', () => {
  const m = buildMatch({ userId: new mongoose.Types.ObjectId(OID), status: 'CLOSED', accountId: OID });
  assert.strictEqual(m.accountId.constructor.name, 'ObjectId');
  assert.strictEqual(String(m.accountId), OID);
});
check('?accountIds= CSV becomes an $in of ObjectIds', () => {
  const m = buildMatch({ status: 'CLOSED', accountId: { $in: [OID, OID2] } });
  assert.strictEqual(m.accountId.$in.length, 2);
  m.accountId.$in.forEach((v) => assert.strictEqual(v.constructor.name, 'ObjectId'));
  assert.deepStrictEqual(m.accountId.$in.map(String), [OID, OID2]);
});
check('no accountId filter is left untouched', () => {
  const m = buildMatch({ userId: new mongoose.Types.ObjectId(OID), status: 'CLOSED' });
  assert.ok(!('accountId' in m));
  assert.strictEqual(m.status, 'CLOSED');
});
check('an already-cast ObjectId survives unchanged', () => {
  const oid = new mongoose.Types.ObjectId(OID);
  const m = buildMatch({ accountId: oid });
  assert.strictEqual(String(m.accountId), OID);
  assert.strictEqual(m.accountId.constructor.name, 'ObjectId');
});
check('a non-id string is passed through, not crashed on', () => {
  const m = buildMatch({ accountId: 'not-an-object-id' });
  assert.strictEqual(m.accountId, 'not-an-object-id');
});
check('the other filter keys are preserved verbatim', () => {
  const src = { userId: new mongoose.Types.ObjectId(OID), status: 'CLOSED', accountId: OID,
                symbol: 'BTCUSD', side: 'BUY', closeReason: 'STOP_LOSS' };
  const m = buildMatch(src);
  assert.strictEqual(m.symbol, 'BTCUSD');
  assert.strictEqual(m.side, 'BUY');
  assert.strictEqual(m.closeReason, 'STOP_LOSS');
  assert.strictEqual(m.status, 'CLOSED');
});
check('the source filter is not mutated (find() still uses it)', () => {
  const src = { status: 'CLOSED', accountId: OID };
  buildMatch(src);
  assert.strictEqual(src.accountId, OID, 'buildMatch must copy, not mutate — find() shares this object');
});

console.log('\nThe controller still carries the fix');
check('positionHistory casts accountId before aggregating', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '../src/controllers/orderController.js'), 'utf8');
  assert.ok(src.includes('$match: matchStage'), 'aggregate must use the cast matchStage, not the raw filter');
  assert.ok(/matchStage\.accountId\.\$in/.test(src), 'the $in (accountIds CSV) branch must be cast too');
});

console.log(`\n${pass}/10 checks passed\n`);
