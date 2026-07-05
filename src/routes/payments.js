const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { authenticate, requireNotBanned } = require('../middleware/auth');
const { getTiers, createCheckout, handleIPN, verifyGooglePlay } = require('../controllers/paymentController');

// Cap checkout creation so a single account can't spam invoice generation.
const checkoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many checkout attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/tiers', authenticate, getTiers);
router.post('/create-checkout', checkoutLimiter, authenticate, requireNotBanned, createCheckout);
router.post('/ipn', handleIPN);
router.post('/google/verify', authenticate, requireNotBanned, verifyGooglePlay);

module.exports = router;
