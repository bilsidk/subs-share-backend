require('dotenv').config();
const app = require('./src/app');
const pool = require('./src/db/pool');
const { startAuditScheduler } = require('./src/services/auditScheduler');
const { runMigration } = require('./src/migrate');

// Process-level safety nets — registered as early as possible, before app.listen.
// A stray rejection must not down all users; log only and let the process keep running
// (Node >= 18 exits on unhandled rejection by default, so this handler is strictly safer).
process.on('unhandledRejection', (err) => { console.error('[unhandledRejection]', err); });
// Unknown state after an uncaught exception — log then exit so Railway restarts clean.
process.on('uncaughtException', (err) => { console.error('[uncaughtException]', err); process.exit(1); });

// Bound every YouTube Data API / Android Publisher / Play Integrity call that reads
// the global googleapis options, so a stalled Google API call can't hang forever.
const { google } = require('googleapis');
google.options({ timeout: 8000 });

const PORT = process.env.PORT || 3000;

const start = async () => {
  try {
    // Fail fast on a missing/weak signing secret — JWT auth AND the Play Integrity
    // nonce HMAC both derive from it, so a blank value would silently accept forgeable
    // tokens. Better to refuse to boot than to run insecurely.
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
      console.error('❌ JWT_SECRET is missing or too short (need ≥16 chars). Refusing to start.');
      process.exit(1);
    }
    // Retry with backoff to absorb a Neon serverless cold-start wake instead of
    // crash-looping on the first failed connection attempt.
    const RETRY_DELAYS_MS = [2000, 4000, 8000];
    let connected = false;
    let lastErr;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        await pool.query('SELECT 1');
        connected = true;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < RETRY_DELAYS_MS.length) {
          console.error(`DB connection attempt ${attempt + 1} failed, retrying in ${RETRY_DELAYS_MS[attempt]}ms:`, e.message);
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
        }
      }
    }
    if (!connected) throw lastErr;
    console.log('✅ PostgreSQL connected');
    try { await runMigration(); console.log('✅ Migration applied'); }
    catch (e) { console.error('Migration error (continuing):', e.message); }
    app.listen(PORT, () => {
      console.log(`🚀 Subs Share API running on port ${PORT}`);
      startAuditScheduler();
    });
  } catch (err) {
    console.error('❌ DB connection failed:', err.message);
    process.exit(1);
  }
};

start();
