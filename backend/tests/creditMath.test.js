/**
 * Credit settlement arithmetic (services/creditMath.js): partial and full
 * settlement status, overshoot rejection, and the cancel guard.
 */
const assert = require('assert');
const { applySettlement, outstandingOf, canCancel } = require('../src/services/creditMath');

// Outstanding is amount minus what has been settled, as a decimal string.
assert.strictEqual(outstandingOf({ amount: '500', settledAmount: '0' }), '500');
assert.strictEqual(outstandingOf({ amount: '500.50', settledAmount: '200.25' }), '300.25');
assert.strictEqual(outstandingOf({ amount: '500' }), '500', 'missing settledAmount reads as 0');

// A partial payment leaves the row PARTIALLY_SETTLED with the remainder open.
let r = applySettlement({ amount: '500', settledAmount: '0', settleAmount: '200' });
assert.deepStrictEqual(r, { settledAmount: '200', status: 'PARTIALLY_SETTLED', outstanding: '300' });

// Paying exactly the remainder settles it fully.
r = applySettlement({ amount: '500', settledAmount: '200', settleAmount: '300' });
assert.deepStrictEqual(r, { settledAmount: '500', status: 'SETTLED', outstanding: '0' });

// Decimal strings never drift: 0.1 + 0.2 style inputs stay exact.
r = applySettlement({ amount: '0.3', settledAmount: '0.1', settleAmount: '0.2' });
assert.strictEqual(r.status, 'SETTLED');
assert.strictEqual(r.outstanding, '0');

// Overshooting the outstanding amount is refused.
assert.throws(() => applySettlement({ amount: '500', settledAmount: '200', settleAmount: '300.01' }), /EXCEEDS_OUTSTANDING/);
// Zero, negative and garbage payments are refused.
assert.throws(() => applySettlement({ amount: '500', settledAmount: '0', settleAmount: '0' }), /INVALID_AMOUNT/);
assert.throws(() => applySettlement({ amount: '500', settledAmount: '0', settleAmount: '-5' }), /INVALID_AMOUNT/);
assert.throws(() => applySettlement({ amount: '500', settledAmount: '0', settleAmount: 'abc' }), /INVALID_AMOUNT/);

// Only an untouched PENDING credit can be cancelled.
assert.strictEqual(canCancel({ status: 'PENDING', settledAmount: '0' }), true);
assert.strictEqual(canCancel({ status: 'PENDING' }), true);
assert.strictEqual(canCancel({ status: 'PARTIALLY_SETTLED', settledAmount: '10' }), false);
assert.strictEqual(canCancel({ status: 'SETTLED', settledAmount: '500' }), false);
assert.strictEqual(canCancel({ status: 'CANCELLED', settledAmount: '0' }), false);

console.log('creditMath: all assertions passed');
