// knowledgeBase 시드 스크립트
// knowledge.json + knowledge2.json 을 Firestore knowledgeBase 컬렉션에 삽입한다.
// 실행: npm run seed:knowledge  또는  node scripts/seedKnowledgeBase.js

const path = require('path');
const { db } = require('../src/services/firebase');

const SOURCES = [
  path.join(__dirname, 'knowledge.json'),
  path.join(__dirname, 'knowledge2.json'),
  path.join(__dirname, 'knowledge3.json'),
];

async function seedKnowledgeBase() {
  console.log('🌱 knowledgeBase 시드 스크립트 시작...\n');

  const allData = SOURCES.flatMap(src => {
    const items = require(src);
    console.log(`  📂 ${path.basename(src)}: ${items.length}건 로드`);
    return items;
  });
  console.log(`\n총 ${allData.length}건 삽입 시작\n`);

  let added = 0;
  const BATCH_SIZE = 500;

  for (let i = 0; i < allData.length; i += BATCH_SIZE) {
    const chunk = allData.slice(i, i + BATCH_SIZE);
    const batch = db.batch();

    for (const item of chunk) {
      const docRef = db.collection('knowledgeBase').doc();
      batch.set(docRef, {
        id:                    docRef.id,
        taskName:              item.taskName,
        space:                 item.space,
        tags:                  item.tags              || [],
        howTo:                 item.howTo             || [],
        tip:                   item.tip               || '',
        tipEmoji:              item.tipEmoji          || '✨',
        difficulty:            item.difficulty        || 'easy',
        estimatedMinutes:      item.estimatedMinutes  ?? null,
        relatedMisconceptions: item.relatedMisconceptions || [],
        ai_generated:          false,
        createdAt:             new Date().toISOString(),
      });
      added++;
      console.log(`  ✅ [${item.space}] ${item.taskName}`);
    }

    await batch.commit();
  }

  console.log(`\n📊 결과: ${added}건 삽입 완료`);
  console.log('✨ seedKnowledgeBase 완료!');
  process.exit(0);
}

seedKnowledgeBase().catch(err => {
  console.error('❌ 오류:', err);
  process.exit(1);
});
