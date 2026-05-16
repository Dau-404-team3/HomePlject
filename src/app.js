const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const errorHandler = require('./middleware/errorHandler');

const authRoutes        = require('./routes/auth');
const onboardingRoutes  = require('./routes/onboarding');
const routineRoutes     = require('./routes/routine');
const guideRoutes       = require('./routes/guide');
const chatbotRoutes     = require('./routes/chatbot');
const notificationRoutes = require('./routes/notification');
const profileRoutes     = require('./routes/profile');
const communityRoutes   = require('./routes/community');

const app = express();

app.use(helmet());

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim());
app.use(cors({
  origin: (origin, callback) => {
    // 출처가 없는 요청(서버간 호출, curl 등)은 허용
    if (!origin) return callback(null, true);
    if (allowedOrigins && allowedOrigins.length > 0) {
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('CORS policy violation'));
    }
    // ALLOWED_ORIGINS 미설정 시 개발환경으로 간주, 모두 허용
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '1mb' }));

// 인증 엔드포인트 전용 강화 rate limit
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15분
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
});

// 일반 API rate limit
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
});

app.get('/', (req, res) => res.json({ status: 'ok', message: 'CleanHome API server is running.' }));

app.use('/api/auth',         authLimiter, authRoutes);
app.use('/api/onboarding',   generalLimiter, onboardingRoutes);
app.use('/api/routine',      generalLimiter, routineRoutes);
app.use('/api/guide',        generalLimiter, guideRoutes);
app.use('/api/chatbot',      generalLimiter, chatbotRoutes);
app.use('/api/notification', generalLimiter, notificationRoutes);
app.use('/api/profile',      generalLimiter, profileRoutes);
app.use('/api/community',    generalLimiter, communityRoutes);

// 전역 에러 핸들러 (항상 마지막에)
app.use(errorHandler);

module.exports = app;
