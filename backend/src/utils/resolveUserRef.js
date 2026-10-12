const mongoose = require('mongoose');
const { AppError } = require('./errors');

/**
 * Turn whatever an admin typed into a real user id.
 *
 * Admin screens accept a "User ID" and passed it straight into a query. An
 * ObjectId that is not 24 hex characters makes Mongoose throw a CastError,
 * which carries no statusCode and so surfaced as a bare
 * `500 Internal server error` — no hint that the id was simply the wrong
 * shape. That is easy to hit by accident: the transactions table prints only
 * the LAST 8 CHARACTERS of the id, so copying what is on screen produces
 * exactly the value that 500s.
 *
 * So this accepts the things an admin can plausibly have in hand:
 *
 *   • a full 24-char ObjectId
 *   • the user-facing UID (USR100245), which is what the Users page shows
 *   • an email address
 *   • the last-N characters of an id, as printed in those tables — resolved
 *     only when exactly one user matches, never when it is ambiguous
 *
 * Anything else is a 400 with a message that says what was expected, and an
 * id that matches nobody is a 404. Neither is a 500.
 *
 * @param {string} ref   what the admin typed
 * @param {string} label field name for the error message
 * @returns {Promise<mongoose.Types.ObjectId>} the resolved user's _id
 */
async function resolveUserRef(ref, label = 'userId') {
  const raw = String(ref == null ? '' : ref).trim();
  if (!raw) throw new AppError(`${label} is required`, 400, 'USER_REF_REQUIRED');

  const User = require('../models/User');

  // 1. A full ObjectId — the common case, and the only one that needs no lookup
  //    beyond confirming the user exists.
  if (mongoose.isValidObjectId(raw) && raw.length === 24) {
    const byId = await User.findById(raw).select('_id').lean();
    if (!byId) throw new AppError(`No user found with ${label} ${raw}`, 404, 'USER_NOT_FOUND');
    return byId._id;
  }

  // 2. The user-facing UID or an email — both unique, both visible in admin.
  const orClauses = [{ userUid: raw.toUpperCase() }];
  if (raw.includes('@')) orClauses.push({ email: raw.toLowerCase() });
  const byUid = await User.findOne({ $or: orClauses }).select('_id').lean();
  if (byUid) return byUid._id;

  // 3. A fragment of an id, as the admin tables print it. Hex only, long
  //    enough to be meaningful, and accepted ONLY when it identifies exactly
  //    one user — a prefix that matches several is an ambiguous instruction,
  //    not a guess to resolve.
  if (/^[0-9a-f]{6,23}$/i.test(raw)) {
    const suffix = raw.toLowerCase();
    // $expr + $toString so the match runs on the hex rendering of the _id,
    // which is what the UI printed. Bounded by a limit: two hits is already
    // enough to know it is ambiguous.
    const matches = await User.aggregate([
      { $addFields: { _hex: { $toString: '$_id' } } },
      { $match: { _hex: { $regex: suffix + '$', $options: 'i' } } },
      { $limit: 2 },
      { $project: { _id: 1 } },
    ]);
    if (matches.length === 1) return matches[0]._id;
    if (matches.length > 1) {
      throw new AppError(
        `"${raw}" matches more than one user. Paste the full 24-character ID or the user's UID (e.g. USR100245).`,
        400,
        'USER_REF_AMBIGUOUS'
      );
    }
  }

  throw new AppError(
    `"${raw}" is not a valid ${label}. Use the full 24-character ID, the user's UID (e.g. USR100245), or their email.`,
    400,
    'USER_REF_INVALID'
  );
}

module.exports = { resolveUserRef };
