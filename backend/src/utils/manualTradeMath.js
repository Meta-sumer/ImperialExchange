/**
 * Pure arithmetic for admin-booked (manual / backdated) trades and trade edits.
 * Kept free of models so it can be unit-tested without a database and reused
 * by the admin orders controller. All money / price / size values are decimal
 * strings — the platform never uses floats for money.
 */
const { D } = require('./decimal');

/** Margin reserved for a position: size × price ÷ leverage (leverage ≥ 1). */
const marginFor = (quantity, price, leverage) => {
  const lev = Number(leverage);
  return D(quantity).times(D(price)).dividedBy(Number.isFinite(lev) && lev > 0 ? lev : 1).toString();
};

/** Realized PnL of a closed trade: BUY profits when price rises, SELL when it falls. */
const realizedPnlFor = (side, entryPrice, closePrice, quantity) => {
  const diff = side === 'BUY' ? D(closePrice).minus(D(entryPrice)) : D(entryPrice).minus(D(closePrice));
  return diff.times(D(quantity)).toString();
};

/** Net result the wallet sees: PnL minus commission. */
const netOf = (pnl, commission) => D(pnl).minus(D(commission || 0)).toString();

/**
 * Validate open / close timestamps. Returns an error message, or null when OK.
 *   • openedAt is required and cannot be in the future
 *   • closedAt (when given) cannot be before openedAt or in the future
 */
const checkTradeTimes = ({ openedAt, closedAt = null, now = new Date() }) => {
  const ms = (d) => (d instanceof Date ? d.getTime() : NaN);
  if (!Number.isFinite(ms(openedAt))) return 'openedAt is required';
  if (ms(openedAt) > ms(now)) return 'openedAt cannot be in the future';
  if (closedAt != null) {
    if (!Number.isFinite(ms(closedAt))) return 'closedAt is not a valid date/time';
    if (ms(closedAt) < ms(openedAt)) return 'closedAt cannot be before openedAt';
    if (ms(closedAt) > ms(now)) return 'closedAt cannot be in the future';
  }
  return null;
};

module.exports = { marginFor, realizedPnlFor, netOf, checkTradeTimes };
