// knowledge5.json → Firestore knowledgeBase 삽입
// 실행: node scripts/seedKnowledge5.js

const path = require('path');
const { db } = require('../src/services/firebase');

async function seed() {
  const items = require(path.join(__dirname, 'knowledge5.json'));
  console.log(`🌱 knowledge5.json: ${items.length}건 삽입 시작\n`);

  let added = 0;
  const BATCH_SIZE = 500;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
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
  process.exit(0);
}

seed().catch(err => {
  console.error('❌ 오류:', err);
  process.exit(1);
});
