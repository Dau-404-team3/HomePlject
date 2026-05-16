const { db, admin } = require('./firebase');

/**
 * aiProfileUpdater
 *
 * 챗봇 응답(chatbotReply)에 포함된 profileChanges를 파싱해
 * Firestore 사용자 프로파일을 자동 갱신한다.
 *
 * 설계 원칙:
 * - Claude를 별도로 호출하지 않음 (챗봇 응답에 분석 결과 포함)
 * - 이 함수는 Firestore 업데이트만 담당
 * - 실패해도 챗봇 응답에 영향 없도록 try-catch로 보호
 */

/**
 * 챗봇 응답의 profileChanges를 파싱해 프로파일을 자동 갱신한다.
 * @param {string} uid - 사용자 UID
 * @param {string} userMessage - 사용자 메시지 (로깅용)
 * @param {Object} profileChanges - chatbot.js에서 파싱된 profileChanges 객체
 */
async function analyzeAndUpdateProfile(uid, userMessage, profileChanges) {
  try {
    // profileChanges가 없으면 업데이트 불필요
    if (!profileChanges) return;

    const profileRef = db.collection('users').doc(uid);
    const profileDoc = await profileRef.get();
    if (!profileDoc.exists) return;

    const profile = profileDoc.data();

    // 기존 customFacts를 알아야
    // 중복 저장과 모순 감지가 가능함
    // 이미 "청소기 없음"이 저장됐는데 또 저장하지 않도록
    const currentCustomFacts = profile?.home?.customFacts || {};

    const updates = {};

    // ── 오개념 감지 처리 ──────────────────────────────────────
    // AI가 감지한 오개념을 knowledgeMap에 자동 추가
    // 이미 교정된 항목(corrected)은 덮어쓰지 않음
    const { knowledgeUpdate } = profileChanges;
    if (knowledgeUpdate?.detected && knowledgeUpdate.key) {
      const existingStatus = profile.knowledgeMap?.[knowledgeUpdate.key];

      // corrected 상태면 덮어쓰지 않음
      if (existingStatus !== 'corrected') {
        const status = knowledgeUpdate.status || 'misconception';
        updates[`knowledgeMap.${knowledgeUpdate.key}`] = status;
      }
    }

    // ── 프로파일 사실 변경 처리 ───────────────────────────────
    // 대화 중 드러난 사실 변경을 해당 필드에 반영
    // 예: "고양이 입양했어요" → home.hasPet: true
    const { profileUpdate } = profileChanges;
    if (profileUpdate?.detected && profileUpdate.field) {
      if (profileUpdate.action === 'delete' || profileUpdate.newValue === null) {
        // delete 액션이면 필드를 null로 설정
        updates[profileUpdate.field] = null;
      } else if (profileUpdate.action === 'update' && profileUpdate.newValue !== undefined) {
        updates[profileUpdate.field] = profileUpdate.newValue;
      }
    }

    // ── 감정/동기 변화 처리 ──────────────────────────────────
    // 대화 중 드러난 동기 변화를 personality 필드에 반영
    // 예: "요즘 청소 너무 힘들어요" → motivationStyle: low
    const { motivationUpdate } = profileChanges;
    if (motivationUpdate?.detected && motivationUpdate.field && motivationUpdate.newValue !== undefined) {
      updates[motivationUpdate.field] = motivationUpdate.newValue;
    }

    // ── customFacts 처리 ─────────────────────────────────────
    // AI가 대화에서 감지한 새로운 사실을 customFacts에 저장
    // 자동 만료 없음 — 삭제는 사용자 확인 또는 사용자 번복 시에만 발생
    const { customFactsUpdate } = profileChanges;
    if (customFactsUpdate?.detected) {
      const { action, key, value } = customFactsUpdate;

      if (action === 'add' && key && value) {
        // 중복 방지: chatbot 프롬프트에서 1차 필터링하지만
        // 여기서도 이미 존재하는 키면 저장하지 않음
        if (!currentCustomFacts[key]) {
          // customFacts 저장 시 반드시 addedAt 타임스탬프 포함
          // addedAt이 있어야 profileScheduler가 6개월 경과 여부를 판단할 수 있음
          updates[`home.customFacts.${key}`] = {
            value,
            addedAt: new Date().toISOString(),
          };
        }
      } else if (action === 'remove' && key) {
        // null로 초기화하지 말고 키 자체를 완전히 제거
        // null이 남아있으면 프롬프트에 빈 값이 포함되어 토큰 낭비
        updates[`home.customFacts.${key}`] = admin.firestore.FieldValue.delete();
      }
    }

    // 업데이트할 내용이 있을 때만 Firestore 쓰기 실행
    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date().toISOString();
      await profileRef.update(updates);
    }
  } catch (err) {
    // 프로파일 업데이트 실패는 챗봇 응답에 영향을 주지 않음
    console.error('[aiProfileUpdater] 프로파일 업데이트 실패:', err.message);
  }
}

module.exports = { analyzeAndUpdateProfile };
