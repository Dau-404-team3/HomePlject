const { auth } = require('../services/firebase');

async function verifyToken(req, res, next) {
  const header = req.headers.authorization;

  // 1. 토큰이 아예 없는 경우
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ 
      error: '인증 토큰이 없습니다.', 
      code: 'TOKEN_MISSING' // 클라이언트가 구분할 수 있도록 코드 추가
    });
  }

  const idToken = header.split('Bearer ')[1];
  try {
    const decoded = await auth.verifyIdToken(idToken);
    req.user = decoded;
    next();
  } catch (err) {
    // 2. 토큰 만료 또는 유효하지 않은 경우
    // Firebase 에러 코드 상 'auth/id-token-expired'인 경우 TOKEN_EXPIRED 반환
    const isExpired = err.code === 'auth/id-token-expired' || err.errorInfo?.code === 'auth/id-token-expired';
    
    const code = isExpired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
    const message = isExpired ? '인증이 만료되었습니다.' : '유효하지 않은 토큰입니다.';

    console.error(`[Auth Error] ${code}:`, err.message); // 서버 로그 기록

    return res.status(401).json({ 
      error: message, 
      code: code 
    });
  }
}

module.exports = { verifyToken };