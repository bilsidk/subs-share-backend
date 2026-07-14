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
        payment_id    VARCHAR(255),
        created_at    TIMESTAMP DEFAULT NOW()
      )`);
    // NowPayments payment_id, learned from a delivered IPN — a direct-lookup fallback for
    // the pending-crypto reconcile. Nullable; added here for tables created before it.
    await pool.query(`ALTER TABLE pending_payments ADD COLUMN IF NOT EXISTS payment_id VARCHAR(255)`);
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

  // 8b. Lock the like_comment bonus onto the task at creation time (exactly like
  //     slot_cost). The owner funds this bonus into slot_cost at creation; if the earner
  //     payout re-read the LIVE comment_bonus setting at verify time instead, raising the
  //     setting would pay every OUTSTANDING campaign's earners more than the owner funded
  //     — minting coins / house loss. Backfill legacy like_comment rows with the default
  //     bonus (4) that was in effect when they were created. Idempotent.
  try {
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS comment_bonus INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`UPDATE tasks SET comment_bonus = 4 WHERE task_type = 'like_comment' AND comment_bonus = 0`);
  } catch (e) { console.error('[migrate] tasks.comment_bonus:', e.message); }

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
          AND verify_status IN ('verified','pending')
      UNION
      SELECT user_id, 'like:'||target_video_id FROM completions
        WHERE task_type IN ('like','like_comment','subscribe_like') AND target_video_id IS NOT NULL
          AND verify_status IN ('verified','pending')
      UNION
      SELECT user_id, 'watch:'||target_video_id FROM completions
        WHERE task_type = 'watch' AND target_video_id IS NOT NULL
          AND verify_status IN ('verified','pending')
      ON CONFLICT DO NOTHING`);
  } catch (e) { console.error('[migrate] earned_targets:', e.message); }

  // 11. Referrals — a per-user code, who referred whom, and reward state. Both
  //     bonuses pay out only on the referee's first verified task (referralService).
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(12)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INTEGER`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_uidx ON users (referral_code) WHERE referral_code IS NOT NULL`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        referee_id  INTEGER PRIMARY KEY,
        referrer_id INTEGER NOT NULL,
        status      VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
        rewarded_at TIMESTAMP
      )`);
  } catch (e) { console.error('[migrate] referrals:', e.message); }

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

  // 11. Ledger floor — belt-and-suspenders invariant. Every deduction path already
  //     clamps (GREATEST(0,…)) or is a guarded/locked update, so this can't fire in
  //     normal operation; it exists so a future bug can never persist a negative
  //     balance. Clamp any pre-existing negatives first so the constraint validates.
  try {
    await pool.query(`UPDATE users SET coins = 0 WHERE coins < 0`);
    await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_coins_nonneg`);
    await pool.query(`ALTER TABLE users ADD CONSTRAINT users_coins_nonneg CHECK (coins >= 0)`);
  } catch (e) { console.error('[migrate] coins_nonneg:', e.message); }

  // 11b. Welcome-bonus integrity. The coins column historically defaulted to 50, which
  //      (a) DOUBLE-GRANTED new users — default 50 + the explicit +50 welcome bonus = 100,
  //      while the ledger recorded only +50 — and (b) DEFEATED the delete+re-signup guard:
  //      account_history only blocks the +50 UPDATE, so a re-signer still got 50 from the
  //      column default. Set the default to 0 so the ledger-backed +50 bonus is the SOLE
  //      initial grant (re-signers correctly get 0). SCHEMA-ONLY — existing balances are
  //      NOT modified; this only affects rows inserted from here on.
  try {
    await pool.query(`ALTER TABLE users ALTER COLUMN coins SET DEFAULT 0`);
  } catch (e) { console.error('[migrate] users.coins default:', e.message); }

  // 12. Comment examples for like_comment campaigns. Owner picks up to 3 curated
  //     template indices (rendered per-locale by the client). comment_ai_examples
  //     caches the per-video, per-language Gemini-generated example so it's produced
  //     at most once per (task, language).
  try {
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS comment_example_ids INTEGER[]`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS comment_ai_examples (
        task_id    INTEGER NOT NULL,
        lang       VARCHAR(12) NOT NULL,
        text       TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (task_id, lang)
      )`);
  } catch (e) { console.error('[migrate] comment_examples:', e.message); }
}

module.exports = { runMigration };
