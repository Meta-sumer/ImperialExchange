const express = require('express');
const c = require('../controllers/instrumentController');
const rec = require('../controllers/recommendedMarketController');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/', c.list);
router.get('/watchlist', c.watchlist);
router.get('/recommended', rec.publicList);  // before /:symbol — admin-curated strip/selector set
router.get('/search', c.search);            // before /:symbol so "search" isn't a symbol
router.get('/economic-calendar', c.economicCalendar); // before /:symbol — live Forex Factory feed
router.get('/auto-sync', authenticate, requireAdmin, c.getAutoSync); // Dhan daily auto-import status (before /:symbol)
router.get('/:symbol', c.getOne);
router.get('/:symbol/volume-usage', c.volumeUsage);
router.get('/:symbol/candles', c.candles);
router.get('/:symbol/orderbook', c.orderbook);
router.get('/:symbol/fundamentals', c.fundamentals);
router.get('/:symbol/news', c.news);
router.get('/:symbol/impact', authenticate, requireAdmin, c.instrumentImpact); // open-positions + pending-orders count (disable modal)

// Admin only
router.post('/', authenticate, requireAdmin, c.create);
router.post('/:symbol/disable', authenticate, requireAdmin, c.disableInstrument); // disable trading (+ options) for a symbol
router.post('/:symbol/enable', authenticate, requireAdmin, c.enableInstrument);   // re-enable trading + market data + visibility
router.post('/bulk-routing', authenticate, requireAdmin, c.bulkRouting); // before /:symbol
router.post('/sync-indian', authenticate, requireAdmin, c.syncIndian);  // on-demand Dhan import (Indian)
router.post('/auto-sync', authenticate, requireAdmin, c.setAutoSync);   // toggle daily Dhan auto-import on/off
router.put('/:symbol', authenticate, requireAdmin, c.update);
router.delete('/:symbol', authenticate, requireAdmin, c.remove);

module.exports = router;
