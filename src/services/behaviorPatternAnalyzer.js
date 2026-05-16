const { db } = require('./firebase');

/**
 * behaviorPatternAnalyzer
 *
 * 사용자 행동 패턴을 분석해 프로파일을 자동 보완한다.
 * 매 체크리스트마다 실행하면 Firestore 읽기 비용 과다 →
 * 공통 원칙: totalChecklistCompleted가 10의 배수일 때만 실행 (하루 평균 1~2회)
 */

/**
 * 건너뜀 패턴 분석: 누적 10회 이상 건너뛴 공간을 troubleSpots에 자동 추가
 * - 연속 3회 건너뜀은 profileAnalyzer의 flagRoutineReview가 처리하므로 중복 처리 X
 * - 누적 10회 기준으로 온보딩 때 빠진 troubleSpots 자동 보완
 * @param {string} uid - 사용자 UID
 */
async function analyzeSkipPattern(uid) {
  try {
    const profileRef = db.collection('users').doc(uid);
    const profileDoc = await profileRef.get();
    if (!profileDoc.exists) return;

    const profile = profileDoc.data();
    const stats = profile.behaviorStats;

    // 10의 배수 완료 시에만 실행 (비용 절감)
    if (stats.totalChecklistCompleted % 10 !== 0) return;

    const skipPatterns = stats.skipPatterns || {};
    const currentTroubleSpots = profile.home?.troubleSpots || [];

    // 누적 10회 이상 건너뛴 공간 중 troubleSpots에 없는 것 찾기
    const newTroubleSpots = [...currentTroubleSpots];
    let updated = false;

    for (const [space, count] of Object.entries(skipPatterns)) {
      if (count >= 10 && !newTroubleSpots.includes(space)) {
        newTroubleSpots.push(space);
        updated = true;
      }
    }

    if (updated) {
      await profileRef.update({
        'home.troubleSpots': newTroubleSpots,
        updatedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('[behaviorPatternAnalyzer] analyzeSkipPattern 실패:', err.message);
  }
}

/**
 * 완료율 패턴 분석: 잘 관리되는 공간을 troubleSpots에서 자동 제거
 * - 완료율 80% 이상 AND spaceStatus 점수 70점 이상일 때만 제거
 * - 완료율만 보면 쉬운 태스크만 한 경우를 구분 못함
 * - 점수까지 함께 봐야 실제로 잘 관리되는 공간인지 판단 가능
 * @param {string} uid - 사용자 UID
 */
async function analyzeCompletionPattern(uid) {
  try {
    const profileRef = db.collection('users').doc(uid);
    const profileDoc = await profileRef.get();
    if (!profileDoc.exists) return;

    const profile = profileDoc.data();
    const stats = profile.behaviorStats;

    // 10의 배수 완료 시에만 실행 (비용 절감)
    if (stats.totalChecklistCompleted % 10 !== 0) return;

    // 최근 30일 완료 데이터 조회
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const completedSnap = await db.collection('completedTasks')
      .where('uid', '==', uid)
      .where('completedAt', '>', thirtyDaysAgo)
      .get();

    if (completedSnap.empty) return;

    // 활성 루틴에서 태스크 목록 조회 (분모 계산용)
    const activeRoutineId = profile.activeRoutineId;
    if (!activeRoutineId) return;

    const routineDoc = await db.collection('routines').doc(activeRoutineId).get();
    if (!routineDoc.exists) return;

    const routine = routineDoc.data();

    // 공간별 총 태스크 수 계산
    const totalBySpace = {};
    for (const day of routine.weeklyRoutine || []) {
      for (const task of day.tasks || []) {
        totalBySpace[task.space] = (totalBySpace[task.space] || 0) + 1;
      }
    }

    // 공간별 완료 횟수 계산
    const completedBySpace = {};
    completedSnap.forEach(doc => {
      const { space } = doc.data();
      if (space) completedBySpace[space] = (completedBySpace[space] || 0) + 1;
    });

    const currentTroubleSpots = profile.home?.troubleSpots || [];
    const spaceStatus = profile.spaceStatus || {};
    const updatedTroubleSpots = [...currentTroubleSpots];
    let updated = false;

    for (const space of currentTroubleSpots) {
      const total = totalBySpace[space] || 0;
      if (total === 0) continue;

      const completed = completedBySpace[space] || 0;
      const completionRate = completed / total;
      const spaceScore = spaceStatus[space]?.score ?? 0;

      // 완료율 80% 이상 AND 점수 70점 이상일 때만 troubleSpots에서 제거
      if (completionRate >= 0.8 && spaceScore >= 70) {
        const idx = updatedTroubleSpots.indexOf(space);
        if (idx !== -1) {
          updatedTroubleSpots.splice(idx, 1);
          updated = true;
        }
      }
    }

    if (updated) {
      await profileRef.update({
        'home.troubleSpots': updatedTroubleSpots,
        updatedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('[behaviorPatternAnalyzer] analyzeCompletionPattern 실패:', err.message);
  }
}

/**
 * 루틴 수정 패턴 분석: 반복 삭제된 공간 처리 및 personality.type 재평가
 * - 특정 공간 태스크가 3회 연속 삭제됐으면 troubleSpots에서 제거
 * - 항상 줄이면 procrastinator 강화, 항상 늘리면 maintainer로 재평가
 * @param {string} uid - 사용자 UID
 */
async function analyzeRoutineEditPattern(uid) {
  try {
    const profileRef = db.collection('users').doc(uid);
    const profileDoc = await profileRef.get();
    if (!profileDoc.exists) return;

    const profile = profileDoc.data();
    const stats = profile.behaviorStats;

    // 10의 배수 완료 시에만 실행 (비용 절감)
    if (stats.totalChecklistCompleted % 10 !== 0) return;

    // 최근 3개 루틴 이력 조회
    const routinesSnap = await db.collection('routines')
      .where('uid', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(3)
      .get();

    if (routinesSnap.size < 3) return;

    const routines = routinesSnap.docs.map(d => d.data());

    // 공간별 삭제 패턴 분석
    const spaceDeleteCount = {};
    let totalShrinkCount = 0;
    let totalGrowCount = 0;

    for (let i = 0; i < routines.length - 1; i++) {
      const current = routines[i];
      const prev = routines[i + 1];

      const currentSpaces = new Set();
      const prevSpaces = new Set();

      for (const day of current.weeklyRoutine || []) {
        for (const task of day.tasks || []) currentSpaces.add(task.space);
      }
      for (const day of prev.weeklyRoutine || []) {
        for (const task of day.tasks || []) prevSpaces.add(task.space);
      }

      // 이전 루틴에 있던 공간이 현재 루틴에 없으면 삭제로 판단
      for (const space of prevSpaces) {
        if (!currentSpaces.has(space)) {
          spaceDeleteCount[space] = (spaceDeleteCount[space] || 0) + 1;
        }
      }

      // 전체 루틴 시간 변화 추적 (personality.type 재평가용)
      const currentMinutes = (current.weeklyRoutine || [])
        .flatMap(d => d.tasks || [])
        .reduce((sum, t) => sum + (t.estimatedMinutes || 0), 0);
      const prevMinutes = (prev.weeklyRoutine || [])
        .flatMap(d => d.tasks || [])
        .reduce((sum, t) => sum + (t.estimatedMinutes || 0), 0);

      if (currentMinutes < prevMinutes) totalShrinkCount++;
      else if (currentMinutes > prevMinutes) totalGrowCount++;
    }

    const currentTroubleSpots = profile.home?.troubleSpots || [];
    const updatedTroubleSpots = [...currentTroubleSpots];
    let updated = false;
    const profileUpdates = {};

    // 3회 연속 삭제된 공간을 troubleSpots에서 제거
    for (const [space, count] of Object.entries(spaceDeleteCount)) {
      if (count >= 3) {
        const idx = updatedTroubleSpots.indexOf(space);
        if (idx !== -1) {
          updatedTroubleSpots.splice(idx, 1);
          updated = true;
        }
      }
    }

    // personality.type 재평가
    // 3회 모두 줄였으면 → procrastinator 성향 강화
    // 3회 모두 늘렸으면 → maintainer 성향으로 재평가
    if (totalShrinkCount >= 2) {
      profileUpdates['personality.type'] = 'procrastinator';
      updated = true;
    } else if (totalGrowCount >= 2) {
      profileUpdates['personality.type'] = 'maintainer';
      updated = true;
    }

    if (updated) {
      await profileRef.update({
        'home.troubleSpots': updatedTroubleSpots,
        ...profileUpdates,
        updatedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('[behaviorPatternAnalyzer] analyzeRoutineEditPattern 실패:', err.message);
  }
}

module.exports = { analyzeSkipPattern, analyzeCompletionPattern, analyzeRoutineEditPattern };
