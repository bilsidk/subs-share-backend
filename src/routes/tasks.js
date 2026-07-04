const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { authenticate, requireNotBanned } = require('../middleware/auth');
const { getAvailableTasks, createTask, verifyTask, getMyTasks, startTask } = require('../controllers/taskController');
const { pauseCampaign, resumeCampaign, cancelCampaign } = require('../controllers/campaignController');

// Per-endpoint rate limiters (defined here so they're in the normal middleware chain)
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many verification attempts, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const campaignLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many campaigns created, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/',           authenticate, getAvailableTasks);
router.get('/my',         authenticate, getMyTasks);
router.post('/',          campaignLimiter, authenticate, requireNotBanned, createTask);
router.post('/:id/start',    verifyLimiter, authenticate, requireNotBanned, startTask);
router.post('/:id/verify',   verifyLimiter, authenticate, requireNotBanned, verifyTask);
router.post('/:id/complete', verifyLimiter, authenticate, requireNotBanned, verifyTask); // backwards compat
router.patch('/:id/pause',   authenticate, requireNotBanned, pauseCampaign);
router.patch('/:id/resume',  authenticate, requireNotBanned, resumeCampaign);
router.delete('/:id',        authenticate, requireNotBanned, cancelCampaign);

module.exports = router;
