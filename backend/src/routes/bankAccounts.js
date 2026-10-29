/**
 * Deposit bank accounts — the pool of company bank accounts a Super Admin
 * assigns to users so deposits are spread across several accounts. Mounted
 * by routes/admin.js at /api/admin/bank-accounts behind `authenticate`,
 * `requireAdmin` and `requireRole(SUPER_ADMIN)`.
 *
 * Handlers live in controllers/bankAccountController.js.
 */
const express = require('express');
const c = require('../controllers/bankAccountController');

const router = express.Router();

// Literal paths first so they are never swallowed by the `:id` routes.
router.get('/', c.list);
router.get('/stats', c.stats);
router.post('/', c.create);
router.post('/assign', c.assign);
router.post('/distribute', c.distribute);

router.get('/:id/users', c.users);
router.put('/:id', c.update);
router.post('/:id/deactivate', c.deactivate);
router.post('/:id/activate', c.activate);

module.exports = router;
