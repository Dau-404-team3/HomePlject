const { db, bucket, admin } = require('../services/firebase');

// base64 data URI에서 MIME 타입·확장자·버퍼를 추출하는 헬퍼
// 지원 형식: JPEG, PNG, WebP, GIF, HEIC/HEIF
function parseImageBase64(imageBase64) {
  const mimeMatch = imageBase64.match(/^data:(image\/[\w+.-]+);base64,/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const extMap = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/heic': 'heic',
    'image/heif': 'heif',
  };
  const ext = extMap[mimeType] || 'jpg';
  const base64Data = imageBase64.replace(/^data:image\/[\w+.-]+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');
  return { mimeType, ext, buffer };
}

/**
 * POST /api/community/posts
 * 게시글 작성
 * 이미지가 있으면 base64를 디코딩해 Firebase Storage에 업로드 후 URL 저장
 */
async function createPost(req, res, next) {
  try {
    const uid = req.user.uid;
    const { type, title, content, tags = [], imageBase64 } = req.body;

    if (!['cleaning_cert', 'info_share'].includes(type)) {
      return res.status(400).json({ error: 'type은 cleaning_cert 또는 info_share여야 합니다.' });
    }
    if (!title?.trim()) {
      return res.status(400).json({ error: '제목을 입력해주세요.' });
    }
    if (title.trim().length > 100) {
      return res.status(400).json({ error: '제목은 100자 이내로 입력해주세요.' });
    }
    if (!content?.trim()) {
      return res.status(400).json({ error: '내용을 입력해주세요.' });
    }
    if (content.trim().length > 5000) {
      return res.status(400).json({ error: '내용은 5000자 이내로 입력해주세요.' });
    }

    let imageUrl = null;

    // 이미지가 있으면 Firebase Storage에 업로드
    if (imageBase64) {
      if (!bucket) {
        return res.status(500).json({ error: 'Firebase Storage가 설정되지 않았습니다. FIREBASE_STORAGE_BUCKET을 확인하세요.' });
      }

      const { mimeType, ext, buffer } = parseImageBase64(imageBase64);
      const filename = `community/${uid}/${Date.now()}.${ext}`;
      const file = bucket.file(filename);

      await file.save(buffer, { metadata: { contentType: mimeType } });
      await file.makePublic();
      imageUrl = `https://storage.googleapis.com/${process.env.FIREBASE_STORAGE_BUCKET}/${filename}`;
    }

    const now = new Date().toISOString();
    const postRef = db.collection('posts').doc();
    const post = {
      uid,
      type,
      title: title.trim(),
      content: content.trim(),
      imageUrl,
      tags: Array.isArray(tags) ? tags : [],
      likes: 0,
      commentCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    await postRef.set(post);

    res.status(201).json({ id: postRef.id, ...post });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/community/posts?type={all|cleaning_cert|info_share}&tag={tag}&cursor={lastDocId}
 * 게시글 목록 조회 — 최신순, 20개 단위 페이지네이션
 * type과 tag로 필터링 가능
 */
async function getPosts(req, res, next) {
  try {
    const { type, tag, cursor } = req.query;
    const limit = 20;

    let query = db.collection('posts').orderBy('createdAt', 'desc');

    // 타입 필터링 (all이면 필터 없음)
    if (type && type !== 'all') {
      if (!['cleaning_cert', 'info_share'].includes(type)) {
        return res.status(400).json({ error: 'type은 all | cleaning_cert | info_share 중 하나여야 합니다.' });
      }
      query = query.where('type', '==', type);
    }

    // 태그 필터링
    if (tag) {
      query = query.where('tags', 'array-contains', tag);
    }

    // 커서 기반 페이지네이션
    if (cursor) {
      const cursorDoc = await db.collection('posts').doc(cursor).get();
      if (cursorDoc.exists) {
        query = query.startAfter(cursorDoc);
      }
    }

    const snap = await query.limit(limit).get();
    const posts = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const nextCursor = posts.length === limit ? posts[posts.length - 1].id : null;

    res.json({ posts, nextCursor });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/community/posts/:postId
 * 게시글 상세 조회
 */
async function getPost(req, res, next) {
  try {
    const { postId } = req.params;
    const doc = await db.collection('posts').doc(postId).get();

    if (!doc.exists) {
      return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' });
    }

    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/community/posts/:postId
 * 게시글 수정 — 본인 게시글만 수정 가능
 */
async function updatePost(req, res, next) {
  try {
    const uid = req.user.uid;
    const { postId } = req.params;
    const { type, title, content, tags, imageBase64, removeImage } = req.body;

    if (type && !['cleaning_cert', 'info_share'].includes(type)) {
      return res.status(400).json({ error: 'type은 cleaning_cert 또는 info_share여야 합니다.' });
    }
    if (title !== undefined && !title?.trim()) {
      return res.status(400).json({ error: '제목을 입력해주세요.' });
    }
    if (title !== undefined && title.trim().length > 100) {
      return res.status(400).json({ error: '제목은 100자 이내로 입력해주세요.' });
    }
    if (content !== undefined && !content?.trim()) {
      return res.status(400).json({ error: '내용을 입력해주세요.' });
    }
    if (content !== undefined && content.trim().length > 5000) {
      return res.status(400).json({ error: '내용은 5000자 이내로 입력해주세요.' });
    }

    const doc = await db.collection('posts').doc(postId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' });
    }
    if (doc.data().uid !== uid) {
      return res.status(403).json({ error: '본인 게시글만 수정할 수 있습니다.' });
    }

    const updates = { updatedAt: new Date().toISOString() };
    if (type) updates.type = type;
    if (title) updates.title = title.trim();
    if (content) updates.content = content.trim();
    if (tags !== undefined) updates.tags = Array.isArray(tags) ? tags : [];

    // 기존 이미지 URL에서 Storage 경로 추출 후 삭제하는 헬퍼
    async function deleteStorageImage(imageUrl) {
      if (!bucket || !imageUrl) return;
      try {
        const prefix = `https://storage.googleapis.com/${process.env.FIREBASE_STORAGE_BUCKET}/`;
        if (imageUrl.startsWith(prefix)) {
          await bucket.file(imageUrl.slice(prefix.length)).delete();
        }
      } catch {
        // 파일이 없어도 무시
      }
    }

    const existingImageUrl = doc.data().imageUrl;

    if (imageBase64) {
      // 새 이미지 업로드: 기존 이미지 먼저 삭제
      if (!bucket) return res.status(500).json({ error: 'Firebase Storage가 설정되지 않았습니다.' });
      await deleteStorageImage(existingImageUrl);

      const { mimeType, ext, buffer } = parseImageBase64(imageBase64);
      const filename = `community/${uid}/${Date.now()}.${ext}`;
      const file = bucket.file(filename);
      await file.save(buffer, { metadata: { contentType: mimeType } });
      await file.makePublic();
      updates.imageUrl = `https://storage.googleapis.com/${process.env.FIREBASE_STORAGE_BUCKET}/${filename}`;
    } else if (removeImage) {
      // 이미지 삭제 요청
      await deleteStorageImage(existingImageUrl);
      updates.imageUrl = null;
    }

    await db.collection('posts').doc(postId).update(updates);

    res.json({ id: postId, ...doc.data(), ...updates });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/community/posts/:postId
 * 게시글 삭제 — 본인 게시글만 삭제 가능
 */
async function deletePost(req, res, next) {
  try {
    const uid = req.user.uid;
    const { postId } = req.params;

    const doc = await db.collection('posts').doc(postId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' });
    }

    // 본인 게시글인지 확인
    if (doc.data().uid !== uid) {
      return res.status(403).json({ error: '본인 게시글만 삭제할 수 있습니다.' });
    }

    // 첨부 이미지가 있으면 Storage에서도 삭제
    const { imageUrl } = doc.data();
    if (bucket && imageUrl) {
      try {
        const prefix = `https://storage.googleapis.com/${process.env.FIREBASE_STORAGE_BUCKET}/`;
        if (imageUrl.startsWith(prefix)) {
          await bucket.file(imageUrl.slice(prefix.length)).delete();
        }
      } catch {
        // 파일이 없어도 게시글 삭제는 계속 진행
      }
    }

    await db.collection('posts').doc(postId).delete();

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/community/posts/:postId/like
 * 좋아요 토글 — 이미 눌렀으면 취소, 안 눌렀으면 추가
 */
async function toggleLike(req, res, next) {
  try {
    const uid = req.user.uid;
    const { postId } = req.params;

    // 게시글 존재 확인
    const postDoc = await db.collection('posts').doc(postId).get();
    if (!postDoc.exists) {
      return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' });
    }

    // 이미 좋아요를 눌렀는지 확인
    const likeSnap = await db.collection('likes')
      .where('postId', '==', postId)
      .where('uid', '==', uid)
      .limit(1)
      .get();

    const postRef = db.collection('posts').doc(postId);
    const currentLikes = postDoc.data().likes || 0;

    if (!likeSnap.empty) {
      // 이미 좋아요 → 취소
      await likeSnap.docs[0].ref.delete();
      await postRef.update({ likes: Math.max(0, currentLikes - 1) });
      return res.json({ liked: false, likes: Math.max(0, currentLikes - 1) });
    }

    // 좋아요 추가
    await db.collection('likes').add({
      postId,
      uid,
      createdAt: new Date().toISOString(),
    });
    await postRef.update({ likes: currentLikes + 1 });

    res.json({ liked: true, likes: currentLikes + 1 });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/community/posts/:postId/comments
 * 댓글 작성
 */
async function createComment(req, res, next) {
  try {
    const uid = req.user.uid;
    const { postId } = req.params;
    const { content } = req.body;

    if (!content?.trim()) {
      return res.status(400).json({ error: '댓글 내용을 입력해주세요.' });
    }
    if (content.trim().length > 1000) {
      return res.status(400).json({ error: '댓글은 1000자 이내로 입력해주세요.' });
    }

    // 게시글 존재 확인
    const postDoc = await db.collection('posts').doc(postId).get();
    if (!postDoc.exists) {
      return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' });
    }

    const now = new Date().toISOString();
    const commentRef = db.collection('comments').doc();
    const comment = {
      postId,
      uid,
      content: content.trim(),
      createdAt: now,
    };

    await commentRef.set(comment);
    await db.collection('posts').doc(postId).update({
      commentCount: admin.firestore.FieldValue.increment(1),
    });

    res.status(201).json({ id: commentRef.id, ...comment });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/community/posts/:postId/comments
 * 댓글 목록 조회 — 오래된 순
 */
async function getComments(req, res, next) {
  try {
    const { postId } = req.params;

    // orderBy + where 조합은 복합 인덱스가 필요하므로 메모리 정렬로 대체
    const snap = await db.collection('comments')
      .where('postId', '==', postId)
      .get();

    const comments = snap.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));

    res.json({ comments });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/community/comments/:commentId
 * 댓글 삭제 — 본인 댓글만 삭제 가능
 */
async function deleteComment(req, res, next) {
  try {
    const uid = req.user.uid;
    const { commentId } = req.params;

    const doc = await db.collection('comments').doc(commentId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: '댓글을 찾을 수 없습니다.' });
    }

    // 본인 댓글인지 확인
    if (doc.data().uid !== uid) {
      return res.status(403).json({ error: '본인 댓글만 삭제할 수 있습니다.' });
    }

    const { postId } = doc.data();
    await db.collection('comments').doc(commentId).delete();
    if (postId) {
      await db.collection('posts').doc(postId).update({
        commentCount: admin.firestore.FieldValue.increment(-1),
      });
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createPost,
  getPosts,
  getPost,
  updatePost,
  deletePost,
  toggleLike,
  createComment,
  getComments,
  deleteComment,
};
