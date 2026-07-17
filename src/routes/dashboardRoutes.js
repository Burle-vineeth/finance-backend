const express = require('express');
const router = express.Router();
const { getDashboardMetrics } = require('../controllers/dashboardController');

router.route('/').get(getDashboardMetrics);

module.exports = router;
