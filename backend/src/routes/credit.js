/**
 * Credit transactions — deposits / withdrawals processed "on credit" (the
 * user pays or is paid later). Mounted by routes/admin.js at
 * /api/admin/credit, so every handler already runs behind `authenticate` +
 * `requireAdmin` and the per-admin module gate.
 *
 * Handlers live in controllers/creditController.js.
 */
const express = require('express');

const router = express.Router();

module.exports = router;
