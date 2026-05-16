const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { submitOnboarding } = require('../controllers/onboarding');

router.post('/submit', verifyToken, submitOnboarding);

module.exports = router;
