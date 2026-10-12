const { resolveMethod } = require('./paymentMethods');

const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

/**
 * Withdrawal fee charged for a payment method on a gross amount, from the
 * admin-configured `deposit.paymentDetails[method]` (same config blob as
 * deposit fees, but the `withdrawalFeePercent` / `withdrawalFeeFixed` keys).
 *
 * Resolution goes through the shared resolver so a custom rail matches by id OR
 * label — the old id-only lookup never matched what clients actually submit
 * (the label), so a fee configured on a custom rail silently came back '0'.
 *
 * Returned in the SAME unit as `grossAmount`, clamped to [0, grossAmount] so the
 * net payout can never go negative. No config (or 0) → returns '0', i.e. no fee
 * until an admin configures one.
 *
 * @param {string} method       Withdrawal.method — 'UPI'|'BANK'|'CRYPTO'|<custom id or label>
 * @param {string|number} grossAmount
 * @returns {Promise<string>}   fee as a string-decimal
 */
async function computeWithdrawalFee(method, grossAmount) {
  const gross = Number(grossAmount) || 0;
  if (gross <= 0 || !method) return '0';
  const resolved = await resolveMethod(method);
  const cfg = resolved && resolved.cfg;
  if (!cfg) return '0';
  const pct = Number(cfg.withdrawalFeePercent) || 0;
  const fixed = Number(cfg.withdrawalFeeFixed) || 0;
  let fee = round2(gross * (pct / 100) + fixed);
  if (fee < 0) fee = 0;
  if (fee > gross) fee = gross;
  return String(fee);
}

module.exports = { computeWithdrawalFee };
