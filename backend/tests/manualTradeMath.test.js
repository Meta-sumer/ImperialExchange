/**
 * Pure math behind admin manual (backdated) trades and trade edits.
 * Run: node backend/tests/manualTradeMath.test.js
 */
const assert = require('assert');
const { marginFor, realizedPnlFor, netOf, checkTradeTimes } = require('../src/utils/manualTradeMath');

// margin = qty × price ÷ leverage
assert.strictEqual(marginFor('10', '2948.40', 1), '29484');
assert.strictEqual(marginFor('10', '2948.40', 5), '5896.8');
assert.strictEqual(marginFor('0.5', '100', 0), '50');          // bad leverage → treated as 1
assert.strictEqual(marginFor('0.5', '100', undefined), '50');

// PnL: BUY gains on a rise, SELL gains on a fall; the sign flips symmetrically
assert.strictEqual(realizedPnlFor('BUY', '2948.40', '2970.10', '10'), '217');
assert.strictEqual(realizedPnlFor('SELL', '2948.40', '2970.10', '10'), '-217');
assert.strictEqual(realizedPnlFor('BUY', '100', '90', '3'), '-30');
assert.strictEqual(realizedPnlFor('SELL', '100', '90', '3'), '30');
// decimal-safe (no float drift)
assert.strictEqual(realizedPnlFor('BUY', '0.1', '0.3', '3'), '0.6');

// net = pnl − commission
assert.strictEqual(netOf('217', '2.5'), '214.5');
assert.strictEqual(netOf('-30', '0'), '-30');
assert.strictEqual(netOf('-30', null), '-30');

// timestamps
const now = new Date('2026-10-29T10:00:00Z');
const t = (s) => new Date(s);
assert.strictEqual(checkTradeTimes({ openedAt: t('2026-10-01T09:30:00Z'), closedAt: t('2026-10-01T10:30:00Z'), now }), null);
assert.strictEqual(checkTradeTimes({ openedAt: t('2026-10-01T09:30:00Z'), now }), null);
assert.strictEqual(checkTradeTimes({ openedAt: t('2026-11-01T09:30:00Z'), now }), 'openedAt cannot be in the future');
assert.strictEqual(checkTradeTimes({ openedAt: t('2026-10-02T09:30:00Z'), closedAt: t('2026-10-01T09:30:00Z'), now }), 'closedAt cannot be before openedAt');
assert.strictEqual(checkTradeTimes({ openedAt: t('2026-10-01T09:30:00Z'), closedAt: t('2026-11-01T09:30:00Z'), now }), 'closedAt cannot be in the future');
assert.strictEqual(checkTradeTimes({ openedAt: new Date('garbage'), now }), 'openedAt is required');
assert.strictEqual(checkTradeTimes({ openedAt: null, now }), 'openedAt is required');
assert.strictEqual(checkTradeTimes({ openedAt: t('2026-10-01T09:30:00Z'), closedAt: new Date('garbage'), now }), 'closedAt is not a valid date/time');
// the same instant for open and close is allowed (instant fill + close)
assert.strictEqual(checkTradeTimes({ openedAt: t('2026-10-01T09:30:00Z'), closedAt: t('2026-10-01T09:30:00Z'), now }), null);

console.log('manualTradeMath: all assertions passed');
