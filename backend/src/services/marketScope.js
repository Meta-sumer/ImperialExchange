/**
 * Market scope — the "Indian market only" switch.
 *
 * Instrument rows carry `exchange` (NSE/BSE/… or null for 24/7 global
 * markets). While the `market.indiaOnly` setting is on, every PUBLIC
 * instrument query and every order placement is clipped to Indian cash
 * exchanges, so a global row left active in the database can never reach a
 * trader. Admin views are not clipped — the admin still sees and manages
 * every row, and can flip the switch from Settings → Market Scope.
 */
const { getSettingSync } = require('./systemSettings.service');
const { AppError } = require('../utils/errors');

const INDIAN_EXCHANGES = ['NSE', 'BSE'];

const isIndiaOnly = () => getSettingSync('market.indiaOnly') !== false;

const isIndianInstrument = (inst) =>
  !!inst && INDIAN_EXCHANGES.includes(String(inst.exchange || '').toUpperCase());

/** Mutates (and returns) a Mongo filter so it only matches in-scope rows. */
const applyMarketScope = (filter) => {
  if (isIndiaOnly()) filter.exchange = { $in: INDIAN_EXCHANGES };
  return filter;
};

/** Rejects an order on an out-of-scope instrument. */
const assertInMarketScope = (inst) => {
  if (isIndiaOnly() && !isIndianInstrument(inst)) {
    throw new AppError('Only Indian market (NSE/BSE) instruments can be traded', 400, 'MARKET_SCOPE');
  }
};

module.exports = { INDIAN_EXCHANGES, isIndiaOnly, isIndianInstrument, applyMarketScope, assertInMarketScope };
