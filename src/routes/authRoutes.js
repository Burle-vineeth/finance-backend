const express = require('express');
const router = express.Router();
const { verifyPin, changePin } = require('../controllers/authController');
const { authMiddleware } = require('../middleware/authMiddleware');

router.post('/verify-pin', verifyPin);
router.post('/change-pin', authMiddleware, changePin);

module.exports = router;
