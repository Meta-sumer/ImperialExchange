/**
 * spreadService — resolves the EFFECTIVE bid-ask spread for an instrument on a
 * given account type. Priority (most specific wins):
 *   1. Per-instrument-per-account override  (Instrument.accountSpreads)
 *   2. Account-plan default spread          (AccountPlan.defaultSpreadValue)
 *   3. Instrument global spread             (Instrument.spreadValue) — legacy
 *
 * Both the matching engine (the real B-book / external fill) and the order-form
 * preview call this, so the quoted spread always equals the spread charged.
 * Returns { spreadValue: String, spreadType: 'FIXED' | 'PERCENTAGE' }.
 */
const accountPlansService = require('./accountPlansService');

const _has = (v) => v != null && String(v).trim() !== '';

async function resolveSpread(instrument, accountType) {
  const at = String(accountType || '').toUpperCase();

  // 1. Per-instrument-per-account override.
  const ov = (instrument?.accountSpreads || []).find(
    (o) => String(o.accountType || '').toUpperCase() === at && _has(o.spreadValue)
  );
  if (ov) return { spreadValue: String(ov.spreadValue), spreadType: ov.spreadType || 'FIXED' };

  // 2. Account-plan default spread (cached lookup).
  if (at) {
    try {
      const plan = await accountPlansService.getByCode(at);
      if (plan && _has(plan.defaultSpreadValue)) {
        return { spreadValue: String(plan.defaultSpreadValue), spreadType: plan.defaultSpreadType || 'FIXED' };
      }
    } catch (_) { /* fall through to the instrument global */ }
  }

  // 3. Instrument global spread (the legacy universal value).
  return { spreadValue: String(instrument?.spreadValue || '0'), spreadType: instrument?.spreadType || 'FIXED' };
}

module.exports = { resolveSpread };
