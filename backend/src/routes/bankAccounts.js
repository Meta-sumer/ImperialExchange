/**
 * Deposit bank accounts — the pool of company bank accounts a Super Admin
 * assigns to users so deposits are spread across several accounts. Mounted
 * by routes/admin.js at /api/admin/bank-accounts behind `authenticate`,
 * `requireAdmin` and `requireRole(SUPER_ADMIN)`.
 *
 * Handlers live in controllers/bankAccountController.js.
 */
const express = require('express');

const router = express.Router();

module.exports = router;
