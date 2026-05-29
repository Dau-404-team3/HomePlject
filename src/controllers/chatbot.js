const { db, admin } = require('../services/firebase');
const { processAndCorrect, markAsCorrected, buildKnowledgeContext } = require('../services/knowledgeCorrector');
const { buildChatbotRagContext } = require('../services/knowledgeRetriever');

const AI_API_URL = process.env.AI_API_URL;
const AI_API_KEY = process.env.AI_API_KEY;

// 실시간 추출 대상 카테고리 (루틴 설계에 즉각적인 영향을 주는 항목)
const REALTIME_CATEGORIES = [
  'cleaning_tools',      // 청소 도구 보유/변경
  'physical_limitation', // 신체 제약
  'pet_change',          // 반려동물 변화
  'housing_change',      // 거주 환경 변화
  'schedule_change',     // 청소 가능 시간대 변화
  'cooking_change',      // 요리 습관 변화
  'problem_area',        // 문제 공간
  'family_change',       // 가족/동거인 변화
  'cleaning_products',   // 세제/용품 보유/변경
  'misconception',       // 청소 오개념
];

/**
 * POST /api/chatbot/message
 */
async function handleMessage(req, res, next) {
  try {
    const uid = req.user.uid;
    const { message, conversationHistory = [], sessionId } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ error: '메시지를 입력해주세요.' });
    }
    if (message.trim().length > 2000) {
      return res.status(400).json({ error: '메시지는 2000자 이내로 입력해주세요.' });
    }
    if (!Array.isArray(conversationHistory) || conversationHistory.length > 50) {
      return res.status(400).json({ error: '대화 기록이 너무 깁니다.' });
    }

    const profileDoc = await db.collection('users').doc(uid).get();
    if (!profileDoc.exists) {
      return res.status(404).json({ error: '프로파일이 없습니다. 온보딩을 먼저 완료하세요.' });
    }
    const profile = profileDoc.data();

    const [{ correctionContext, corrected }, ragContext] = await Promise.all([
      processAndCorrect(uid, message),
      buildChatbotRagContext(message),
    ]);
    const systemPrompt = buildChatbotSystemPrompt(profile, correctionContext, ragContext);
    const reply = await callChatAI(systemPrompt, conversationHistory, message);

    if (corrected.length > 0) {
      await markAsCorrected(uid, corrected.map(c => c.key));
    }

    await saveToSession(uid, sessionId, message, reply);

    res.json({ reply, correctedKnowledge: corrected.map(c => c.key) });
  } catch (err) {
    next(err);
  }
}

// ── 시스템 프롬프트 빌더 ─────────────────────────────────

function buildChatbotSystemPrompt(profile, correctionContext, ragContext) {
  const { personality, home, spaceStatus, knowledgeMap, recentSessionSummaries, behaviorStats } = profile;

  const lowSpaces = Object.entries(spaceStatus || {})
    .filter(([, v]) => v.score < 40)
    .map(([k]) => k);

  const knowledgeContext = buildKnowledgeContext(knowledgeMap || {});

  // customFacts: 대화에서 학습한 사용자 정보
  const customFacts = home?.customFacts || {};
  const knownFactsList = Object.values(customFacts)
    .filter(Boolean)
    .map(f => (typeof f === 'object' ? f.value : f))
    .filter(Boolean);

  // 아직 파악되지 않은 카테고리 — 대화 흐름상 자연스럽게 1개만 질문
  const knownCategories = new Set(
    Object.values(customFacts).map(f => (typeof f === 'object' ? f.category : null)).filter(Boolean)
  );
  const missingCategories = REALTIME_CATEGORIES
    .filter(c => c !== 'misconception' && !knownCategories.has(c))
    .slice(0, 2);

  const missingLabels = {
    cleaning_tools: '보유 중인 청소 도구',
    physical_limitation: '신체적 제약 여부',
    pet_change: '반려동물 여부',
    housing_change: '거주 환경',
    schedule_change: '청소 가능 시간대',
    cooking_change: '요리 빈도',
    problem_area: '가장 청소하기 힘든 공간',
    family_change: '동거인 현황',
    cleaning_products: '보유 세제/청소용품',
  };

  const missingSection = missingCategories.length > 0
    ? `\n[아직 파악하지 못한 정보 — 관련 주제가 나올 때 자연스럽게 1가지만 확인]\n${missingCategories.map(c => `- ${missingLabels[c] || c}`).join('\n')}\n단, 강제로 물어보지 말 것. 대화 흐름이 자연스러울 때만.`
    : '';

  // 이전 세션 요약 (최대 3개)
  const summariesSection = buildSessionSummariesSection(recentSessionSummaries);

  // 루틴 수행 현황
  const behaviorSection = buildBehaviorStatsSection(behaviorStats);

  // ── 정적 파트: 사용자 세션 내에서 변하지 않는 정보 (캐시 대상) ──
  const staticPart = `마크다운 형식 절대 사용 금지.
**, __, ##, -, *, \` 같은 마크다운 기호 사용하지 말 것.
줄바꿈이 필요하면 자연스러운 문장으로 처리할 것.
일반 텍스트로만 답변할 것.

당신은 청소 전문 AI 코치입니다. 사용자의 청소 관련 질문에 친절하고 실용적으로 답하세요.

[사용자 프로파일]
- 청소 성향: ${personality?.type ?? '미설정'} (${getPersonalityDesc(personality?.type)})
- 하루 가능 시간: ${personality?.availableMinutes ?? '미설정'}분
- 주거 형태: ${home?.houseType ?? '미설정'}, 반려동물: ${home?.hasPet ? '있음' : '없음'}
- 요리 빈도: ${home?.cookingFrequency ?? '미설정'}
- 현재 청결 점수 낮은 공간: ${lowSpaces.join(', ') || '없음'}

[대화를 통해 파악된 추가 정보]
${knownFactsList.length > 0 ? knownFactsList.map(f => `- ${f}`).join('\n') : '- 아직 없음'}

${knowledgeContext}
${summariesSection}
${behaviorSection}
${missingSection}

[응답 원칙]
1. 항상 사용자 성향에 맞게 조언하세요. 예: passive/binge에게는 짧고 쉬운 방법을 먼저 제시.
2. 안전 정보(환기, 장갑, 세제 혼합 금지)는 관련 주제일 때 자연스럽게 포함하세요.
3. 잘못된 정보는 "틀렸어요" 대신 "사실은~", "더 효과적인 방법은~" 식으로 부드럽게 교정하세요.
4. 답변은 간결하게, 실천 가능한 단계로 구성하세요.
5. 한국어로만 답하세요.
6. 파악된 추가 정보(신체 제약, 보유 도구 등)를 반드시 조언에 반영하세요.
7. 이전 대화 요약이 있다면 자연스럽게 맥락으로 활용하되, 직접 언급은 사용자가 먼저 언급할 때만 하세요.`;

  // ── 동적 파트: 메시지마다 달라지는 정보 (캐시 제외) ──
  const dynamicParts = [
    ragContext ? `\n${ragContext}` : '',
    correctionContext ? `\n[이번 응답에서 반드시 교정할 내용]\n${correctionContext}` : '',
  ].filter(Boolean).join('\n');

  return { staticPart, dynamicPart: dynamicParts };
}

function getPersonalityDesc(type) {
  const desc = {
    binge: '평소에는 미루다 한 번에 몰아서 청소하는 타입 → 짧고 쉬운 루틴 선호',
    busy: '바쁜 와중에도 틈틈이 조금씩 하는 타입 → 유연한 초단기 루틴 선호',
    perfectionist: '자주 청소하지만 체계적인 방법을 원하는 타입 → 공간별 가이드 필요',
    passive: '청소를 많이 미루는 타입 → 아주 쉬운 루틴으로 습관 형성 필요',
    maintainer: '청소 습관이 잘 잡혀 있는 타입 → 놓치기 쉬운 공간 관리 위주',
  };
  return desc[type] || type || '미설정';
}

function buildSessionSummariesSection(recentSessionSummaries) {
  if (!Array.isArray(recentSessionSummaries) || recentSessionSummaries.length === 0) return '';

  const now = Date.now();
  const lines = recentSessionSummaries.slice(0, 3).map(s => {
    const diffDays = Math.floor((now - new Date(s.date).getTime()) / 86400000);
    const label = diffDays === 0 ? '오늘' : diffDays === 1 ? '어제' : `${diffDays}일 전`;
    return `- ${label}: ${s.summary}`;
  });

  return `\n[이전 대화 요약 — 최근 ${lines.length}회]\n${lines.join('\n')}`;
}

function buildBehaviorStatsSection(behaviorStats) {
  if (!behaviorStats) return '';

  const { currentStreak, skipPatterns, totalChecklistCompleted, totalChecklistSkipped } = behaviorStats;

  const lines = [];

  if (currentStreak > 0) lines.push(`- 연속 달성: ${currentStreak}일째`);

  const skipEntries = Object.entries(skipPatterns || {})
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);
  if (skipEntries.length > 0) {
    lines.push(`- 자주 건너뛰는 공간: ${skipEntries.map(([k, v]) => `${k}(${v}회)`).join(', ')}`);
  }

  const total = (totalChecklistCompleted || 0) + (totalChecklistSkipped || 0);
  if (total > 0) {
    const rate = Math.round((totalChecklistCompleted / total) * 100);
    lines.push(`- 전체 수행률: ${rate}%`);
  }

  if (lines.length === 0) return '';
  return `\n[루틴 수행 현황]\n${lines.join('\n')}`;
}

// ── AI API 호출 (plain text) ──────────────────────────────

async function callChatAI({ staticPart, dynamicPart }, history, newMessage) {
  const messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: newMessage },
  ];

  // system을 배열로 구성: 정적 파트에 cache_control 적용
  // 정적 파트(프로필·지시사항)는 같은 사용자의 연속 메시지에서 캐시 히트 → 입력 토큰 ~90% 절감
  const system = [
    { type: 'text', text: staticPart, cache_control: { type: 'ephemeral' } },
    ...(dynamicPart ? [{ type: 'text', text: dynamicPart }] : []),
  ];

  const response = await fetch(AI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': AI_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system,
      messages,
    }),
  });

  if (!response.ok) throw new Error(`AI API error: ${response.status}`);
  const data = await response.json();
  return (data.content?.[0]?.text ?? '').trim() || '잠시 후 다시 시도해주세요.';
}

// ── 세션 종료 시 일괄 customFacts 추출 ──────────────────

const CATEGORY_LABELS = {
  cleaning_tools: '청소 도구',
  physical_limitation: '신체 제약',
  pet_change: '반려동물',
  housing_change: '거주 환경',
  schedule_change: '청소 가능 시간',
  cooking_change: '요리 습관',
  problem_area: '문제 공간',
  family_change: '가족/동거인',
  cleaning_products: '청소용품',
  misconception: '청소 상식',
};

async function handleAnalyzeSession(req, res, next) {
  try {
    const uid = req.user.uid;
    const { conversationHistory = [], sessionId } = req.body;

    const userMessages = conversationHistory.filter(m => m.role === 'user');
    if (userMessages.length === 0) return res.json({ changedCategories: [] });

    const profileDoc = await db.collection('users').doc(uid).get();
    if (!profileDoc.exists) return res.json({ changedCategories: [] });

    // fact 추출 + 세션 요약을 병렬 실행
    const [changedCategories, summary] = await Promise.all([
      extractSessionFacts(uid, conversationHistory, profileDoc.data()),
      generateSessionSummary(conversationHistory),
    ]);

    if (summary) {
      // 프로파일에 최근 3개 요약 유지 (시스템 프롬프트 컨텍스트용)
      const existing = profileDoc.data().recentSessionSummaries || [];
      const updated = [
        { summary, date: new Date().toISOString() },
        ...existing,
      ].slice(0, 3);

      const writes = [
        db.collection('users').doc(uid).update({ recentSessionSummaries: updated }),
      ];

      // 세션 문서에도 요약 저장 (대화 기록 목록에서 표시)
      if (sessionId) {
        writes.push(
          db.collection('chatSessions').doc(sessionId)
            .update({ summary, updatedAt: new Date().toISOString() })
            .catch(() => null)
        );
      }

      await Promise.all(writes);
    }

    res.json({ changedCategories });
  } catch (err) {
    next(err);
  }
}

async function generateSessionSummary(conversationHistory) {
  const conversationText = conversationHistory
    .map(m => `${m.role === 'user' ? '사용자' : 'AI'}: ${m.content}`)
    .join('\n\n');

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
          content: `아래 대화를 2~3문장으로 요약하세요. 어떤 청소 주제를 다뤘고 어떤 조언을 했는지 중심으로. 요약문만 반환하세요.\n\n${conversationText}`,
        }],
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}

async function handleGetPendingUpdate(req, res, next) {
  try {
    const uid = req.user.uid;
    const userDoc = await db.collection('users').doc(uid).get();
    const pending = userDoc.data()?.pendingRoutineUpdate ?? null;
    res.json({ pending });
  } catch (err) {
    next(err);
  }
}

async function handleClearPendingUpdate(req, res, next) {
  try {
    const uid = req.user.uid;
    await db.collection('users').doc(uid).update({ pendingRoutineUpdate: null });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function extractSessionFacts(uid, conversationHistory, profile) {
  const categoryList = REALTIME_CATEGORIES.map(c => `- ${c}`).join('\n');
  const conversationText = conversationHistory
    .map(m => `${m.role === 'user' ? '사용자' : 'AI'}: ${m.content}`)
    .join('\n\n');

  const prompt = `아래 대화에서 두 단계로 정보를 추출하세요.
해당 정보가 없으면 findings를 빈 배열로 반환하세요.

[1단: 필수 항목 — 해당하면 반드시 추출]
${categoryList}

[2단: 자유 추출 — category를 "specific_situation"으로 설정]
1단 항목에 해당하지 않더라도 아래 기준 중 하나라도 충족하면 자유롭게 추출:
1. 해결하고 싶어 하는 구체적인 청소·위생 문제 (예: 후라이팬 눌어붙음, 높은 선반 먼지, 날파리)
2. 반복적으로 관심을 보이는 특정 품목·소재 (예: 청바지, 가죽 소파, 원목 가구)
3. 원인이나 대응법을 찾고 있는 지속 문제 (예: 쉰내, 물때, 결로)
단, 1회성 언급이나 지나가는 말은 제외. 해결 의지가 명확하거나 2회 이상 언급된 경우만 추출.

[대화 기록]
${conversationText}

[응답 형식 - JSON만 반환]
{"findings":[{"category":"항목명 또는 specific_situation","key":"snake_case_키","value":"파악된 사실 한 문장","action":"add 또는 remove"}]}

주의: 일시적 감정·날씨·음식 등 청소와 무관한 내용은 무시. 확실하지 않은 정보는 포함하지 말 것. 문맥을 충분히 고려해 판단할 것.`;

  const response = await fetch(AI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': AI_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) return [];

  const data = await response.json();
  const rawText = data.content?.[0]?.text ?? '';

  let findings;
  try {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) return [];
    findings = JSON.parse(match[0]).findings;
  } catch {
    return [];
  }

  if (!findings?.length) return [];

  const userRef = db.collection('users').doc(uid);
  const customFacts = { ...(profile.home?.customFacts || {}) };
  const changedCategories = [];

  for (const f of findings) {
    if (!f.key || !f.action) continue;
    if (f.action === 'add' && f.value && !customFacts[f.key]) {
      customFacts[f.key] = { value: f.value, category: f.category, addedAt: new Date().toISOString() };
      changedCategories.push({
        category: f.category,
        key: f.key,
        value: f.value,
        label: CATEGORY_LABELS[f.category] || f.category,
      });
    } else if (f.action === 'remove' && customFacts[f.key]) {
      const removed = customFacts[f.key];
      delete customFacts[f.key];
      changedCategories.push({
        category: f.category,
        key: f.key,
        value: null,
        label: CATEGORY_LABELS[removed.category] || f.category,
      });
    }
  }

  if (changedCategories.length > 0) {
    await userRef.update({
      'home.customFacts': customFacts,
      updatedAt: new Date().toISOString(),
      pendingRoutineUpdate: {
        categories: changedCategories,
        detectedAt: new Date().toISOString(),
      },
    });
  }

  return changedCategories;
}

// ── 세션 저장 ────────────────────────────────────────────

async function saveToSession(uid, sessionId, userMessage, aiReply) {
  if (!sessionId) return;

  const sessionRef = db.collection('chatSessions').doc(sessionId);
  const now = new Date().toISOString();
  const newPair = [
    { role: 'user',      content: userMessage, timestamp: now },
    { role: 'assistant', content: aiReply,     timestamp: now },
  ];

  const sessionDoc = await sessionRef.get();
  if (!sessionDoc.exists) {
    await sessionRef.set({
      uid,
      sessionId,
      title: userMessage.slice(0, 40),
      summary: null,
      messages: newPair,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await sessionRef.update({
      messages: admin.firestore.FieldValue.arrayUnion(...newPair),
      updatedAt: now,
    });
  }
}

// ── 세션 목록 조회 ───────────────────────────────────────

async function handleGetSessions(req, res, next) {
  try {
    const uid = req.user.uid;
    // orderBy를 제거해 복합 인덱스 없이 동작하도록 하고, JS에서 정렬
    const snap = await db.collection('chatSessions')
      .where('uid', '==', uid)
      .limit(50)
      .get();

    const sessions = snap.docs
      .map(d => {
        const { messages, ...meta } = d.data();
        return meta;
      })
      .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1))
      .slice(0, 20);

    res.json({ sessions });
  } catch (err) {
    next(err);
  }
}

// ── 세션 단건 조회 (대화 내역 포함) ─────────────────────

async function handleGetSession(req, res, next) {
  try {
    const uid = req.user.uid;
    const { sessionId } = req.params;

    const doc = await db.collection('chatSessions').doc(sessionId).get();
    if (!doc.exists || doc.data().uid !== uid) {
      return res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
    }

    res.json(doc.data());
  } catch (err) {
    next(err);
  }
}

module.exports = {
  handleMessage,
  handleAnalyzeSession,
  handleGetPendingUpdate,
  handleClearPendingUpdate,
  handleGetSessions,
  handleGetSession,
};
