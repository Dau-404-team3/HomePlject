// knowledgeBase space 필드를 앱 공간 키로 정규화
// livingroom → living
// general / bedroom → 태스크명 기반으로 laundry / closet / living 분류
// 실행: node scripts/migrateKnowledgeBaseSpaces.js

const { db } = require('../src/services/firebase');

// 태스크명 → 앱 공간 키 명시적 매핑 (general/bedroom 항목 전용)
const EXPLICIT_SPACE_MAP = {
  // general → laundry
  '수건 단독 세탁하기':           'laundry',
  '청바지 색 빠짐 없이 세탁하기':  'laundry',
  '드럼세탁기 효율적으로 돌리기':  'laundry',
  '세탁기 자체 청소하기':         'laundry',
  '실크·캐시미어 손세탁하기':     'laundry',
  // general → living
  '창틀 청소':  'living',
  '바닥 청소':  'living',
  // bedroom → laundry
  '침구(시트·베갯잇) 세탁하기':   'laundry',
  '베개솜 세탁하기':              'laundry',
  // bedroom → closet
  '옷장 비우기·정리하기':  'closet',
  '패딩 보관하기':        'closet',
  '옷장 청소':           'closet',
  '침대 및 매트리스 청소': 'closet',
  // bedroom → living
  '책상 청소': 'living',
};

async function migrate() {
  console.log('🔄 knowledgeBase space 마이그레이션 시작...\n');

  const snap = await db.collection('knowledgeBase')
    .where('ai_generated', '==', false)
    .get();

  if (snap.empty) {
    console.log('❌ ai_generated=false 문서가 없습니다.');
    process.exit(1);
  }

  const batch = db.batch();
  let updated = 0;
  let skipped = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const currentSpace = data.space;
    const taskName = data.taskName;
    let newSpace = null;

    if (currentSpace === 'livingroom') {
      newSpace = 'living';
    } else if (currentSpace === 'general' || currentSpace === 'bedroom') {
      newSpace = EXPLICIT_SPACE_MAP[taskName] || null;
      if (!newSpace) {
        console.warn(`  ⚠️  매핑 없음: [${currentSpace}] "${taskName}" — 건너뜀`);
        skipped++;
        continue;
      }
    } else {
      // bathroom, kitchen, living, closet, laundry 등 이미 정규화된 키 → 변경 불필요
      skipped++;
      continue;
    }

    batch.update(doc.ref, { space: newSpace });
    console.log(`  ✅ [${currentSpace}] → [${newSpace}]  "${taskName}"`);
    updated++;
  }

  if (updated === 0) {
    console.log('✅ 변경할 항목이 없습니다. 이미 모두 정규화되어 있어요.');
    process.exit(0);
  }

  await batch.commit();
  console.log(`\n📊 결과: ${updated}건 업데이트, ${skipped}건 변경 없음`);
  console.log('✨ 마이그레이션 완료!');
  process.exit(0);
}

migrate().catch(err => {
  console.error('❌ 오류:', err);
  process.exit(1);
});
