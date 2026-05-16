// server.js
require('dotenv').config();
const app = require('./src/app');
const cron = require('node-cron');
const { decaySpaceScores, flagStaleProfileFields, cleanupStaleData, sendScheduledNotifications } = require('./src/services/profileScheduler');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});

// 매일 새벽 3시 — 공간 점수 감쇠, 스테일 프로파일 플래그, 데이터 정리
cron.schedule('0 3 * * *', async () => {
  console.log('[스케줄러] 일일 프로파일 정리 시작');
  await decaySpaceScores();
  await flagStaleProfileFields();
  await cleanupStaleData();
  console.log('[스케줄러] 완료');
});

// 매 분 — 사용자 알림 설정 시간(HH:MM)과 현재 시각이 일치하는 경우 발송
cron.schedule('* * * * *', async () => {
  await sendScheduledNotifications();
});
