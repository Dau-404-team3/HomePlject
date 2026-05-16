// ── middleware/errorHandler.js ────────────────────────────
function errorHandler(err, req, res, next) {
  console.error(`[${new Date().toISOString()}] ${err.stack}`);
  const status = err.status || 500;
  // 클라이언트가 직접 설정한 4xx 오류는 메시지를 그대로 전달, 5xx는 내부 오류 숨김
  const isClientError = status >= 400 && status < 500;
  res.status(status).json({
    error: isClientError ? (err.message || '요청이 잘못되었습니다.') : '서버 오류가 발생했습니다.',
  });
}

module.exports = errorHandler;
