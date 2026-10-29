/**
 * Credit transactions — deposits / withdrawals processed "on credit" (the
 * user pays or is paid later). Mounted by routes/admin.js at
 * /api/admin/credit, so every handler already runs behind `authenticate` +
 * `requireAdmin` and the per-admin module gate (DEPOSITS module, see
 * config/adminPermissions.js).
 *
 * Handlers live in controllers/creditController.js.
 */
const express = require('express');
const c = require('../controllers/creditController');

const router = express.Router();

router.get('/', c.list);
router.get('/summary', c.summary);
router.post('/', c.create);
router.post('/:id/settle', c.settle);
router.post('/:id/cancel', c.cancel);

module.exports = router;
