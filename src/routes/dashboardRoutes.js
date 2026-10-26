const express = require('express');
const router = express.Router();
const { getDashboardMetrics, getCollectionTrend } = require('../controllers/dashboardController');

router.route('/').get(getDashboardMetrics);
router.get('/collections', getCollectionTrend);

module.exports = router;
