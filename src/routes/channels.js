const express = require('express');
const router = express.Router();
const { authenticate, requireNotBanned } = require('../middleware/auth');
const { addChannel, getMyChannels } = require('../controllers/channelController');
router.post('/', authenticate, requireNotBanned, addChannel);
router.get('/', authenticate, getMyChannels);
module.exports = router;
