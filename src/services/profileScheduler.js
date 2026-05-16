const { db } = require('./firebase');

/**
 * profileScheduler
 *
 * 매일 새벽 3시 node-cron으로 실행되는 일일 정리 작업.
 * 활성 사용자만 처리해 Firestore 비용을 최소화한다.
 * 전체 users를 순회하면 사용자 수 비례로 비용 폭발 →
 * updatedAt 기준으로 최근 30일 내 접속한 사용자만 필터링
 */

const AI_API_URL = process.env.AI_API_URL;
const AI_API_KEY = process.env.AI_API_KEY;

// 대화에서 추출할 프로파일 관련 항목 10개
const EXTRACTION_CATEGORIES = [
  'cleaning_tools',       // 청소 도구 보유/변경
  'cleaning_products',    // 세제/용품 보유/변경
  'pet_change',           // 반려동물 변화
  'housing_change',       // 거주 환경 변화
  'family_change',        // 가족/동거인 변화
  'physical_limitation',  // 신체 제약
  'schedule_change',      // 청소 가능 시간대 변화
  'cooking_change',       // 요리 습관 변화
  'problem_area',         // 문제 공간
  'misconception',        // 청소 오개념
];

/**
 * 공간 청결 점수 감소 처리
 * - 마지막 청소 후 경과 시간에 비례해 점수를 감소시킨다
 * - 최솟값 0으로 제한
 */
async function decaySpaceScores() {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // 최근 30일 내 접속한 활성 사용자만 처리 (비용 절감)
    const usersSnap = await db.collection('users')
      .where('updatedAt', '>', thirtyDaysAgo.toISOString())
      .get();

    if (usersSnap.empty) return;

    const now = Date.now();
    const batch = db.batch();
    let batchCount = 0;

    for (const userDoc of usersSnap.docs) {
      const profile = userDoc.data();
      const spaceStatus = profile.spaceStatus || {};
      const updates = {};

      for (const [space, status] of Object.entries(spaceStatus)) {
        if (!status.lastCleanedAt) continue;

        const lastCleaned = new Date(status.lastCleanedAt).getTime();
        const daysPassed = (now - lastCleaned) / (1000 * 60 * 60 * 24);
        const currentScore = status.score ?? 50;

        let decay = 0;
        if (daysPassed >= 30) decay = 20;
        else if (daysPassed >= 14) decay = 10;
        else if (daysPassed >= 7) decay = 5;

        if (decay > 0) {
          // 최솟값 0 보장
          updates[`spaceStatus.${space}.score`] = Math.max(0, currentScore - decay);
        }
      }

      if (Object.keys(updates).length > 0) {
        batch.update(userDoc.ref, updates);
        batchCount++;

        // Firestore batch 최대 500개 제한
        if (batchCount >= 500) {
          await batch.commit();
          batchCount = 0;
        }
      }
    }

    if (batchCount > 0) await batch.commit();

    console.log(`[decaySpaceScores] ${usersSnap.size}명 처리 완료`);
  } catch (err) {
    console.error('[profileScheduler] decaySpaceScores 실패:', err.message);
  }
}

/**
 * 오래된 프로파일 필드 stale 플래그 설정
 * - 프론트에서 "정보를 다시 확인해주세요" 팝업 트리거용
 * - 태스크 완료율로 판단하지 않음:
 *   루틴에 해당 태스크가 없으면 완료율 계산 자체가 불가능하기 때문
 */
async function flagStaleProfileFields() {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // 최근 30일 내 접속한 활성 사용자만 처리
    const usersSnap = await db.collection('users')
      .where('updatedAt', '>', thirtyDaysAgo.toISOString())
      .get();

    if (usersSnap.empty) return;

    const now = Date.now();
    const sixMonthsMs = 6 * 30 * 24 * 60 * 60 * 1000;
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    const twelveMonthsMs = 12 * 30 * 24 * 60 * 60 * 1000;

    const batch = db.batch();
    let batchCount = 0;

    for (const userDoc of usersSnap.docs) {
      const profile = userDoc.data();
      const staleFlags = profile.staleFlags ? [...profile.staleFlags] : [];
      let updated = false;

      const updatedAt = profile.updatedAt ? new Date(profile.updatedAt).getTime() : 0;
      const createdAt = profile.createdAt ? new Date(profile.createdAt).getTime() : 0;

      // 조건 1: 반려동물 있는데 updatedAt이 6개월 이상 지남
      if (profile.home?.hasPet === true && now - updatedAt > sixMonthsMs) {
        if (!staleFlags.includes('hasPet')) {
          staleFlags.push('hasPet');
          updated = true;
        }
      }

      // 조건 2: 어린이 있는데 createdAt이 1년 이상 지남 (구형 데이터 호환)
      if (profile.home?.hasChild === true && now - createdAt > oneYearMs) {
        if (!staleFlags.includes('hasChild')) {
          staleFlags.push('hasChild');
          updated = true;
        }
      }

      // 조건 3: 집 유형이 있는데 updatedAt이 12개월 이상 지남
      if (profile.home?.houseType && now - updatedAt > twelveMonthsMs) {
        if (!staleFlags.includes('houseType')) {
          staleFlags.push('houseType');
          updated = true;
        }
      }

      // 조건 4: customFacts 각 항목의 addedAt이 6개월 이상 지난 경우 재확인 요청
      // 자동 삭제는 하지 않음 — 오래된 항목을 사용자에게 재확인 요청만 함
      // 사용자가 직접 확인하고 삭제하게 유도
      const customFacts = profile.home?.customFacts || {};
      for (const [key, fact] of Object.entries(customFacts)) {
        if (!fact || !fact.addedAt) continue;

        const addedAtMs = new Date(fact.addedAt).getTime();
        if (now - addedAtMs < sixMonthsMs) continue;

        // 이미 해당 key로 customFact 재확인 플래그가 있으면 중복 추가 금지
        const alreadyFlagged = staleFlags.some(
          f => f && typeof f === 'object' && f.type === 'customFact' && f.key === key
        );
        if (alreadyFlagged) continue;

        // staleFlags는 프론트에서 "아직 손목이 불편하신가요?" 같은 팝업을 띄우는 데 사용
        // 사용자가 "아니요" 선택 시 해당 키 삭제
        // 사용자가 "네" 선택 시 addedAt만 현재 시각으로 갱신
        staleFlags.push({
          type: 'customFact',
          key,
          value: fact.value,
          message: '아직도 해당되나요? 확인 후 업데이트해주세요.',
          addedAt: fact.addedAt,
        });
        updated = true;
      }

      if (updated) {
        batch.update(userDoc.ref, { staleFlags });
        batchCount++;

        if (batchCount >= 500) {
          await batch.commit();
          batchCount = 0;
        }
      }
    }

    if (batchCount > 0) await batch.commit();

    console.log(`[flagStaleProfileFields] ${usersSnap.size}명 처리 완료`);
  } catch (err) {
    console.error('[profileScheduler] flagStaleProfileFields 실패:', err.message);
  }
}

/**
 * 오래된 데이터 정리 (더미 데이터 누적 방지)
 *
 * 아카이브 방식 (장기 통계 대비):
 *   completedTasks 90일 초과 → completedTasksArchive로 이동 후 원본 삭제
 *   삭제하면 나중에 복구 불가능하므로 archive 컬렉션에 보존
 *
 * 즉시 삭제 (복구 필요 없는 것들):
 *   chatLogs 60일 초과 → 즉시 삭제
 *   routines isActive: false이고 30일 초과 → 즉시 삭제
 *   routineReviewFlags resolved: true이고 30일 초과 → 즉시 삭제
 */
async function cleanupStaleData() {
  try {
    const now = Date.now();
    const ninetyDaysAgo = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
    const sixtyDaysAgo = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    // ── completedTasks 90일 초과 → archive로 이동 ─────────────
    const oldTasksSnap = await db.collection('completedTasks')
      .where('completedAt', '<', ninetyDaysAgo)
      .limit(500)
      .get();

    if (!oldTasksSnap.empty) {
      const archiveBatch = db.batch();
      oldTasksSnap.forEach(doc => {
        // archive 컬렉션에 복사 (장기 통계 기능 추가 시 여기서 읽으면 됨)
        const archiveRef = db.collection('completedTasksArchive').doc(doc.id);
        archiveBatch.set(archiveRef, { ...doc.data(), archivedAt: new Date().toISOString() });
        // 원본 삭제
        archiveBatch.delete(doc.ref);
      });
      await archiveBatch.commit();
      console.log(`[cleanupStaleData] completedTasks ${oldTasksSnap.size}건 archive 이동`);
    }

    // ── chatLogs 60일 초과 → 즉시 삭제 ──────────────────────
    const oldLogsSnap = await db.collection('chatLogs')
      .where('timestamp', '<', sixtyDaysAgo)
      .limit(500)
      .get();

    if (!oldLogsSnap.empty) {
      const logBatch = db.batch();
      oldLogsSnap.forEach(doc => logBatch.delete(doc.ref));
      await logBatch.commit();
      console.log(`[cleanupStaleData] chatLogs ${oldLogsSnap.size}건 삭제`);
    }

    // ── 비활성 routines 30일 초과 → 즉시 삭제 ───────────────
    const oldRoutinesSnap = await db.collection('routines')
      .where('isActive', '==', false)
      .where('createdAt', '<', thirtyDaysAgo)
      .limit(500)
      .get();

    if (!oldRoutinesSnap.empty) {
      const routineBatch = db.batch();
      oldRoutinesSnap.forEach(doc => routineBatch.delete(doc.ref));
      await routineBatch.commit();
      console.log(`[cleanupStaleData] routines ${oldRoutinesSnap.size}건 삭제`);
    }

    // ── 해결된 routineReviewFlags 30일 초과 → 즉시 삭제 ─────
    const oldFlagsSnap = await db.collection('routineReviewFlags')
      .where('resolved', '==', true)
      .where('createdAt', '<', thirtyDaysAgo)
      .limit(500)
      .get();

    if (!oldFlagsSnap.empty) {
      const flagBatch = db.batch();
      oldFlagsSnap.forEach(doc => flagBatch.delete(doc.ref));
      await flagBatch.commit();
      console.log(`[cleanupStaleData] routineReviewFlags ${oldFlagsSnap.size}건 삭제`);
    }
  } catch (err) {
    console.error('[profileScheduler] cleanupStaleData 실패:', err.message);
  }
}

/**
 * 어제 하루치 대화 로그를 Claude로 일괄 분석해 프로파일을 업데이트한다.
 * 매일 새벽 3시 cron에서 실행.
 *
 * 처리 순서:
 * 1. 어제 하루치 chatLogs 조회 (최근 30일 내 접속 사용자만)
 * 2. 사용자별로 대화 로그 그룹핑
 * 3. 각 사용자의 대화 로그를 Claude에게 한 번에 분석 요청
 * 4. EXTRACTION_CATEGORIES 10개 항목에 해당하는 내용만 추출
 * 5. 해당 항목이 있으면 customFacts에 저장
 * 6. 해당 항목이 없으면 아무것도 하지 않음
 */
async function analyzeDailyChatLogs() {
  try {
    // 어제 날짜 범위 계산
    const now = new Date();
    const yesterdayStart = new Date(now);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    yesterdayStart.setHours(0, 0, 0, 0);

    const yesterdayEnd = new Date(now);
    yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);
    yesterdayEnd.setHours(23, 59, 59, 999);

    // 1. 어제 하루치 chatLogs 조회 (최근 접속 사용자 한정)
    const logsSnap = await db.collection('chatLogs')
      .where('timestamp', '>=', yesterdayStart.toISOString())
      .where('timestamp', '<=', yesterdayEnd.toISOString())
      .get();

    if (logsSnap.empty) {
      console.log('[analyzeDailyChatLogs] 어제 대화 로그 없음, 종료');
      return;
    }

    // 2. 사용자별로 대화 로그 그룹핑
    const logsByUser = {};
    logsSnap.forEach(doc => {
      const log = doc.data();
      if (!logsByUser[log.uid]) {
        logsByUser[log.uid] = [];
      }
      logsByUser[log.uid].push(log);
    });

    console.log(`[analyzeDailyChatLogs] ${Object.keys(logsByUser).length}명 분석 시작`);

    // 3. 사용자별 분석 처리
    for (const [uid, logs] of Object.entries(logsByUser)) {
      try {
        await analyzeUserChatLogs(uid, logs);
      } catch (err) {
        // 개별 사용자 실패 시 전체 중단 없이 계속 진행
        console.error(`[analyzeDailyChatLogs] uid=${uid} 분석 실패:`, err.message);
      }
    }

    console.log('[analyzeDailyChatLogs] 완료');
  } catch (err) {
    console.error('[profileScheduler] analyzeDailyChatLogs 실패:', err.message);
  }
}

/**
 * 단일 사용자의 대화 로그를 Claude로 분석해 프로파일에 반영
 */
async function analyzeUserChatLogs(uid, logs) {
  // 대화 내용을 텍스트로 조합
  const conversationText = logs
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map(log => `사용자: ${log.userMessage}\nAI: ${log.aiReply}`)
    .join('\n\n');

  // Claude 분석 프롬프트 구성
  const prompt = buildAnalysisPrompt(conversationText);

  // Claude API 호출
  const response = await fetch(AI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': AI_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) throw new Error(`AI API error: ${response.status}`);

  const data = await response.json();
  const rawText = data.content[0].text;

  // JSON 파싱
  let findings;
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;
    findings = JSON.parse(jsonMatch[0]).findings;
  } catch (err) {
    console.error(`[analyzeUserChatLogs] uid=${uid} JSON 파싱 실패:`, rawText);
    return;
  }

  // 해당 항목 없으면 아무것도 하지 않음
  if (!findings || findings.length === 0) return;

  // 4~5. 프로파일 업데이트 (customFacts에 저장)
  await applyFindingsToProfile(uid, findings);
}

/**
 * Claude 분석 프롬프트 생성
 */
function buildAnalysisPrompt(conversationText) {
  const categoryList = EXTRACTION_CATEGORIES
    .map(c => `- ${c}`)
    .join('\n');

  return `아래는 오늘 하루 사용자와 AI의 대화 기록입니다.
아래 10개 항목에 해당하는 내용만 추출하세요.
해당 없으면 findings를 빈 배열로 반환하세요.

[추출 항목]
${categoryList}

[대화 기록]
${conversationText}

[응답 형식 - JSON만 반환, 다른 텍스트 절대 금지]
{
  "findings": [
    {
      "category": "항목명 (위 10개 중 하나)",
      "key": "snake_case_키명",
      "value": "파악된 사실 한 문장",
      "action": "add 또는 remove"
    }
  ]
}

주의사항:
- 청소 루틴에 직접적이고 지속적인 영향을 주는 정보만 추출
- 일시적 감정, 날씨, 음식 등 청소와 무관한 내용은 무시
- 확실하지 않은 정보는 포함하지 말 것`;
}

/**
 * Claude 분석 결과를 사용자 프로파일 customFacts에 반영
 */
async function applyFindingsToProfile(uid, findings) {
  const userRef = db.collection('users').doc(uid);
  const userDoc = await userRef.get();
  if (!userDoc.exists) return;

  const profile = userDoc.data();
  const customFacts = { ...(profile.home?.customFacts || {}) };
  let updated = false;

  for (const finding of findings) {
    if (!finding.key || !finding.action) continue;

    if (finding.action === 'add' && finding.value) {
      // 이미 동일한 키가 있으면 덮어쓰지 않음 (중복 방지)
      if (!customFacts[finding.key]) {
        customFacts[finding.key] = {
          value: finding.value,
          category: finding.category,
          addedAt: new Date().toISOString(),
        };
        updated = true;
      }
    } else if (finding.action === 'remove') {
      if (customFacts[finding.key]) {
        delete customFacts[finding.key];
        updated = true;
      }
    }
  }

  if (updated) {
    await userRef.update({
      'home.customFacts': customFacts,
      updatedAt: new Date().toISOString(),
    });
  }
}

/**
 * 사용자별 알림 설정 시간에 맞춰 오늘의 청소 루틴 알림 발송
 * 매 정각 cron에서 실행: 현재 시(hour)와 사용자 설정 시(hour)가 일치하면 발송
 */
/**
 * 매 분 cron에서 실행.
 * 태스크별 notificationTime과 현재 시각이 일치하면 태스크 단위로 개별 알림 발송.
 * notificationTime 없는 태스크는 사용자 전역 설정 시간(notificationPreference.time)으로 폴백.
 * taskNotifiedDates[taskId] === todayStr 이면 오늘 이미 발송한 태스크로 간주하고 건너뜀.
 */
async function sendScheduledNotifications() {
  try {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const todayStr = now.toISOString().split('T')[0];
    const today = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();

    const usersSnap = await db.collection('users')
      .where('notificationPreference.enabled', '==', true)
      .get();

    if (usersSnap.empty) return;

    const { sendPush } = require('./pushNotification');

    for (const userDoc of usersSnap.docs) {
      const profile = userDoc.data();
      if (!profile.activeRoutineId) continue;

      const routineDoc = await db.collection('routines').doc(profile.activeRoutineId).get();
      if (!routineDoc.exists) continue;

      const todayRoutine = routineDoc.data().weeklyRoutine
        ?.find(r => r.day?.toLowerCase() === today);
      const tasks = todayRoutine?.tasks || [];
      if (tasks.length === 0) continue;

      const taskNotifiedDates = profile.taskNotifiedDates || {};
      const globalTime = profile.notificationPreference?.time;

      for (const task of tasks) {
        // 태스크 개별 시간 → 없으면 전역 설정 시간
        const taskTime = task.notificationTime || globalTime;
        if (!taskTime) continue;

        const [hourStr, minuteStr = '0'] = taskTime.split(':');
        const taskHour = parseInt(hourStr, 10);
        const taskMinute = parseInt(minuteStr, 10);
        if (isNaN(taskHour) || taskHour !== currentHour) continue;
        if (isNaN(taskMinute) || taskMinute !== currentMinute) continue;

        // 오늘 이미 발송한 태스크는 건너뜀
        if (taskNotifiedDates[task.id] === todayStr) continue;

        try {
          await sendPush(userDoc.id, {
            title: `🧹 ${task.taskName}`,
            body: `${task.space} · 예상 ${task.estimatedMinutes}분`,
          });
          await userDoc.ref.update({
            [`taskNotifiedDates.${task.id}`]: todayStr,
          });
        } catch (err) {
          console.error(`[sendScheduledNotifications] uid=${userDoc.id} task=${task.id} 발송 실패:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('[profileScheduler] sendScheduledNotifications 실패:', err.message);
  }
}

module.exports = {
  decaySpaceScores,
  flagStaleProfileFields,
  cleanupStaleData,
  analyzeDailyChatLogs,
  sendScheduledNotifications,
};
