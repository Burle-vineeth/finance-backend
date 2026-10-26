const express = require('express');
const router = express.Router();
const { getLoans, addLoan, updateLoanDetails, addLateFee, removeLateFee } = require('../controllers/loanController');

router.route('/').get(getLoans).post(addLoan);
router.patch('/:id', updateLoanDetails);
router.post('/:id/late-fees', addLateFee);
router.delete('/:id/late-fees/:feeId', removeLateFee);

module.exports = router;
