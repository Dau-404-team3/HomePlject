// knowledgeBase 컬렉션 전체 삭제
const { db } = require('../src/services/firebase');

async function clearCollection(colName) {
  let deleted = 0;
  while (true) {
    const snap = await db.collection(colName).limit(500).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    deleted += snap.size;
    console.log(`  🗑️  ${deleted}건 삭제 중...`);
  }
  console.log(`✅ ${colName} 전체 삭제 완료 (총 ${deleted}건)`);
}

clearCollection('knowledgeBase')
  .then(() => process.exit(0))
  .catch(err => { console.error('❌', err); process.exit(1); });
