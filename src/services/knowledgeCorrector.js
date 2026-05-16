const { db } = require('./firebase');

/**
 * KnowledgeCorrector
 *
 * 챗봇 대화에서 사용자의 잘못된 청소 지식을 감지하고,
 * (1) 프로파일 knowledgeMap을 업데이트하고
 * (2) AI 응답에 교정 컨텍스트를 삽입한다.
 */

// 감지 규칙: 키워드 패턴 → 관련 지식 항목
const MISCONCEPTION_RULES = [
  {
    key: 'bleach_mixing_danger',
    patterns: [
      /락스.{0,15}(세제|주방세제|화장실세제).{0,10}(같이|함께|섞|혼합)/,
      /(세제|주방세제).{0,15}락스.{0,10}(같이|함께|섞|혼합)/,
      /락스.{0,20}(더 잘|더욱|효과)/,
    ],
    misconceptionLabel: '세제 혼합이 효과적이라고 생각함',
    correctionHint: `락스와 다른 세제를 혼합하면 염소 가스가 발생해 위험합니다.
락스 단독 사용만으로도 충분한 살균 효과가 있습니다.
반드시 단독으로 사용하고, 찬물로 충분히 헹구세요.`,
  },
  {
    key: 'rinse_cold_not_hot',
    patterns: [
      /락스.{0,20}뜨거운\s*물/,
      /뜨거운\s*물.{0,20}락스/,
    ],
    misconceptionLabel: '락스를 뜨거운 물로 헹구면 좋다고 생각함',
    correctionHint: `락스는 뜨거운 물보다 찬물로 헹구는 것이 안전합니다.
뜨거운 물은 락스의 가스 발생을 촉진할 수 있습니다.`,
  },
  {
    key: 'ventilation_required',
    patterns: [
      /락스.{0,30}(환기|창문).{0,10}(안|없이|굳이|필요없)/,
      /(환기|창문).{0,10}(안|없이).{0,15}락스/,
    ],
    misconceptionLabel: '락스 사용 시 환기가 불필요하다고 생각함',
    correctionHint: `락스 사용 시 반드시 환기가 필요합니다.
창문을 열거나 환풍기를 켜고 사용하세요.`,
  },
  {
    key: 'mold_vs_waterstain',
    patterns: [
      /곰팡이.{0,20}(물때|석회)/,
      /(물때|석회).{0,20}곰팡이/,
      /곰팡이.{0,10}(같은|비슷한).{0,10}(물때|청소)/,
    ],
    misconceptionLabel: '곰팡이와 물때를 같은 것으로 혼동',
    correctionHint: `곰팡이와 물때는 원인과 청소법이 다릅니다.
물때(석회질)는 산성 세제로, 곰팡이는 락스 계열로 제거합니다.
혼용하면 효과가 없거나 표면이 손상될 수 있습니다.`,
  },
  {
    key: 'material_specific_cleaner',
    patterns: [
      /대리석.{0,15}(락스|염산|산성)/,
      /스테인리스.{0,15}염산/,
      /원목.{0,15}(물|물청소)/,
    ],
    misconceptionLabel: '소재에 맞지 않는 세제 사용 시도',
    correctionHint: `소재별로 사용하면 안 되는 세제가 있습니다.
대리석에 산성 세제 금지, 스테인리스에 염산 금지, 원목은 물 최소화.`,
  },
];

/**
 * 사용자 메시지에서 오개념을 감지한다.
 * @param {string} message - 사용자 입력 텍스트
 * @returns {Array} 감지된 오개념 목록
 */
function detectMisconceptions(message) {
  const detected = [];
  for (const rule of MISCONCEPTION_RULES) {
    const matched = rule.patterns.some(pattern => pattern.test(message));
    if (matched) {
      detected.push({
        key: rule.key,
        correctionHint: rule.correctionHint,
        misconceptionLabel: rule.misconceptionLabel,
      });
    }
  }
  return detected;
}

/**
 * 감지된 오개념을 프로파일에 기록하고
 * AI 응답용 교정 컨텍스트 문자열을 반환한다.
 */
async function processAndCorrect(uid, message) {
  const detected = detectMisconceptions(message);
  if (detected.length === 0) return { correctionContext: null, corrected: [] };

  const profileRef = db.collection('users').doc(uid);
  const profile = (await profileRef.get()).data();
  const knowledgeMap = { ...profile.knowledgeMap };

  const corrected = [];
  for (const item of detected) {
    // 이미 교정된 항목은 재교정하지 않음
    if (knowledgeMap[item.key] === 'corrected') continue;

    knowledgeMap[item.key] = 'misconception';
    corrected.push(item);
  }

  if (corrected.length > 0) {
    await profileRef.update({
      knowledgeMap,
      updatedAt: new Date().toISOString(),
    });
  }

  // 교정 힌트를 AI system prompt 컨텍스트로 조합
  const correctionContext = corrected.length > 0
    ? `[교정 필요]\n${corrected.map(c => c.correctionHint).join('\n\n')}\n\n이 정보를 자연스럽게 대화에 녹여 친절하게 알려주세요. "틀렸어요"라는 직접적 표현은 피하세요.`
    : null;

  return { correctionContext, corrected };
}

/**
 * 교정 완료 표시 (AI가 교정 응답을 전송한 후 호출)
 */
async function markAsCorrected(uid, keys) {
  if (!keys.length) return;
  const profileRef = db.collection('users').doc(uid);
  const updates = {};
  keys.forEach(key => {
    updates[`knowledgeMap.${key}`] = 'corrected';
  });
  await profileRef.update({ ...updates, updatedAt: new Date().toISOString() });
}

/**
 * 프로파일의 knowledgeMap을 AI 컨텍스트 문자열로 변환
 * 챗봇 system prompt에 삽입해 AI가 이미 아는 것/모르는 것을 파악하게 함
 */
function buildKnowledgeContext(knowledgeMap) {
  const unknown = [], known = [], misconception = [], corrected = [];

  for (const [key, status] of Object.entries(knowledgeMap)) {
    if (status === 'unknown') unknown.push(key);
    else if (status === 'known') known.push(key);
    else if (status === 'misconception') misconception.push(key);
    else if (status === 'corrected') corrected.push(key);
  }

  return `
[사용자 청소 지식 현황]
- 이미 아는 것: ${known.join(', ') || '없음'}
- 잘못 알고 있는 것 (교정 중): ${misconception.join(', ') || '없음'}
- 교정 완료: ${corrected.join(', ') || '없음'}
- 아직 모르는 것: ${unknown.join(', ') || '없음'}
`.trim();
}

module.exports = { detectMisconceptions, processAndCorrect, markAsCorrected, buildKnowledgeContext };
