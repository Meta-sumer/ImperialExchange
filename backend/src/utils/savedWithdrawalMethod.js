const { AppError } = require('./errors');

/**
 * Resolve a user's SAVED, admin-VERIFIED withdrawal method into a payout
 * destination.
 *
 * The raw destination is never accepted from the request. The client only ever
 * holds a masked view (WithdrawalMethod.toSafeJSON), so the real account
 * number / UPI ID / wallet address is read here, server-side, from the record
 * the admin verified. That is the whole point: it makes an arbitrary
 * destination impossible no matter what the frontend sends.
 *
 * The trading wallet has always worked this way. The Main and Bonus wallets
 * only accepted a manually typed destination, so the same user could send
 * those balances anywhere, unverified. This helper exists so all three payout
 * paths resolve a saved method through ONE piece of code and cannot drift
 * apart — a security control split across three copies is a control waiting to
 * be half-fixed.
 *
 * @param {string} userId  owner — also the IDOR guard
 * @param {string} id      WithdrawalMethod._id
 * @returns {{ type: 'UPI'|'BANK'|'CRYPTO', dest: object, method: object }}
 *          `dest` is shaped for the Withdrawal document; `method` is the doc.
 */
async function resolveSavedMethod(userId, id) {
  const WithdrawalMethod = require('../models/WithdrawalMethod');
  // The userId filter is the IDOR guard — another user's id simply won't match.
  const wm = await WithdrawalMethod.findOne({ _id: id, userId });
  if (!wm || wm.archived) {
    throw new AppError('Withdrawal method not found.', 404, 'WITHDRAWAL_METHOD_NOT_FOUND');
  }
  if (wm.status === 'BLOCKED') {
    throw new AppError('This withdrawal method is blocked. Contact support.', 403, 'WITHDRAWAL_METHOD_BLOCKED');
  }
  if (wm.status === 'REJECTED') {
    throw new AppError('This withdrawal method was rejected. Add and verify a new one.', 403, 'WITHDRAWAL_METHOD_REJECTED');
  }
  if (wm.status !== 'VERIFIED' || !wm.isVerified) {
    throw new AppError('This withdrawal method is not verified yet.', 403, 'WITHDRAWAL_METHOD_NOT_VERIFIED');
  }

  // Copied verbatim so a later edit or delete of the method cannot change a
  // payout that is already pending.
  const dest = {};
  if (wm.type === 'UPI') {
    dest.upiId = wm.upiId;
  } else if (wm.type === 'BANK') {
    dest.bankAccountNumber = wm.accountNumber;
    dest.bankIFSC = wm.ifsc;
    dest.bankAccountHolderName = wm.accountHolderName;
    if (wm.bankName) dest.bankName = wm.bankName;
  } else if (wm.type === 'CRYPTO') {
    dest.cryptoAddress = wm.walletAddress;
    dest.cryptoNetwork = wm.network;
  } else {
    throw new AppError(`Unsupported withdrawal method type: ${wm.type}`, 400);
  }

  return { type: wm.type, dest, method: wm };
}

/**
 * Defence in depth: if the request ALSO carried destination fields, they must
 * not disagree with the saved method. A mismatch means the client tried to
 * steer the payout somewhere else, so it is refused rather than silently
 * ignored.
 */
function assertNoConflictingDestination(body, type, dest) {
  const b = body || {};
  const clash = (
    (b.upiId && b.upiId !== dest.upiId) ||
    (b.bankAccountNumber && String(b.bankAccountNumber) !== String(dest.bankAccountNumber)) ||
    (b.cryptoAddress && b.cryptoAddress !== dest.cryptoAddress) ||
    (b.method && String(b.method).toUpperCase() !== type)
  );
  if (clash) {
    throw new AppError(
      'Withdrawal destination cannot be entered manually. Use your saved verified method.',
      400,
      'ARBITRARY_DESTINATION'
    );
  }
}

module.exports = { resolveSavedMethod, assertNoConflictingDestination };
