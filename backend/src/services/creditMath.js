/**
 * Pure settlement arithmetic for credit transactions — no I/O, so it can be
 * unit-tested and reused by the controller and any report.
 */
const { add, sub, gt, gte, eq } = require('../utils/decimal');

/** What is still owed on a credit row (decimal string). */
const outstandingOf = (tx) => sub(tx.amount, tx.settledAmount || '0');

/**
 * Apply one payment of `settleAmount` to a credit of `amount` that already has
 * `settledAmount` recorded. Throws Error('INVALID_AMOUNT') for a non-positive
 * payment and Error('EXCEEDS_OUTSTANDING') when it overshoots.
 */
function applySettlement({ amount, settledAmount = '0', settleAmount }) {
  const n = Number(settleAmount);
  if (!Number.isFinite(n) || !gt(settleAmount, '0')) throw new Error('INVALID_AMOUNT');
  const outstanding = sub(amount, settledAmount);
  if (gt(settleAmount, outstanding)) throw new Error('EXCEEDS_OUTSTANDING');
  const next = add(settledAmount, settleAmount);
  const status = gte(next, amount) ? 'SETTLED' : 'PARTIALLY_SETTLED';
  return { settledAmount: next, status, outstanding: sub(amount, next) };
}

/** Only a PENDING credit with nothing settled against it can be reversed. */
const canCancel = (tx) => tx.status === 'PENDING' && eq(tx.settledAmount || '0', '0');

module.exports = { outstandingOf, applySettlement, canCancel };
