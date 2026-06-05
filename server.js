require('dotenv').config();
const app = require('./src/app');
const pool = require('./src/db/pool');
const { startAuditScheduler } = require('./src/services/auditScheduler');

const PORT = process.env.PORT || 3000;

const start = async () => {
  try {
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL connected');
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
