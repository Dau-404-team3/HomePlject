const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { signup, login, refreshToken, resetPassword, withdraw, getMe } = require('../controllers/auth');

router.post('/signup', signup);
router.post('/login', login);
router.post('/refresh', refreshToken);
router.post('/reset-password', resetPassword);
router.get('/me', verifyToken, getMe);
router.delete('/withdraw', verifyToken, withdraw);

module.exports = router;
