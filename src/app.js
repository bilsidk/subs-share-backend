const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const authRoutes        = require('./routes/auth');
const userRoutes        = require('./routes/users');
const channelRoutes     = require('./routes/channels');
const taskRoutes        = require('./routes/tasks');
const transactionRoutes = require('./routes/transactions');
const paymentRoutes     = require('./routes/payments');
const adminRoutes       = require('./routes/admin');
const { errorHandler }  = require('./middleware/errorHandler');
const { initOnBoot }    = require('./services/settingsService');

const app = express();
app.set('trust proxy', 1);
// When served under a base path (e.g. cPanel/Passenger mounts the app at /api),
// strip that prefix so the root-mounted routes below still match. No-op at root.
app.use((req, res, next) => {
  if (req.url === '/api') req.url = '/';
  else if (req.url.startsWith('/api/')) req.url = req.url.slice(4);
  next();
});
// CSP off: the web app inlines its scripts and loads Google Identity Services.
// COOP must allow popups or the GIS sign-in popup can't message back.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
}));
// ALLOWED_ORIGINS: unset -> same-origin only; "*" -> reflect any origin (the cors
// package treats ["*"] as a literal match, NOT a wildcard, so handle it explicitly);
// otherwise a comma-separated allowlist (trimmed).
const _allowedOrigins = process.env.ALLOWED_ORIGINS?.trim();
app.use(cors({
  origin: !_allowedOrigins ? false
        : _allowedOrigins === '*' ? true
        : _allowedOrigins.split(',').map(o => o.trim()),
}));
app.use(express.json({ limit: '10kb' }));

// Web app (same-origin static SPA — see /web)
app.use(express.static(path.join(__dirname, '..', 'web')));

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
// Limiters for verify/complete/campaign-creation live inside routes/tasks.js
// so they are part of the normal middleware chain, not standalone app.post routes.
app.use('/tasks',                        taskRoutes);
app.use('/transactions',                 transactionRoutes);
app.use('/payments',                     paymentRoutes);
app.use('/admin',        adminLimiter,   adminRoutes);

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use(errorHandler);

initOnBoot();

module.exports = app;
