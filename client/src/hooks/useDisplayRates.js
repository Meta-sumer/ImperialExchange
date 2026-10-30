/**
 * Display exchange rates — INR-only.
 *
 * The platform's ledger is INR and INR is the only currency money moves in,
 * so there is exactly one "rate": 1. This hook keeps the API the pages were
 * written against (currencies, rateFor, rateOf, symbolFor) so a deposit or
 * withdrawal screen that quotes an admin limit still works, but it no longer
 * fetches anything and never converts.
 */
const CURRENCIES = [{ code: 'INR', symbol: '₹', rate: 1, depositRate: 1, withdrawalRate: 1 }];
const SYMBOLS = { INR: '₹', USD: '$', GBP: '£', EUR: '€', JPY: '¥', USDT: '₮', BTC: '₿' };

export function useDisplayRates() {
  const rateOf = (code) => (String(code || 'INR').toUpperCase() === 'INR' ? 1 : null);
  const rateFor = () => 1;
  const symbolFor = (code) => {
    const c = String(code || 'INR').toUpperCase();
    return SYMBOLS[c] || (c + ' ');
  };
  return { currencies: CURRENCIES, rateFor, rateOf, symbolFor };
}
