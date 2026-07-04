const express = require('express');
const router = express.Router();
const { authenticate, requireNotBanned } = require('../middleware/auth');
const { getTiers, createCheckout, handleIPN } = require('../controllers/paymentController');

router.get('/tiers', authenticate, getTiers);
router.post('/create-checkout', authenticate, requireNotBanned, createCheckout);
router.post('/ipn', handleIPN);

module.exports = router;
