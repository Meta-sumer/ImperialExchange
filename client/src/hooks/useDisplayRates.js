import { useSyncExternalStore } from 'react';
import { api } from '../services/api';

/**
 * Live DISPLAY exchange rates (1 USD = rate <code>) for the currency selector.
 * Display-only — these convert USD → the chosen currency at render time and
 * NEVER touch a wallet balance. Mirrors the useFxRate singleton pattern:
 * module-level cache, 5-min TTL, refreshed on first subscribe, re-renders
 * subscribers when the list updates.
 *
 * GET /fx/rates → { base:'USD', currencies:[{ code, symbol, rate }] }.
 */
const FALLBACK = [
  { code: 'USD', symbol: '$', rate: 1, depositRate: 1, withdrawalRate: 1 },
  { code: 'INR', symbol: '₹', rate: Number(import.meta.env.VITE_USDINR_RATE) || 83 },
];
const TTL_MS = 5 * 60 * 1000;

let current = FALLBACK;
let lastFetchAt = 0;
let inflight = null;
const listeners = new Set();

const emit = () => { for (const l of listeners) l(); };

const refresh = () => {
  const now = Date.now();
  if (inflight || now - lastFetchAt < TTL_MS) return;
  inflight = api.get('/fx/rates', { timeout: 8000 })
    .then((res) => {
      const rows = res?.data?.currencies;
      if (Array.isArray(rows) && rows.length) {
        current = rows.map((r) => ({
          code: String(r.code).toUpperCase(),
          symbol: r.symbol || '',
          rate: Number(r.rate) || 1,
          // Absent on an older server → fall back to the display rate.
          depositRate: Number(r.depositRate) || Number(r.rate) || 1,
          withdrawalRate: Number(r.withdrawalRate) || Number(r.rate) || 1,
        }));
        lastFetchAt = Date.now();
        emit();
      }
    })
    .catch(() => { lastFetchAt = Date.now(); /* back off; keep last */ })
    .finally(() => { inflight = null; });
};

const subscribe = (cb) => {
  listeners.add(cb);
  refresh();
  return () => listeners.delete(cb);
};

/**
 * Returns { currencies, rateFor(code, leg), rateOf(code, leg), symbolFor(code) }.
 *   rateFor(code, leg) → 1 USD = rate <code>; unknown currency = 1
 *   rateOf(code, leg)  → the same, but NULL when the currency is not configured,
 *                        so a caller can fall back rather than silently use 1:1
 *   leg: 'display' (default) | 'deposit' | 'withdrawal'
 *
 * The leg matters. A deposit is credited at the DEPOSIT rate and a payout is
 * debited at the WITHDRAWAL rate; pricing either screen off the display rate
 * shows the user a number the wallet will not honour.
 */
const LEG_FIELD = { display: 'rate', deposit: 'depositRate', withdrawal: 'withdrawalRate' };

export function useDisplayRates() {
  const currencies = useSyncExternalStore(subscribe, () => current, () => FALLBACK);
  const rateOf = (code, leg = 'display') => {
    const c = String(code || 'USD').toUpperCase();
    if (c === 'USD') return 1;
    const row = currencies.find((r) => r.code === c);
    if (!row) return null;
    const v = Number(row[LEG_FIELD[leg] || 'rate']) || Number(row.rate);
    return Number(v) > 0 ? Number(v) : null;
  };
  const rateFor = (code, leg = 'display') => rateOf(code, leg) ?? 1;
  const symbolFor = (code) => {
    const c = String(code || 'USD').toUpperCase();
    const row = currencies.find((r) => r.code === c);
    if (row && row.symbol) return row.symbol;
    return { USD: '$', INR: '₹', GBP: '£', EUR: '€', JPY: '¥', USDT: '₮', BTC: '₿' }[c] || (c + ' ');
  };
  return { currencies, rateFor, rateOf, symbolFor };
}
