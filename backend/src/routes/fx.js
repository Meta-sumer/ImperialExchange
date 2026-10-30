/**
 * /api/fx — kept for older clients (the mobile app reads these). EquityHub is
 * INR-only, so there is exactly one currency and no conversion: every amount the
 * API returns is already rupees.
 */
const express = require('express');
const { BASE_CURRENCY } = require('../config/constants');

const router = express.Router();

// Legacy: callers multiplied "USD" balances by this to show rupees. Balances
// are rupees now, so the multiplier is 1.
router.get('/usdinr', (req, res) => {
  res.json({ rate: 1, source: 'inr-ledger', ts: Date.now() });
});

router.get('/rates', (req, res) => {
  res.json({
    base: BASE_CURRENCY,
    ts: Date.now(),
    currencies: [{ code: BASE_CURRENCY, symbol: '₹', rate: 1, depositRate: 1, withdrawalRate: 1 }],
  });
});

module.exports = router;
