/**
 * Firestore 컬렉션: users/{uid}
 *
 * 이 파일은 실제 DB 스키마를 문서화하고
 * 신규 사용자 기본 프로파일을 생성하는 팩토리 함수를 제공한다.
 */

/**
 * 온보딩 응답으로 초기 프로파일 생성
 * cleaningType은 classifyCleaningType으로 자동 분류된 값을 전달받음
 *
 * @param {string} uid          - Firebase Auth UID
 * @param {object} answers      - 온보딩 설문 응답
 * @param {string} cleaningType - 분류된 청소 유형
 * @returns {object} Firestore에 저장할 초기 사용자 프로파일
 */
function createInitialProfile(uid, email, answers, cleaningType) {
  return {
    uid,
    email,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),

    // --- 성향 모델 ---
    personality: {
      type: cleaningType,
      availableMinutes: getDefaultMinutes(cleaningType),
      preferredTime: null,             // 행동 로그에서 자동 학습
      motivationStyle: null,           // 행동 로그에서 자동 학습
      notificationResponseRate: 1.0,   // 알림 반응률 (0~1)
    },

    // --- 집 정보 ---
    home: {
      houseType: answers.houseType,
      roomType: answers.roomType,
      hasPet: answers.hasPet,
      petType: answers.petType,
      cookingFrequency: answers.cookingFrequency,
      troubleSpots: mapDifficultiesToSpots(answers.difficulties),
      // 챗봇 대화에서 AI가 새로운 사실을 발견할 때마다 자동으로 추가되는 필드
      // 저장 형식: { key: { value: "내용", addedAt: "ISO 날짜" } }
      // 예) no_vacuum: { value: "청소기 없음 빗자루만 보유", addedAt: "..." }
      customFacts: {},
    },

    // --- 공간별 청결 상태 (집 구조에 따라 동적 생성) ---
    spaceStatus: getDefaultSpaceStatus(answers.roomType),

    // --- 행동 통계 ---
    behaviorStats: {
      totalChecklistCompleted: 0,
      totalChecklistSkipped: 0,
      currentStreak: 0,          // 연속 달성 일수
      longestStreak: 0,
      skipPatterns: {},           // { 'bathroom': 3 } 공간별 건너뛴 횟수
      completionByHour: {},       // { '22': 5 } 시간대별 완료 횟수 (선호 시간 추론용)
    },

    // --- 지식 맵: 챗봇 대화에서 학습된 청소 관련 지식 ---
    // 상태: 'unknown' | 'known' | 'misconception' | 'corrected'
    knowledgeMap: {},

    // --- stale 플래그: 오래된 정보 재확인 요청용 ---
    staleFlags: [],

    // --- 현재 활성 루틴 ID ---
    activeRoutineId: null,

    // --- FCM 푸시 토큰 ---
    fcmToken: null,

    // --- 오늘의 코멘트 ---
    todayComment: null,

    // --- 온보딩 완료 여부 ---
    isOnboarded: true,
  };
}

// 유형별 기본 가능 시간 (분)
function getDefaultMinutes(type) {
  const defaults = {
    binge: 15,
    busy: 10,
    perfectionist: 20,
    passive: 5,
    maintainer: 20,
  };
  return defaults[type] || 15;
}

// 집 구조별 공간 목록 기본값
function getDefaultSpaceStatus(roomType) {
  const base = {
    bathroom: { score: 50, lastCleanedAt: null, cleanCount: 0 },
    kitchen: { score: 50, lastCleanedAt: null, cleanCount: 0 },
  };
  // 원룸이 아닌 경우 침실과 거실 공간 추가
  if (roomType !== 'oneroom') {
    base.bedroom = { score: 50, lastCleanedAt: null, cleanCount: 0 };
    base.livingroom = { score: 50, lastCleanedAt: null, cleanCount: 0 };
  }
  return base;
}

// difficulties 배열을 troubleSpots 배열로 매핑
function mapDifficultiesToSpots(difficulties) {
  const spots = [];
  // 방법을 모르는 어려움이면 기본 공간(화장실, 주방)을 문제 공간으로 지정
  if (difficulties.includes('no_method')) {
    spots.push('bathroom', 'kitchen');
  }
  return spots;
}

module.exports = { createInitialProfile };
