const express = require('express');
const router = express.Router();
const { getLoans, addLoan, updateLoanDetails } = require('../controllers/loanController');

router.route('/').get(getLoans).post(addLoan);
router.patch('/:id', updateLoanDetails);

module.exports = router;
