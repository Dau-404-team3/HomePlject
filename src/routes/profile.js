const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { getProfile, deleteAccount, staleConfirm } = require('../controllers/userProfile');

router.get('/', verifyToken, getProfile);
router.delete('/', verifyToken, deleteAccount);
router.post('/stale-confirm', verifyToken, staleConfirm);

module.exports = router;
