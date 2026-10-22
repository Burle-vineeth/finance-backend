const express = require('express');
const router = express.Router();
const { listUsers, createStaff, updateStaff, resetStaffPin } = require('../controllers/userController');

router.route('/').get(listUsers).post(createStaff);
router.patch('/:id', updateStaff);
router.post('/:id/reset-pin', resetStaffPin);

module.exports = router;
