/**
 * Regression: modifying a pending order used to fill it immediately.
 *
 * Moving a pending order across the live price (chart drag OR Modify dialog)
 * left its `type` untouched, so a SELL LIMIT could end up BELOW the bid — a
 * level the worker considers already triggerable. It fired on the next tick
 * and filled at market, without price ever travelling to the level the user
 * set.
 *
 * These tests run the REAL resolver out of orderController.js, and assert the
 * worker's trigger expressions still read as this test assumes.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const CTRL = path.join(__dirname, '../src/controllers/orderController.js');
const WORKER = path.join(__dirname, '../src/services/backgroundWorker.js');
const ctrlSrc = fs.readFileSync(CTRL, 'utf8');
const workerSrc = fs.readFileSync(WORKER, 'utf8');

// ── Pull the real implementations out of the controller ──────────────
// Brace-match from the marker so the extracted text is the whole function,
// not a prefix cut short by a nested '}'.
// The marker must end at the body's opening brace, so a destructured
// parameter list ({ side, ... }) is not mistaken for the body.
const grab = (src, startMarker) => {
  const i = src.indexOf(startMarker);
  assert.ok(i !== -1, `could not find ${startMarker}`);
  const open = i + startMarker.lastIndexOf('{');
  assert.strictEqual(src[open], '{', `marker must end at the body brace: ${startMarker}`);
  let depth = 0;
  for (let k = open; k < src.length; k += 1) {
    if (src[k] === '{') depth += 1;
    else if (src[k] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(i, k + 1);
    }
  }
  throw new Error(`unbalanced braces in ${startMarker}`);
};
const sandbox = {};
// eslint-disable-next-line no-new-func
new Function(
  'exports',
  `${grab(ctrlSrc, 'const _currentBidAsk = (instrument) => {')};
   ${grab(ctrlSrc, 'function resolveLimitTabOrderType({ side, limitPrice, currentBid, currentAsk }) {')}
   exports._currentBidAsk = _currentBidAsk;
   exports.resolveLimitTabOrderType = resolveLimitTabOrderType;`
)(sandbox);
const { _currentBidAsk, resolveLimitTabOrderType } = sandbox;

// ── Guard: the worker still triggers the way these tests assume ──────
assert.ok(
  workerSrc.includes("(order.side === 'BUY' && Number.isFinite(ask) && ask <= limitPx)") &&
  workerSrc.includes("(order.side === 'SELL' && Number.isFinite(bid) && bid >= limitPx)"),
  'LIMIT trigger expressions changed — update this test'
);
assert.ok(
  workerSrc.includes("(order.side === 'BUY' && gte(String(ask), order.stopPrice))") &&
  workerSrc.includes("(order.side === 'SELL' && lte(String(bid), order.stopPrice))"),
  'STOP trigger expressions changed — update this test'
);

// Mirrors of the worker's conditions, verified against source above.
const limitWouldFire = (side, bid, ask, limitPx) =>
  (side === 'BUY' && ask <= limitPx) || (side === 'SELL' && bid >= limitPx);
const stopWouldFire = (side, bid, ask, stopPx) =>
  (side === 'BUY' && ask >= stopPx) || (side === 'SELL' && bid <= stopPx);

// BTC-ish book: last 63500, 10-wide spread → bid 63495 / ask 63505
const inst = { lastPrice: '63500', spreadType: 'ABSOLUTE', spreadValue: 10 };
const { bid, ask } = _currentBidAsk(inst);
assert.strictEqual(bid, 63495);
assert.strictEqual(ask, 63505);

// What modifyOrder now does with a new level.
const applyModify = (side, level) => {
  const resolved = resolveLimitTabOrderType({
    side, limitPrice: level, currentBid: bid, currentAsk: ask,
  });
  if (resolved === 'INVALID') return { rejected: true };
  return resolved === 'STOP'
    ? { type: 'STOP', stopPrice: level, price: undefined }
    : { type: 'LIMIT', price: level, stopPrice: undefined };
};

let pass = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  PASS  ${name}`); pass += 1; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
};

console.log('\nSELL LIMIT dragged from above market to below it (the reported bug)');
check('old behaviour: stays LIMIT at 63400 and fires instantly', () => {
  assert.strictEqual(limitWouldFire('SELL', bid, ask, 63400), true);
});
check('new behaviour: becomes a SELL STOP and keeps resting', () => {
  const o = applyModify('SELL', 63400);
  assert.strictEqual(o.type, 'STOP');
  assert.strictEqual(o.stopPrice, 63400);
  assert.strictEqual(o.price, undefined);
  assert.strictEqual(stopWouldFire('SELL', bid, ask, o.stopPrice), false);
});

console.log('\nBUY LIMIT edited from below market to above it');
check('old behaviour: stays LIMIT at 63600 and fires instantly', () => {
  assert.strictEqual(limitWouldFire('BUY', bid, ask, 63600), true);
});
check('new behaviour: becomes a BUY STOP and keeps resting', () => {
  const o = applyModify('BUY', 63600);
  assert.strictEqual(o.type, 'STOP');
  assert.strictEqual(o.stopPrice, 63600);
  assert.strictEqual(stopWouldFire('BUY', bid, ask, o.stopPrice), false);
});

console.log('\nOrdinary moves must still work (no over-rejection)');
check('BUY LIMIT 63400 -> 63300 stays a resting LIMIT', () => {
  const o = applyModify('BUY', 63300);
  assert.strictEqual(o.type, 'LIMIT');
  assert.strictEqual(o.price, 63300);
  assert.strictEqual(limitWouldFire('BUY', bid, ask, o.price), false);
});
check('SELL LIMIT 63600 -> 63700 stays a resting LIMIT', () => {
  const o = applyModify('SELL', 63700);
  assert.strictEqual(o.type, 'LIMIT');
  assert.strictEqual(limitWouldFire('SELL', bid, ask, o.price), false);
});

console.log('\nGenuine fills must still happen');
check('BUY LIMIT 63300 fires once the ask actually falls to 63250', () => {
  assert.strictEqual(limitWouldFire('BUY', 63240, 63250, 63300), true);
});
check('SELL STOP 63400 fires once the bid actually falls to 63390', () => {
  assert.strictEqual(stopWouldFire('SELL', 63390, 63400, 63400), true);
});

console.log('\nLevel sitting exactly on the market');
check('BUY at the ask is rejected, not silently filled', () => {
  assert.strictEqual(applyModify('BUY', ask).rejected, true);
});
check('SELL at the bid is rejected, not silently filled', () => {
  assert.strictEqual(applyModify('SELL', bid).rejected, true);
});

console.log(`\n${pass}/10 checks passed\n`);
