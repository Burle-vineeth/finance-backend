const express = require('express');
const router = express.Router();
const { getDashboardMetrics, getCollectionTrend, getBusinessScore } = require('../controllers/dashboardController');

router.route('/').get(getDashboardMetrics);
router.get('/collections', getCollectionTrend);
router.get('/score', getBusinessScore);

module.exports = router;
