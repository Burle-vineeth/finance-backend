const express = require('express');
const router = express.Router();
const { login, me, changePin } = require('../controllers/authController');
const { authMiddleware } = require('../middleware/authMiddleware');

router.post('/login', login);
// The sign-in route that app versions from before user accounts call
router.post('/verify-pin', login);
router.get('/me', authMiddleware, me);
router.post('/change-pin', authMiddleware, changePin);

module.exports = router;
