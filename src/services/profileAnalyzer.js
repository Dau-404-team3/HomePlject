const { db } = require('./firebase');

const DECAY_GRACE_DAYS = 2;  // 청소 후 감소가 시작되기까지의 유예 기간(일)
const DECAY_PER_DAY   = 2;   // 유예 기간 이후 하루당 감소 점수

/**
 * ProfileAnalyzer
 * 사용자의 행동 데이터(체크리스트 완료/건너뜀, 루틴 수정 등)를
 * 분석해 프로파일을 점진적으로 업데이트한다.
 */

/**
 * 체크리스트 완료 이벤트 처리
 * - 공간 점수 갱신
 * - 선호 시간대 학습
 * - 연속 달성 스트릭 갱신
 */
async function onChecklistComplete(uid, { taskId, space, completedAt }) {
  const profileRef = db.collection('users').doc(uid);
  const profile = (await profileRef.get()).data();
  if (!profile) throw new Error('Profile not found');

  const hour = new Date(completedAt).getHours().toString();
  const stats = profile.behaviorStats;
  const spaceStatus = profile.spaceStatus;

  // 공간 점수 상승 (최대 100)
  const currentScore = spaceStatus[space]?.score ?? 50;
  const newScore = Math.min(100, currentScore + 10);

  // 시간대별 완료 횟수 누적 (선호 시간 학습)
  const completionByHour = { ...stats.completionByHour };
  completionByHour[hour] = (completionByHour[hour] || 0) + 1;

  // 선호 시간대: 가장 많이 완료한 시간대
  const preferredHour = Object.entries(completionByHour)
    .sort(([, a], [, b]) => b - a)[0]?.[0];
  const preferredTime = preferredHour ? classifyTime(parseInt(preferredHour)) : null;

  await profileRef.update({
    updatedAt: new Date().toISOString(),
    [`spaceStatus.${space}.score`]: newScore,
    [`spaceStatus.${space}.lastCleanedAt`]: completedAt,
    [`spaceStatus.${space}.lastDecayAt`]: null,  // 청소 완료 → 감소 타이머 리셋
    [`spaceStatus.${space}.cleanCount`]: (spaceStatus[space]?.cleanCount ?? 0) + 1,
    'behaviorStats.totalChecklistCompleted': stats.totalChecklistCompleted + 1,
    'behaviorStats.completionByHour': completionByHour,
    'personality.preferredTime': preferredTime,
    [`consecutiveSkips.${space}`]: 0,  // 완료 시 연속 건너뜀 카운터 리셋
    // 스트릭은 별도 함수로 처리
  });

  await updateStreak(uid, profile);
}

/**
 * 체크리스트 건너뜀 이벤트 처리
 * - 공간 점수 소폭 하락
 * - 건너뜀 패턴 누적 → 루틴 조정 트리거
 */
async function onChecklistSkip(uid, { taskId, space }) {
  const profileRef = db.collection('users').doc(uid);
  const profile = (await profileRef.get()).data();

  const stats = profile.behaviorStats;
  const spaceStatus = profile.spaceStatus;

  const currentScore = spaceStatus[space]?.score ?? 50;
  const newScore = Math.max(0, currentScore - 3);

  const skipPatterns = { ...stats.skipPatterns };
  skipPatterns[space] = (skipPatterns[space] || 0) + 1;

  const newConsecutiveSkips = (profile.consecutiveSkips?.[space] || 0) + 1;

  await profileRef.update({
    updatedAt: new Date().toISOString(),
    [`spaceStatus.${space}.score`]: newScore,
    'behaviorStats.totalChecklistSkipped': stats.totalChecklistSkipped + 1,
    'behaviorStats.skipPatterns': skipPatterns,
    [`consecutiveSkips.${space}`]: newConsecutiveSkips,
  });

  // 특정 공간을 3번 이상 연속 건너뛰면 루틴 재조정 플래그
  if (skipPatterns[space] >= 3) {
    await flagRoutineReview(uid, space, skipPatterns[space]);
  }
}

/**
 * 루틴을 사용자가 직접 수정했을 때
 * - 수정 내역을 분석해 personality.availableMinutes 재추론
 */
async function onRoutineEdited(uid, { removedTasks, addedTasks, totalMinutesBefore, totalMinutesAfter }) {
  const profileRef = db.collection('users').doc(uid);

  const updates = {
    updatedAt: new Date().toISOString(),
  };

  // 루틴 시간이 줄어든 경우 → 실제 가능 시간 재설정
  if (totalMinutesAfter < totalMinutesBefore) {
    updates['personality.availableMinutes'] = totalMinutesAfter;
  }

  await profileRef.update(updates);
}

/**
 * 알림 반응률 업데이트
 * - 알림을 탭하면 response=true, 무시하면 false
 */
async function onNotificationResponse(uid, { response }) {
  const profileRef = db.collection('users').doc(uid);
  const profile = (await profileRef.get()).data();

  const currentRate = profile.personality.notificationResponseRate ?? 1.0;
  // 지수 이동 평균으로 부드럽게 갱신
  const alpha = 0.2;
  const newRate = alpha * (response ? 1 : 0) + (1 - alpha) * currentRate;

  await profileRef.update({
    'personality.notificationResponseRate': Math.round(newRate * 100) / 100,
  });
}

// ── 내부 헬퍼 ─────────────────────────────────────────────

function classifyTime(hour) {
  if (hour >= 6  && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'night';
}

async function updateStreak(uid, profile) {
  const today = new Date().toDateString();
  const streakRef = db.collection('users').doc(uid).collection('streaks').doc('current');
  const streakDoc = await streakRef.get();

  if (!streakDoc.exists) {
    await streakRef.set({ lastDate: today, streak: 1 });
    return;
  }

  const { lastDate, streak } = streakDoc.data();
  const yesterday = new Date(Date.now() - 86400000).toDateString();

  if (lastDate === yesterday) {
    // 전날 완료 → 스트릭 연장
    const newStreak = streak + 1;
    await streakRef.update({ lastDate: today, streak: newStreak });
    await db.collection('users').doc(uid).update({
      'behaviorStats.currentStreak': newStreak,
      'behaviorStats.longestStreak': Math.max(newStreak, profile.behaviorStats.longestStreak),
    });
  } else if (lastDate !== today) {
    // 하루 이상 끊김 → 리셋
    await streakRef.update({ lastDate: today, streak: 1 });
    await db.collection('users').doc(uid).update({
      'behaviorStats.currentStreak': 1,
    });
  }
}

async function flagRoutineReview(uid, space, skipCount) {
  // routineReviewFlags 컬렉션에 플래그 저장 → 루틴 AI가 참조
  await db.collection('routineReviewFlags').add({
    uid,
    space,
    skipCount,
    createdAt: new Date().toISOString(),
    resolved: false,
  });
}

/**
 * 방치된 공간의 청결 점수 자동 감소
 *
 * 규칙:
 *  - 마지막 청소 후 DECAY_GRACE_DAYS일 이내 → 감소 없음
 *  - 유예 기간 초과 후 하루마다 DECAY_PER_DAY점 감소 (최소 0)
 *  - getTodayRoutine 호출 시 실행 (홈 화면 로드마다)
 *
 * @param {string} uid
 * @param {object} spaceStatus - 이미 읽어온 profile.spaceStatus
 * @returns {object} 감소 적용 후 spaceStatus (변경 없으면 원본 그대로 반환)
 */
async function applyScoreDecay(uid, spaceStatus) {
  if (!spaceStatus) return spaceStatus;

  const now = Date.now();
  const updates = {};
  const updatedStatus = { ...spaceStatus };

  for (const [space, status] of Object.entries(spaceStatus)) {
    const lastCleanedAt = status.lastCleanedAt
      ? new Date(status.lastCleanedAt).getTime()
      : null;

    // 한 번도 청소한 적 없으면 패스
    if (!lastCleanedAt) continue;

    const gracePeriodEnd = lastCleanedAt + DECAY_GRACE_DAYS * 86400000;

    // 아직 유예 기간 내
    if (now < gracePeriodEnd) continue;

    const lastDecayAt = status.lastDecayAt
      ? new Date(status.lastDecayAt).getTime()
      : null;

    // 이전 감소 적용 시점 결정
    // lastDecayAt이 없거나 lastCleanedAt 이전이면 유예 기간 종료 시점을 기준으로 사용
    const decayFrom = (lastDecayAt && lastDecayAt > lastCleanedAt)
      ? lastDecayAt
      : gracePeriodEnd;

    const daysSinceLastDecay = Math.floor((now - decayFrom) / 86400000);
    if (daysSinceLastDecay < 1) continue;

    const currentScore = status.score ?? 50;
    const decayAmount = daysSinceLastDecay * DECAY_PER_DAY;
    const newScore = Math.max(0, currentScore - decayAmount);

    if (newScore !== currentScore) {
      const nowIso = new Date(now).toISOString();
      updates[`spaceStatus.${space}.score`] = newScore;
      updates[`spaceStatus.${space}.lastDecayAt`] = nowIso;
      updatedStatus[space] = { ...status, score: newScore, lastDecayAt: nowIso };
    }
  }

  if (Object.keys(updates).length > 0) {
    updates.updatedAt = new Date(now).toISOString();
    await db.collection('users').doc(uid).update(updates);
  }

  return updatedStatus;
}

module.exports = {
  onChecklistComplete,
  onChecklistSkip,
  onRoutineEdited,
  onNotificationResponse,
  applyScoreDecay,
};
