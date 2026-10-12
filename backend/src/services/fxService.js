/**
 * fxService — the single source of truth for multi-currency conversion.
 *
 * ARCHITECTURE (do not mix these):
 *   ACCOUNT BASE CURRENCY = USD  (the wallet + all trading/margin/P&L math)
 *   DISPLAY CURRENCY      = what the user chose to SEE (presentation only)
 *   TRANSACTION CURRENCY  = what a deposit/withdrawal is entered in
 *   EXCHANGE RATE         = 1 USD = <rate> <quoteCurrency>
 *
 * This service ONLY converts numbers. It never mutates a wallet balance. The
 * caller decides which rate purpose to use:
 *   - 'display'    → UI conversion (balances, notional)
 *   - 'deposit'    → incoming deposit amount → USD
 *   - 'withdrawal' → withdrawal amount ↔ USD
 *
 * Rates come from the ExchangeRate collection (admin-configured). AUTO mode uses
 * the live online rate (reusing the existing currencyService for INR + a
 * generalized frankfurter fetch for others); MANUAL mode uses the admin-entered
 * rate and NEVER hits the network. Unknown/unconfigured currencies fall back to
 * 1:1 with USD — exactly the pre-existing currencyService behaviour, so nothing
 * regresses.
 */
const ExchangeRate = require('../models/ExchangeRate');
const currencyService = require('./currencyService');

const BASE = 'USD';

// Default currencies seeded on first boot. USD is implicit (rate always 1).
const DEFAULT_CURRENCIES = [
  { quoteCurrency: 'INR', symbol: '₹', mode: 'AUTO', displayRate: 83, depositRate: 83, withdrawalRate: 83 },
  { quoteCurrency: 'GBP', symbol: '£', mode: 'AUTO', displayRate: 0.79, depositRate: 0.79, withdrawalRate: 0.79 },
  { quoteCurrency: 'EUR', symbol: '€', mode: 'AUTO', displayRate: 0.92, depositRate: 0.92, withdrawalRate: 0.92 },
  { quoteCurrency: 'USDT', symbol: '₮', mode: 'MANUAL', displayRate: 1, depositRate: 1, withdrawalRate: 1 },
];

const SYMBOLS = { USD: '$', INR: '₹', GBP: '£', EUR: '€', JPY: '¥', USDT: '₮', BTC: '₿' };
const symbolFor = (code) => SYMBOLS[String(code || '').toUpperCase()] || '';

// ── Live-rate cache (per currency), 5-min TTL. AUTO mode only. ─────────────
const _live = new Map(); // code -> { rate, at }
const LIVE_TTL_MS = 5 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 7000;

/**
 * Live 1 USD = <rate> <code>. INR reuses the existing (cached) currencyService
 * so the whole app agrees on one INR number. Others fetch frankfurter directly.
 * Any failure returns null so the caller can fall back to the stored rate.
 */
const _fetchLive = async (code) => {
  if (code === 'INR') {
    try { const r = await currencyService.getUsdInrRate(); return Number.isFinite(r) && r > 0 ? r : null; }
    catch (_) { return null; }
  }
  const cached = _live.get(code);
  if (cached && Date.now() - cached.at < LIVE_TTL_MS) return cached.rate;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.frankfurter.app/latest?from=USD&to=${encodeURIComponent(code)}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const json = await res.json();
    const rate = Number(json && json.rates && json.rates[code]);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('bad payload');
    _live.set(code, { rate, at: Date.now() });
    return rate;
  } catch (_) {
    return null; // caller falls back to stored displayRate
  } finally {
    clearTimeout(timer);
  }
};

/** Seed the default currency rows once (idempotent — skips existing). */
// Seeding is a boot concern, not a per-request one. server.js calls this once
// at startup; GET /fx/rates used to call it again on EVERY request, paying four
// sequential Atlas upserts (~75ms at 18.7ms RTT) to insert rows that already
// exist. The flag keeps the boot call and makes any later call free.
let _seeded = false;
const ensureSeed = async () => {
  if (_seeded) return;
  try {
    for (const c of DEFAULT_CURRENCIES) {
      await ExchangeRate.updateOne(
        { quoteCurrency: c.quoteCurrency },
        { $setOnInsert: { baseCurrency: BASE, enabled: true, ...c } },
        { upsert: true }
      );
    }
    _seeded = true;
  } catch (e) {
    console.warn('[fxService] ensureSeed failed:', e.message);
  }
};

/** All configured currencies incl. USD (base), enabled first. */
const listCurrencies = async ({ enabledOnly = false } = {}) => {
  const rows = await ExchangeRate.find(enabledOnly ? { enabled: true } : {}).lean();
  const out = [{ code: BASE, symbol: '$', enabled: true, mode: 'MANUAL', base: true }];
  for (const r of rows) {
    out.push({
      code: r.quoteCurrency,
      symbol: r.symbol || symbolFor(r.quoteCurrency),
      enabled: r.enabled !== false,
      mode: r.mode || 'AUTO',
      displayRate: r.displayRate,
      depositRate: r.depositRate,
      withdrawalRate: r.withdrawalRate,
    });
  }
  return out;
};

const _rateField = (type) =>
  type === 'deposit' ? 'depositRate' : type === 'withdrawal' ? 'withdrawalRate' : 'displayRate';

/**
 * Resolve 1 USD = <rate> <code> for a purpose. Returns { rate, source }.
 * Throws for MANUAL currencies missing/invalid a required deposit/withdrawal
 * rate (money movement must never silently use a wrong rate).
 */
/**
 * The body of getRate, operating on an ALREADY-LOADED row instead of issuing
 * its own findOne. GET /fx/rates calls listCurrencies() — which returns mode,
 * displayRate, depositRate and withdrawalRate for every currency — and then
 * used to call getRate() per currency, re-reading from Atlas the exact rows it
 * was already holding. Accepts either shape: an ExchangeRate document
 * (quoteCurrency) or a listCurrencies entry (code).
 */
const resolveRateFromRow = async (doc, type = 'display') => {
  // No row at all. 1:1 is a reasonable placeholder for a DISPLAY estimate and
  // is never acceptable for money movement: it would credit ₹8,300 as $8,300
  // on a deposit, and pay ₹100 where ₹8,300 was owed on a withdrawal. The
  // MANUAL branch below already refuses for the same reason; this path just
  // never did, so an admin adding a currency to a rail without giving it a
  // rate opened that hole.
  if (!doc) {
    if (type === 'display') return { rate: 1, source: 'unconfigured' };
    const err = new Error(`No exchange rate is configured for this currency (${type})`);
    err.code = 'MISSING_RATE';
    throw err;
  }
  const c = String(doc.quoteCurrency || doc.code || BASE).toUpperCase();
  if (c === BASE) return { rate: 1, source: 'base' };

  const field = _rateField(type);
  const stored = Number(doc[field]);
  const storedDisplay = Number(doc.displayRate);

  if (doc.mode === 'MANUAL') {
    const r = Number.isFinite(stored) && stored > 0 ? stored
      : (Number.isFinite(storedDisplay) && storedDisplay > 0 ? storedDisplay : null);
    if (r == null) {
      if (type === 'display') return { rate: 1, source: 'manual-missing' };
      const err = new Error(`No ${type} exchange rate configured for ${c}`);
      err.code = 'MISSING_RATE';
      throw err;
    }
    return { rate: r, source: 'manual' };
  }

  // AUTO → live, with stored value (or 1) as fallback.
  const live = await _fetchLive(c);
  if (Number.isFinite(live) && live > 0) return { rate: live, source: 'auto-live' };
  if (Number.isFinite(stored) && stored > 0) return { rate: stored, source: 'auto-fallback' };
  if (Number.isFinite(storedDisplay) && storedDisplay > 0) return { rate: storedDisplay, source: 'auto-fallback' };
  // AUTO, the live fetch failed, and no stored fallback. Same rule as above:
  // a 1:1 guess is fine for a display estimate, never for money.
  if (type === 'display') return { rate: 1, source: 'auto-fallback-1' };
  const err = new Error(`No ${type} exchange rate available for ${c} (live lookup failed and no fallback is stored)`);
  err.code = 'MISSING_RATE';
  throw err;
};

/**
 * Resolve 1 USD = <rate> <code> for a purpose. Returns { rate, source }.
 * Throws for MANUAL currencies missing/invalid a required deposit/withdrawal
 * rate (money movement must never silently use a wrong rate).
 */
const getRate = async (code, type = 'display') => {
  const c = String(code || BASE).toUpperCase();
  if (c === BASE) return { rate: 1, source: 'base' };
  // Unknown currency → 1:1 with USD (matches legacy currencyService). Only
  // safe for display; deposits/withdrawals validate the currency separately.
  return resolveRateFromRow(await ExchangeRate.findOne({ quoteCurrency: c }).lean(), type);
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Convert an amount in `code` → USD using the `type` rate. */
const toUsd = async (code, amount, type = 'display') => {
  const amt = Number(amount) || 0;
  const { rate, source } = await getRate(code, type);
  const usd = String(code || BASE).toUpperCase() === BASE ? amt : amt / rate;
  return { usd: round2(usd), rate, source };
};

/** Convert a USD amount → `code` using the `type` rate. */
const fromUsd = async (code, usdAmount, type = 'display') => {
  const amt = Number(usdAmount) || 0;
  const { rate, source } = await getRate(code, type);
  const converted = String(code || BASE).toUpperCase() === BASE ? amt : amt * rate;
  return { amount: round2(converted), rate, source };
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
