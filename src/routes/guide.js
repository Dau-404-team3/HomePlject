const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { getAllGuides, getGuide, getTaskGuideHandler } = require('../controllers/guide');

router.get('/', verifyToken, getAllGuides);
// /task는 /:space보다 반드시 앞에 등록해야 'task'가 space 파라미터로 매칭되지 않음
router.get('/task', verifyToken, getTaskGuideHandler);
router.get('/:space', verifyToken, getGuide);

module.exports = router;
