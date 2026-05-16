// Firestore 연결 상태 진단 스크립트
// 실행: node scripts/testFirestore.js

const { db } = require('../src/services/firebase');

async function test() {
  try {
    // 쓰기 테스트
    await db.collection('users').doc('test-uid-001').set({
      testField: 'hello',
      createdAt: new Date().toISOString(),
    });
    console.log('✅ Firestore 쓰기 성공');

    // 읽기 테스트
    const doc = await db.collection('users').doc('test-uid-001').get();
    console.log('✅ Firestore 읽기 성공:', doc.data());

    // 삭제 테스트
    await db.collection('users').doc('test-uid-001').delete();
    console.log('✅ Firestore 삭제 성공');

    process.exit(0);
  } catch (err) {
    console.error('❌ Firestore 오류:', err);
    process.exit(1);
  }
}

test();
