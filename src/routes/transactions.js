const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getTransactions } = require('../controllers/transactionController');
router.get('/', authenticate, getTransactions);
module.exports = router;
