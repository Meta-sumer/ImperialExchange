const express = require('express');
const c = require('../controllers/bonusWalletController');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// User-facing. The Bonus Wallet is WITHDRAW-ONLY: funded by referral and
// partner earnings, emptied by withdrawal or an internal transfer OUT. The two
// deposit routes below now refuse with BONUS_WALLET_WITHDRAW_ONLY; they are
// kept mounted so an old client gets a clear message rather than a 404.
router.get('/', authenticate, c.getWallet);
router.get('/summary', authenticate, c.getSummary);
router.get('/history', authenticate, c.history);
// "Add funds" — instant transfer from a trading account, or a manual
// (UPI/Bank/Crypto/…) deposit that an admin verifies.
router.post('/deposit', authenticate, c.deposit);
router.post('/manual-deposit', authenticate, c.manualDeposit);
// Real cash-out: debit/hold the balance + create a PENDING withdrawal for the
// admin queue (refunded on reject). KYC-gated.
router.post('/withdraw', authenticate, c.requestWithdrawal);
router.post('/auto-renew', authenticate, c.toggleAutoRenew);

// Admin
router.post('/admin/credit', authenticate, requireAdmin, c.adminCredit);
router.post('/admin/debit', authenticate, requireAdmin, c.adminDebit);
router.get('/admin/balances', authenticate, requireAdmin, c.adminBalances);
router.get('/admin/logs', authenticate, requireAdmin, c.adminLogs);

module.exports = router;
