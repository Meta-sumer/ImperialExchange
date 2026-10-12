/**
 * The order ticket a user sees — last 6 hex characters of a Mongo _id,
 * upper-cased and '#'-prefixed, e.g. `#69EBF9`.
 *
 * There is ONE correct rendering of a trade's id and this is it. The trade
 * screen, the admin panel's order list and the wallet ledger notes all use
 * this form, so anything that invents its own is, to the person reading it, a
 * different order entirely — Trade History used to convert the last 8 hex
 * chars to decimal ("694807545") and nothing it showed could be matched
 * against any other screen or against support's admin view.
 *
 * Mirrors backend/src/utils/ticket.js. The backend returns '' for a missing id
 * because it concatenates into a sentence; here '—' is the table placeholder.
 *
 * @param {*} id  Mongo ObjectId / string / null
 * @param {string} [fallback] shown when there is no id
 */
export const ticketShort = (id, fallback = '—') =>
  (id ? `#${String(id).slice(-6).toUpperCase()}` : fallback);

export default ticketShort;
