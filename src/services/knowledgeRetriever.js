// knowledgeBase RAG 서비스
// 태스크 이름으로 DB 검색 → 없으면 Claude 폴백 → 결과 자동 캐싱

const { db } = require('./firebase');

const AI_API_URL = process.env.AI_API_URL;
const AI_API_KEY = process.env.AI_API_KEY;
// AI_MODEL_CHAT 미설정 시 Haiku 기본값 사용
const AI_MODEL_CHAT = process.env.AI_MODEL_CHAT || 'claude-haiku-4-5-20251001';

// 공간 코드 → 한글 라벨 변환 (Claude 프롬프트에 활용)
// 프론트엔드 키(living, closet, laundry)와 백엔드 키(livingroom, bedroom) 모두 포함
const SPACE_LABEL = {
  bathroom:   '화장실',
  kitchen:    '주방',
  bedroom:    '침실',
  livingroom: '거실',
  living:     '거실',
  closet:     '옷장',
  laundry:    '세탁',
  general:    '공통',
};

/**
 * Firestore knowledgeBase에서 태스크 가이드 검색
 *
 * 검색 우선순위:
 *  1순위 — taskName + space + ai_generated==false  (사전 저장, 공간 일치)
 *  2순위 — taskName + space                        (AI 캐시 포함, 공간 일치)
 *  3순위 — taskName + ai_generated==false          (사전 저장, 공간 무관)
 *  4순위 — taskName                                (AI 캐시 포함, 공간 무관)
 *  5순위 — 제목 유사도 점수 기반 관련 가이드 검색   (사전 저장 우선)
 *  실패 시 null 반환
 *
 * Firestore 복합 인덱스 필요:
 *  - knowledgeBase: taskName ASC + space ASC + ai_generated ASC
 *  - knowledgeBase: taskName ASC + ai_generated ASC
 *  - knowledgeBase: space ASC + ai_generated ASC
 */
async function retrieveByTaskName(taskName, space) {
  // 1순위: taskName + space + 사전 저장 데이터
  const q1 = await db.collection('knowledgeBase')
    .where('taskName', '==', taskName)
    .where('space', '==', space)
    .where('ai_generated', '==', false)
    .limit(1)
    .get();
  if (!q1.empty) return q1.docs[0].data();

  // 2순위: taskName + space (AI 캐시 포함)
  const q2 = await db.collection('knowledgeBase')
    .where('taskName', '==', taskName)
    .where('space', '==', space)
    .limit(1)
    .get();
  if (!q2.empty) return q2.docs[0].data();

  // 3순위: taskName만 + 사전 저장 데이터 (공간이 다른 문서라도 활용)
  const q3 = await db.collection('knowledgeBase')
    .where('taskName', '==', taskName)
    .where('ai_generated', '==', false)
    .limit(1)
    .get();
  if (!q3.empty) return q3.docs[0].data();

  // 4순위: taskName만 (AI 캐시 포함)
  const q4 = await db.collection('knowledgeBase')
    .where('taskName', '==', taskName)
    .limit(1)
    .get();
  if (!q4.empty) return q4.docs[0].data();

  // 5순위: 제목 유사도 기반 — 사전 저장 데이터에서 가장 관련성 높은 가이드 검색
  return retrieveByRelevance(taskName, space);
}

// knowledgeBase 공간 키 정규화: DB에 저장된 키 → 앱 공간 키
// (예: 앱은 'living'을 쓰지만 일부 DB 문서는 'livingroom'으로 저장됨)
const SPACE_KEY_NORMALIZE = { livingroom: 'living' };

// 유사도 계산 시 제외할 범용 동사/명사 — 매칭 정밀도 향상
// (예: "닦기", "청소" 만으로는 관련성 판단 불가)
const RELEVANCE_STOPWORDS = new Set([
  '청소', '정리', '닦기', '세척', '제거', '관리', '하기', '비우기',
  '채우기', '돌리기', '개기', '분리', '정돈', '배치', '교체',
]);

/**
 * 사전 저장(ai_generated==false) 가이드 중 taskName과 가장 관련성 높은 문서를 반환한다.
 *
 * 알고리즘:
 *  1. extractKeywords()로 의미 있는 명사성 키워드만 추출 (어미·범용어 제거)
 *  2. SPACE_KEY_NORMALIZE로 공간 키 정규화 (livingroom → living 등)
 *  3. 동일 space + general space의 사전 저장 문서를 모두 조회
 *  4. 각 문서의 taskName(+2점)과 tags(+1점)에 키워드 포함 횟수로 점수 계산
 *  5. 점수 2 이상인 문서 중 가장 높은 점수를 반환
 *     - 점수 동점 시 동일 space 우선
 *
 * Firestore 복합 인덱스 필요: space ASC + ai_generated ASC
 */
async function retrieveByRelevance(taskName, space) {
  // extractKeywords는 normalizeKorean을 적용해 어미·조사를 제거하고
  // 2글자 이상의 의미 있는 단어만 남김
  const rawKeywords = extractKeywords(taskName);
  const keywords = rawKeywords.filter(kw => !RELEVANCE_STOPWORDS.has(kw));

  if (!keywords.length) return null;

  // DB 공간 키 → 앱 공간 키 역방향 매핑 (쿼리 시 DB 키 사용)
  // 예: 앱의 'living' 공간을 조회할 때 DB에는 'living' 또는 'livingroom' 문서가 있을 수 있음
  const dbSpaceKeys = Object.entries(SPACE_KEY_NORMALIZE)
    .filter(([, appKey]) => appKey === space)
    .map(([dbKey]) => dbKey);
  const querySpaces = [...new Set([space, ...dbSpaceKeys, 'general'])];

  // 동일 space + 별칭 + general space를 병렬 조회 (AI 생성 문서 제외)
  const snaps = await Promise.all(
    querySpaces.map(s =>
      db.collection('knowledgeBase')
        .where('space', '==', s)
        .where('ai_generated', '==', false)
        .get()
    )
  );

  const docs = snaps.flatMap(snap => snap.docs.map(d => d.data()));
  if (!docs.length) return null;

  // 각 문서의 관련성 점수 계산
  // taskName 포함 시 +2 (직접 연관), tags 포함 시 +1 (간접 연관)
  const normalizedSpace = SPACE_KEY_NORMALIZE[space] || space;
  const scored = docs.map(doc => {
    const nameText = (doc.taskName || '').toLowerCase();
    const tagsText = (doc.tags || []).join(' ').toLowerCase();
    const docAppSpace = SPACE_KEY_NORMALIZE[doc.space] || doc.space;
    let score = 0;
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      if (nameText.includes(kwLower)) score += 2;
      else if (tagsText.includes(kwLower)) score += 1;
    }
    return { doc, score, sameSpace: docAppSpace === normalizedSpace };
  });

  // 최소 점수 2 이상만 유효 매칭으로 인정 (단일 범용어 오매칭 방지)
  const candidates = scored
    .filter(r => r.score >= 2)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.sameSpace !== b.sameSpace) return a.sameSpace ? -1 : 1;
      return 0;
    });

  return candidates.length > 0 ? candidates[0].doc : null;
}

/**
 * Claude API로 청소 가이드 생성 (DB 미존재 시 폴백)
 * howTo 2~4단계, tip 1~2문장, JSON만 반환하도록 프롬프트 설계
 */
async function generateWithClaude(taskName, space) {
  const spaceLabel = SPACE_LABEL[space] || space;

  const prompt = `아래 청소 태스크에 대한 가이드를 JSON 형식으로만 반환하세요.

태스크: "${taskName}"
공간: ${spaceLabel}

⚠️ 중요: 반드시 "${taskName}" 태스크에만 해당하는 내용을 작성하세요.
다른 청소 항목(예: 다른 세탁물, 다른 공간의 청소 등)과 절대 혼동하지 마세요.

반드시 아래 스키마를 정확히 따르세요:
{
  "howTo": [
    { "step": 1, "description": "${taskName}에 맞는 구체적인 단계 설명" },
    { "step": 2, "description": "${taskName}에 맞는 구체적인 단계 설명" }
  ],
  "tip": "${taskName}에만 해당하는 실용적인 팁 1~2문장",
  "tipEmoji": "적절한 이모지 1개"
}

규칙:
- howTo는 "${taskName}" 전용으로 2~4단계 작성 (간결하고 실천 가능하게)
- tip은 "${taskName}"에만 적용되는 실용적인 사실 위주로 작성
- 절대로 다른 태스크의 방법을 혼용하지 말 것
- JSON 외 다른 텍스트 절대 출력 금지`;

  try {
    const response = await fetch(AI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': AI_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: AI_MODEL_CHAT,
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) throw new Error(`Claude API 오류: ${response.status}`);

    const data = await response.json();
    const text = data.content[0].text;

    // ```json ... ``` 마크다운 래퍼 제거 후 파싱
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    if (!parsed.howTo || !Array.isArray(parsed.howTo)) {
      throw new Error('howTo 필드가 없거나 배열이 아님');
    }

    return {
      howTo:     parsed.howTo,
      tip:       parsed.tip      || `${taskName}을 정기적으로 청소하면 위생을 유지할 수 있어요.`,
      tipEmoji:  parsed.tipEmoji || '✨',
    };
  } catch (_err) {
    // 파싱 실패 시 최소한의 기본값으로 응답 보장
    return {
      howTo: [
        { step: 1, description: `${taskName}에 필요한 도구를 준비한다.` },
        { step: 2, description: '전체적으로 꼼꼼하게 청소한다.' },
        { step: 3, description: '마른 천으로 마무리하고 도구를 정리한다.' },
      ],
      tip:      `${taskName}을 규칙적으로 하면 점점 쉬워져요!`,
      tipEmoji: '🧹',
    };
  }
}

/**
 * 태스크 가이드 통합 조회 (RAG 메인 진입점)
 *
 * 흐름:
 *  DB 검색 성공 → source: 'db' 반환
 *  DB 검색 실패 → Claude 생성 → knowledgeBase에 자동 캐싱 → source: 'ai' 반환
 *
 * 반환 형식:
 * {
 *   source: 'db' | 'ai',
 *   howTo: [{ step, description }],
 *   tip: string,
 *   tipEmoji: string,
 *   estimatedMinutes: number | null,
 * }
 */
async function getTaskGuide(taskName, space) {
  const dbResult = await retrieveByTaskName(taskName, space);

  if (dbResult) {
    return {
      source:           'db',
      howTo:            dbResult.howTo            || [],
      tip:              dbResult.tip              || '',
      tipEmoji:         dbResult.tipEmoji         || '✨',
      estimatedMinutes: dbResult.estimatedMinutes ?? null,
    };
  }

  // DB에 없으면 Claude로 생성
  const aiResult = await generateWithClaude(taskName, space);

  // AI 생성 결과를 knowledgeBase에 캐싱
  // 다음 동일 요청부터는 DB에서 바로 반환되므로 API 비용 절감
  try {
    const docRef = db.collection('knowledgeBase').doc();
    await docRef.set({
      id:                   docRef.id,
      taskName,
      space,
      // 태스크명 단어를 태그로 저장해 이후 키워드 검색에도 매칭되도록
      tags:                 taskName.split(/\s+/).filter(k => k.length >= 2),
      howTo:                aiResult.howTo,
      tip:                  aiResult.tip,
      tipEmoji:             aiResult.tipEmoji,
      difficulty:           'easy',
      estimatedMinutes:     null,
      relatedMisconceptions: [],
      ai_generated:         true,   // AI가 생성한 문서임을 표시
      createdAt:            new Date().toISOString(),
    });
  } catch (_cacheErr) {
    // 캐싱 실패는 무시 — 응답 자체는 정상 반환
  }

  return {
    source:           'ai',
    howTo:            aiResult.howTo,
    tip:              aiResult.tip,
    tipEmoji:         aiResult.tipEmoji,
    estimatedMinutes: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 챗봇 RAG: 사용자 메시지에서 키워드를 추출해 knowledgeBase + lifeKnowledge 검색
// ─────────────────────────────────────────────────────────────────────────────

// 한국어 어미·조사 제거 순서: 긴 패턴 먼저 (짧은 패턴이 먼저 걸리면 잘못 잘림)
const KO_SUFFIXES = /^(.{2,}?)(하기|하는|하여|하고|하면|하기|하지|하다|하던|하자|하니|하며|하면서|해서|해도|해야|했|하게|하기도|하기만|하기엔|하기는|세요|해요|해주세요|해줘|시키기|시키는|하려고|하려면|하려|하려다|하러|하러가|청소하기|닦기|씻기|비우기|털기|제거|제거하기|정리|정리하기|세탁|세탁하기|건조|건조하기|소독|소독하기|살균|살균하기)$/;

/**
 * 한국어 어미·조사를 제거해 어근만 남긴다.
 * 예: "세탁하기" → "세탁", "수건을" → "수건"
 */
function normalizeKorean(word) {
  // 조사 제거 (을/를/이/가/은/는/의/에/에서/으로/로/와/과/도/만/부터/까지)
  const noParticle = word.replace(/(을|를|이|가|은|는|의|에서|에게|에|으로|로|와|과|도|만|부터|까지|이랑|랑)$/, '');
  // 어미 제거 — 긴 패턴 우선
  const m = KO_SUFFIXES.exec(noParticle);
  return m ? m[1] : noParticle;
}

/**
 * 한국어 문장에서 2글자 이상 의미 있는 단어를 추출하고 정규화한다.
 * 원형과 정규화형을 모두 포함해 검색 범위를 넓힌다.
 */
function extractKeywords(text) {
  const raw = text
    .split(/[\s,.\-!?~·•()[\]]+/)
    .map(w => w.trim())
    .filter(w => w.length >= 2);

  const result = new Set(raw);
  for (const w of raw) {
    const norm = normalizeKorean(w);
    if (norm.length >= 2) result.add(norm);
  }
  return [...result];
}

/**
 * knowledgeBase (청소 방법) 에서 관련 항목 검색
 * tags 배열 기반 array-contains-any → 최대 limit 건 반환
 */
async function searchKnowledgeBase(keywords, limit = 2) {
  if (!keywords.length) return [];
  const snap = await db.collection('knowledgeBase')
    .where('tags', 'array-contains-any', keywords.slice(0, 10))
    .limit(limit)
    .get();
  return snap.docs.map(d => d.data());
}

/**
 * lifeKnowledge (청소 상식/원리) 에서 관련 항목 검색
 * tags 배열 기반 array-contains-any → 최대 limit 건 반환
 */
async function searchLifeKnowledge(keywords, limit = 2) {
  if (!keywords.length) return [];
  const snap = await db.collection('lifeKnowledge')
    .where('tags', 'array-contains-any', keywords.slice(0, 10))
    .limit(limit)
    .get();
  return snap.docs.map(d => d.data());
}

/**
 * 챗봇 메시지에 대한 RAG 컨텍스트 문자열 생성
 *
 * 반환 형식:
 *   "[관련 지식 베이스]\n..."  — 검색 결과가 있을 때
 *   null                       — 검색 결과 없을 때 (LLM 자체 지식으로 답변)
 */
async function buildChatbotRagContext(message) {
  const keywords = extractKeywords(message);
  if (!keywords.length) return null;

  const [knowledgeDocs, lifeDocs] = await Promise.all([
    searchKnowledgeBase(keywords, 2),
    searchLifeKnowledge(keywords, 2),
  ]);

  const sections = [];

  for (const doc of knowledgeDocs) {
    const steps = (doc.howTo || []).map(s => `${s.step}. ${s.description}`).join(' / ');
    const tip = doc.tip ? `팁: ${doc.tip}` : '';
    sections.push(`■ ${doc.taskName}${doc.space ? ` (${SPACE_LABEL[doc.space] || doc.space})` : ''}\n청소 순서: ${steps}\n${tip}`.trim());
  }

  for (const doc of lifeDocs) {
    sections.push(`■ ${doc.title}\n${doc.content}`.trim());
  }

  if (!sections.length) return null;

  return `[관련 지식 베이스]\n아래는 DB에서 검색된 실제 정보입니다. 이 내용을 우선적으로 참고해 답변하세요.\n\n${sections.join('\n\n')}`;
}

module.exports = { retrieveByTaskName, generateWithClaude, getTaskGuide, buildChatbotRagContext };
