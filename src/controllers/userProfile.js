const { db, admin } = require('../services/firebase');

const USER_COLLECTIONS = [
  'routines',
  'completedTasks',
  'completedTasksArchive',
  'notifications',
  'routineReviewFlags',
  'chatLogs',
];

async function cascadeDeleteUser(uid) {
  try {
    await admin.auth().deleteUser(uid);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
  }

  await admin.firestore().recursiveDelete(db.collection('users').doc(uid));

  for (const col of USER_COLLECTIONS) {
    let hasMore = true;
    while (hasMore) {
      const snap = await db.collection(col).where('uid', '==', uid).limit(500).get();
      if (snap.empty) { hasMore = false; break; }
      const batch = db.batch();
      snap.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      hasMore = snap.size === 500;
    }
  }
}

/**
 * GET /api/profile
 * 로그인한 사용자의 프로파일 조회
 */
async function getProfile(req, res, next) {
  try {
    const uid = req.user.uid;
    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) {
      return res.status(404).json({ error: '프로파일이 없습니다. 온보딩을 먼저 완료하세요.' });
    }

    const userData = doc.data();

    const responseData = {
      ...userData,
      uid,
      email: userData.email || req.user.email,
      isOnboarded: userData.isOnboarded === true,
    };

    res.json(responseData);
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/profile
 * 계정 및 연관 데이터 전체 삭제
 */
async function deleteAccount(req, res, next) {
  try {
    const uid = req.user.uid;
    await cascadeDeleteUser(uid);
    res.json({ success: true, message: '계정이 삭제되었습니다.' });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/profile/stale-confirm
 * body: { key: string, confirmed: boolean }
 *
 * 프론트에서 오래된 customFact 재확인 팝업에 사용자가 응답한 결과를 처리한다.
 *
 * confirmed: true  → 아직 해당됨 → addedAt만 현재 시각으로 갱신 (6개월 카운트 리셋)
 * confirmed: false → 더 이상 해당 안 됨 → 사용자가 직접 확인했으므로 즉시 삭제
 *
 * 강제 삭제가 아닌 사용자 의사에 의한 삭제이므로 FieldValue.delete() 사용
 */
async function staleConfirm(req, res, next) {
  try {
    const uid = req.user.uid;
    const { key, confirmed } = req.body;

    if (!key || typeof confirmed !== 'boolean') {
      return res.status(400).json({ error: 'key와 confirmed(boolean) 값이 필요합니다.' });
    }

    const profileRef = db.collection('users').doc(uid);
    const profileDoc = await profileRef.get();
    if (!profileDoc.exists) {
      return res.status(404).json({ error: '프로파일이 없습니다.' });
    }

    const profile = profileDoc.data();
    const updates = {};

    if (confirmed) {
      // 아직 해당됨 → 타임스탬프만 갱신해서 6개월 카운트 리셋
      // 데이터는 유지, 만료 시점만 연장
      updates[`home.customFacts.${key}.addedAt`] = new Date().toISOString();
    } else {
      // 더 이상 해당 안 됨 → 사용자가 직접 확인했으므로 즉시 삭제
      // null로 초기화하지 말고 키 자체를 완전히 제거
      updates[`home.customFacts.${key}`] = admin.firestore.FieldValue.delete();
    }

    // 두 경우 모두 staleFlags에서 해당 key의 customFact 항목 제거
    // 문자열 플래그(hasPet 등)는 그대로 유지하고 해당 customFact 항목만 제거
    const currentStaleFlags = profile.staleFlags || [];
    const updatedStaleFlags = currentStaleFlags.filter(
      f => !(f && typeof f === 'object' && f.type === 'customFact' && f.key === key)
    );
    updates.staleFlags = updatedStaleFlags;
    updates.updatedAt = new Date().toISOString();

    await profileRef.update(updates);

    res.json({ success: true, key, confirmed });
  } catch (err) {
    next(err);
  }
}

module.exports = { getProfile, deleteAccount, staleConfirm, cascadeDeleteUser };
