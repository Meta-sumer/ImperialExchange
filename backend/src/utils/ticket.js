/**
 * Human-readable trade ticket from a Mongo _id — the last 6 hex characters,
 * upper-cased and '#'-prefixed, e.g. `#726B5A`.
 *
 * This is the ONLY id a user ever sees: the trade screen's "Order ID" column
 * renders it for open positions, pending orders and order history (client
 * `ticketShort()`), so a wallet-ledger note that quotes a raw 24-character
 * ObjectId is, from the user's side, a different number entirely. Every note
 * and every reference we surface goes through here so the number in the
 * transaction history is the same number on the trade screen.
 *
 * Keep in sync with `ticketShort()` in client/src/pages/Trade.jsx.
 *
 * @param {*} id  Mongo ObjectId / string / null
 * @returns {string} `#XXXXXX`, or '' when there is no id to show
 */
const ticketShort = (id) => (id ? `#${String(id).slice(-6).toUpperCase()}` : '');

module.exports = { ticketShort };
