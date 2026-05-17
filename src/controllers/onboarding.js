const { db } = require('../services/firebase');
const { createInitialProfile } = require('../models/userProfile');
const { generateAiRecommendations } = require('../services/routineAI');

/**
 * POST /api/onboarding/submit
 * 온보딩 설문 완료 처리:
 * 1. 청소 유형 자동 분류 (Claude 호출 없이 순수 코드 로직)
 * 2. 프로파일 생성 및 저장
 * 3. 성향 결과 반환 (루틴은 사용자가 routine-add에서 직접 선택)
 *
 * Request Body:
 * {
 *   houseType: "solo" | "family" | "shared" | "dorm",
 *   roomType: "oneroom" | "multiroom" | "officetel" | "other",
 *   hasPet: boolean,
 *   petType: "dog" | "cat" | "other" | null,
 *   cookingFrequency: "rarely" | "sometimes" | "often" | "daily",
 *   cleaningFrequency: 1 | 2 | 3 | 4,
 *   cleaningStyle: 1 | 2,
 *   procrastination: 1 | 2 | 3 | 4,
 *   difficulties: string[]
 * }
 */
async function submitOnboarding(req, res, next) {
  try {
    const uid = req.user.uid;
    const answers = req.body;

    // 기존 프로파일 조회
    const existing = await db.collection('users').doc(uid).get();

    // 이미 온보딩이 완료된 경우 409 반환
    if (existing.exists && existing.data()?.isOnboarded) {
      return res.status(409).json({ error: '이미 온보딩이 완료되었습니다.' });
    }

    // 청소 유형 분류 후 전체 프로파일 저장
    const cleaningType = classifyCleaningType(
      answers.cleaningFrequency,
      answers.cleaningStyle,
      answers.procrastination
    );
    const profile = createInitialProfile(uid, req.user.email ?? '', answers, cleaningType);
    await db.collection('users').doc(uid).set(profile);
    console.log(`[온보딩] uid=${uid} 프로파일 저장 완료 (type=${cleaningType})`);

    // 온보딩 데이터 기반 AI 맞춤 추천 즉시 생성 (forceCustom=true: 온보딩 정보로 맞춤 루틴 포함)
    // 실패해도 온보딩 자체는 완료 처리
    await generateAiRecommendations(uid, null, true).catch(err =>
      console.error('[온보딩] AI 추천 생성 실패:', err.message)
    );

    // 성향 진단 결과
    const personalityResult = getPersonalityResult(cleaningType);

    res.status(201).json({
      success: true,
      isOnboarded: true,
      personality: personalityResult,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * 청소 유형 분류 로직
 * cleaningFrequency, cleaningStyle, procrastination 세 값으로 분류
 *
 * @param {number} cleaningFrequency - 청소 빈도 (1:거의안함 ~ 4:거의매일)
 * @param {number} cleaningStyle     - 청소 방식 (1:몰아서, 2:매일조금씩)
 * @param {number} procrastination   - 미루는 정도 (1:거의안미룸 ~ 4:많이미룸)
 * @returns {string} 청소 유형
 */
function classifyCleaningType(cleaningFrequency, cleaningStyle, procrastination) {
  // 생활형 (maintainer): 자주 청소 + 거의 안 미룸
  if (cleaningFrequency >= 3 && procrastination === 1) {
    return 'maintainer';
  }

  // 꼼꼼형 (perfectionist): 자주 청소 + 조금씩 + 가끔 미룸
  if (cleaningFrequency >= 3 && cleaningStyle === 2 && procrastination <= 2) {
    return 'perfectionist';
  }

  // 틈새형 (busy): 매일 조금씩 + 가끔 미룸
  if (cleaningStyle === 2 && procrastination === 2) {
    return 'busy';
  }

  // 방관형 (passive): 거의 안 함 + 많이 미룸
  if (cleaningFrequency <= 1 && procrastination >= 4) {
    return 'passive';
  }

  // 폭발형 (binge): 나머지 (몰아서 + 미루는 경향)
  return 'binge';
}

function getPersonalityResult(type) {
  const results = {
    binge: {
      title: '몰아서 해결형 🌋',
      description: '평소에는 미루다가 한 번에 몰아서 청소하는 타입이에요.',
      recommendation: '짧고 쉬운 루틴으로 시작해서 부담을 줄이는 게 핵심이에요.',
      tips: ['한 번에 한 공간만 집중', '5분짜리 미니 루틴부터 시작', '알림 기능 적극 활용'],
    },
    busy: {
      title: '틈새 청소형 ⚡',
      description: '바쁜 와중에도 틈틈이 조금씩 하려고 노력하는 타입이에요.',
      recommendation: '생활 패턴에 맞춘 유연한 루틴이 잘 맞아요.',
      tips: ['시간대별 맞춤 루틴', '2~3분짜리 초단기 루틴 활용', '출근 전/후 루틴 분리'],
    },
    perfectionist: {
      title: '꼼꼼 관리형 🎯',
      description: '자주 청소하지만 방법을 몰라 아쉬운 타입이에요.',
      recommendation: '공간별 청소 가이드와 체계적인 루틴이 도움 돼요.',
      tips: ['공간별 상세 가이드 참고', '놓치기 쉬운 포인트 체크', '월간 대청소 루틴 추가'],
    },
    passive: {
      title: '느긋한 자유형 😑',
      description: '청소를 많이 미루는 편이지만 괜찮아요. 작은 것부터 시작하면 돼요.',
      recommendation: '아주 짧고 쉬운 루틴으로 습관을 만드는 게 먼저예요.',
      tips: ['3분 이내 초간단 루틴', '하루 1개만 완료해도 성공', '뱃지로 작은 성취감 쌓기'],
    },
    maintainer: {
      title: '생활 습관형 🏠',
      description: '이미 청소 습관이 잘 잡혀 있는 타입이에요.',
      recommendation: '효율 최적화와 놓치기 쉬운 공간 관리에 집중해보세요.',
      tips: ['놓치기 쉬운 공간 알림', '월간 대청소 스케줄', '새로운 청소 팁 습득'],
    },
  };

  return results[type] || results.binge;
}

module.exports = { submitOnboarding };
