const { db } = require('./firebase');

/**
 * Expo Push API를 사용해 푸시 알림을 발송한다.
 * - 모바일: expo-notifications가 발급한 ExponentPushToken 사용
 * - 웹: 로컬 알림으로 처리되므로 백엔드 발송 불필요 (토큰 없음)
 * - 토큰 없거나 유효하지 않으면 조용히 건너뜀
 */
async function sendPush(uid, { title, body, data = {} }) {
  // 인앱 알림 저장 — 웹 포함 모든 플랫폼에서 확인 가능
  await db.collection('notifications').add({
    uid,
    title,
    body,
    read: false,
    createdAt: new Date().toISOString(),
  });

  const userDoc = await db.collection('users').doc(uid).get();
  const expoPushToken = userDoc.data()?.fcmToken;

  if (!expoPushToken || !expoPushToken.startsWith('ExponentPushToken')) return;

  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        to: expoPushToken,
        title,
        body,
        data,
        sound: 'default',
      }),
    });

    const result = await response.json();

    // 유효하지 않은 토큰이면 DB에서 제거
    const ticket = result.data;
    if (ticket?.status === 'error' && ticket?.details?.error === 'DeviceNotRegistered') {
      await db.collection('users').doc(uid).update({ fcmToken: null });
    }
  } catch (err) {
    console.error('[pushNotification] Expo Push 발송 실패:', err.message);
  }
}

/**
 * 오늘 청소 루틴이 있는 사용자에게 알림 발송
 */
async function sendTodayCleaningReminder(uid) {
  const userDoc = await db.collection('users').doc(uid).get();
  const profile = userDoc.data();
  if (!profile?.activeRoutineId) return;

  const routineDoc = await db.collection('routines').doc(profile.activeRoutineId).get();
  if (!routineDoc.exists) return;

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  const todayRoutine = routineDoc.data().weeklyRoutine?.find((r) => r.day === today);
  const taskCount = todayRoutine?.tasks?.length ?? 0;
  if (taskCount === 0) return;

  await sendPush(uid, {
    title: '오늘의 청소 🧹',
    body: `오늘 할 청소 루틴이 ${taskCount}개 있어요!`,
  });
}

module.exports = { sendPush, sendTodayCleaningReminder };
