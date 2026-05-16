/**
 * 청소 코치 앱 — 전체 기능 통합 시뮬레이터
 *
 * 테스트 시나리오:
 * STEP 1.  회원가입
 * STEP 2.  로그인
 * STEP 3.  온보딩 (프로파일 생성)
 * STEP 4.  Claude로 초기 루틴 생성
 * STEP 5.  체크리스트 완료 (공간 점수↑, 선호시간 학습)
 * STEP 6.  체크리스트 건너뜀 (3회 → 플래그 저장)
 * STEP 7.  챗봇 대화 — 오개념 감지 + knowledgeMap 교정
 * STEP 8.  챗봇 대화 — customFacts 저장 (새로운 사실 감지)
 * STEP 9.  챗봇 대화 — customFacts 삭제 (모순 감지)
 * STEP 10. 챗봇 대화 — 무관한 정보 저장 안 됨 확인
 * STEP 11. 챗봇 대화 — 사실 변경 감지 (hasPet 수정)
 * STEP 12. 루틴 재생성 (플래그 + customFacts 반영)
 * STEP 13. 루틴 직접 수정 (availableMinutes 재추론)
 * STEP 14. 알림 반응률 학습
 * FINAL.   Firestore 최종 상태 출력
 *
 * 실행: node simulate-real.js
 * 비용: Claude Haiku 사용, 토큰 최소화
 */

require('dotenv').config();
const admin = require('firebase-admin');
const path  = require('path');
const fs    = require('fs');

// ── 환경변수 및 파일 체크 ────────────────────────────────
const REQUIRED_ENV = ['FIREBASE_API_KEY', 'AI_API_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`\n  ✗ .env에 ${key}가 없습니다.\n`);
    process.exit(1);
  }
}

const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
if (!fs.existsSync(serviceAccountPath)) {
  console.error('\n  ✗ serviceAccountKey.json 파일이 없습니다.\n');
  process.exit(1);
}

// ── Firebase Admin 초기화 ────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require(serviceAccountPath)),
  });
}
const db = admin.firestore();

// ── 상수 ─────────────────────────────────────────────────
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const CLAUDE_API_KEY   = process.env.AI_API_KEY;
const CLAUDE_URL       = 'https://api.anthropic.com/v1/messages';
const TEST_EMAIL       = `sim_${Date.now()}@cleaningapp.test`;
const TEST_PASSWORD    = 'Test1234!';

// ── 터미널 출력 헬퍼 ─────────────────────────────────────
const C = {
  reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
  green:'\x1b[32m', yellow:'\x1b[33m', blue:'\x1b[34m',
  cyan:'\x1b[36m', red:'\x1b[31m', magenta:'\x1b[35m',
  bgGreen:'\x1b[42m',
};
const log    = (...a) => console.log(...a);
const br     = ()    => log('');
const line   = (c='─',n=60) => log(C.dim+c.repeat(n)+C.reset);
const title  = t => { br(); line('═'); log(`${C.bold}${C.cyan}  ${t}${C.reset}`); line('═'); };
const section= t => { br(); log(`${C.bold}${C.blue}▶ ${t}${C.reset}`); line('─',50); };
const ok     = t => log(`  ${C.green}✓${C.reset} ${t}`);
const warn   = t => log(`  ${C.yellow}⚠${C.reset}  ${t}`);
const info   = t => log(`  ${C.cyan}ℹ${C.reset}  ${t}`);
const fail   = t => log(`  ${C.red}✗${C.reset} ${t}`);
const arrow  = t => log(`  ${C.magenta}→${C.reset} ${t}`);
const diff   = (l,a,b) => log(`  ${C.dim}${l}:${C.reset} ${C.red}${a}${C.reset} → ${C.green}${b}${C.reset}`);
const scoreBar = s => {
  const f = Math.round(s/10);
  const col = s>=70?C.green:s>=40?C.yellow:C.red;
  return `${col}${'█'.repeat(f)}${C.dim}${'░'.repeat(10-f)}${C.reset}`;
};
const sleep = ms => new Promise(r => setTimeout(r,ms));

// ── Firebase Auth REST API ────────────────────────────────
async function firebaseAuth(endpoint, body) {
  const res  = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:${endpoint}?key=${FIREBASE_API_KEY}`,
    { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'Firebase Auth 오류');
  return data;
}

// ── Claude API 호출 ──────────────────────────────────────
// 비용 절감: 시뮬레이터는 haiku 사용
async function callClaude(system, userMsg, maxTokens=400) {
  const res = await fetch(CLAUDE_URL, {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version':'2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system,
      messages:[{ role:'user', content:userMsg }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API 오류: ${res.status}`);
  const data = await res.json();
  return data.content[0].text;
}

// ── Firestore 프로파일 전체 출력 ─────────────────────────
async function printProfile(uid, label) {
  const doc = await db.collection('users').doc(uid).get();
  if (!doc.exists) { fail('프로파일 없음'); return; }
  const p = doc.data();

  section(label);

  // 성향
  log(`  ${C.bold}성향${C.reset}`);
  log(`    유형: ${C.yellow}${p.personality?.type}${C.reset}`);
  log(`    가능시간: ${C.yellow}${p.personality?.availableMinutes}분/일${C.reset}`);
  log(`    선호시간대: ${C.yellow}${p.personality?.preferredTime || '미파악'}${C.reset}`);
  log(`    알림반응률: ${C.yellow}${((p.personality?.notificationResponseRate||1)*100).toFixed(0)}%${C.reset}`);
  br();

  // 공간 점수
  log(`  ${C.bold}공간별 청결 점수${C.reset}`);
  for (const [space, data] of Object.entries(p.spaceStatus||{})) {
    const s = data.score;
    const col = s>=70?C.green:s>=40?C.yellow:C.red;
    log(`    ${space.padEnd(12)} ${scoreBar(s)} ${col}${s}점${C.reset}  (청소 ${data.cleanCount}회)`);
  }
  br();

  // 행동 통계
  log(`  ${C.bold}행동 통계${C.reset}`);
  const bs = p.behaviorStats||{};
  log(`    완료: ${C.green}${bs.totalChecklistCompleted||0}회${C.reset}  건너뜀: ${C.red}${bs.totalChecklistSkipped||0}회${C.reset}  스트릭: ${C.cyan}${bs.currentStreak||0}일${C.reset}`);
  if (Object.keys(bs.skipPatterns||{}).length > 0) {
    const s = Object.entries(bs.skipPatterns).map(([k,v])=>`${k}(${v}회)`).join(', ');
    warn(`건너뜀 패턴: ${s}`);
  }
  br();

  // 지식 맵
  log(`  ${C.bold}지식 맵${C.reset}`);
  for (const [key, status] of Object.entries(p.knowledgeMap||{})) {
    const icon =
      status==='corrected'    ? `${C.green}✓ 교정완료` :
      status==='misconception'? `${C.red}✗ 오개념`   :
      status==='known'        ? `${C.cyan}● 알고있음` :
                                `${C.dim}○ 미파악`;
    log(`    ${key.padEnd(32)} ${icon}${C.reset}`);
  }
  br();

  // customFacts
  log(`  ${C.bold}customFacts (대화에서 파악된 사실)${C.reset}`);
  const cf = p.home?.customFacts || {};
  if (Object.keys(cf).length === 0) {
    log(`    ${C.dim}(없음)${C.reset}`);
  } else {
    for (const [key, data] of Object.entries(cf)) {
      const val = typeof data === 'object' ? data.value : data;
      const at  = typeof data === 'object' ? data.addedAt?.substring(0,10) : '';
      log(`    ${C.cyan}${key}${C.reset}: ${val} ${C.dim}(${at})${C.reset}`);
    }
  }
  br();

  // home 정보
  log(`  ${C.bold}home 정보${C.reset}`);
  const h = p.home||{};
  log(`    집 유형: ${h.houseType} / 거주: ${h.residents}명 / 반려동물: ${h.hasPet?'있음':'없음'} / 아이: ${h.hasChild?'있음':'없음'}`);
  log(`    요리빈도: ${h.cookingFrequency} / 문제공간: ${(h.troubleSpots||[]).join(', ')}`);

  arrow(`Firebase 콘솔에서 확인: users/${uid}`);
}

// ── 챗봇 + 프로파일 분석 통합 호출 ──────────────────────
// 실제 서버의 chatbot.js + aiProfileUpdater.js 로직을 시뮬레이션
async function chatWithAnalysis(uid, userMsg) {
  const snap = await db.collection('users').doc(uid).get();
  const profile = snap.data();
  const currentCustomFacts = profile.home?.customFacts || {};

  // 비용 절감: 챗봇 응답 + 프로파일 분석을 1회 호출로 처리
  const systemPrompt = `당신은 청소 전문 AI 코치입니다.
사용자 성향: ${profile.personality?.type}
현재 home 필드: hasPet=${profile.home?.hasPet}, houseType=${profile.home?.houseType}, cookingFrequency=${profile.home?.cookingFrequency}
현재 저장된 customFacts: ${JSON.stringify(currentCustomFacts)}

응답은 반드시 아래 JSON 형식으로만 반환하세요:
{
  "reply": "사용자에게 보낼 답변 (2문장 이내)",
  "profileChanges": {
    "knowledgeUpdate": {
      "detected": false,
      "key": "",
      "status": "misconception",
      "correctionHint": ""
    },
    "profileUpdate": {
      "detected": false,
      "field": "",
      "action": "update",
      "newValue": null,
      "reason": ""
    },
    "customFactsUpdate": {
      "detected": false,
      "action": "add",
      "key": "",
      "value": "",
      "reason": ""
    }
  }
}

[profileUpdate 사용 조건]
- 반려동물 없어짐/죽음 -> field: home.hasPet, action: update, newValue: false
- 이사/집 유형 변화 -> field: home.houseType, action: update, newValue: studio 등
- 요리 빈도 변화 -> field: home.cookingFrequency, action: update, newValue: rarely 등
- 아이 생김 -> field: home.hasChild, action: update, newValue: true

[customFactsUpdate 사용 조건 - home 필드에 없는 새로운 사실만]
저장 가능: 청소도구(청소기없음), 신체제약(손목부상), 주거특성(반지하), 세제제약
저장 금지: 감정/기분, 음식/취미, 날씨, 일시적상황, 이미 home필드에 있는 정보

[customFacts 모순 처리 - 반드시 준수]
기존 customFacts와 반대 정보가 나오면 action: remove 로 기존 키 삭제
예) 기존 cleaningTools=빗자루만사용 + 청소기샀다 -> action:remove, key:cleaningTools

JSON만 반환. 다른 텍스트 없음.`;


  const raw = await callClaude(systemPrompt, userMsg, 600);
  const clean = raw.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    // JSON 파싱 실패 시 텍스트를 reply로 사용
    return { reply: raw.trim(), profileChanges: null };
  }

  const { reply, profileChanges } = parsed;

  // Firestore 업데이트
  if (profileChanges) {
    const updates = { updatedAt: new Date().toISOString() };

    // 오개념 감지
    if (profileChanges.knowledgeUpdate?.detected) {
      const { key, status } = profileChanges.knowledgeUpdate;
      if (profile.knowledgeMap?.[key] !== 'corrected') {
        updates[`knowledgeMap.${key}`] = status;
      }
    }

    // 사실 변경 (hasPet, houseType 등 정해진 필드)
    if (profileChanges.profileUpdate?.detected) {
      const { field, action, newValue } = profileChanges.profileUpdate;
      updates[field] = action === 'delete'
        ? admin.firestore.FieldValue.delete()
        : newValue;
    }

    // customFacts 처리
    if (profileChanges.customFactsUpdate?.detected) {
      const { action, key, value } = profileChanges.customFactsUpdate;
      if (action === 'add') {
        updates[`home.customFacts.${key}`] = {
          value,
          addedAt: new Date().toISOString(),
        };
      } else if (action === 'remove') {
        updates[`home.customFacts.${key}`] = admin.firestore.FieldValue.delete();
      }
    }

    if (Object.keys(updates).length > 1) {
      await db.collection('users').doc(uid).update(updates);
    }
  }

  // 대화 로그 저장
  await db.collection('chatLogs').add({
    uid, userMessage: userMsg, aiReply: reply,
    timestamp: new Date().toISOString(),
  });

  return { reply, profileChanges };
}

// ════════════════════════════════════════════════════════
// 메인 시뮬레이션
// ════════════════════════════════════════════════════════
async function main() {
  console.clear();
  title('청소 코치 앱 — 전체 기능 통합 시뮬레이터');
  info(`테스트 계정: ${TEST_EMAIL}`);
  info('비용 절감: Claude Haiku + 토큰 최소화 + 1회 호출로 분석 통합');
  br();

  let uid, idToken;

  // ════════════════════════════════════════════════════
  // STEP 1: 회원가입
  // ════════════════════════════════════════════════════
  title('STEP 1 — 회원가입');
  try {
    const data = await firebaseAuth('signUp', {
      email: TEST_EMAIL, password: TEST_PASSWORD, returnSecureToken: true,
    });
    uid     = data.localId;
    idToken = data.idToken;
    ok(`계정 생성 완료`);
    ok(`UID: ${C.cyan}${uid}${C.reset}`);
    arrow('Firebase 콘솔 → Authentication → Users 확인');
  } catch(e) { fail(e.message); process.exit(1); }
  await sleep(500);

  // ════════════════════════════════════════════════════
  // STEP 2: 로그인
  // ════════════════════════════════════════════════════
  title('STEP 2 — 로그인');
  try {
    const data = await firebaseAuth('signInWithPassword', {
      email: TEST_EMAIL, password: TEST_PASSWORD, returnSecureToken: true,
    });
    idToken = data.idToken;
    ok('로그인 성공');
    ok(`idToken 발급 (앞 20자): ${C.dim}${idToken.substring(0,20)}...${C.reset}`);
    info('이후 모든 API 요청에 Authorization: Bearer {idToken} 헤더 필요');
  } catch(e) { fail(e.message); process.exit(1); }
  await sleep(500);

  // ════════════════════════════════════════════════════
  // STEP 3: 온보딩 — 프로파일 생성
  // ════════════════════════════════════════════════════
  title('STEP 3 — 온보딩 (프로파일 Firestore 저장)');

  const onboarding = {
    houseType: 'apartment', residents: 1,
    hasPet: true,  // 나중에 STEP 11에서 챗봇 대화로 false로 바뀌는지 확인
    hasChild: false, cookingFrequency: 'often',
    cleaningStyle: 'procrastinator', availableMinutes: 15,
    troubleSpots: ['bathroom', 'kitchen'],
  };

  log(`  ${C.bold}설문 응답:${C.reset}`);
  for (const [k,v] of Object.entries(onboarding)) {
    log(`    ${C.dim}${k}:${C.reset} ${C.yellow}${JSON.stringify(v)}${C.reset}`);
  }
  br();

  const initialProfile = {
    uid, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    personality: {
      type: onboarding.cleaningStyle,
      availableMinutes: onboarding.availableMinutes,
      preferredTime: null,
      notificationResponseRate: 1.0,
    },
    home: {
      houseType: onboarding.houseType, residents: onboarding.residents,
      hasPet: onboarding.hasPet, hasChild: onboarding.hasChild,
      cookingFrequency: onboarding.cookingFrequency,
      troubleSpots: onboarding.troubleSpots,
      customFacts: {},
    },
    knowledgeMap: {
      bleach_mixing_danger: 'unknown', rinse_cold_not_hot: 'unknown',
      mold_vs_waterstain: 'unknown', ventilation_required: 'unknown',
      gloves_required: 'unknown', material_specific_cleaner: 'unknown',
    },
    spaceStatus: {
      bathroom:   { score:50, lastCleanedAt:null, cleanCount:0 },
      kitchen:    { score:50, lastCleanedAt:null, cleanCount:0 },
      bedroom:    { score:50, lastCleanedAt:null, cleanCount:0 },
      livingroom: { score:50, lastCleanedAt:null, cleanCount:0 },
      toilet:     { score:50, lastCleanedAt:null, cleanCount:0 },
    },
    behaviorStats: {
      totalChecklistCompleted:0, totalChecklistSkipped:0,
      currentStreak:0, longestStreak:0,
      skipPatterns:{}, completionByHour:{},
    },
    activeRoutineId: null,
    taskPerformance: {},
    staleFlags: [],
  };

  await db.collection('users').doc(uid).set(initialProfile);
  ok('Firestore users/{uid} 저장 완료');
  ok(`hasPet: true (STEP 11에서 챗봇 대화로 수정될 예정)`);
  arrow(`Firebase 콘솔 → Firestore → users → ${uid}`);
  await sleep(300);

  // ════════════════════════════════════════════════════
  // STEP 4: Claude로 초기 루틴 생성
  // ════════════════════════════════════════════════════
  title('STEP 4 — Claude API 초기 루틴 생성');
  info('Claude Haiku 호출 중...');

  try {
    // JSON 잘림 방지: 3일치만 생성 + 토큰 1200으로 증가
    const sysPrompt = `청소 루틴 전문가. 반드시 monday/wednesday/friday 3일치만 JSON으로 반환.
스키마: {"weeklyRoutine":[{"day":"monday","tasks":[{"id":"t001","space":"bathroom","taskName":"세면대닦기","estimatedMinutes":5,"difficulty":"easy","priority":"normal"}]},{"day":"wednesday","tasks":[]},{"day":"friday","tasks":[]}],"generationReason":"근거"}
3일치 day만 포함. 태스크명 8자 이내. JSON만 출력.`;

    const userPrompt = `
성향: procrastinator / 하루 15분 / apartment
문제공간: bathroom kitchen
하루 15분 초과 금지 공간당 1개 태스크`;

    const text    = await callClaude(sysPrompt, userPrompt, 1200);
    const routine = JSON.parse(text.replace(/```json|```/g,'').trim());

    const routineRef = db.collection('routines').doc();
    await routineRef.set({ id:routineRef.id, uid, ...routine, createdAt:new Date().toISOString(), isActive:true });
    await db.collection('users').doc(uid).update({ activeRoutineId:routineRef.id, updatedAt:new Date().toISOString() });

    ok(`루틴 생성 완료 (ID: ${routineRef.id})`);
    ok(`생성 이유: ${routine.generationReason}`);

    const today = new Date().toLocaleDateString('en-US',{weekday:'long'}).toLowerCase();
    const todayR = routine.weeklyRoutine?.find(r=>r.day===today);
    if (todayR?.tasks?.length) {
      log(`  ${C.bold}오늘(${today}) 루틴:${C.reset}`);
      todayR.tasks.forEach(t => log(`    ${C.dim}[${t.priority}]${C.reset} ${t.taskName} (${t.space}, ${t.estimatedMinutes}분)`));
    }
    arrow('Firebase 콘솔 → Firestore → routines 확인');
  } catch(e) { fail(`루틴 생성 실패: ${e.message}`); }
  await sleep(500);

  // ════════════════════════════════════════════════════
  // STEP 5: 체크리스트 완료
  // ════════════════════════════════════════════════════
  title('STEP 5 — 체크리스트 완료 (공간점수↑ + 선호시간 학습)');

  const completions = [
    { taskId:'t_sim_001', space:'bathroom', hour:21 },
    { taskId:'t_sim_002', space:'kitchen',  hour:21 },
    { taskId:'t_sim_003', space:'bathroom', hour:22 },
  ];

  for (const c of completions) {
    const snap = await db.collection('users').doc(uid).get();
    const p    = snap.data();
    const completedAt = new Date(); completedAt.setHours(c.hour,0,0,0);
    const prevScore   = p.spaceStatus[c.space]?.score ?? 50;
    const newScore    = Math.min(100, prevScore+10);
    const byHour      = { ...p.behaviorStats.completionByHour };
    byHour[c.hour.toString()] = (byHour[c.hour.toString()]||0)+1;
    const bestHour    = Object.entries(byHour).sort(([,a],[,b])=>b-a)[0]?.[0];
    const preferredTime = bestHour
      ? (parseInt(bestHour)>=18 ? 'evening' : parseInt(bestHour)>=12 ? 'afternoon' : 'morning')
      : null;

    await db.collection('users').doc(uid).update({
      updatedAt: new Date().toISOString(),
      [`spaceStatus.${c.space}.score`]:        newScore,
      [`spaceStatus.${c.space}.lastCleanedAt`]: completedAt.toISOString(),
      [`spaceStatus.${c.space}.cleanCount`]:    (p.spaceStatus[c.space]?.cleanCount??0)+1,
      'behaviorStats.totalChecklistCompleted':  p.behaviorStats.totalChecklistCompleted+1,
      'behaviorStats.completionByHour':         byHour,
      'personality.preferredTime':              preferredTime,
    });
    await db.collection('completedTasks').add({
      uid, taskId:c.taskId, space:c.space,
      date: completedAt.toISOString().split('T')[0],
      completedAt: completedAt.toISOString(),
    });

    ok(`[완료] ${c.space} / ${c.taskId} (${c.hour}시)`);
    diff(`  ${c.space} 점수`, prevScore, newScore);
  }

  br();
  const afterStep5 = (await db.collection('users').doc(uid).get()).data();
  arrow(`선호 시간대 자동 학습: ${C.bold}${C.cyan}${afterStep5.personality.preferredTime}${C.reset}`);
  await sleep(300);

  // ════════════════════════════════════════════════════
  // STEP 6: 체크리스트 건너뜀 → 플래그
  // ════════════════════════════════════════════════════
  title('STEP 6 — 체크리스트 건너뜀 (3회 → routineReviewFlags 저장)');

  for (let i=1; i<=3; i++) {
    const snap = await db.collection('users').doc(uid).get();
    const p    = snap.data();
    const prev = p.spaceStatus['bathroom']?.score ?? 50;
    const next = Math.max(0, prev-3);
    const patterns = { ...p.behaviorStats.skipPatterns };
    patterns['bathroom'] = (patterns['bathroom']||0)+1;

    await db.collection('users').doc(uid).update({
      updatedAt: new Date().toISOString(),
      'spaceStatus.bathroom.score': next,
      'behaviorStats.totalChecklistSkipped': p.behaviorStats.totalChecklistSkipped+1,
      'behaviorStats.skipPatterns': patterns,
    });

    if (patterns['bathroom'] >= 3) {
      await db.collection('routineReviewFlags').add({
        uid, space:'bathroom', skipCount:patterns['bathroom'],
        createdAt: new Date().toISOString(), resolved:false,
      });
      warn(`[건너뜀 ${i}회] bathroom → ${C.bold}${C.red}플래그 저장!${C.reset}`);
      arrow('Firebase 콘솔 → Firestore → routineReviewFlags 확인');
    } else {
      log(`  ${C.yellow}⊘${C.reset} [건너뜀 ${i}회] bathroom`);
    }
    diff(`  bathroom 점수`, prev, next);
  }
  await sleep(300);

  // ════════════════════════════════════════════════════
  // STEP 7: 챗봇 — 오개념 감지 + 교정
  // ════════════════════════════════════════════════════
  title('STEP 7 — 챗봇 대화: 오개념 감지 + knowledgeMap 교정');
  info('Claude Haiku 1회 호출 (응답 + 프로파일 분석 동시 처리)');

  const msg7 = '락스랑 주방세제 섞어서 같이 쓰면 더 잘 닦이지 않나요?';
  log(`  ${C.bold}사용자:${C.reset} "${msg7}"`);

  try {
    const { reply, profileChanges } = await chatWithAnalysis(uid, msg7);
    log(`  ${C.bold}AI:${C.reset}     "${reply}"`);

    if (profileChanges?.knowledgeUpdate?.detected) {
      const ku = profileChanges.knowledgeUpdate;
      warn(`오개념 감지: ${ku.key} → ${ku.status}`);
      ok(`knowledgeMap.${ku.key}: unknown → ${ku.status}`);
    } else {
      info('오개념 감지 없음');
    }
    if (profileChanges?.customFactsUpdate?.detected) {
      info(`customFacts 변경: ${profileChanges.customFactsUpdate.action} / ${profileChanges.customFactsUpdate.key}`);
    }
  } catch(e) { fail(`Claude 호출 실패: ${e.message}`); }
  await sleep(1200);

  // ════════════════════════════════════════════════════
  // STEP 8: 챗봇 — customFacts 저장 (새로운 사실)
  // ════════════════════════════════════════════════════
  title('STEP 8 — 챗봇 대화: customFacts 저장 (청소기 없음)');
  info('청소와 직접 관련된 새로운 사실 → customFacts에 자동 저장');

  const msg8 = '저는 청소기가 없어서 빗자루만 써요. 그래도 괜찮을까요?';
  log(`  ${C.bold}사용자:${C.reset} "${msg8}"`);

  try {
    const { reply, profileChanges } = await chatWithAnalysis(uid, msg8);
    log(`  ${C.bold}AI:${C.reset}     "${reply}"`);

    if (profileChanges?.customFactsUpdate?.detected) {
      const cu = profileChanges.customFactsUpdate;
      ok(`customFacts.${cu.key} 저장: "${cu.value}"`);
      arrow('다음 루틴 생성 시 청소기 관련 태스크 자동 제외됨');
    } else {
      warn('customFacts 변경 없음 (AI가 저장 불필요 판단)');
    }
  } catch(e) { fail(`Claude 호출 실패: ${e.message}`); }
  await sleep(1200);

  // ════════════════════════════════════════════════════
  // STEP 9: 챗봇 — customFacts 삭제 (모순 정보)
  // ════════════════════════════════════════════════════
  title('STEP 9 — 챗봇 대화: customFacts 삭제 (청소기 구입)');
  info('기존 customFacts와 모순되는 정보 → 기존 키 자동 삭제');

  const msg9 = '어제 청소기 새로 샀어요! 다이슨 샀는데 진짜 잘 되더라고요.';
  log(`  ${C.bold}사용자:${C.reset} "${msg9}"`);

  try {
    const { reply, profileChanges } = await chatWithAnalysis(uid, msg9);
    log(`  ${C.bold}AI:${C.reset}     "${reply}"`);

    if (profileChanges?.customFactsUpdate?.detected) {
      const cu = profileChanges.customFactsUpdate;
      if (cu.action === 'remove') {
        ok(`customFacts.${cu.key} 삭제 완료 (FieldValue.delete())`);
        arrow('청소기 제한 해제 → 다음 루틴에 청소기 태스크 포함 가능');
      } else {
        ok(`customFacts.${cu.key} 추가: "${cu.value}"`);
      }
    } else {
      warn('customFacts 변경 없음');
    }
  } catch(e) { fail(`Claude 호출 실패: ${e.message}`); }
  await sleep(1200);

  // ════════════════════════════════════════════════════
  // STEP 10: 챗봇 — 무관한 정보 (저장 안 됨)
  // ════════════════════════════════════════════════════
  title('STEP 10 — 챗봇 대화: 청소와 무관한 정보 (저장 금지 확인)');
  info('감정/음식/일상 → customFacts에 저장되지 않아야 함');

  const msg10 = '오늘 치킨 먹었는데 너무 맛있었어요. 기분이 너무 좋아요!';
  log(`  ${C.bold}사용자:${C.reset} "${msg10}"`);

  try {
    const { reply, profileChanges } = await chatWithAnalysis(uid, msg10);
    log(`  ${C.bold}AI:${C.reset}     "${reply}"`);

    if (!profileChanges?.customFactsUpdate?.detected &&
        !profileChanges?.profileUpdate?.detected &&
        !profileChanges?.knowledgeUpdate?.detected) {
      ok('프로파일 변경 없음 — 무관한 정보 정상적으로 필터링됨');
    } else {
      warn('예상치 못한 프로파일 변경 발생');
      log(`    ${JSON.stringify(profileChanges)}`);
    }
  } catch(e) { fail(`Claude 호출 실패: ${e.message}`); }
  await sleep(1200);

  // ════════════════════════════════════════════════════
  // STEP 11: 챗봇 — 사실 변경 감지 (hasPet 수정)
  // ════════════════════════════════════════════════════
  title('STEP 11 — 챗봇 대화: 사실 변경 감지 (hasPet 수정)');
  info('온보딩에서 hasPet: true로 등록했으나 챗봇 대화에서 번복');

  const msg11 = '사실 강아지는 작년에 무지개다리 건넜어요. 지금은 혼자 살아요.';
  log(`  ${C.bold}사용자:${C.reset} "${msg11}"`);
  info(`현재 home.hasPet: ${C.red}true${C.reset} → 대화 후 false로 바뀌어야 함`);

  try {
    const { reply, profileChanges } = await chatWithAnalysis(uid, msg11);
    log(`  ${C.bold}AI:${C.reset}     "${reply}"`);

    if (profileChanges?.profileUpdate?.detected) {
      const pu = profileChanges.profileUpdate;
      ok(`사실 변경 감지: ${pu.field} → ${JSON.stringify(pu.newValue)}`);
      ok(`이유: ${pu.reason}`);
      arrow('반려동물 관련 루틴 태스크가 다음 재생성 시 제외됨');
    } else {
      warn('사실 변경 감지 못함 (AI 판단에 따라 달라질 수 있음)');
    }
  } catch(e) { fail(`Claude 호출 실패: ${e.message}`); }
  await sleep(1200);

  // ════════════════════════════════════════════════════
  // STEP 12: 루틴 재생성 (플래그 + customFacts 반영)
  // ════════════════════════════════════════════════════
  title('STEP 12 — 루틴 재생성 (건너뜀 플래그 + customFacts 반영)');
  info('bathroom 건너뜀 플래그 + 현재 customFacts 반영해서 새 루틴 생성');

  try {
    const snap    = await db.collection('users').doc(uid).get();
    const p       = snap.data();
    const flags   = await db.collection('routineReviewFlags')
      .where('uid','==',uid).where('resolved','==',false).get();
    const flagList = flags.docs.map(d=>d.data());

    const cf = p.home?.customFacts || {};
    const cfList = Object.values(cf)
      .filter(Boolean)
      .map(f => typeof f==='object' ? f.value : f)
      .join(', ') || '없음';

    const skipSummary = Object.entries(p.behaviorStats.skipPatterns||{})
      .map(([s,c])=>`${s} ${c}회 건너뜀`).join(', ') || '없음';

    // JSON 잘림 방지: 3일치만 생성 + 토큰 1200
    const sysPrompt = `청소 루틴 전문가. 반드시 monday/wednesday/friday 3일치만 JSON으로 반환.
스키마: {"weeklyRoutine":[{"day":"monday","tasks":[{"id":"t001","space":"bathroom","taskName":"세면대닦기","estimatedMinutes":5,"difficulty":"easy","priority":"normal"}]},{"day":"wednesday","tasks":[]},{"day":"friday","tasks":[]}],"generationReason":"근거"}
3일치 day만 포함. 태스크명 8자 이내. JSON만 출력.`;

    const userPrompt = `
성향: ${p.personality.type} / 하루 ${p.personality.availableMinutes}분
건너뜀 패턴: ${skipSummary}
대화에서 파악된 추가정보: ${cfList}
반려동물: ${p.home.hasPet ? '있음' : '없음'}

건너뜀 잦은 공간(bathroom)은 빈도 줄이거나 태스크 단축.
추가정보에 있는 제약사항 반드시 반영.
하루 ${p.personality.availableMinutes}분 초과 금지.`;

    const text    = await callClaude(sysPrompt, userPrompt, 1200);
    const routine = JSON.parse(text.replace(/```json|```/g,'').trim());

    // 이전 루틴 비활성화
    const prevRoutines = await db.collection('routines')
      .where('uid','==',uid).where('isActive','==',true).get();
    const batch = db.batch();
    prevRoutines.forEach(doc => batch.update(doc.ref, { isActive:false }));
    await batch.commit();

    // 새 루틴 저장
    const routineRef = db.collection('routines').doc();
    await routineRef.set({ id:routineRef.id, uid, ...routine, createdAt:new Date().toISOString(), isActive:true });
    await db.collection('users').doc(uid).update({ activeRoutineId:routineRef.id, updatedAt:new Date().toISOString() });

    // 플래그 resolved
    const fb = db.batch();
    flags.forEach(doc => fb.update(doc.ref, { resolved:true }));
    await fb.commit();

    ok(`새 루틴 생성 완료 (ID: ${routineRef.id})`);
    ok(`생성 이유: ${routine.generationReason}`);
    ok('이전 루틴 비활성화 완료');
    ok(`routineReviewFlags ${flagList.length}개 resolved 처리`);
  } catch(e) { fail(`루틴 재생성 실패: ${e.message}`); }
  await sleep(500);

  // ════════════════════════════════════════════════════
  // STEP 13: 루틴 직접 수정 → availableMinutes 재추론
  // ════════════════════════════════════════════════════
  title('STEP 13 — 루틴 직접 수정 (availableMinutes 자동 재추론)');

  const snap13 = await db.collection('users').doc(uid).get();
  const p13    = snap13.data();
  const prevMin = p13.personality.availableMinutes;
  const newMin  = 10; // 사용자가 15분→10분으로 줄임

  await db.collection('users').doc(uid).update({
    'personality.availableMinutes': newMin,
    updatedAt: new Date().toISOString(),
  });

  ok('루틴 수정 이벤트 처리');
  diff('availableMinutes', `${prevMin}분`, `${newMin}분`);
  arrow('다음 루틴 생성 시 10분 기준으로 생성됨');
  await sleep(300);

  // ════════════════════════════════════════════════════
  // STEP 14: 알림 반응률 학습
  // ════════════════════════════════════════════════════
  title('STEP 14 — 알림 반응률 학습 (지수 이동 평균)');

  const responses = [true, false, false, true, false];
  for (const r of responses) {
    const snap = await db.collection('users').doc(uid).get();
    const prev = snap.data().personality.notificationResponseRate ?? 1.0;
    const alpha = 0.2;
    const next  = Math.round((alpha*(r?1:0) + (1-alpha)*prev)*100)/100;
    await db.collection('users').doc(uid).update({
      'personality.notificationResponseRate': next,
    });
    log(`  알림 ${r?`${C.green}탭함${C.reset}`:`${C.red}무시${C.reset}`}  →  반응률: ${C.yellow}${(prev*100).toFixed(0)}%${C.reset} → ${C.yellow}${(next*100).toFixed(0)}%${C.reset}`);
  }
  const finalRate = (await db.collection('users').doc(uid).get()).data().personality.notificationResponseRate;
  br();
  arrow(`최종 반응률: ${C.bold}${(finalRate*100).toFixed(0)}%${C.reset} → 알림 시간대/빈도 조정 기준으로 활용`);
  await sleep(300);

  // ════════════════════════════════════════════════════
  // FINAL: 최종 상태 출력
  // ════════════════════════════════════════════════════
  title('FINAL — Firestore 최종 저장 데이터 확인');
  await printProfile(uid, '최종 프로파일 (모든 상호작용 반영 후)');

  // 컬렉션 요약
  br();
  section('Firestore 저장 현황');
  const [r,t,l,f] = await Promise.all([
    db.collection('routines').where('uid','==',uid).get(),
    db.collection('completedTasks').where('uid','==',uid).get(),
    db.collection('chatLogs').where('uid','==',uid).get(),
    db.collection('routineReviewFlags').where('uid','==',uid).get(),
  ]);
  ok(`users/                  → 프로파일 1개`);
  ok(`routines/               → ${r.size}개 (활성: ${r.docs.filter(d=>d.data().isActive).length}개)`);
  ok(`completedTasks/         → ${t.size}개`);
  ok(`chatLogs/               → ${l.size}개`);
  ok(`routineReviewFlags/     → ${f.size}개 (미해결: ${f.docs.filter(d=>!d.data().resolved).length}개)`);

  br();
  section('테스트 계정 정보');
  log(`  UID:      ${C.cyan}${uid}${C.reset}`);
  log(`  Email:    ${C.cyan}${TEST_EMAIL}${C.reset}`);
  log(`  Password: ${C.cyan}${TEST_PASSWORD}${C.reset}`);

  br();
  log(`  ${C.bgGreen}${C.bold}  시뮬레이션 완료 — Firebase 콘솔에서 데이터를 확인하세요  ${C.reset}`);
  br();

  await admin.app().delete();
  process.exit(0);
}

main().catch(async e => {
  console.error('\n', e.message);
  try { await admin.app().delete(); } catch {}
  process.exit(1);
});