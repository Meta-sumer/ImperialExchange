/**
 * Admin trade delete / restore — regression pins.
 *
 *  1. Every user-facing position query hides admin-deleted trades: the unified
 *     history, the closed-position history, the open-position list, the
 *     dashboard aggregates and the CSV export all filter `deletedAt: null`.
 *  2. The wallet reversal uses the trade's NET result (realized − commission),
 *     with the sign that walks the money back: a profit is debited, a loss is
 *     credited, and restoring applies the same amount the other way.
 *  3. The controller exposes both handlers and the router mounts them.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// 1. user-facing exclusion
const oc = read('src/controllers/orderController.js');
assert.ok(oc.includes("const posMatch = { ...scope, status: POSITION_STATUS.CLOSED, deletedAt: null }"), 'unified history must hide deleted trades');
assert.ok(oc.includes("const baseFilter = { userId: req.userId, status: POSITION_STATUS.CLOSED, deletedAt: null }"), 'positions/history must hide deleted trades');
assert.ok(oc.includes("const posFilter = { userId: req.userId, status: POSITION_STATUS.OPEN, deletedAt: null }"), 'open positions must hide deleted trades');
const dc = read('src/controllers/dashboardController.js');
assert.strictEqual((dc.match(/status: 'CLOSED', deletedAt: null/g) || []).length >= 2, true, 'dashboard closed queries must hide deleted trades');
assert.ok(dc.includes("deletedAt: null,\n    closedAt: { $gte: oldest }") || dc.includes("deletedAt: null,\r\n    closedAt: { $gte: oldest }"), 'dashboard bucket query must hide deleted trades');
const ec = read('src/controllers/exportController.js');
assert.ok(ec.includes("status: 'CLOSED', deletedAt: null"), 'CSV export must hide deleted trades');

// 2. net reversal math (pure helper the controller uses)
const { netOf } = require('../src/utils/manualTradeMath');
const D = (v) => Number(v);
// profit 90, commission 2 → net 88 is DEBITED on delete, CREDITED on restore
assert.strictEqual(netOf('90', '2'), '88');
assert.ok(D(netOf('90', '2')) > 0, 'a net profit is taken back (debit)');
// loss -50, commission 1 → net -51 is CREDITED on delete, DEBITED on restore
assert.strictEqual(netOf('-50', '1'), '-51');
assert.ok(D(netOf('-50', '1')) < 0, 'a net loss is given back (credit)');
assert.strictEqual(netOf('0', '0'), '0');

// 3. handlers + routes
const ac = read('src/controllers/adminOrdersController.js');
assert.ok(/const deleteTrade = asyncHandler/.test(ac) && /const restoreTrade = asyncHandler/.test(ac), 'handlers defined');
assert.ok(/module\.exports = \{\s*deleteTrade,\s*restoreTrade,/.test(ac), 'handlers exported');
assert.ok(ac.includes("deletedFromStatus: 'OPEN'") && ac.includes("deletedFromStatus: 'CLOSED'"), 'delete records where the trade came from');
assert.ok(ac.includes("throw new AppError('A trade deleted while open was closed out and cannot be restored', 400, 'CANNOT_RESTORE_OPEN')"), 'open deletions are not restorable');
const rt = read('src/routes/adminOrders.js');
assert.ok(rt.includes("router.post('/positions/:id/delete', c.deleteTrade)") && rt.includes("router.post('/positions/:id/restore', c.restoreTrade)"), 'routes mounted');

console.log('tradeDelete.test.js: all assertions passed');
