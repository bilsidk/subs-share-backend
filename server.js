require('dotenv').config();
const app = require('./src/app');
const pool = require('./src/db/pool');
const { startAuditScheduler } = require('./src/services/auditScheduler');
const { runMigration } = require('./src/migrate');

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
    await pool.query('SELECT 1');
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
