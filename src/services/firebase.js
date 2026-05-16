const admin = require('firebase-admin');

if (!admin.apps.length) {
  let credential;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    credential = admin.credential.cert(serviceAccount);
  } else {
    // 로컬 개발용: serviceAccountKey.json 파일 직접 사용
    // 절대 Git에 커밋하지 마세요
    const serviceAccount = require('../../serviceAccountKey.json');
    credential = admin.credential.cert(serviceAccount);
  }

  admin.initializeApp({
    credential,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}

const db = admin.firestore();
const auth = admin.auth();

// FIREBASE_STORAGE_BUCKET 환경변수가 없으면 bucket은 null로 설정
// 커뮤니티 이미지 업로드 전에 bucket이 null인지 확인 필요
const bucket = process.env.FIREBASE_STORAGE_BUCKET
  ? admin.storage().bucket()
  : null;

module.exports = { db, auth, admin, bucket };
