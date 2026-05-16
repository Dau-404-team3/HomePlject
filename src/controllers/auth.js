const { db } = require('../services/firebase');
const { cascadeDeleteUser } = require('./userProfile');

const FIREBASE_API_BASE = 'https://identitytoolkit.googleapis.com/v1/accounts';
const FIREBASE_TOKEN_URL = 'https://securetoken.googleapis.com/v1/token';

const FIREBASE_ERROR_MESSAGES = {
  EMAIL_EXISTS: '이미 사용 중인 이메일입니다.',
  INVALID_EMAIL: '올바르지 않은 이메일 형식입니다.',
  WEAK_PASSWORD: '비밀번호는 6자 이상이어야 합니다.',
  EMAIL_NOT_FOUND: '등록되지 않은 이메일입니다.',
  INVALID_PASSWORD: '비밀번호가 올바르지 않습니다.',
  INVALID_LOGIN_CREDENTIALS: '이메일 또는 비밀번호가 올바르지 않습니다.',
  USER_DISABLED: '비활성화된 계정입니다. 고객센터에 문의하세요.',
  TOO_MANY_ATTEMPTS_TRY_LATER: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
  OPERATION_NOT_ALLOWED: '이 로그인 방식은 허용되지 않습니다.',
  MISSING_PASSWORD: '비밀번호를 입력해주세요.',
  INVALID_REFRESH_TOKEN: '유효하지 않은 갱신 토큰입니다.',
  TOKEN_EXPIRED: '토큰이 만료되었습니다. 다시 로그인해주세요.',
};

function parseFirebaseError(body) {
  const code = body?.error?.errors?.[0]?.message || body?.error?.message || '';
  const matched = Object.keys(FIREBASE_ERROR_MESSAGES).find((key) => code.includes(key));
  return matched ? FIREBASE_ERROR_MESSAGES[matched] : '처리 중 오류가 발생했습니다.';
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateInputs(email, password) {
  if (!email || !password) return '이메일과 비밀번호를 모두 입력해주세요.';
  if (!validateEmail(email)) return '올바른 이메일 형식을 입력해주세요.';
  if (password.length < 6) return '비밀번호는 6자 이상이어야 합니다.';
  return null;
}

async function callFirebaseAuth(endpoint, payload) {
  const apiKey = process.env.FIREBASE_API_KEY;
  const url = `${FIREBASE_API_BASE}:${endpoint}?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

async function signup(req, res) {
  const { email, password } = req.body;
  const validationError = validateInputs(email, password);
  if (validationError) return res.status(400).json({ error: validationError });

  const { ok, data } = await callFirebaseAuth('signUp', {
    email,
    password,
    returnSecureToken: true,
  });

  if (!ok) return res.status(400).json({ error: parseFirebaseError(data) });

  const uid = data.localId;

  // Firebase Auth 계정 생성 성공 후 Firestore users/{uid} 최소 문서 생성
  // 온보딩 완료 전에도 uid 기반으로 문서가 존재해야 함
  // isOnboarded: false → 온보딩 컨트롤러에서 전체 프로파일로 덮어씀
  await db.collection('users').doc(uid).set({
    email,
    personality: {},
    home: {},
    knowledgeMap: {},
    spaceStatus: {},
    behaviorStats: {
      totalChecklistCompleted: 0,
      skipPatterns: {},
      completionByHour: {},
      currentStreak: 0,
    },
    staleFlags: [],
    todayComment: null,
    activeRoutineId: null,
    fcmToken: null,
    isOnboarded: false,
    createdAt: new Date().toISOString(),
  });

  return res.status(201).json({
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid,
    email: data.email,
  });
}

async function login(req, res) {
  const { email, password } = req.body;
  const validationError = validateInputs(email, password);
  if (validationError) return res.status(400).json({ error: validationError });

  const { ok, data } = await callFirebaseAuth('signInWithPassword', {
    email,
    password,
    returnSecureToken: true,
  });

  if (!ok) return res.status(401).json({ error: parseFirebaseError(data) });

  return res.json({
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.localId,
    email: data.email,
  });
}

async function refreshToken(req, res) {
  const { refreshToken: token } = req.body;
  if (!token) return res.status(400).json({ error: '갱신 토큰이 없습니다.' });

  const apiKey = process.env.FIREBASE_API_KEY;
  try {
    const response = await fetch(`${FIREBASE_TOKEN_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(token)}`,
    });
    
    const data = await response.json();

    if (!response.ok) {
      // 프론트엔드 인터셉터가 인식할 수 있도록 code를 명시적으로 전달
      return res.status(401).json({ 
        error: parseFirebaseError(data),
        code: 'TOKEN_EXPIRED' // 이 부분이 추가되어야 합니다!
      });
    }

    return res.json({
      idToken: data.id_token,
      refreshToken: data.refresh_token,
    });
  } catch (err) {
    return res.status(500).json({ error: '서버 오류' });
  }
}

async function resetPassword(req, res) {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: '이메일을 입력해주세요.' });
  if (!validateEmail(email)) return res.status(400).json({ error: '올바른 이메일 형식을 입력해주세요.' });

  const { ok, data } = await callFirebaseAuth('sendOobCode', {
    requestType: 'PASSWORD_RESET',
    email,
  });

  if (!ok) return res.status(400).json({ error: parseFirebaseError(data) });

  return res.json({ message: '비밀번호 재설정 이메일을 발송했습니다.' });
}

async function withdraw(req, res) {
  const uid = req.user?.uid;
  if (!uid) return res.status(401).json({ error: '인증 정보가 없습니다.' });

  await cascadeDeleteUser(uid);
  return res.json({ message: '계정이 삭제되었습니다.' });
}

function getMe(req, res) {
  const { uid, email } = req.user;
  return res.json({ uid, email });
}

module.exports = { signup, login, refreshToken, resetPassword, withdraw, getMe };
