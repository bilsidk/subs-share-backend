const pool = require('./db/pool');

// Idempotent additive migration — safe to run on every boot.
async function runMigration() {
  // 1. Allow 'cancelled' status. The tasks_status_check constraint didn't include
  //    it, so DELETE /tasks/:id (cancel) failed with a 500 on every attempt.
  try {
    await pool.query(`ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check`);
    await pool.query(
      `ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
       CHECK (status IN ('active','paused','completed','cancelled'))`
    );
  } catch (e) { console.error('[migrate] tasks_status_check:', e.message); }

  // 2. Welcome-bonus-once per Google account — survives account deletion so a
  //    user can't delete + re-sign-up with the same email to farm the 50 coins.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS account_history (
        google_id     VARCHAR(255) PRIMARY KEY,
        bonus_granted BOOLEAN DEFAULT FALSE,
        was_banned    BOOLEAN DEFAULT FALSE,
        ban_reason    TEXT,
        updated_at    TIMESTAMP DEFAULT NOW()
      )`);
  } catch (e) { console.error('[migrate] account_history:', e.message); }
}

module.exports = { runMigration };
