const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Local Postgres (same-host, e.g. cPanel) has no TLS — disable SSL for localhost.
  // Remote managed PG (e.g. Neon) in production still verifies the cert.
  ssl: /@(?:localhost|127\.0\.0\.1)[:\/]/.test(process.env.DATABASE_URL || '')
    ? false
    : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false),
  max: 10,
  idleTimeoutMillis: 30000,
  // Raised from 2000: a Neon serverless cold-start wake can take longer than 2s,
  // which would otherwise false-crash boot.
  connectionTimeoutMillis: 10000,
  // Bound how long a single query/lock can run so a stuck query can't hang a
  // connection (and the pool) forever.
  options: '-c statement_timeout=15000 -c lock_timeout=8000',
});

pool.on('error', (err) => {
  console.error('Unexpected pool error:', err);
});

module.exports = pool;
