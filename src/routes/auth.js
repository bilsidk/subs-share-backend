// routes/auth.js
const express = require('express');
const router = express.Router();
const { googleSignIn } = require('../controllers/authController');
router.post('/google', googleSignIn);
module.exports = router;
