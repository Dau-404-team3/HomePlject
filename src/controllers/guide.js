const { getTaskGuide } = require('../services/knowledgeRetriever');

const CLEANING_GUIDES = {
  bathroom: {
    title: '욕실 청소 가이드',
    steps: [
      { order: 1, action: '환기 먼저 — 창문 또는 환풍기를 켜세요.', tip: '화학 세제 사용 전 필수' },
      { order: 2, action: '변기에 락스를 뿌리고 10분 대기', tip: '락스는 반드시 단독 사용' },
      { order: 3, action: '세면대·샤워기·수도꼭지 물때 제거', tip: '산성 세제(구연산) 사용' },
      { order: 4, action: '바닥 솔질 후 물로 헹굼', tip: '장갑 착용 권장' },
      { order: 5, action: '변기 안쪽 솔질 후 물 내림', tip: '' },
    ],
    estimatedMinutes: 20,
    supplies: ['락스', '욕실 세제', '솔', '장갑', '구연산 스프레이'],
    warnings: ['락스와 다른 세제 절대 혼합 금지', '반드시 환기'],
  },
  kitchen: {
    title: '주방 청소 가이드',
    steps: [
      { order: 1, action: '가스레인지·인덕션 주변 기름때 제거', tip: '베이킹소다 + 주방세제' },
      { order: 2, action: '싱크대 배수구 세척', tip: '뜨거운 물 + 베이킹소다' },
      { order: 3, action: '냉장고 외부 닦기', tip: '중성세제 사용' },
      { order: 4, action: '환풍기 필터 점검', tip: '월 1회 권장' },
      { order: 5, action: '식탁·조리대 소독', tip: '알코올 스프레이 사용' },
    ],
    estimatedMinutes: 25,
    supplies: ['주방세제', '베이킹소다', '알코올 스프레이', '수세미', '장갑'],
    warnings: ['기름때 제거 시 장갑 착용', '환풍기 켜기'],
  },
  bedroom: {
    title: '침실 청소 가이드',
    steps: [
      { order: 1, action: '침구류 털고 환기', tip: '창문 열어 15분 이상 환기' },
      { order: 2, action: '먼지 위→아래 순서로 제거', tip: '천장→가구→바닥 순' },
      { order: 3, action: '침대 매트리스 진공청소기', tip: '월 1회 권장' },
      { order: 4, action: '바닥 청소기 후 물걸레', tip: '원목 바닥은 물 최소화' },
    ],
    estimatedMinutes: 15,
    supplies: ['청소기', '물걸레', '먼지떨이'],
    warnings: ['원목 바닥에 물 과다 사용 금지'],
  },
  livingroom: {
    title: '거실 청소 가이드',
    steps: [
      { order: 1, action: '소파·쿠션 먼지 제거', tip: '청소기 브러시 노즐 사용' },
      { order: 2, action: 'TV·전자기기 먼지 닦기', tip: '정전기 방지 천 사용' },
      { order: 3, action: '창문·창틀 닦기', tip: '신문지로 유리 닦으면 얼룩 방지' },
      { order: 4, action: '바닥 청소기 후 물걸레', tip: '' },
    ],
    estimatedMinutes: 20,
    supplies: ['청소기', '물걸레', '유리세제', '극세사 천'],
    warnings: [],
  },
  toilet: {
    title: '화장실(변기) 집중 청소 가이드',
    steps: [
      { order: 1, action: '환기 먼저', tip: '필수' },
      { order: 2, action: '변기 시트·뚜껑 닦기', tip: '소독 티슈 또는 알코올 스프레이' },
      { order: 3, action: '변기 안쪽 락스 도포 후 5분 대기', tip: '락스 단독 사용' },
      { order: 4, action: '솔로 안쪽 닦은 후 물 내림', tip: '' },
    ],
    estimatedMinutes: 10,
    supplies: ['락스', '변기 솔', '소독 티슈', '장갑'],
    warnings: ['락스 단독 사용', '환기 필수'],
  },
};

/**
 * GET /api/guide
 * 전체 가이드 목록 (요약) 반환
 */
async function getAllGuides(_req, res, next) {
  try {
    const summary = Object.entries(CLEANING_GUIDES).map(([space, guide]) => ({
      space,
      title: guide.title,
      estimatedMinutes: guide.estimatedMinutes,
    }));
    res.json(summary);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/guide/:space
 * 특정 공간 청소 가이드 반환
 */
async function getGuide(req, res, next) {
  try {
    const { space } = req.params;
    if (!CLEANING_GUIDES[space]) {
      return res.status(404).json({
        error: `'${space}' 공간의 가이드가 없습니다.`,
        availableSpaces: Object.keys(CLEANING_GUIDES),
      });
    }
    res.json(CLEANING_GUIDES[space]);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/guide/task?taskName=쓰레기통 비우기&space=kitchen
 * knowledgeBase RAG 검색 → 없으면 Claude 폴백
 */
async function getTaskGuideHandler(req, res, next) {
  try {
    const { taskName, space = 'general' } = req.query;

    if (!taskName) {
      return res.status(400).json({ error: 'taskName 파라미터가 필요합니다.' });
    }

    const result = await getTaskGuide(taskName, space);

    // 다른 API 엔드포인트와 일관성 유지 — 래퍼 없이 TaskGuide 직접 반환
    res.json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = { getAllGuides, getGuide, getTaskGuideHandler };
