import { CURRENCY, CURRENCY_SYMBOL, fmtNum } from '../utils/format';

/**
 * Render an account-money amount. EquityHub is INR-only: every balance, P&L,
 * fee and deposit figure the API returns is already in rupees, so there is no
 * conversion — this only applies the rupee symbol and Indian digit grouping.
 *
 *   const { money, signed, num, symbol } = useMoney();
 *   money(1234.5)            -> "₹1,234.50"
 *   signed(-12.3)            -> "-₹12.30"
 *   money(1234.5, 0)         -> "₹1,235"
 */
const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Plain number, no symbol. */
const num = (v, decimals = 2) => fmtNum(toNum(v), decimals);

/** Symbol + amount. Negatives read "-₹12.30", not "₹-12.30". */
const money = (v, decimals = 2) => {
  const n = toNum(v);
  return `${n < 0 ? '-' : ''}${CURRENCY_SYMBOL}${fmtNum(Math.abs(n), decimals)}`;
};

/** Always shows a sign — for P&L, where "+" carries meaning. */
const signed = (v, decimals = 2) => {
  const n = toNum(v);
  return `${n < 0 ? '-' : '+'}${CURRENCY_SYMBOL}${fmtNum(Math.abs(n), decimals)}`;
};

const MONEY = {
  code: CURRENCY,
  rate: 1,
  symbol: CURRENCY_SYMBOL,
  locale: 'en-IN',
  convert: toNum,
  num,
  money,
  signed,
};

export function useMoney() {
  return MONEY;
}
