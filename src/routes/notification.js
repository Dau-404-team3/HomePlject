const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const {
  recordNotificationResponse,
  saveFcmToken,
  saveNotificationPreference,
  getNotificationPreference,
  testNotification,
  testRoutineRefreshNotification,
  testScheduledNotification,
  getNotificationInbox,
  markNotificationsRead,
} = require('../controllers/behaviorLog');

router.post('/token',      verifyToken, saveFcmToken);
router.post('/response',   verifyToken, recordNotificationResponse);
router.post('/preference', verifyToken, saveNotificationPreference);
router.get('/preference',  verifyToken, getNotificationPreference);
router.post('/test',                  verifyToken, testNotification);
router.post('/test/routine-refresh',  verifyToken, testRoutineRefreshNotification);
router.post('/test/scheduled',        verifyToken, testScheduledNotification);
router.get('/inbox',       verifyToken, getNotificationInbox);
router.post('/inbox/read', verifyToken, markNotificationsRead);

module.exports = router;
