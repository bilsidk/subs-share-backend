const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getStatus, setModeManual, setRole } = require('../controllers/adminController');
router.get('/status',   authenticate, getStatus);
router.post('/mode',    authenticate, setModeManual);
router.post('/promote', authenticate, setRole);
module.exports = router;
