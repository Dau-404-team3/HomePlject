// knowledgeBase(ai_generated==false) 카탈로그 품질 검증 스크립트
// 앱 카탈로그 = DB에서 동적 로드이므로, DB 항목 자체의 완성도를 검사한다.
// 실행: node scripts/checkKnowledgeCoverage.js

const { db } = require('../src/services/firebase');

const REQUIRED_FIELDS = ['taskName', 'space', 'howTo', 'tip', 'difficulty', 'estimatedMinutes'];
const APP_SPACES = new Set(['living', 'kitchen', 'closet', 'bathroom', 'laundry']);

function pct(n, total) { return total > 0 ? Math.round(n / total * 100) : 0; }

async function checkCoverage() {
  console.log('🔍 knowledgeBase 카탈로그 품질 검증 시작...\n');

  const snap = await db.collection('knowledgeBase')
    .where('ai_generated', '==', false)
    .get();

  if (snap.empty) {
    console.log('❌ ai_generated=false 문서가 없습니다. 먼저 시드를 실행하세요.');
    process.exit(1);
  }

  const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  console.log(`총 ${docs.length}건 로드\n`);

  const bySpace = {};
  const unknownSpace = [];
  const incomplete = [];
  const complete = [];

  for (const doc of docs) {
    const space = doc.space;

    // 앱 공간 키 검증
    if (!APP_SPACES.has(space)) {
      unknownSpace.push(doc);
      continue;
    }

    if (!bySpace[space]) bySpace[space] = [];
    bySpace[space].push(doc);

    // 필수 필드 완성도 검사
    const missing = REQUIRED_FIELDS.filter(f => {
      const v = doc[f];
      if (v === undefined || v === null || v === '') return true;
      if (Array.isArray(v) && v.length === 0) return true;
      return false;
    });

    if (missing.length > 0) {
      incomplete.push({ doc, missing });
    } else {
      complete.push(doc);
    }
  }

  // ── 공간별 항목 수 ───────────────────────────────────────────
  console.log('📂 공간별 항목 수:');
  for (const space of APP_SPACES) {
    const count = bySpace[space]?.length ?? 0;
    const marker = count === 0 ? '⚠️ ' : '  ';
    console.log(`${marker}[${space}] ${count}건`);
  }
  console.log();

  // ── 알 수 없는 공간 ──────────────────────────────────────────
  if (unknownSpace.length > 0) {
    console.log(`❌ 알 수 없는 공간 키 (${unknownSpace.length}건) — 앱에서 무시됩니다:`);
    unknownSpace.forEach(d => console.log(`   [${d.space}] "${d.taskName}"`));
    console.log();
  }

  // ── 필드 미완성 항목 ────────────────────────────────────────
  if (incomplete.length > 0) {
    console.log(`⚠️  필드 미완성 (${incomplete.length}건):`);
    incomplete.forEach(({ doc, missing }) =>
      console.log(`   [${doc.space}] "${doc.taskName}" — 누락: ${missing.join(', ')}`)
    );
    console.log();
  }

  // ── 요약 ────────────────────────────────────────────────────
  const total = docs.length;
  const appTotal = total - unknownSpace.length;
  console.log('─'.repeat(55));
  console.log(`📊 전체 ${total}건`);
  console.log(`   유효 공간 항목:  ${appTotal}건 (앱에서 카탈로그로 사용)`);
  console.log(`   필드 완성:       ${complete.length}건 (${pct(complete.length, appTotal)}%)`);
  console.log(`   필드 미완성:     ${incomplete.length}건 (${pct(incomplete.length, appTotal)}%)`);
  console.log(`   알 수 없는 공간: ${unknownSpace.length}건`);

  if (incomplete.length === 0 && unknownSpace.length === 0) {
    console.log('\n🎉 모든 카탈로그 항목이 완성되어 있습니다!');
  } else {
    console.log('\n💡 미완성 항목은 knowledge.json / knowledge2.json / knowledge3.json을');
    console.log('   보완한 뒤 npm run seed:knowledge 로 재시드하세요.');
  }

  process.exit(0);
}

checkCoverage().catch(err => {
  console.error('❌ 오류:', err);
  process.exit(1);
});
