const { db } = require('./firebase');

/**
 * taskPerformanceLearner
 *
 * 태스크 실행률을 학습해 routineAI의 루틴 생성에 반영한다.
 * behaviorPatternAnalyzer와 동일하게 10의 배수 완료 시에만 실행 (비용 절감)
 */

/**
 * 태스크 실행 패턴 학습: space + difficulty 조합별 실행률을 계산해 저장
 * @param {string} uid - 사용자 UID
 */
async function learnFromTaskPerformance(uid) {
  try {
    const profileRef = db.collection('users').doc(uid);
    const profileDoc = await profileRef.get();
    if (!profileDoc.exists) return;

    const profile = profileDoc.data();
    const stats = profile.behaviorStats;

    // 매번 실행하면 Firestore 읽기 비용 과다
    // behaviorPatternAnalyzer와 동일하게 10의 배수일 때만 실행
    if (stats.totalChecklistCompleted % 10 !== 0) return;

    // 활성 루틴에서 태스크 목록 조회
    const activeRoutineId = profile.activeRoutineId;
    if (!activeRoutineId) return;

    const routineDoc = await db.collection('routines').doc(activeRoutineId).get();
    if (!routineDoc.exists) return;

    const routine = routineDoc.data();

    // 활성 루틴의 태스크를 space+difficulty 조합으로 그룹화
    const taskGroups = {};
    for (const day of routine.weeklyRoutine || []) {
      for (const task of day.tasks || []) {
        const key = `${task.space}_${task.difficulty || 'medium'}`;
        if (!taskGroups[key]) {
          taskGroups[key] = { total: 0, space: task.space, difficulty: task.difficulty || 'medium' };
        }
        taskGroups[key].total++;
      }
    }

    if (Object.keys(taskGroups).length === 0) return;

    // 최근 30일 완료 데이터 조회
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const completedSnap = await db.collection('completedTasks')
      .where('uid', '==', uid)
      .where('completedAt', '>', thirtyDaysAgo)
      .get();

    // space+difficulty 조합별 완료 횟수 집계
    const completedByKey = {};
    completedSnap.forEach(doc => {
      const { space, difficulty } = doc.data();
      if (space) {
        const key = `${space}_${difficulty || 'medium'}`;
        completedByKey[key] = (completedByKey[key] || 0) + 1;
      }
    });

    // 실행률 계산 및 flag 분류
    // 실행률 30% 미만 → too_hard (빈도 줄이거나 쪼개기 필요)
    // 실행률 80% 이상 → good (유지하거나 비슷한 난이도 추가 가능)
    // 그 외 → normal
    const taskPerformance = {};
    for (const [key, group] of Object.entries(taskGroups)) {
      if (group.total === 0) continue;

      const completed = completedByKey[key] || 0;
      const rate = completed / group.total;

      let flag = 'normal';
      if (rate < 0.3) flag = 'too_hard';
      else if (rate >= 0.8) flag = 'good';

      taskPerformance[key] = {
        rate: Math.round(rate * 100) / 100,
        flag,
      };
    }

    // users/{uid}.taskPerformance 필드에 저장
    await profileRef.update({
      taskPerformance,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[taskPerformanceLearner] learnFromTaskPerformance 실패:', err.message);
  }
}

module.exports = { learnFromTaskPerformance };
