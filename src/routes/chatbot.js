const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const {
  handleMessage,
  handleAnalyzeSession,
  handleGetPendingUpdate,
  handleClearPendingUpdate,
  handleGetSessions,
  handleGetSession,
} = require('../controllers/chatbot');

router.post('/message',          verifyToken, handleMessage);
router.post('/analyze-session',  verifyToken, handleAnalyzeSession);
router.get('/pending-update',    verifyToken, handleGetPendingUpdate);
router.delete('/pending-update', verifyToken, handleClearPendingUpdate);
router.get('/sessions',          verifyToken, handleGetSessions);
router.get('/sessions/:sessionId', verifyToken, handleGetSession);

module.exports = router;
