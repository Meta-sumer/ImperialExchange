const express = require('express');
const router = express.Router();

const FALLBACK = Number(process.env.USDINR_FALLBACK) || 83;
const TTL_MS = 5 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 7000;

let cachedRate = FALLBACK;
let cachedAt = 0;
let inflight = null;

const fetchUpstream = async () => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=INR', {
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`upstream status ${res.status}`);
    const json = await res.json();
    const rate = Number(json && json.rates && json.rates.INR);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('upstream payload invalid');
    return rate;
  } finally {
    clearTimeout(timer);
  }
};

router.get('/usdinr', async (req, res) => {
  const now = Date.now();
  if (now - cachedAt < TTL_MS && cachedAt > 0) {
    return res.json({ rate: cachedRate, source: 'cache', ts: cachedAt });
  }

  if (!inflight) {
    inflight = fetchUpstream()
      .then((rate) => {
        cachedRate = rate;
        cachedAt = Date.now();
        return { rate, source: 'frankfurter', ts: cachedAt };
      })
      .catch((err) => {
        cachedAt = Date.now();
        return { rate: cachedRate, source: 'fallback', ts: cachedAt, error: err.message };
      })
      .finally(() => { inflight = null; });
  }

  const result = await inflight;
  res.json(result);
});

/**
 * GET /api/fx/rates — public list of enabled DISPLAY currencies + their
 * `1 USD = rate` display rates, for the client currency selector. Display-only:
 * these never touch a wallet balance. Deposit/withdrawal use their own rates
 * (resolved server-side at transaction time), not these.
 *
 * Shape: { base:'USD', ts, currencies:[{ code, symbol, rate }] } where `rate`
 * is `1 USD = rate <code>` (USD itself = 1).
 */
router.get('/rates', async (req, res) => {
  try {
    const fxService = require('../services/fxService');
    // ensureSeed() is gone from the request path. server.js already calls it at
    // boot; calling it here re-ran four sequential Atlas upserts on EVERY hit,
    // inserting rows that always already existed (~75ms at 18.7ms RTT).
    const configured = await fxService.listCurrencies({ enabledOnly: true });

    // listCurrencies already returned mode/displayRate/depositRate/withdrawalRate
    // for every currency, so the old per-currency getRate() call was re-reading
    // from Atlas the very rows we are holding — one extra round trip each, in
    // series. resolveRateFromRow runs the identical logic against the loaded row.
    //
    // Promise.all matters for a second reason: an AUTO currency resolves through
    // an outbound HTTPS call to the rate provider (5-minute cache, 7s timeout).
    // Serialised, a cold cache with three AUTO currencies could hold this request
    // open for 21 seconds. Overlapped, the worst case is one timeout.
    const out = await Promise.all(configured.map(async (c) => {
      if (c.code === 'USD') return { code: 'USD', symbol: '$', rate: 1, depositRate: 1, withdrawalRate: 1 };
      // resolveRateFromRow throws on a MANUAL row with no rate for that leg, so
      // each leg resolves independently and falls back to the display rate.
      const pick = async (type) => {
        try { return (await fxService.resolveRateFromRow(c, type)).rate; }
        catch (_) { return null; }
      };
      const display = (await pick('display')) || Number(c.displayRate) || 1;
      // The DEPOSIT and WITHDRAWAL legs are what the wallet actually credits and
      // debits at. Shipping only the display rate meant the deposit screen could
      // promise one USD figure while the admin's confirm credited another — the
      // exact mismatch a user would, rightly, complain about.
      const deposit = (await pick('deposit')) || display;
      const withdrawal = (await pick('withdrawal')) || display;
      return { code: c.code, symbol: c.symbol || '', rate: display, depositRate: deposit, withdrawalRate: withdrawal };
    }));
    res.json({ base: 'USD', ts: Date.now(), currencies: out });
  } catch (err) {
    // Never break the client selector — fall back to USD-only.
    res.json({ base: 'USD', ts: Date.now(), currencies: [{ code: 'USD', symbol: '$', rate: 1, depositRate: 1, withdrawalRate: 1 }], error: err.message });
  }
});

module.exports = router;
