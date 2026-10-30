/**
 * fxService — EquityHub is INR-only.
 *
 * This used to convert between a USD ledger and the currency a user deposited
 * in, chose to view, or withdrew in (ExchangeRate collection, admin-managed
 * rates, live frankfurter lookups). The ledger is now INR (BASE_CURRENCY) and
 * INR is the only currency money can move in, so:
 *
 *   - INR → rate 1, amounts pass through unchanged.
 *   - Any other currency → UNSUPPORTED_CURRENCY (never a guessed rate).
 *
 * The function names (toUsd / fromUsd) are kept so existing callers keep
 * working; read them as "to ledger" / "from ledger".
 */
const { BASE_CURRENCY } = require('../config/constants');

const BASE = BASE_CURRENCY;
const SYMBOLS = { INR: '₹' };
const symbolFor = (code) => SYMBOLS[String(code || '').toUpperCase()] || '';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const _unsupported = (c) => {
  const err = new Error(`Only ${BASE} is supported (got ${c}).`);
  err.code = 'UNSUPPORTED_CURRENCY';
  err.statusCode = 400;
  return err;
};

/** No exchange rates to seed any more. Kept for the boot call in server.js. */
const ensureSeed = async () => {};

/** The one currency. */
const listCurrencies = async () => [{ code: BASE, symbol: symbolFor(BASE), enabled: true, mode: 'MANUAL', base: true }];

const getRate = async (code) => {
  const c = String(code || BASE).toUpperCase();
  if (c !== BASE) throw _unsupported(c);
  return { rate: 1, source: 'base' };
};
const resolveRateFromRow = async (doc) => getRate(doc && (doc.quoteCurrency || doc.code));

/** Amount in `code` → ledger (INR). */
const toUsd = async (code, amount) => {
  const { rate, source } = await getRate(code);
  return { usd: round2(Number(amount) || 0), rate, source };
};

/** Ledger (INR) amount → `code`. */
const fromUsd = async (code, amount) => {
  const { rate, source } = await getRate(code);
  return { amount: round2(Number(amount) || 0), rate, source };
};

module.exports = {
  BASE,
  symbolFor,
  ensureSeed,
  listCurrencies,
  getRate,
  resolveRateFromRow,
  toUsd,
  fromUsd,
  round2,
};
