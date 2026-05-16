// ── routes/chatbot.js ─────────────────────────────────────
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { handleMessage } = require('../controllers/chatbot');

router.post('/message', verifyToken, handleMessage);

module.exports = router;
