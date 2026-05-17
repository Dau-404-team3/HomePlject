const { db } = require('./firebase');

const AI_API_URL = process.env.AI_API_URL;
const AI_API_KEY = process.env.AI_API_KEY;

async function getProfile(uid) {
  const doc = await db.collection('users').doc(uid).get();
  if (!doc.exists) throw new Error('User profile not found');
  return doc.data();
}

// ── AI 맞춤 추천 생성 ─────────────────────────────────────

// 루틴 제목을 6자리 36진수 해시로 변환 — gen- ID의 안정성 확보
function hashTitle(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 6);
}

const SPACE_LABELS = {
  living: '거실',
  kitchen: '주방',
  closet: '옷장',
  bathroom: '화장실',
  laundry: '세탁',
};

// ── 온보딩 설문 기반 맞춤 보장 루틴 생성 ────────────────────────
// AI 생성 결과가 없거나 실패했을 때 반드시 호출. 성향 타입 + 반려동물 + 요리빈도 +
// 거주형태 등 온보딩 8개 항목을 모두 반영해 신규 유저도 맞춤 루틴을 즉시 표시한다.
function buildPersonalityFallback(profile) {
  const type = profile?.personality?.type || 'binge';
  const home = profile?.home || {};
  const { hasPet, petType, houseType, cookingFrequency } = home;

  const isDog     = hasPet && petType === 'dog';
  const isCat     = hasPet && petType === 'cat';
  const cookingHeavy = cookingFrequency === 'daily' || cookingFrequency === 'often';
  const isFamily  = houseType === 'family';

  // 성향별 분 범위 [짧음, 중간, 김]
  const [ms, mm, ml] = {
    binge:        [8, 12, 15],
    busy:         [2,  3,  5],
    perfectionist:[5, 10, 15],
    passive:      [1,  2,  3],
    maintainer:   [3,  7, 10],
  }[type] || [5, 10, 15];

  const suf = {
    binge: '몰아서해결형', busy: '틈새청소형', perfectionist: '꼼꼼관리형',
    passive: '느긋한자유형', maintainer: '생활습관형',
  }[type] || '맞춤형';

  const r = (title, minutes, basis) => ({
    title, minutes: Math.max(1, Math.min(15, minutes)), basis,
  });

  // ── 화장실 ──────────────────────────────────────────────────
  const bathroomRows = {
    binge:        [r('변기·세면대·욕조 한 번에 닦기', ml, suf), r('욕실 바닥·벽 한꺼번에 청소', mm, suf)],
    busy:         [r('세면대 2분 빠른 닦기', ms, suf), r('변기 브러시로 빠르게 닦기', ms + 1, suf)],
    perfectionist:[r('욕실 구석구석 꼼꼼히 닦기', ml, suf), r('거울·수납장 틈새 청소', ms, suf)],
    passive:      [r('세면대 30초 간단 닦기', 1, suf), r('변기 빠르게 한 번 닦기', ms + 1, suf)],
    maintainer:   [r('욕실 환기팬 먼지 제거', ms, suf), r('배수구 머리카락 제거', ms, suf)],
  }[type] || [];
  const bathroom = [...bathroomRows];
  if (isCat) bathroom.push(r('고양이 화장실 모래 교체·청소', Math.min(ms + 2, 5), '반려묘 위생'));

  // ── 주방 ────────────────────────────────────────────────────
  const kitchen = cookingHeavy
    ? ({
        binge:        [r('가스레인지·싱크대·후드 한 번에 청소', ml, '요리빈도·' + suf), r('냄비·프라이팬 한꺼번에 세척', mm, '요리빈도·' + suf)],
        busy:         [r('요리 후 가스레인지 바로 닦기', ms + 1, '요리빈도·' + suf), r('식사 후 바로 싱크대 닦기', ms, '요리빈도·' + suf)],
        perfectionist:[r('가스레인지 틈새 기름때 꼼꼼히 제거', mm, '요리빈도·' + suf), r('주방 후드 필터 청소', mm, '요리빈도·' + suf), r('냉장고 외관·손잡이 닦기', ms, '요리빈도·' + suf)],
        passive:      [r('가스레인지 눈에 보이는 오염 닦기', ms + 1, '요리빈도·' + suf), r('설거지 후 주변 물기 닦기', ms, '요리빈도·' + suf)],
        maintainer:   [r('냉장고 정리·유통기한 확인', mm, '요리빈도·' + suf), r('주방 후드 필터 주기적 청소', mm, '요리빈도·' + suf)],
      }[type] || [])
    : ({
        binge:        [r('주방 싱크대·가스레인지 동시 닦기', mm, suf), r('냄비·프라이팬 한꺼번에 세척', mm, suf)],
        busy:         [r('식사 후 바로 싱크대 닦기', ms, suf), r('가스레인지 쓴 뒤 바로 닦기', ms + 1, suf)],
        perfectionist:[r('주방 타일 기름때 꼼꼼히 제거', mm, suf), r('냉장고 손잡이·외관 닦기', ms, suf)],
        passive:      [r('설거지 후 주변 물기 닦기', ms + 1, suf)],
        maintainer:   [r('냉장고 정리·유통기한 확인', mm, suf), r('주방 후드 필터 닦기', mm, suf)],
      }[type] || []);

  // ── 거실 ────────────────────────────────────────────────────
  const living = isDog
    ? ({
        binge:        [r('강아지 털 청소기로 거실 한 번에 청소', ml, '반려견·' + suf), r('소파·쿠션 롤러로 털 제거', mm, '반려견·' + suf)],
        busy:         [r('소파 롤러로 강아지 털 빠르게 제거', ms + 1, '반려견·' + suf), r('거실 바닥 빠르게 쓸기', ms, suf)],
        perfectionist:[r('강아지 털 구석구석 청소기 흡입', ml, '반려견·' + suf), r('창문틀·블라인드 먼지 닦기', mm, suf)],
        passive:      [r('강아지 털 눈에 보이는 것만 줍기', ms + 1, '반려견·' + suf), r('소파 주변 간단 정리', ms + 2, suf)],
        maintainer:   [r('강아지 털 주기적 청소기 루틴 실행', mm, '반려견·' + suf), r('커튼·블라인드 먼지 털기', ms, suf)],
      }[type] || [])
    : isCat
    ? ({
        binge:        [r('고양이 털 롤러로 소파·침구 한 번에 청소', mm, '반려묘·' + suf), r('캣타워 주변 먼지·털 청소', mm, '반려묘·' + suf)],
        busy:         [r('고양이 털 롤러로 소파 빠르게 제거', ms + 1, '반려묘·' + suf), r('거실 바닥 빠르게 쓸기', ms, suf)],
        perfectionist:[r('고양이 털·비듬 꼼꼼히 제거', mm, '반려묘·' + suf), r('캣타워 주변 구석구석 청소', mm, '반려묘·' + suf)],
        passive:      [r('소파 위 고양이 털 간단히 털기', ms + 1, '반려묘·' + suf), r('눈에 보이는 쓰레기 줍기', 1, suf)],
        maintainer:   [r('캣타워 주변·소파 주기적 털 청소', mm, '반려묘·' + suf), r('스위치·콘센트 주변 닦기', ms, suf)],
      }[type] || [])
    : isFamily
    ? ({
        binge:        [r('거실 바닥 한 번에 쓸고 닦기', ml, '가족가구·' + suf), r('소파·쿠션 한꺼번에 정리', mm, suf)],
        busy:         [r('거실 바닥 빠르게 쓸기', ms, suf), r('테이블 위 빠르게 정리', ms, suf)],
        perfectionist:[r('창문틀·블라인드 먼지 꼼꼼히 닦기', mm, suf), r('가구 밑 먼지 제거', mm, suf)],
        passive:      [r('눈에 보이는 쓰레기 줍기', 1, suf), r('소파 주변 간단 정리', ms + 2, suf)],
        maintainer:   [r('커튼·블라인드 먼지 털기', ms, suf), r('스위치·콘센트 주변 닦기', ms, suf)],
      }[type] || [])
    : ({
        binge:        [r('거실 바닥 한 번에 쓸고 닦기', mm, suf), r('소파·쿠션 한꺼번에 정리', ms, suf)],
        busy:         [r('거실 바닥 빠르게 쓸기', ms, suf), r('테이블 위 빠르게 정리', ms, suf)],
        perfectionist:[r('창문틀 먼지 꼼꼼히 닦기', mm, suf), r('가구 밑 먼지 제거', mm, suf)],
        passive:      [r('눈에 보이는 쓰레기 줍기', 1, suf), r('소파 주변 간단 정리', ms + 1, suf)],
        maintainer:   [r('커튼·블라인드 먼지 털기', ms, suf), r('스위치·콘센트 주변 닦기', ms, suf)],
      }[type] || []);

  // ── 옷장 ────────────────────────────────────────────────────
  const closetBase = {
    binge:        [r('옷장 전체 한 번에 정리 정돈', ml, suf), r('안 입는 옷 정리·정돈', mm, suf)],
    busy:         [r('입은 옷 바로 제자리에 걸기', ms, suf)],
    perfectionist:[r('옷장 내부 선반 먼지 닦기', mm, suf), r('계절 옷 분류 수납', ml, suf)],
    passive:      [r('입은 옷 제자리에 걸기', ms + 1, suf)],
    maintainer:   [r('계절 옷 정리 및 수납', ml, suf), r('옷장 내부 습기·냄새 관리', ms, suf)],
  }[type] || [];
  const closet = [...closetBase];
  if (isFamily && closet.length < 3) closet.push(r('가족 의류 계절별 정리 수납', ml, '가족가구·' + suf));

  // ── 세탁 ────────────────────────────────────────────────────
  const laundryBase = {
    binge:        [r('빨래 모아서 한 번에 돌리기', ms, suf)],
    busy:         [r('빨래 바구니 확인 후 세탁기 돌리기', ms + 1, suf)],
    perfectionist:[r('세탁기 내부·고무패킹 청소', ms, suf), r('세탁물 종류별 분류 세탁', ms + 2, suf)],
    passive:      [r('세탁물 빨래 바구니에 넣기', 1, suf)],
    maintainer:   [r('세탁기 청소 주기 체크 및 통세척', ms, suf), r('세탁물 주기적 분류·정리', ms, suf)],
  }[type] || [];
  const laundry = [...laundryBase];
  if (isDog) laundry.push(r('강아지 담요·방석 세탁기 돌리기', Math.min(ms + 2, 5), '반려견 위생'));
  else if (isCat) laundry.push(r('고양이 털 묻은 옷 세탁기 돌리기', Math.min(ms + 2, 5), '반려묘 위생'));

  // ── ID 매핑 후 반환 ─────────────────────────────────────────
  const raw = { bathroom, kitchen, living, closet, laundry };
  const result = {};
  for (const [space, items] of Object.entries(raw)) {
    const valid = items.filter(item => item?.title);
    if (valid.length > 0) {
      result[space] = valid.slice(0, 3).map(item => ({
        id: `gen-${space}-${hashTitle(item.title)}`,
        title: item.title,
        minutes: item.minutes,
        basis: item.basis,
      }));
    }
  }
  return result;
}

// ── DB 기반 카탈로그 로더 ────────────────────────────────────
// knowledgeBase (ai_generated==false) 에서 카탈로그를 동적으로 로드한다.
// 5분 TTL 캐시로 매 요청마다 DB 호출을 방지한다.
let _catalogueCache = null;
let _catalogueCachedAt = 0;
const CATALOGUE_TTL_MS = 5 * 60 * 1000;

async function loadRoutineCatalogue() {
  const now = Date.now();
  if (_catalogueCache && now - _catalogueCachedAt < CATALOGUE_TTL_MS) {
    return _catalogueCache;
  }

  const snap = await db.collection('knowledgeBase')
    .where('ai_generated', '==', false)
    .get();

  const catalogue = {};
  for (const doc of snap.docs) {
    const { taskName, space, estimatedMinutes, tip } = doc.data();
    if (!taskName || !space) continue;
    const appSpace = SPACE_LABELS[space] ? space : null;
    if (!appSpace) continue;
    if (!catalogue[appSpace]) catalogue[appSpace] = [];
    // ID: space-hash(taskName) 형태로 안정적으로 생성
    catalogue[appSpace].push({
      id: `${appSpace}-${hashTitle(taskName)}`,
      title: taskName,
      minutes: estimatedMinutes ?? 10,
      tip: tip || '',
    });
  }

  _catalogueCache = catalogue;
  _catalogueCachedAt = now;
  return catalogue;
}

// 카탈로그 캐시를 강제로 무효화 (시드/마이그레이션 후 호출용)
function invalidateCatalogueCache() {
  _catalogueCache = null;
  _catalogueCachedAt = 0;
}


/**
 * customFacts, knowledgeMap, behaviorStats 등을 바탕으로
 * knowledgeBase DB에 없는 사용자 맞춤 루틴을 AI가 자유 생성한다.
 * 실패 시 빈 객체({})를 반환해 호출부가 안전하게 폴백할 수 있도록 한다.
 */
async function generateCustomRoutines(profile) {
  const { personality, behaviorStats, spaceStatus, home, knowledgeMap, consecutiveSkips } = profile;

  const customFactsText = Object.entries(home?.customFacts || {})
    .map(([, v]) => `- ${v.value}`)
    .join('\n') || '없음';

  const knowledgeGaps = Object.entries(knowledgeMap || {})
    .filter(([, v]) => v === 'unknown' || v === 'misconception')
    .map(([k]) => k)
    .join(', ') || '없음';

  const skipSummary = Object.entries(behaviorStats?.skipPatterns || {})
    .map(([space, count]) => `${space} ${count}회`)
    .join(', ') || '없음';

  const lowScoreSpaces = Object.entries(spaceStatus || {})
    .filter(([space, v]) => v.score < 40 || (consecutiveSkips?.[space] || 0) >= 2)
    .map(([k]) => k)
    .join(', ') || '없음';

  const troubleSpotsText = (home?.troubleSpots || []).join(', ') || '없음';
  const houseContext = [
    home?.houseType === 'solo' ? '1인 가구' :
    home?.houseType === 'family' ? '가족 가구' :
    home?.houseType === 'shared' ? '쉐어하우스' :
    home?.houseType === 'dorm' ? '기숙사' : '',
    home?.roomType === 'oneroom' ? '원룸' :
    home?.roomType === 'multiroom' ? '다방 구조' :
    home?.roomType === 'officetel' ? '오피스텔' : '',
  ].filter(Boolean).join(', ') || '미파악';

  const personalityGuide = {
    binge:       '한 번에 몰아서 청소하는 성향 → 짧은 시간 안에 끝낼 수 있는 집중 루틴',
    busy:        '바쁜 일상 속 틈새 청소 성향 → 2~3분짜리 초단기 루틴',
    perfectionist: '꼼꼼하게 관리하는 성향 → 놓치기 쉬운 세부 포인트 청소 루틴',
    passive:     '청소를 자주 미루는 성향 → 아주 짧고 쉬운 입문 루틴',
    maintainer:  '이미 청소 습관이 잡힌 성향 → 효율을 높이는 심화 루틴',
  }[personality?.type] || '생활 패턴에 맞는 루틴';

  const prompt = `사용자 맞춤 청소 루틴 생성 요청입니다.

사용자 정보:
- 청소 성향: ${personality?.type || '미파악'} (${personalityGuide})
- 하루 가능 시간: ${personality?.availableMinutes || 15}분
- 거주 형태: ${houseContext}
- 반려동물: ${home?.hasPet ? `있음 (${home.petType || '종류 미파악'})` : '없음'}
- 요리 빈도: ${home?.cookingFrequency || '미파악'}
- 청소가 어려운 공간: ${troubleSpotsText}
- 챗봇 대화에서 학습된 개인 정보:
${customFactsText}
- 청소 지식 격차 (모르거나 잘못 알고 있는 항목): ${knowledgeGaps}
- 자주 건너뛰는 공간: ${skipSummary}
- 청결 점수 낮은 공간: ${lowScoreSpaces}

위 사용자를 위한 청소 루틴을 공간별로 2~3개씩 생성해주세요.

조건:
1. 【필수】 데이터가 적더라도 반드시 공간마다 2~3개씩 생성하세요. 빈 배열 반환은 절대 금지입니다.
2. 청소 성향을 가장 중요한 기준으로 삼으세요. 성향 가이드: ${personalityGuide}
3. 반려동물·거주 형태·요리 빈도 등 온보딩 정보를 루틴에 반영하세요
4. 챗봇 정보(customFacts)가 있으면 최우선으로 반영하세요 (예: 청소기 없음 → 빗자루 활용 루틴)
5. 소요 시간은 1~15분 사이로 현실적이어야 합니다
6. 한국어 행동 지시문 형태로 작성하세요 (예: "세면대 주변 물기 닦기")
7. basis 필드에 추천 근거를 15자 이내로 적어주세요

반드시 다음 JSON 형식으로만 응답하세요:
{
  "living": [{"title": "거실 바닥 빠르게 쓸기", "minutes": 3, "basis": "몰아서해결형"}],
  "kitchen": [...],
  "closet": [...],
  "bathroom": [...],
  "laundry": [...]
}
각 공간에 2~3개씩. JSON 외 다른 텍스트는 절대 출력하지 마세요.`;

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
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      console.warn(`[routineAI] 생성형 루틴 API 오류: ${response.status} — 온보딩 폴백 사용`);
      return buildPersonalityFallback(profile);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text;
    if (!text) {
      console.warn('[routineAI] 맞춤 루틴: 응답 텍스트 없음 — 온보딩 폴백 사용');
      return buildPersonalityFallback(profile);
    }

    // Claude가 JSON 앞뒤에 설명 텍스트를 붙이는 경우를 대응해 regex로 JSON 객체만 추출
    const stripped = text.replace(/```json|```/g, '').trim();
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[routineAI] 맞춤 루틴: JSON 추출 실패 — 온보딩 폴백 사용. raw:', stripped.slice(0, 200));
      return buildPersonalityFallback(profile);
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn('[routineAI] 맞춤 루틴: JSON 파싱 실패 — 온보딩 폴백 사용:', e.message);
      return buildPersonalityFallback(profile);
    }

    const result = {};
    for (const [space, items] of Object.entries(parsed)) {
      if (!Array.isArray(items)) continue;
      result[space] = items
        .filter(item => typeof item.title === 'string' && item.title.trim())
        .slice(0, 3)
        .map(item => ({
          id: `gen-${space}-${hashTitle(item.title)}`,
          title: item.title.trim(),
          minutes: Math.min(Math.max(1, Math.round(item.minutes || 5)), 15),
          basis: (item.basis || '').slice(0, 20),
        }));
    }

    // AI 결과가 비어있는 공간은 온보딩 기반 보장 루틴으로 채운다.
    const fallbackResult = buildPersonalityFallback(profile);
    for (const space of Object.keys(SPACE_LABELS)) {
      if (!result[space] || result[space].length === 0) {
        if (fallbackResult[space]?.length > 0) result[space] = fallbackResult[space];
      }
    }

    const filled = Object.keys(result).filter(k => result[k].length > 0);
    console.log(`[routineAI] 맞춤 루틴 생성 완료: ${filled.join(', ')} (${filled.length}개 공간)`);
    return result;
  } catch (e) {
    console.warn('[routineAI] 맞춤 루틴 AI 오류, 온보딩 폴백 사용:', e.message);
    return buildPersonalityFallback(profile);
  }
}

/**
 * 이전 추천과 새 추천을 비교해 변경 내용을 한국어 문자열로 반환한다.
 * 푸시 알림 body에 사용된다.
 */
/**
 * 이전 추천과 새 추천을 비교해 변경 내용을 반환한다.
 * - body: 푸시 알림용 전체 요약 문자열 (triggerSpaceKey가 있으면 해당 공간 변경사항 우선)
 * - spaceChanges: 공간별 카드 표시용 짧은 문자열 { living: "'소파 쿠션 정리' 추가됨", ... }
 */
/**
 * 카탈로그 추천 변경 + 생성형 루틴 변경을 합산해 변경 내역을 반환한다.
 * - body: 푸시 알림 / 팝업용 전체 요약 문자열
 * - spaceChanges: 공간 카드별 짧은 변경 문자열 { living: "'소파 쿠션 정리' 추가됨", ... }
 */
function buildChangeBody(newRecs, previousRecs, newGenerated, previousGenerated, triggerSpaceKey = null, catalogue = {}) {
  const idToTitle = {};
  for (const items of Object.values(catalogue)) {
    for (const item of items) idToTitle[item.id] = item.title;
  }

  const isFirstTime =
    Object.keys(previousRecs).length === 0 && Object.keys(previousGenerated).length === 0;
  const spaceChanges = {};
  const allSpaces = new Set([...Object.keys(newRecs), ...Object.keys(newGenerated)]);

  if (isFirstTime) {
    for (const space of allSpaces) {
      const parts = [];
      const catTitles = (newRecs[space] || []).map(id => idToTitle[id]).filter(Boolean);
      if (catTitles.length) parts.push(...catTitles.slice(0, 2).map(t => `'${t}'`));
      const genTitles = (newGenerated[space] || []).map(g => g.title).filter(Boolean);
      if (genTitles.length) parts.push(`'${genTitles[0]}'`);
      if (parts.length) spaceChanges[space] = parts.slice(0, 2).join(', ') + ' 등 새 추천';
    }
    const orderedEntries = sortEntriesByTrigger(Object.entries(spaceChanges), triggerSpaceKey);
    const highlights = orderedEntries.slice(0, 2)
      .map(([space, txt]) => `${SPACE_LABELS[space] || space}에 ${txt}`);
    const body = highlights.length
      ? `${highlights.join(', ')} 루틴을 준비했어요!`
      : '생활 패턴에 맞춘 루틴 추천을 준비했어요!';
    return { body, spaceChanges };
  }

  // 재생성: 카탈로그 변경 + 생성형 변경 합산
  const allChangeParts = [];
  for (const space of allSpaces) {
    const changeLines = [];

    // 카탈로그 — 새로 추가된 ID
    const oldCatSet = new Set(previousRecs[space] || []);
    const addedCatTitles = (newRecs[space] || [])
      .filter(id => !oldCatSet.has(id))
      .map(id => idToTitle[id])
      .filter(Boolean);
    if (addedCatTitles.length) changeLines.push(...addedCatTitles.slice(0, 2).map(t => `'${t}'`));

    // 생성형 — 이전에 없던 ID (제목 해시 기반으로 안정적)
    const oldGenIds = new Set((previousGenerated[space] || []).map(g => g.id));
    const addedGenTitles = (newGenerated[space] || [])
      .filter(g => !oldGenIds.has(g.id))
      .map(g => g.title)
      .filter(Boolean);
    if (addedGenTitles.length) changeLines.push(`'${addedGenTitles[0]}'`);

    if (changeLines.length) {
      const titlesStr = changeLines.slice(0, 2).join(', ');
      spaceChanges[space] = `${titlesStr} 루틴이 새로 추가됐어요`;
      allChangeParts.push([space, `${SPACE_LABELS[space] || space}에 ${titlesStr}`]);
    }
  }

  const orderedParts = sortEntriesByTrigger(allChangeParts, triggerSpaceKey).map(([, txt]) => txt);
  if (orderedParts.length) {
    return { body: `${orderedParts.slice(0, 3).join(', ')} 루틴이 추가됐어요!`, spaceChanges };
  }

  // 변경 없음 — 트리거 공간 현재 추천 목록으로 폴백
  if (triggerSpaceKey) {
    const catTitles = (newRecs[triggerSpaceKey] || []).map(id => idToTitle[id]).filter(Boolean);
    const genTitles = (newGenerated[triggerSpaceKey] || []).map(g => g.title).filter(Boolean);
    const allTitles = [...catTitles, ...genTitles].slice(0, 2).map(t => `'${t}'`).join(', ');
    if (allTitles) {
      const label = SPACE_LABELS[triggerSpaceKey] || triggerSpaceKey;
      spaceChanges[triggerSpaceKey] = `현재 ${allTitles} 등 추천 중`;
      return { body: `${label}에 ${allTitles} 루틴을 추천하고 있어요.`, spaceChanges };
    }
  }

  return { body: '생활 패턴을 다시 분석해 맞춤 추천을 확인했어요!', spaceChanges };
}

function sortEntriesByTrigger(entries, triggerSpaceKey) {
  if (!triggerSpaceKey) return entries;
  const trigger = entries.filter(([space]) => space === triggerSpaceKey);
  const rest = entries.filter(([space]) => space !== triggerSpaceKey);
  return [...trigger, ...rest];
}

/**
 * 공간별 AI 맞춤 추천 루틴 ID 목록을 생성하고 Firestore에 저장한다.
 * 홈 화면 활성 루틴(activeRoutineId)에는 전혀 영향을 주지 않는다.
 */
async function generateAiRecommendations(uid, triggerSpaceKey = null, forceCustom = false) {
  if (!AI_API_KEY || !AI_API_URL) {
    throw new Error('AI_API_KEY 또는 AI_API_URL 환경변수가 설정되지 않았습니다.');
  }

  const profile = await getProfile(uid);
  const previousRecommendations = profile.aiRecommendations || {};
  const previousGeneratedRoutines = profile.aiGeneratedRoutines || {};
  const { personality, behaviorStats, spaceStatus, consecutiveSkips } = profile;

  const skipSummary = Object.entries(behaviorStats?.skipPatterns || {})
    .map(([space, count]) => `${space} ${count}회`)
    .join(', ') || '없음';

  const lowScoreSpaces = Object.entries(spaceStatus || {})
    .filter(([space, v]) => v.score < 40 || (consecutiveSkips?.[space] || 0) >= 2)
    .map(([k]) => k)
    .join(', ') || '없음';

  const customFactsText = Object.entries(profile.home?.customFacts || {})
    .map(([, v]) => `- ${v.value}`)
    .join('\n') || '없음';

  // DB에서 카탈로그 동적 로드 (5분 TTL 캐시)
  const catalogue = await loadRoutineCatalogue();

  const nonEmptyEntries = Object.entries(catalogue).filter(([, items]) => items.length > 0);
  const emptySpaces = Object.keys(SPACE_LABELS).filter(s => !catalogue[s]?.length);

  // 태스크명 → ID 역방향 조회 맵 (AI 응답 후 이름→ID 변환용)
  const nameToId = {};
  for (const [, items] of nonEmptyEntries) {
    for (const item of items) nameToId[item.title] = item.id;
  }

  // AI에게는 ID 대신 태스크명만 보여준다 — 해시 ID를 복사하는 과정에서 오류 방지
  // 따옴표 없이 표시해야 AI가 JSON 반환 시 추가 따옴표를 붙이지 않는다
  const catalogueText = nonEmptyEntries.length > 0
    ? nonEmptyEntries
        .map(([space, items]) =>
          `[${space}]\n` + items.map(r => `  - ${r.title} (${r.minutes}분)`).join('\n')
        )
        .join('\n\n')
    : '(카탈로그 없음 — 맞춤 생성 루틴만 사용합니다)';

  const emptySpaceNote = emptySpaces.length > 0
    ? `\n참고: ${emptySpaces.map(s => SPACE_LABELS[s] || s).join(', ')} 공간은 현재 DB에 루틴이 없어 목록에서 제외됩니다.\n`
    : '';

  const triggerNote = triggerSpaceKey
    ? `\n[재조정 트리거]\n이번 재조정은 사용자가 "${SPACE_LABELS[triggerSpaceKey] || triggerSpaceKey}" 공간 루틴을 반복적으로 건너뛰어 발생했습니다.\n→ ${SPACE_LABELS[triggerSpaceKey] || triggerSpaceKey} 루틴을 특히 더 짧고 부담 없는 항목으로 교체하세요.\n`
    : '';

  const prompt = `사용자 프로파일:
- 청소 성향: ${personality?.type || '미파악'}
- 하루 가능 시간: ${personality?.availableMinutes || 15}분
- 선호 청소 시간대: ${personality?.preferredTime || '미파악'}
- 건너뜀 패턴: ${skipSummary}
- 청결 점수 낮은 공간: ${lowScoreSpaces}
- 연속 달성: ${behaviorStats?.currentStreak || 0}일
- 반려동물: ${profile.home?.hasPet ? '있음' : '없음'}
- 요리 빈도: ${profile.home?.cookingFrequency || '미파악'}
- 챗봇 대화에서 학습된 개인 정보:
${customFactsText}
${triggerNote}${emptySpaceNote}
아래 루틴 목록에서 이 사용자에게 가장 적합한 루틴을 공간별로 최대 3개씩 골라주세요.
건너뜀이 잦은 공간은 더 짧고 쉬운 루틴을, 청결 점수가 낮은 공간은 효과적인 루틴을 우선 선택하세요.
하루 가능 시간이 짧으면 소요 시간이 짧은 루틴을 우선 선택하세요.
챗봇 대화에서 학습된 개인 정보(신체 제약, 보유 도구, 반려동물 등)를 반드시 루틴 선택에 반영하세요.
목록에 없는 공간은 빈 배열([])로 응답하세요.

${catalogueText}

반드시 다음 JSON 형식으로만 응답하세요. 루틴 이름은 목록에 있는 것을 철자·띄어쓰기 포함 정확히 동일하게 사용하세요:
{
${nonEmptyEntries.map(([s, items]) => `  "${s}": ["${items[0]?.title || ''}"]`).join(',\n')}${emptySpaces.length ? ',\n' + emptySpaces.map(s => `  "${s}": []`).join(',\n') : ''}
}
JSON 외 다른 텍스트는 절대 출력하지 마세요.`;

  // 맞춤 생성 루틴은 최초 온보딩 직후 첫 1회만 스킵한다.
  // forceCustom=true(수동·건너뜀 재생성)이면 항상 생성하고,
  // 자동 생성(온보딩)은 aiRecommendationsUpdatedAt이 없는 첫 번째 호출에서만 스킵한다.
  const isFirstTimeEver = !profile.aiRecommendationsUpdatedAt;
  const shouldGenerateCustom = forceCustom || !isFirstTimeEver;

  console.log(`[routineAI] AI 추천 생성 시작 — uid=${uid}, generateCustom=${shouldGenerateCustom}`);

  // 카탈로그 선별 + 생성형 루틴 병렬 호출 (생성형은 데이터 축적 후에만)
  const catalogueFetch = fetch(AI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': AI_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const [response, customRoutines] = await Promise.all([
    catalogueFetch,
    shouldGenerateCustom ? generateCustomRoutines(profile) : Promise.resolve({}),
  ]);

  // 카탈로그 추천 처리 — API 오류/파싱 실패 시 이전 추천을 유지하고 계속 진행한다.
  // 맞춤생성 루틴은 카탈로그 결과와 관계없이 항상 저장해야 신규 유저도 첫 화면에 표시된다.
  let sanitized = { ...previousRecommendations }; // default: 이전 카탈로그 추천 유지
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    console.warn(`[routineAI] 카탈로그 API 오류: ${response.status} — 이전 추천 유지. ${errText.slice(0, 100)}`);
  } else {
    const data = await response.json().catch(() => null);
    const text = data?.content?.[0]?.text;
    if (!text) {
      console.warn('[routineAI] 카탈로그 응답 텍스트 없음 — 이전 추천 유지');
    } else {
      const clean = text.replace(/```json|```/g, '').trim();
      try {
        const parsed = JSON.parse(clean);
        const newSanitized = {};
        for (const [space, names] of Object.entries(parsed)) {
          if (Array.isArray(names)) {
            newSanitized[space] = names
              .filter(name => typeof name === 'string' && nameToId[name.trim()])
              .map(name => nameToId[name.trim()])
              .slice(0, 5);
          }
        }
        sanitized = newSanitized;
      } catch (e) {
        console.warn('[routineAI] 카탈로그 JSON 파싱 실패 — 이전 추천 유지:', e.message);
      }
    }
  }

  // 공간별 개별 병합: 새 결과가 비어있는 공간은 이전 값 유지
  // (AI 파싱 실패, 빈 배열 반환, 공간 누락 등 어떤 이유로든 새 항목이 없으면 기존 맞춤 루틴 보존)
  const mergedCustomRoutines = { ...previousGeneratedRoutines };
  for (const [space, items] of Object.entries(customRoutines)) {
    if (Array.isArray(items) && items.length > 0) {
      mergedCustomRoutines[space] = items;
    }
  }

  await db.collection('users').doc(uid).update({
    aiRecommendations: sanitized,
    aiGeneratedRoutines: mergedCustomRoutines,
    aiRecommendationsUpdatedAt: new Date().toISOString(),
  });

  const { body: changeBody, spaceChanges } = buildChangeBody(
    sanitized,
    previousRecommendations,
    mergedCustomRoutines,
    previousGeneratedRoutines,
    triggerSpaceKey,
    catalogue
  );

  // 공간별 추천 목록 + 변경 여부 상세 로그
  for (const [space, newIds] of Object.entries(sanitized)) {
    const oldIds = previousRecommendations[space] || [];
    const label = SPACE_LABELS[space] || space;
    const idTitleMap = {};
    for (const item of (catalogue[space] || [])) idTitleMap[item.id] = item.title;
    const newTitles = newIds.map(id => idTitleMap[id] || id);
    const changed = JSON.stringify(newIds.slice().sort()) !== JSON.stringify(oldIds.slice().sort());
    console.log(`  [${label}] ${changed ? '변경됨' : '동일'}: ${newTitles.join(' / ')}`);
  }
  console.log(`[routineAI] changeBody=${changeBody}`);
  return { recommendations: sanitized, generatedRoutines: mergedCustomRoutines, changeBody, spaceChanges };
}

module.exports = { generateAiRecommendations, loadRoutineCatalogue, invalidateCatalogueCache };
