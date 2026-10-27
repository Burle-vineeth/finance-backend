const express = require('express');
const router = express.Router();
const { getTransactions, getCashSplit, addTransaction, deleteTransaction } = require('../controllers/transactionController');

router.route('/').get(getTransactions).post(addTransaction);
router.get('/cash', getCashSplit);
router.route('/:id').delete(deleteTransaction);

module.exports = router;
