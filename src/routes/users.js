const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getMe, deleteMe } = require('../controllers/userController');
router.get('/me', authenticate, getMe);
router.delete('/me', authenticate, deleteMe);
module.exports = router;
