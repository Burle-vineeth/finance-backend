const express = require('express');
const router = express.Router();
const { getLoans, addLoan } = require('../controllers/loanController');

router.route('/').get(getLoans).post(addLoan);

module.exports = router;
