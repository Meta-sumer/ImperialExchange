import { useDisplayCurrency } from '../store/displayCurrency';
import { useDisplayRates } from './useDisplayRates';

/**
 * Render an account-money amount in the user's chosen DISPLAY currency.
 *
 * Every balance, P&L and deposit figure the API returns is USD — wallets are
 * USD-denominated and the backend converts on the way in. A display currency
 * selector already existed (store/displayCurrency, default USD, persisted and
 * synced to the profile), but only Layout and Trade honoured it. Everywhere
 * else hardcoded a rupee sign and multiplied by a USD->INR rate, so the
 * selector did nothing on the pages where the numbers actually live.
 *
 * This is for ACCOUNT MONEY only. An instrument's own quote is a different
 * thing: NSE stocks and options are genuinely priced in rupees, and a NIFTY
 * option really does cost Rs 120 rather than $120. Those keep their native
 * symbol and must not be routed through here.
 *
 *   const { money, signed, num, symbol } = useMoney();
 *   money(1234.5)            -> "$1,234.50"   (or "₹1,02,463.50" in INR)
 *   signed(-12.3)            -> "-$12.30"
 *   money(1234.5, 0)         -> "$1,235"
 */

// Indian digit grouping (1,23,456.78) is correct for rupees and wrong for
// everything else, so it follows the currency rather than being baked in.
const LOCALES = { INR: 'en-IN' };

export function useMoney() {
  const code = useDisplayCurrency((s) => s.code);
  const { rateFor, symbolFor } = useDisplayRates();

  const rate = rateFor(code);
  const symbol = symbolFor(code);
  const locale = LOCALES[code] || 'en-US';

  const convert = (usd) => {
    const n = Number(usd);
    return Number.isFinite(n) ? n * rate : 0;
  };

  const group = (v, decimals) => v.toLocaleString(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  /** Plain converted number, no symbol. */
  const num = (usd, decimals = 2) => group(convert(usd), decimals);

  /** Symbol + amount. Negatives read "-$12.30", not "$-12.30". */
  const money = (usd, decimals = 2) => {
    const v = convert(usd);
    return `${v < 0 ? '-' : ''}${symbol}${group(Math.abs(v), decimals)}`;
  };

  /** Always shows a sign — for P&L, where "+" carries meaning. */
  const signed = (usd, decimals = 2) => {
    const v = convert(usd);
    return `${v < 0 ? '-' : '+'}${symbol}${group(Math.abs(v), decimals)}`;
  };

  return { code, rate, symbol, locale, convert, num, money, signed };
}
