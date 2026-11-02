/**
 * Derived (MCX) price math — the pure helper behind the Yahoo poller and the
 * admin calibration endpoint (utils/derivedPrice.js), plus the MCX catalogue
 * invariants the calibration relies on (every row carries a family group).
 */
const assert = require('assert');
const { ADJUST_LIMIT, applyAdjust, stripAdjust, adjustFromReference, derivedPrice } = require('../src/utils/derivedPrice');

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// Gold parity: GC=F 3905.9 USD/oz × USDINR 94.925 × 10/31.1035 = ₹1,19,2xx per 10 g.
const OZ = 31.1035;
const gold = derivedPrice(3905.9, 94.925, 10 / OZ);
assert.ok(gold > 119000 && gold < 119500, `gold parity ${gold}`);

// No adjustment → identity.
assert.ok(close(applyAdjust(100, 0), 100));
assert.ok(close(stripAdjust(100, 0), 100));

// Reference below parity → negative adjustment; applying it reproduces the reference.
const adj = adjustFromReference(gold, 100000);
assert.ok(adj < 0 && adj > -ADJUST_LIMIT, `adjust ${adj}`);
assert.ok(close(applyAdjust(gold, adj), 100000, 0.5), `round trip ${applyAdjust(gold, adj)}`);
// Four decimals.
assert.strictEqual(adj, Math.round(adj * 10000) / 10000);

// strip(apply(x)) === x.
assert.ok(close(stripAdjust(applyAdjust(1234.5, -16.13), -16.13), 1234.5));

// Clamp: a typo cannot push beyond ±ADJUST_LIMIT.
assert.strictEqual(adjustFromReference(100, 1000), ADJUST_LIMIT);
assert.strictEqual(adjustFromReference(100, 1), -ADJUST_LIMIT);

// Full chain with an adjustment equals parity × (1 + pct/100).
assert.ok(close(derivedPrice(3905.9, 94.925, 10 / OZ, -10), gold * 0.9, 1e-6));

// Invalid inputs are refused rather than producing a silent 0 or Infinity.
assert.throws(() => adjustFromReference(0, 100));
assert.throws(() => adjustFromReference(100, -5));

// Catalogue: every MCX row has a family group, a free Yahoo source and a unique symbol.
const { MCX_COMMODITIES } = require('../src/services/mcxCommodities');
const symbols = new Set();
for (const c of MCX_COMMODITIES) {
  assert.ok(c.group, `${c.symbol} needs a group`);
  assert.ok(/=F$/.test(c.yh), `${c.symbol} needs a Yahoo futures ticker`);
  assert.ok(c.mult > 0, `${c.symbol} multiplier`);
  assert.ok(!symbols.has(c.symbol), `duplicate ${c.symbol}`);
  symbols.add(c.symbol);
}
// Same-family contracts share the feed ticker (one calibration fits all of them).
const byGroup = {};
for (const c of MCX_COMMODITIES) (byGroup[c.group] = byGroup[c.group] || new Set()).add(c.yh);
for (const [g, set] of Object.entries(byGroup)) assert.strictEqual(set.size, 1, `${g} mixes feed tickers`);

console.log('derivedPrice ok —', MCX_COMMODITIES.length, 'MCX contracts in', Object.keys(byGroup).length, 'families');
