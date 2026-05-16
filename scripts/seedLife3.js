// life3.json → Firestore lifeKnowledge 삽입
// 실행: node scripts/seedLife3.js

const path = require('path');
const { db } = require('../src/services/firebase');

async function seed() {
  const items = require(path.join(__dirname, 'life3.json'));
  console.log(`🌱 life3.json: ${items.length}건 삽입 시작\n`);

  let added = 0;
  const BATCH_SIZE = 500;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    const batch = db.batch();

    for (const item of chunk) {
      const docRef = db.collection('lifeKnowledge').doc();
      batch.set(docRef, {
        id:           docRef.id,
        title:        item.title,
        category:     item.category,
        tags:         item.tags    || [],
        content:      item.content || '',
        source:       item.source  || '',
        ai_generated: false,
        createdAt:    new Date().toISOString(),
      });
      added++;
      console.log(`  ✅ [${item.category}] ${item.title}`);
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
