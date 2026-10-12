const express = require('express');
const c = require('../controllers/withdrawalMethodController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Every route requires an authenticated user; each handler additionally scopes
// its query to req.userId so a caller can only ever touch their own methods.
router.use(authenticate);

router.get('/', c.listMethods);
router.post('/', c.addMethod);
router.get('/:id', c.getMethod);
router.delete('/:id', c.deleteMethod);

module.exports = router;
