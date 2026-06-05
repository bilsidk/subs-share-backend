const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { addChannel, getMyChannels } = require('../controllers/channelController');
router.post('/', authenticate, addChannel);
router.get('/', authenticate, getMyChannels);
module.exports = router;
