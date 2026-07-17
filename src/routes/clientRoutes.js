const express = require('express');
const router = express.Router();
const { getClients, addClient } = require('../controllers/clientController');

router.route('/').get(getClients).post(addClient);

module.exports = router;
