// lifeKnowledge 시드 스크립트
// life.json + life2.json 을 Firestore lifeKnowledge 컬렉션에 삽입한다.
// 실행: npm run seed:life  또는  node scripts/seedLifeKnowledge.js

const path = require('path');
const { db } = require('../src/services/firebase');

const SOURCES = [
  path.join(__dirname, 'life.json'),
  path.join(__dirname, 'life2.json'),
];

async function seedLifeKnowledge() {
  console.log('🌱 lifeKnowledge 시드 스크립트 시작...\n');

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
  console.log('✨ seedLifeKnowledge 완료!');
  process.exit(0);
}

seedLifeKnowledge().catch(err => {
  console.error('❌ 오류:', err);
  process.exit(1);
});
