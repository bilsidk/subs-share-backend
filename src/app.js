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
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: 'Too many requests' }));
app.use(express.json({ limit: '10kb' }));

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.use('/auth',         authRoutes);
app.use('/users',        userRoutes);
app.use('/channels',     channelRoutes);
app.use('/tasks',        taskRoutes);
app.use('/transactions', transactionRoutes);
app.use('/admin',        adminRoutes);

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use(errorHandler);

module.exports = app;
