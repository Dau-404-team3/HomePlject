const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const {
  createPost,
  getPosts,
  getPost,
  updatePost,
  deletePost,
  toggleLike,
  createComment,
  getComments,
  deleteComment,
} = require('../controllers/community');

// 게시글 목록 조회 (type, tag 필터 / cursor 페이지네이션)
router.get('/posts',                       verifyToken, getPosts);

// 게시글 작성 (이미지 base64 포함 가능)
router.post('/posts',                      verifyToken, createPost);

// 게시글 상세 조회
router.get('/posts/:postId',               verifyToken, getPost);

// 게시글 수정 — 본인만 가능
router.put('/posts/:postId',               verifyToken, updatePost);

// 게시글 삭제 — 본인만 가능
router.delete('/posts/:postId',            verifyToken, deletePost);

// 좋아요 토글
router.post('/posts/:postId/like',         verifyToken, toggleLike);

// 댓글 목록 조회
router.get('/posts/:postId/comments',      verifyToken, getComments);

// 댓글 작성
router.post('/posts/:postId/comments',     verifyToken, createComment);

// 댓글 삭제 — 본인만 가능
router.delete('/comments/:commentId',      verifyToken, deleteComment);

module.exports = router;
