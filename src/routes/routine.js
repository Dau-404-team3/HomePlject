const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const {
  getTodayRoutine,
  completeChecklist,
  uncompleteChecklist,
  skipChecklist,
  editRoutine,
  resetRoutine,
  getWeeklyStats,
  getAiComment,
  getRoutineByFrequency,
  getCalendar,
  getCatalogueCounts,
  getSpaceRecommendations,
  refreshAiRecommendations,
  getActiveTaskIds,
} = require('../controllers/behaviorLog');

router.get('/today',               verifyToken, getTodayRoutine);
router.post('/checklist/complete',   verifyToken, completeChecklist);
router.post('/checklist/uncomplete', verifyToken, uncompleteChecklist);
router.post('/checklist/skip',       verifyToken, skipChecklist);
router.post('/edit',               verifyToken, editRoutine);
router.post('/reset',              verifyToken, resetRoutine);

// 홈 화면 — 이번 주 달성률
router.get('/weekly-stats',        verifyToken, getWeeklyStats);

// 홈 화면 — AI 한마디 (하루 1회 캐싱)
router.get('/ai-comment',          verifyToken, getAiComment);

// 루틴 화면 — 매일/주간/월간 탭 필터링
router.get('/by-frequency',        verifyToken, getRoutineByFrequency);

// 캘린더 화면 — 월별 루틴 이력
router.get('/calendar',            verifyToken, getCalendar);

// 루틴 추가 화면 — 활성 루틴 전체 태스크 ID (이미 추가된 루틴 표시용)
router.get('/task-ids',                  verifyToken, getActiveTaskIds);

// 루틴 추가 화면 — 공간별 카탈로그 항목 수 (DB 기반)
router.get('/catalogue/counts',          verifyToken, getCatalogueCounts);

// 루틴 추가 화면 — 공간별 AI 맞춤 추천 ID 목록
router.get('/recommendations/:spaceKey', verifyToken, getSpaceRecommendations);

// 건너뜀 패턴 감지 후 AI 맞춤 추천 재생성 (홈 루틴 변경 없음, 알림 미발송)
router.post('/recommendations/refresh', verifyToken, refreshAiRecommendations);

module.exports = router;
