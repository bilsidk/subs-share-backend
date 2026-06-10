const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getStatus, getAppSettings, updateAppSettings, setModeManual, setRole, getUsers, banUser } = require('../controllers/adminController');

router.get('/status', authenticate, getStatus);
router.get('/settings', authenticate, getAppSettings);
router.patch('/settings', authenticate, updateAppSettings);
router.post('/mode', authenticate, setModeManual);
router.post('/promote', authenticate, setRole);
router.get('/users',   authenticate, getUsers);
router.post('/ban',    authenticate, banUser);

module.exports = router;
