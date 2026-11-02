/**
 * Derived (MCX) price math — shared by the Yahoo poller and the admin
 * calibration endpoint, and unit-tested on its own (tests/derivedPrice.test.js).
 *
 *   derived(₹) = raw(USD) × fx(USDINR) × multiplier × (1 + adjustPct / 100)
 *
 * `adjustPct` is the admin's calibration. MCX quotes sit above or below the
 * international parity price (import duty, local premium/discount, contract
 * expiry basis), so the admin enters today's MCX price once and every row in
 * the same family (Instrument.feedConvert.group) is nudged by the same
 * percentage. Clamped to ±ADJUST_LIMIT so a typo cannot flip a market.
 */
const ADJUST_LIMIT = 50; // ± percent

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/** raw × (1 + adjustPct / 100). */
const applyAdjust = (raw, adjustPct) => num(raw) * (1 + num(adjustPct) / 100);

/** The un-adjusted (parity) price behind a stored lastPrice. */
const stripAdjust = (price, adjustPct) => {
  const f = 1 + num(adjustPct) / 100;
  return f > 0 ? num(price) / f : num(price);
};

/** Adjustment % that maps `raw` onto `reference`, clamped to ±ADJUST_LIMIT, 4 dp. */
const adjustFromReference = (raw, reference) => {
  const r = num(raw); const ref = num(reference);
  if (!(r > 0) || !(ref > 0)) throw new Error('raw and reference must be positive numbers');
  const pct = (ref / r - 1) * 100;
  const clamped = Math.max(-ADJUST_LIMIT, Math.min(ADJUST_LIMIT, pct));
  return Math.round(clamped * 10000) / 10000;
};

/** Full chain: Yahoo USD quote → rupee price for the contract unit. */
const derivedPrice = (rawUsd, fx, multiplier, adjustPct = 0) =>
  applyAdjust(num(rawUsd) * num(fx, 1) * num(multiplier, 1), adjustPct);

module.exports = { ADJUST_LIMIT, applyAdjust, stripAdjust, adjustFromReference, derivedPrice };
