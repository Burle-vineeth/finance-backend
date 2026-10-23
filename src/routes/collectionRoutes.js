const express = require('express');
const router = express.Router();
const {
  getCollectableLoans,
  submitCollection,
  listCollections,
  getSummary,
  cancelCollection,
  approveCollection,
  rejectCollection,
} = require('../controllers/collectionController');
const { requireRole } = require('../middleware/authMiddleware');

const staff = requireRole('STAFF');
const admin = requireRole('ADMIN');
const anyone = requireRole('ADMIN', 'STAFF');

router.get('/loans', anyone, getCollectableLoans);
router.get('/summary', admin, getSummary);
router.route('/').get(anyone, listCollections).post(staff, submitCollection);
router.post('/:id/cancel', staff, cancelCollection);
router.post('/:id/approve', admin, approveCollection);
router.post('/:id/reject', admin, rejectCollection);

module.exports = router;
