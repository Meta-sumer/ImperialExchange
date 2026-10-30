/**
 * Currency service — EquityHub is INR-only.
 *
 * The ledger currency is INR (config/constants BASE_CURRENCY): wallets,
 * margin, P&L, fees, deposits and withdrawals are all rupees, and every Indian
 * instrument is quoted in rupees, so there is nothing to convert. These helpers
 * keep their old names (callers still call toBase / fromBase) but are identity
 * functions for INR and REFUSE any other currency rather than guessing a rate —
 * a wrong rate on money movement is worse than a clear error.
 *
 * getUsdInrRate() remains only for the few legacy reporting paths that still
 * mention USD; it never feeds the ledger.
 */
const { BASE_CURRENCY } = require('../config/constants');

const FALLBACK = Number(process.env.USDINR_FALLBACK) || 83;
const TTL_MS = 5 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 7000;
const MIN_RATE = FALLBACK * 0.5;
const MAX_RATE = FALLBACK * 2;

let cachedRate = FALLBACK;
let cachedAt = 0;
let inflight = null;

const fetchUpstream = async () => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=INR', { signal: ctrl.signal });
    if (!res.ok) throw new Error(`upstream status ${res.status}`);
    const json = await res.json();
    const rate = Number(json && json.rates && json.rates.INR);
    if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) throw new Error('upstream payload invalid or out of range');
    return rate;
  } finally {
    clearTimeout(timer);
  }
};

/** Live USD→INR (reference only — the ledger never uses it). */
async function getUsdInrRate() {
  const now = Date.now();
  if (now - cachedAt < TTL_MS && cachedAt > 0) return cachedRate;
  if (!inflight) {
    inflight = fetchUpstream()
      .then((r) => { cachedRate = r; cachedAt = Date.now(); return r; })
      .catch(() => { cachedAt = Date.now(); return cachedRate; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

const unsupported = (cur) => {
  const err = new Error(`Only ${BASE_CURRENCY} is supported (got ${cur}).`);
  err.code = 'UNSUPPORTED_CURRENCY';
  err.statusCode = 400;
  return err;
};

/** Amount in `currency` → ledger currency. INR only. */
async function toBase(currency, amount) {
  const cur = String(currency || BASE_CURRENCY).toUpperCase();
  if (cur !== BASE_CURRENCY) throw unsupported(cur);
  const amt = Number(amount);
  const ok = Number.isFinite(amt) && amt >= 0;
  return { baseCurrency: BASE_CURRENCY, baseAmount: ok ? amt : 0, rate: 1, originalCurrency: cur, originalAmount: ok ? amt : 0 };
}

/** Ledger amount → `currency`. INR only. */
async function fromBase(currency, amount) {
  const cur = String(currency || BASE_CURRENCY).toUpperCase();
  if (cur !== BASE_CURRENCY) throw unsupported(cur);
  const amt = Number(amount);
  return Number.isFinite(amt) ? amt : 0;
}

module.exports = { getUsdInrRate, toBase, fromBase };
