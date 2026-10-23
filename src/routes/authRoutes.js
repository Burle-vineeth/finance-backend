const express = require('express');
const router = express.Router();
const { login, me, changePin } = require('../controllers/authController');
const { authMiddleware, requireRole } = require('../middleware/authMiddleware');

router.post('/login', login);
// The sign-in route that app versions from before user accounts call
router.post('/verify-pin', login);
router.get('/me', authMiddleware, me);
// Only the admin changes their own PIN; a staff member's PIN is set by the admin (POST /api/users/:id/reset-pin)
router.post('/change-pin', authMiddleware, requireRole('ADMIN'), changePin);

module.exports = router;
