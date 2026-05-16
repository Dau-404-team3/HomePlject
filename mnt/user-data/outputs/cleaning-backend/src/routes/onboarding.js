// ── routes/onboarding.js ──────────────────────────────────
const express = require('express');
const router = express.Router();
const { submitOnboarding } = require('../controllers/onboarding');
const { verifyToken } = require('../middleware/auth');

router.post('/submit', verifyToken, submitOnboarding);

module.exports = router;
