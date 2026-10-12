const { resolveMethod } = require('./paymentMethods');

const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

/**
 * Deposit fee charged for a payment method on a gross amount, from the
 * admin-configured `deposit.paymentDetails[method]`: `feePercent`% of the
 * amount + a flat `feeFixed`.
 *
 * Resolution goes through the shared resolver, which matches a fixed rail by
 * id AND a custom rail by id OR label. That matters: every client submits a
 * custom method as its LABEL ("PhonePe Biz"), never its id, so the old
 * `custom.find(c => c.id === method)` lookup matched nothing and quietly
 * returned '0' — an admin could set a fee on a custom rail and it would never
 * be charged, with no error anywhere to say so.
 *
 * Returned in the SAME unit as `grossAmount`, clamped to [0, grossAmount] so a
 * deposit can never credit a negative amount. No config (or 0) → returns '0',
 * i.e. existing behaviour is unchanged until an admin sets a fee.
 *
 * @param {string} method       Deposit.method — 'UPI'|'BANK'|'CRYPTO'|'SKRILL'|'NETELLER'|'RAZORPAY'|<custom id or label>
 * @param {string|number} grossAmount
 * @returns {Promise<string>}   fee as a string-decimal
 */
async function computeDepositFee(method, grossAmount) {
  const gross = Number(grossAmount) || 0;
  if (gross <= 0 || !method) return '0';
  const resolved = await resolveMethod(method);
  const cfg = resolved && resolved.cfg;
  if (!cfg) return '0';
  const pct = Number(cfg.feePercent) || 0;
  const fixed = Number(cfg.feeFixed) || 0;
  let fee = round2(gross * (pct / 100) + fixed);
  if (fee < 0) fee = 0;
  if (fee > gross) fee = gross;
  return String(fee);
}

module.exports = { computeDepositFee };
