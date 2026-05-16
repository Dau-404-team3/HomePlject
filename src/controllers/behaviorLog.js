const {
  onChecklistComplete,
  onChecklistSkip,
  onRoutineEdited,
  onNotificationResponse,
  applyScoreDecay,
} = require('../services/profileAnalyzer');
const { generateAiRecommendations, loadRoutineCatalogue } = require('../services/routineAI');
const { sendPush } = require('../services/pushNotification');
const { db } = require('../services/firebase');
const { analyzeSkipPattern, analyzeCompletionPattern } = require('../services/behaviorPatternAnalyzer');
const { learnFromTaskPerformance } = require('../services/taskPerformanceLearner');

const AI_API_URL = process.env.AI_API_URL;
const AI_API_KEY = process.env.AI_API_KEY;

/**
 * POST /api/routine/checklist/complete
 * 체크리스트 항목 완료 처리
 */
async function completeChecklist(req, res, next) {
  try {
    const uid = req.user.uid;
    const { taskId, space, taskName = '' } = req.body;
    const completedAt = new Date().toISOString();
    const todayStr = completedAt.split('T')[0];

    // 중복 완료 방지 체크를 먼저 수행해야 stats가 이중으로 올라가지 않는다
    const existingSnap = await db.collection('completedTasks')
      .where('uid', '==', uid)
      .where('taskId', '==', taskId)
      .where('date', '==', todayStr)
      .limit(1)
      .get();

    if (!existingSnap.empty) {
      return res.json({ success: true, completedAt: existingSnap.docs[0].data().completedAt });
    }

    await onChecklistComplete(uid, { taskId, space, completedAt });

    // 완료 기록을 completedTasks 컬렉션에 저장
    // getTodayRoutine, getWeeklyStats, getCalendar 등이 이 컬렉션을 기반으로 동작함
    await db.collection('completedTasks').add({
      uid,
      taskId,
      space,
      taskName,
      date: todayStr,
      completedAt,
    });

    // 10의 배수 완료 시에만 패턴 분석 실행 (비용 절감)
    // await 없이 백그라운드 실행 (응답 속도에 영향 없음)
    analyzeCompletionPattern(uid).catch(() => null);
    learnFromTaskPerformance(uid).catch(() => null);

    res.json({ success: true, completedAt });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/routine/checklist/skip
 * 체크리스트 항목 건너뜀 처리
 */
async function skipChecklist(req, res, next) {
  try {
    const uid = req.user.uid;
    const { taskId, space, frequency = 'daily' } = req.body;
    const skippedAt = new Date().toISOString();
    const todayStr = skippedAt.split('T')[0];

    await onChecklistSkip(uid, { taskId, space });

    // 건너뜀 기록 저장 — frequency-aware 복원을 위해 Firestore에 영속화
    await db.collection('skippedTasks').add({
      uid,
      taskId,
      space,
      frequency,
      date: todayStr,
      skippedAt,
    });

    // 건너뜀 패턴 확인 후 루틴 재조정 필요 여부 반환
    const profile = (await db.collection('users').doc(uid).get()).data();
    const skipCount = profile?.behaviorStats?.skipPatterns?.[space] || 0;

    // 건너뜀 패턴 분석 백그라운드 실행 (응답 속도에 영향 없음)
    analyzeSkipPattern(uid).catch(() => null);

    // 3회 건너뜀마다 제안 (3, 6, 9, ... 회) — 재조정 수락 시 카운트 0 리셋되므로 다시 3회부터 시작
    res.json({
      success: true,
      routineRefreshSuggested: skipCount > 0 && skipCount % 3 === 0,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/routine/checklist/uncomplete
 * 체크리스트 항목 완료 취소 처리
 */
async function uncompleteChecklist(req, res, next) {
  try {
    const uid = req.user.uid;
    const { taskId, space } = req.body;
    const todayStr = new Date().toISOString().split('T')[0];

    // 오늘 날짜의 해당 태스크 완료 기록 삭제
    const completedSnap = await db.collection('completedTasks')
      .where('uid', '==', uid)
      .where('taskId', '==', taskId)
      .where('date', '==', todayStr)
      .get();
    await Promise.all(completedSnap.docs.map(doc => doc.ref.delete()));

    // behaviorStats.totalChecklistCompleted -1, spaceStatus[space].score -2 (0 미만 방지)
    const profile = (await db.collection('users').doc(uid).get()).data();
    const currentTotal = profile?.behaviorStats?.totalChecklistCompleted || 0;
    const currentScore = profile?.spaceStatus?.[space]?.score || 0;

    await db.collection('users').doc(uid).update({
      'behaviorStats.totalChecklistCompleted': Math.max(0, currentTotal - 1),
      [`spaceStatus.${space}.score`]: Math.max(0, currentScore - 2),
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/routine/edit
 * 사용자가 루틴을 직접 수정했을 때
 * - 추가된 태스크는 isAiRecommended: false로 저장
 * - 제거된 태스크는 활성 루틴에서 삭제
 * - activeRoutineId가 없으면 빈 주간 루틴을 새로 생성 후 저장
 * - frequency='daily' 태스크는 7일 전체에 추가 (매일 홈화면에 표시)
 * - frequency='weekly'/'monthly' 태스크는 오늘 요일에만 추가
 */
async function editRoutine(req, res, next) {
  try {
    const uid = req.user.uid;
    const { removedTasks = [], addedTasks = [], totalMinutesBefore, totalMinutesAfter } = req.body;

    await onRoutineEdited(uid, { removedTasks, addedTasks, totalMinutesBefore, totalMinutesAfter });

    if (removedTasks.length === 0 && addedTasks.length === 0) {
      return res.json({ success: true });
    }

    const ALL_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const profileDoc = await db.collection('users').doc(uid).get();
    const profile = profileDoc.data();

    let activeRoutineId = profile?.activeRoutineId;
    let routineRef;
    let weeklyRoutine;

    if (!activeRoutineId) {
      // 활성 루틴 없음 → 7일 빈 슬롯으로 새 루틴 생성
      weeklyRoutine = ALL_DAYS.map(day => ({ day, tasks: [] }));
      routineRef = db.collection('routines').doc();
      activeRoutineId = routineRef.id;
      await routineRef.set({
        id: activeRoutineId,
        uid,
        weeklyRoutine,
        generationReason: 'user_added',
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await db.collection('users').doc(uid).update({
        activeRoutineId,
        isOnboarded: true,
      });
    } else {
      routineRef = db.collection('routines').doc(activeRoutineId);
      const routineDoc = await routineRef.get();
      if (!routineDoc.exists) {
        return res.json({ success: true });
      }
      weeklyRoutine = routineDoc.data().weeklyRoutine.map(d => ({ ...d, tasks: [...(d.tasks || [])] }));
    }

    // 7일 슬롯이 모두 존재하도록 보장 (AI 루틴이 일부 요일만 생성한 경우 보완)
    for (const day of ALL_DAYS) {
      if (!weeklyRoutine.find(d => d.day === day)) {
        weeklyRoutine.push({ day, tasks: [] });
      }
    }

    // 제거할 태스크 — id 기준으로 모든 요일에서 삭제 + 완료/건너뜀 기록도 함께 초기화
    if (removedTasks.length > 0) {
      const removedIds = new Set(removedTasks.map(t => t.id ?? t));
      weeklyRoutine = weeklyRoutine.map(dayRoutine => ({
        ...dayRoutine,
        tasks: dayRoutine.tasks.filter(t => !removedIds.has(t.id)),
      }));

      const thirtyDaysAgoStr = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      for (const removedId of removedIds) {
        if (!removedId) continue;
        const [cSnap, sSnap] = await Promise.all([
          db.collection('completedTasks').where('uid', '==', uid).where('taskId', '==', removedId).get(),
          db.collection('skippedTasks').where('uid', '==', uid).where('taskId', '==', removedId).get(),
        ]);
        const ops = [
          ...cSnap.docs.filter(doc => doc.data().date >= thirtyDaysAgoStr).map(doc => doc.ref.delete()),
          ...sSnap.docs.filter(doc => doc.data().date >= thirtyDaysAgoStr).map(doc => doc.ref.delete()),
        ];
        if (ops.length > 0) await Promise.all(ops);
      }
    }

    // 추가할 태스크
    if (addedTasks.length > 0) {
      const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();

      const todayStr2 = new Date().toISOString().split('T')[0];
      const thirtyDaysAgoStr2 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      // 재추가 태스크의 최근 30일 완료·건너뜀 기록 삭제
      // uid + taskId 동등 조건만 사용해 composite index 없이 조회 후 메모리에서 날짜 필터
      for (const task of addedTasks) {
        const [completedSnap2, skippedSnap2] = await Promise.all([
          db.collection('completedTasks')
            .where('uid', '==', uid)
            .where('taskId', '==', task.id)
            .get(),
          db.collection('skippedTasks')
            .where('uid', '==', uid)
            .where('taskId', '==', task.id)
            .get(),
        ]);
        const deleteOps2 = [
          ...completedSnap2.docs
            .filter(doc => doc.data().date >= thirtyDaysAgoStr2)
            .map(doc => doc.ref.delete()),
          ...skippedSnap2.docs
            .filter(doc => doc.data().date >= thirtyDaysAgoStr2)
            .map(doc => doc.ref.delete()),
        ];
        if (deleteOps2.length > 0) await Promise.all(deleteOps2);
      }

      for (const task of addedTasks) {
        const { day: taskDay, ...taskWithoutDay } = task;
        // addedAt: 재추가 시점 날짜 — getTodayRoutine에서 이전 완료/건너뜀 이력 무시에 사용
        const newTask = { ...taskWithoutDay, isAiRecommended: false, addedAt: todayStr2 };

        // 매일 루틴 → 7일 전체, 주간/월간 → 오늘 하루만
        const targetDays = task.frequency === 'daily' ? ALL_DAYS : [taskDay || todayName];

        for (const targetDay of targetDays) {
          const dayIndex = weeklyRoutine.findIndex(d => d.day === targetDay);
          if (dayIndex >= 0) {
            const existingIdx = weeklyRoutine[dayIndex].tasks.findIndex(t => t.id === newTask.id);
            if (existingIdx >= 0) {
              // 이미 존재하는 태스크: addedAt만 갱신해 이전 완료 이력 리셋
              weeklyRoutine[dayIndex] = {
                ...weeklyRoutine[dayIndex],
                tasks: weeklyRoutine[dayIndex].tasks.map((t, i) =>
                  i === existingIdx ? { ...t, addedAt: todayStr2 } : t
                ),
              };
            } else {
              weeklyRoutine[dayIndex] = {
                ...weeklyRoutine[dayIndex],
                tasks: [...weeklyRoutine[dayIndex].tasks, newTask],
              };
            }
          } else {
            weeklyRoutine.push({ day: targetDay, tasks: [newTask] });
          }
        }
      }
    }

    await routineRef.update({
      weeklyRoutine,
      updatedAt: new Date().toISOString(),
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/routine/reset
 * 활성 루틴의 모든 태스크 초기화 (빈 7일 슬롯으로 리셋)
 */
async function resetRoutine(req, res, next) {
  try {
    const uid = req.user.uid;
    const profileDoc = await db.collection('users').doc(uid).get();
    const profile = profileDoc.data();

    if (!profile?.activeRoutineId) {
      return res.json({ success: true });
    }

    const ALL_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    await db.collection('routines').doc(profile.activeRoutineId).update({
      weeklyRoutine: ALL_DAYS.map(day => ({ day, tasks: [] })),
      updatedAt: new Date().toISOString(),
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/routine/today
 * 오늘의 체크리스트 반환
 */
async function getTodayRoutine(req, res, next) {
  try {
    const uid = req.user.uid;
    const profile = (await db.collection('users').doc(uid).get()).data();

    // 방치된 공간 점수 자동 감소 (홈 화면 로드마다 실행)
    // 반환값은 감소 적용 후 spaceStatus — 이후 res.json에 사용
    const spaceStatus = await applyScoreDecay(uid, profile.spaceStatus);

    // 클라이언트가 전달한 요일 우선 사용 — 없으면 서버 UTC 기준 (시간대 불일치 방지)
    const VALID_DAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const dayParam = req.query.day?.toLowerCase();
    const today = VALID_DAYS.includes(dayParam)
      ? dayParam
      : new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const todayStr = new Date().toISOString().split('T')[0];

    if (!profile?.activeRoutineId) {
      return res.json({ activeRoutineId: null, tasks: [], totalMinutes: 0, completedCount: 0, date: todayStr, day: today });
    }

    const routineDoc = await db.collection('routines').doc(profile.activeRoutineId).get();
    if (!routineDoc.exists) {
      return res.json({ activeRoutineId: null, tasks: [], totalMinutes: 0, completedCount: 0, date: todayStr, day: today });
    }

    const routine = routineDoc.data();

    // AI가 요일명을 대문자/혼용으로 저장한 경우도 처리
    const todayDayRoutine = routine.weeklyRoutine.find(r => r.day?.toLowerCase() === today);

    // weekly/monthly 태스크는 특정 요일에만 저장되지만 매일 홈화면에 노출돼야 한다.
    // 전체 요일을 스캔해 weekly/monthly 태스크를 수집하고 오늘 목록에 병합한다.
    const todayTaskIds = new Set((todayDayRoutine?.tasks || []).map(t => t.id));
    const recurringTasks = [];
    const seenIds = new Set(todayTaskIds);
    for (const dayRoutine of routine.weeklyRoutine || []) {
      for (const task of dayRoutine.tasks || []) {
        const freq = task.frequency || 'daily';
        if ((freq === 'weekly' || freq === 'monthly') && !seenIds.has(task.id)) {
          seenIds.add(task.id);
          recurringTasks.push(task);
        }
      }
    }
    const mergedTasks = [...(todayDayRoutine?.tasks || []), ...recurringTasks];

    // 완료/건너뜀 상태 조회 — 최근 30일치를 한 번에 조회해 빈도별로 판단
    // (매일: 오늘, 주간: 7일, 월간: 30일)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const sevenDaysAgo  = new Date(Date.now() -  7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const [completedSnap, skippedSnap] = await Promise.all([
      db.collection('completedTasks')
        .where('uid', '==', uid)
        .where('date', '>=', thirtyDaysAgo)
        .where('date', '<=', todayStr)
        .get(),
      db.collection('skippedTasks')
        .where('uid', '==', uid)
        .where('date', '>=', thirtyDaysAgo)
        .where('date', '<=', todayStr)
        .get(),
    ]);

    // taskId → 가장 최근 완료/건너뜀 날짜
    const lastCompletedDate = {};
    completedSnap.docs.forEach(doc => {
      const { taskId, date } = doc.data();
      if (!lastCompletedDate[taskId] || date > lastCompletedDate[taskId]) {
        lastCompletedDate[taskId] = date;
      }
    });

    const lastSkippedDate = {};
    skippedSnap.docs.forEach(doc => {
      const { taskId, date } = doc.data();
      if (!lastSkippedDate[taskId] || date > lastSkippedDate[taskId]) {
        lastSkippedDate[taskId] = date;
      }
    });

    // frequency 필드 포함하여 반환 (탭 필터링에 활용)
    // weekly/monthly 태스크는 완료/건너뜀 후에도 홈화면에 표시 (7일/30일 뒤 체크 해제)
    const allTasks = mergedTasks.map(task => {
      const freq = task.frequency || 'daily';

      // addedAt: 태스크가 루틴에 (재)추가된 날짜. 이보다 이전 완료/건너뜀 기록은 무시한다.
      // 이를 통해 같은 ID의 카탈로그 루틴을 삭제 후 재추가해도 이전 이력이 반영되지 않는다.
      const addedDate = task.addedAt ? task.addedAt.split('T')[0] : null;
      const rawLastDone = lastCompletedDate[task.id] ?? null;
      const rawLastSkip = lastSkippedDate[task.id]   ?? null;
      const lastDone = addedDate && rawLastDone && rawLastDone < addedDate ? null : rawLastDone;
      const lastSkip = addedDate && rawLastSkip && rawLastSkip < addedDate ? null : rawLastSkip;

      let completed = false;
      let skipped   = false;

      if (freq === 'daily') {
        completed = lastDone === todayStr;
        skipped   = lastSkip === todayStr;
      } else if (freq === 'weekly') {
        completed = lastDone !== null && lastDone >= sevenDaysAgo;
        skipped   = !completed && lastSkip !== null && lastSkip >= sevenDaysAgo;
      } else {
        // monthly
        completed = lastDone !== null && lastDone >= thirtyDaysAgo;
        skipped   = !completed && lastSkip !== null && lastSkip >= thirtyDaysAgo;
      }

      const isDone = completed || skipped;
      return {
        ...task,
        frequency: freq,
        isAiRecommended: task.isAiRecommended !== false,
        completed,
        skipped,
        lastCompletedAt: lastDone,  // 프론트 tracker 복원용 날짜 문자열 (e.g. "2026-05-13")
        lastSkippedAt:   lastSkip,
        dueToday: !isDone,
      };
    });

    // weekly/monthly 태스크는 완료/건너뜀 후에도 계속 노출 — 7일/30일 경과 후 자동 해제
    const tasks = allTasks;

    const totalMinutes = tasks.reduce((sum, t) => sum + t.estimatedMinutes, 0);

    res.json({
      date: todayStr,
      day: today,
      // 프론트에서 온보딩 미완료(null)와 쉬는 날(값 있음)을 구분하는 데 사용
      activeRoutineId: profile.activeRoutineId,
      tasks,
      totalMinutes,
      completedCount: tasks.filter(t => t.completed).length,
      spaceStatus,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/routine/weekly-stats
 * 홈 화면 이번 주 달성률 계산
 * completedTasks에서 이번 주 월~오늘 데이터를 조회해서 계산
 */
async function getWeeklyStats(req, res, next) {
  try {
    const uid = req.user.uid;
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    // 이번 주 월요일 날짜 계산 (일요일=0이면 6일 전이 월요일)
    const dayOfWeek = now.getDay();
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(now);
    monday.setDate(now.getDate() - daysToMonday);
    const mondayStr = monday.toISOString().split('T')[0];

    // 이번 주 월~오늘 완료된 태스크 수 조회
    const weekCompletedSnap = await db.collection('completedTasks')
      .where('uid', '==', uid)
      .where('date', '>=', mondayStr)
      .where('date', '<=', todayStr)
      .get();
    const completedCount = weekCompletedSnap.size;

    const profile = (await db.collection('users').doc(uid).get()).data();

    // 루틴 없는 신규 사용자: 에러가 아닌 빈 통계 반환
    if (!profile?.activeRoutineId) {
      return res.json({
        weeklyCompletionRate: 0,
        completedCount,
        totalCount: 0,
        currentStreak: profile?.behaviorStats?.currentStreak || 0,
        remainingToday: 0,
      });
    }

    const routineDoc = await db.collection('routines').doc(profile.activeRoutineId).get();
    if (!routineDoc.exists) {
      return res.json({
        weeklyCompletionRate: 0,
        completedCount,
        totalCount: 0,
        currentStreak: profile?.behaviorStats?.currentStreak || 0,
        remainingToday: 0,
      });
    }

    const routine = routineDoc.data();

    // 이번 주 전체 태스크 수 = 주간 루틴 모든 요일의 태스크 합
    const totalCount = (routine.weeklyRoutine || []).reduce(
      (sum, day) => sum + (day.tasks?.length || 0),
      0
    );

    // 오늘 남은 태스크 수 계산
    const todayDayName = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const todayRoutine = routine.weeklyRoutine?.find(r => r.day === todayDayName);
    const todayTaskIds = new Set((todayRoutine?.tasks || []).map(t => t.id));

    const todayCompletedSnap = await db.collection('completedTasks')
      .where('uid', '==', uid)
      .where('date', '==', todayStr)
      .get();
    const todayCompletedIds = new Set(todayCompletedSnap.docs.map(d => d.data().taskId));

    const remainingToday = [...todayTaskIds].filter(id => !todayCompletedIds.has(id)).length;
    const weeklyCompletionRate = totalCount > 0 ? Math.round(completedCount / totalCount * 100) : 0;

    res.json({
      weeklyCompletionRate,
      completedCount,
      totalCount,
      currentStreak: profile.behaviorStats?.currentStreak || 0,
      remainingToday,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/routine/ai-comment
 * 홈 화면 하단 AI 한마디
 * 비용 절감: claude-haiku 사용, max_tokens 150 제한
 * 하루에 한 번만 생성하고 Firestore에 캐싱 (재요청 시 캐시 반환)
 */
async function getAiComment(req, res, next) {
  try {
    const uid = req.user.uid;
    const todayStr = new Date().toISOString().split('T')[0];

    const profileDoc = await db.collection('users').doc(uid).get();
    if (!profileDoc.exists) {
      return res.status(404).json({ error: '프로파일이 없습니다.' });
    }
    const profile = profileDoc.data();

    // 오늘 날짜로 생성된 캐시가 있으면 Claude 호출 없이 그대로 반환
    if (profile.todayComment?.date === todayStr) {
      return res.json({ message: profile.todayComment.message });
    }

    // 오늘 완료율 계산 (AI 코멘트 생성에 활용)
    const todayCompletedSnap = await db.collection('completedTasks')
      .where('uid', '==', uid)
      .where('date', '==', todayStr)
      .get();
    const todayCompletedCount = todayCompletedSnap.size;

    let todayTotalCount = 0;
    if (profile.activeRoutineId) {
      const routineDoc = await db.collection('routines').doc(profile.activeRoutineId).get();
      if (routineDoc.exists) {
        const todayDayName = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
        const todayRoutine = routineDoc.data().weeklyRoutine?.find(r => r.day === todayDayName);
        todayTotalCount = todayRoutine?.tasks?.length || 0;
      }
    }
    const todayRate = todayTotalCount > 0 ? Math.round(todayCompletedCount / todayTotalCount * 100) : 0;

    // 가장 청결 점수가 낮은 공간 (동기부여 메시지에 활용)
    const spaceEntries = Object.entries(profile.spaceStatus || {});
    const lowestSpace = spaceEntries.sort(([, a], [, b]) => a.score - b.score)[0]?.[0] || '없음';

    // Claude Haiku 호출 — AI API 실패해도 폴백 메시지로 항상 200 반환
    try {
      const response = await fetch(AI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': AI_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          messages: [{
            role: 'user',
            content: `사용자 정보:
- 청소 성향: ${profile.personality?.type}
- 오늘 완료율: ${todayRate}%
- 현재 연속 달성: ${profile.behaviorStats?.currentStreak || 0}일
- 가장 청결 점수 낮은 공간: ${lowestSpace}

위 정보를 바탕으로 2문장 이내의 짧고 따뜻한 한국어 동기부여 메시지를 작성해주세요.
텍스트만 반환하고 다른 설명은 절대 추가하지 마세요.`,
          }],
        }),
      });

      if (!response.ok) throw new Error(`AI API HTTP 오류: ${response.status}`);
      const aiData = await response.json();
      const message = aiData.content[0].text.trim();

      // 생성된 코멘트를 오늘 날짜와 함께 Firestore에 저장 (다음 요청 시 캐시로 사용)
      await db.collection('users').doc(uid).update({
        todayComment: { message, date: todayStr },
      });

      return res.json({ message });
    } catch (aiErr) {
      // AI API 실패 → 프론트엔드 렌더링이 막히지 않도록 폴백 메시지 반환
      console.error('[getAiComment] AI API 호출 실패:', aiErr.message);
      return res.json({ message: '오늘도 깨끗한 하루 시작해봐요! 💪' });
    }
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/routine/by-frequency?type={daily|weekly|monthly}
 * 루틴 화면 탭별(매일/주간/월간) 태스크 목록 조회
 */
async function getRoutineByFrequency(req, res, next) {
  try {
    const uid = req.user.uid;
    const { type } = req.query;

    if (!['daily', 'weekly', 'monthly'].includes(type)) {
      return res.status(400).json({ error: 'type은 daily | weekly | monthly 중 하나여야 합니다.' });
    }

    const profile = (await db.collection('users').doc(uid).get()).data();
    if (!profile?.activeRoutineId) {
      return res.status(404).json({ error: '활성 루틴이 없습니다.' });
    }

    const routineDoc = await db.collection('routines').doc(profile.activeRoutineId).get();
    if (!routineDoc.exists) {
      return res.status(404).json({ error: '루틴을 찾을 수 없습니다.' });
    }

    const routine = routineDoc.data();

    // 전체 요일에서 frequency가 일치하는 태스크만 추출
    const tasks = [];
    for (const dayRoutine of (routine.weeklyRoutine || [])) {
      for (const task of (dayRoutine.tasks || [])) {
        if ((task.frequency || 'daily') === type) {
          tasks.push({ ...task, day: dayRoutine.day });
        }
      }
    }

    const totalMinutes = tasks.reduce((sum, t) => sum + (t.estimatedMinutes || 0), 0);

    res.json({ frequency: type, tasks, totalMinutes });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/routine/calendar?month=2025-04
 * 캘린더 화면 — 날짜별 루틴 완료 이력 조회
 * month 파라미터: YYYY-MM 형식
 */
async function getCalendar(req, res, next) {
  try {
    const uid = req.user.uid;
    const { month } = req.query;

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month 파라미터는 YYYY-MM 형식이어야 합니다.' });
    }

    const [year, monthNum] = month.split('-').map(Number);
    const startDate = `${month}-01`;
    // 해당 월의 마지막 날짜 계산 (다음 달 0일 = 이번 달 마지막 날)
    const endDate = new Date(year, monthNum, 0).toISOString().split('T')[0];

    // 해당 월의 완료 태스크 전체 조회
    const completedSnap = await db.collection('completedTasks')
      .where('uid', '==', uid)
      .where('date', '>=', startDate)
      .where('date', '<=', endDate)
      .get();

    // 날짜별로 그룹핑
    const days = {};
    completedSnap.forEach(doc => {
      const data = doc.data();
      if (!days[data.date]) {
        days[data.date] = { tasks: [], completionRate: 0 };
      }
      days[data.date].tasks.push({
        taskName: data.taskName || '',
        space: data.space,
        completedAt: data.completedAt,
      });
    });

    // 각 날짜의 완료율 계산
    // 해당 요일의 루틴 태스크 수를 기준으로 계산
    const profile = (await db.collection('users').doc(uid).get()).data();
    let weeklyRoutine = [];
    if (profile?.activeRoutineId) {
      const routineDoc = await db.collection('routines').doc(profile.activeRoutineId).get();
      if (routineDoc.exists) {
        weeklyRoutine = routineDoc.data().weeklyRoutine || [];
      }
    }

    for (const dateStr of Object.keys(days)) {
      // 날짜 문자열을 파싱할 때 시간대 오류 방지를 위해 정오 기준으로 처리
      const dayName = new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
      const dayRoutine = weeklyRoutine.find(r => r.day === dayName);
      const totalForDay = dayRoutine?.tasks?.length || 0;
      days[dateStr].completionRate = totalForDay > 0
        ? Math.round(days[dateStr].tasks.length / totalForDay * 100)
        : 100;
    }

    res.json({ month, days });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/notification/preference
 * 알림 시간 설정 저장
 */
async function saveNotificationPreference(req, res, next) {
  try {
    const uid = req.user.uid;
    const { enabled, time } = req.body;
    if (typeof enabled !== 'boolean' || typeof time !== 'string') {
      return res.status(400).json({ error: 'enabled(boolean)와 time(string) 필드가 필요합니다.' });
    }
    await db.collection('users').doc(uid).update({
      notificationPreference: { enabled, time },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/notification/preference
 * 알림 시간 설정 조회
 */
async function getNotificationPreference(req, res, next) {
  try {
    const uid = req.user.uid;
    const profile = (await db.collection('users').doc(uid).get()).data();
    res.json(profile?.notificationPreference ?? { enabled: true, time: '8:00' });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/notification/response
 * 알림 반응 기록
 */
async function recordNotificationResponse(req, res, next) {
  try {
    const uid = req.user.uid;
    const { response } = req.body; // true = 탭함, false = 무시
    await onNotificationResponse(uid, { response });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/notification/token
 * FCM 토큰 저장
 */
async function saveFcmToken(req, res, next) {
  try {
    const uid = req.user.uid;
    const { fcmToken } = req.body;
    if (!fcmToken) return res.status(400).json({ error: 'fcmToken이 없습니다.' });

    await db.collection('users').doc(uid).update({ fcmToken });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

async function getNotificationInbox(req, res, next) {
  try {
    const uid = req.user.uid;
    const snap = await db.collection('notifications')
      .where('uid', '==', uid)
      .limit(50)
      .get();

    const notifications = snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    res.json({ notifications });
  } catch (err) {
    next(err);
  }
}

async function markNotificationsRead(req, res, next) {
  try {
    const { ids = [] } = req.body;
    if (ids.length === 0) return res.json({ success: true });

    const batch = db.batch();
    for (const id of ids) {
      batch.update(db.collection('notifications').doc(id), { read: true });
    }
    await batch.commit();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

async function testNotification(req, res, next) {
  try {
    const uid = req.user.uid;
    await sendPush(uid, {
      title: '테스트 알림 🔔',
      body: '알림이 정상적으로 동작하고 있어요!',
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// AI 맞춤 추천 재생성 후 알림 발송 (개발 테스트용 — 쿨다운 무시)
// 홈 화면 활성 루틴(activeRoutineId)에는 전혀 영향을 주지 않는다.
async function testRoutineRefreshNotification(req, res, next) {
  try {
    const uid = req.user.uid;
    const { recommendations, changeBody } = await generateAiRecommendations(uid);
    await sendPush(uid, {
      title: '맞춤 루틴 추천이 업데이트됐어요 ✨',
      body: changeBody,
    });
    res.json({ success: true, spaceCount: Object.keys(recommendations).length, changeBody });
  } catch (err) {
    next(err);
  }
}

// 건너뜀 패턴 감지 후 사용자 승낙 시 AI 맞춤 추천 재생성 (알림 미발송)
async function refreshAiRecommendations(req, res, next) {
  try {
    const uid = req.user.uid;
    const triggerSpaceKey = req.body?.spaceKey ?? null;
    // 수동·건너뜀 재생성은 항상 맞춤생성 루틴도 포함 (forceCustom=true)
    const { recommendations, changeBody, spaceChanges } = await generateAiRecommendations(uid, triggerSpaceKey, true);

    // 재조정 수락 시 트리거 공간의 skip 카운트 초기화 — 다음 3회부터 다시 제안 가능
    if (triggerSpaceKey) {
      await db.collection('users').doc(uid).update({
        [`behaviorStats.skipPatterns.${triggerSpaceKey}`]: 0,
      });
    }

    res.json({ success: true, spaceCount: Object.keys(recommendations).length, changeBody, spaceChanges });
  } catch (err) {
    next(err);
  }
}

// 전체 공간 카탈로그 항목 수 반환 (routine-add 화면의 "추천 N개" 표시용)
async function getCatalogueCounts(req, res, next) {
  try {
    const catalogue = await loadRoutineCatalogue();
    const counts = {};
    for (const [space, items] of Object.entries(catalogue)) {
      counts[space] = items.length;
    }
    res.json({ counts });
  } catch (err) {
    next(err);
  }
}

// 공간별 AI 맞춤 추천 반환 — 카탈로그 ID 목록 + 생성형 루틴 객체 목록 + 카탈로그 루틴 상세
async function getSpaceRecommendations(req, res, next) {
  try {
    const uid = req.user.uid;
    const { spaceKey } = req.params;
    const [profile, catalogue] = await Promise.all([
      db.collection('users').doc(uid).get().then(d => d.data()),
      loadRoutineCatalogue(),
    ]);
    const ids = profile?.aiRecommendations?.[spaceKey] ?? [];
    const generated = profile?.aiGeneratedRoutines?.[spaceKey] ?? [];
    const updatedAt = profile?.aiRecommendationsUpdatedAt ?? null;
    const spaceRoutines = catalogue[spaceKey] ?? [];
    res.json({ ids, generated, updatedAt, routines: spaceRoutines });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/routine/task-ids
 * 활성 루틴의 전체 태스크 ID 목록 (중복 제거)
 * routine-space 화면에서 이미 추가된 루틴 표시에 사용
 */
async function getActiveTaskIds(req, res, next) {
  try {
    const uid = req.user.uid;
    const profile = (await db.collection('users').doc(uid).get()).data();
    if (!profile?.activeRoutineId) {
      return res.json({ ids: [] });
    }
    const routineDoc = await db.collection('routines').doc(profile.activeRoutineId).get();
    if (!routineDoc.exists) {
      return res.json({ ids: [] });
    }
    const seen = new Set();
    for (const dayRoutine of (routineDoc.data().weeklyRoutine || [])) {
      for (const task of (dayRoutine.tasks || [])) {
        if (task.id) seen.add(task.id);
      }
    }
    res.json({ ids: [...seen] });
  } catch (err) {
    next(err);
  }
}

// 오늘 루틴의 태스크별 개별 알림 즉시 발송 (개발 테스트용 — 최대 5개)
async function testScheduledNotification(req, res, next) {
  try {
    const uid = req.user.uid;
    const profile = (await db.collection('users').doc(uid).get()).data();

    if (!profile?.activeRoutineId) {
      return res.json({ success: false, message: '활성 루틴이 없어요' });
    }

    const routineDoc = await db.collection('routines').doc(profile.activeRoutineId).get();
    if (!routineDoc.exists) {
      return res.json({ success: false, message: '루틴을 찾을 수 없어요' });
    }

    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const todayRoutine = routineDoc.data().weeklyRoutine?.find(r => r.day?.toLowerCase() === today);
    const tasks = todayRoutine?.tasks || [];

    if (tasks.length === 0) {
      return res.json({ success: false, message: '오늘 루틴이 없어요' });
    }

    let count = 0;
    for (const task of tasks.slice(0, 5)) {
      await sendPush(uid, {
        title: `🧹 ${task.taskName}`,
        body: `${task.space} · 예상 ${task.estimatedMinutes}분`,
      });
      count++;
    }

    res.json({ success: true, count });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  completeChecklist,
  uncompleteChecklist,
  skipChecklist,
  editRoutine,
  resetRoutine,
  getTodayRoutine,
  getWeeklyStats,
  getAiComment,
  getRoutineByFrequency,
  getCalendar,
  recordNotificationResponse,
  saveFcmToken,
  saveNotificationPreference,
  getNotificationPreference,
  testNotification,
  testRoutineRefreshNotification,
  testScheduledNotification,
  getNotificationInbox,
  markNotificationsRead,
  getCatalogueCounts,
  getSpaceRecommendations,
  refreshAiRecommendations,
  getActiveTaskIds,
};
