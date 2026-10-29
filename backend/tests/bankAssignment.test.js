/**
 * Deposit bank-account pool: the least-loaded pick is a pure function, so it is
 * tested on its own (same source-grab style as the other tests here — no
 * database, no model requires).
 *
 *   node backend/tests/bankAssignment.test.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = path.join(__dirname, '../src/services/bankAssignment.js');
const src = fs.readFileSync(SRC, 'utf8');

const grab = (startMarker) => {
  const i = src.indexOf(startMarker);
  assert.ok(i !== -1, `could not find ${startMarker}`);
  const open = i + startMarker.lastIndexOf('{');
  assert.strictEqual(src[open], '{', 'marker must end at the body brace');
  let depth = 0;
  for (let k = open; k < src.length; k += 1) {
    if (src[k] === '{') depth += 1;
    else if (src[k] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(i, k + 1);
    }
  }
  throw new Error('unbalanced braces');
};

// eslint-disable-next-line no-new-func
const pickLeastLoadedFrom = new Function(`${grab('function pickLeastLoadedFrom(accounts, counts) {')}; return pickLeastLoadedFrom;`)();

const A = { _id: 'a', label: 'A' };
const B = { _id: 'b', label: 'B' };
const C = { _id: 'c', label: 'C' };
const counts = (obj) => new Map(Object.entries(obj));

// Empty pool → nothing to assign.
assert.strictEqual(pickLeastLoadedFrom([], counts({})), null);
assert.strictEqual(pickLeastLoadedFrom(null, counts({})), null);

// Fewest assigned users wins.
assert.strictEqual(pickLeastLoadedFrom([A, B, C], counts({ a: 5, b: 2, c: 9 })), B);

// An account with no count entry is empty (0) and wins.
assert.strictEqual(pickLeastLoadedFrom([A, B, C], counts({ a: 1, b: 1 })), C);
assert.strictEqual(pickLeastLoadedFrom([A, B], undefined), A);

// Ties go to the first account in the given (oldest-first) order.
assert.strictEqual(pickLeastLoadedFrom([B, A, C], counts({ a: 3, b: 3, c: 3 })), B);

// Simulated distribute loop: running counts spread a batch evenly.
const running = counts({ a: 0, b: 0, c: 0 });
for (let i = 0; i < 9; i += 1) {
  const pick = pickLeastLoadedFrom([A, B, C], running);
  running.set(pick._id, running.get(pick._id) + 1);
}
assert.deepStrictEqual([...running.values()], [3, 3, 3]);

// The service must still use the function (guards against a silent rename).
assert.ok(src.includes('pickLeastLoadedFrom(accounts, counts)'), 'distributeUnassigned uses pickLeastLoadedFrom');
assert.ok(src.includes("depositBankAccountId: { $nin: activeIds }"), 'unassigned filter covers deactivated accounts');

console.log('bankAssignment: least-loaded pick ok');
