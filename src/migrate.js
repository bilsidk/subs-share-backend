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

  // 3. Store each user's own-channel subscriber count (for finding big creators).
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscriber_count INTEGER DEFAULT 0`);
    // Backfill existing users from their own channel's already-stored count.
    await pool.query(`
      UPDATE users u SET subscriber_count = c.subscriber_count
      FROM channels c
      WHERE c.youtube_channel_id = u.youtube_channel_id
        AND COALESCE(u.subscriber_count, 0) = 0 AND COALESCE(c.subscriber_count, 0) > 0`);
  } catch (e) { console.error('[migrate] users.subscriber_count:', e.message); }

  // 4. Add 'purchase' to transactions type check for NowPayments.
  try {
    await pool.query(`ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check`);
    await pool.query(
      `ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
       CHECK (type IN ('earned', 'spent', 'bonus', 'purchase'))`
    );
  } catch (e) { console.error('[migrate] transactions_type_check:', e.message); }

  // 5. Pending payments table for NowPayments invoices.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pending_payments (
        invoice_id    VARCHAR(255) PRIMARY KEY,
        order_id      VARCHAR(255) NOT NULL,
        user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
        usd           INTEGER NOT NULL,
        coins         INTEGER NOT NULL,
        bonus_pct     INTEGER DEFAULT 0,
        status        VARCHAR(20) DEFAULT 'pending',
        created_at    TIMESTAMP DEFAULT NOW()
      )`);
  } catch (e) { console.error('[migrate] pending_payments:', e.message); }

  // 6. Server-stamped task starts — so the verify delay is measured from a time
  //    the server controls, not a client-supplied (forgeable) started_at.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS task_starts (
        user_id    INTEGER NOT NULL,
        task_id    INTEGER NOT NULL,
        started_at TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, task_id)
      )`);
  } catch (e) { console.error('[migrate] task_starts:', e.message); }

  // 7. Hard uniqueness on completions — a user can complete a given task at most
  //    once. Without this, concurrent /verify requests could each pass the
  //    (non-transactional) dup SELECT and double-credit. First collapse any
  //    pre-existing duplicates (keep the earliest row), then add the index.
  try {
    await pool.query(`
      DELETE FROM completions a USING completions b
      WHERE a.task_id = b.task_id AND a.user_id = b.user_id AND a.id > b.id`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS completions_task_user_uidx
      ON completions (task_id, user_id)`);
  } catch (e) { console.error('[migrate] completions unique index:', e.message); }

  // 8. Record the slot cost actually charged at campaign-creation time, so a
  //    cancel refunds exactly what was paid — not a price recomputed from live
  //    settings (which could refund more than was charged).
  try {
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS slot_cost INTEGER`);
    // Best-effort backfill for existing rows: reward + default house margin (3).
    await pool.query(`UPDATE tasks SET slot_cost = reward + 3 WHERE slot_cost IS NULL`);
  } catch (e) { console.error('[migrate] tasks.slot_cost:', e.message); }

  // 9. Permanent per-user "already earned for this target" ledger. A user can be
  //    paid at most once for subscribing to a given channel / liking / watching a
  //    given video — across ALL campaigns, forever. Closes the "re-created
  //    campaign re-pays an already-subscribed user" farm. Backfilled from history.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS earned_targets (
        user_id    INTEGER NOT NULL,
        target_key TEXT    NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, target_key)
      )`);
    await pool.query(`
      INSERT INTO earned_targets (user_id, target_key)
      SELECT user_id, 'sub:'||target_channel_id FROM completions
        WHERE task_type IN ('subscribe','subscribe_like') AND target_channel_id IS NOT NULL
      UNION
      SELECT user_id, 'like:'||target_video_id FROM completions
        WHERE task_type IN ('like','like_comment','subscribe_like') AND target_video_id IS NOT NULL
      UNION
      SELECT user_id, 'watch:'||target_video_id FROM completions
        WHERE task_type = 'watch' AND target_video_id IS NOT NULL
      ON CONFLICT DO NOTHING`);
  } catch (e) { console.error('[migrate] earned_targets:', e.message); }

  // 10. Google Play purchases — exactly-once coin crediting for in-app purchases.
  //     The purchase_token is unique per transaction; the PRIMARY KEY guarantees a
  //     replayed/retried verify can never double-credit.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS google_purchases (
        purchase_token TEXT PRIMARY KEY,
        order_id       TEXT,
        user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
        product_id     TEXT NOT NULL,
        coins          INTEGER NOT NULL,
        status         VARCHAR(20) DEFAULT 'credited',
        created_at     TIMESTAMP NOT NULL DEFAULT NOW()
      )`);
  } catch (e) { console.error('[migrate] google_purchases:', e.message); }
}

module.exports = { runMigration };
