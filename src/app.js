const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const authRoutes        = require('./routes/auth');
const userRoutes        = require('./routes/users');
const channelRoutes     = require('./routes/channels');
const taskRoutes        = require('./routes/tasks');
const transactionRoutes = require('./routes/transactions');
const adminRoutes       = require('./routes/admin');
const { errorHandler }  = require('./middleware/errorHandler');

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
app.use(express.json({ limit: '10kb' }));

// ── Rate limiters ────────────────────────────────────────────

// Global — 200 requests per 15 min per IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Auth — 10 sign-in attempts per 15 min per IP (brute force protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many sign-in attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Task verification — 30 per 15 min per IP (anti-bot)
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many verification attempts, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Campaign creation — 20 per hour per IP
const campaignLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many campaigns created, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Admin — 60 per 15 min per IP
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: 'Too many admin requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Apply limiters ───────────────────────────────────────────
app.use(globalLimiter);

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.use('/auth',         authLimiter,    authRoutes);
app.use('/users',                        userRoutes);
app.use('/channels',                     channelRoutes);
app.use('/tasks',                        taskRoutes);
app.use('/tasks/:id/verify', verifyLimiter);   // extra limit on verify endpoint
app.use('/tasks',        campaignLimiter);      // also limits campaign creation
app.use('/transactions',                 transactionRoutes);
app.use('/admin',        adminLimiter,   adminRoutes);

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use(errorHandler);

module.exports = app;
