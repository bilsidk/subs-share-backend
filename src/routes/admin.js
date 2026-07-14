const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getStatus, getStats, refreshSubs, getAppSettings, updateAppSettings, setModeManual, setRole, getUsers, banUser, adjustCoins } = require('../controllers/adminController');

router.get('/status', authenticate, getStatus);
router.get('/stats', authenticate, getStats);
router.post('/refresh-subs', authenticate, refreshSubs);
router.get('/settings', authenticate, getAppSettings);
router.patch('/settings', authenticate, updateAppSettings);
router.post('/mode', authenticate, setModeManual);
router.post('/promote', authenticate, setRole);
router.get('/users',   authenticate, getUsers);
router.post('/ban',    authenticate, banUser);
router.post('/coins',  authenticate, adjustCoins);

module.exports = router;
