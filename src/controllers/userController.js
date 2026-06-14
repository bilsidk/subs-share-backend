const pool = require('../db/pool');

const getMe = async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT u.*,
              COUNT(DISTINCT c.id) AS channel_count,
              COUNT(DISTINCT co.id) AS tasks_completed
       FROM users u
       LEFT JOIN channels c  ON c.user_id = u.id
       LEFT JOIN completions co ON co.user_id = u.id
       WHERE u.id=$1 GROUP BY u.id`,
      [req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = r.rows[0];
    delete user.youtube_access_token;
    delete user.youtube_refresh_token;
    delete user.youtube_token_expiry;
    res.json(user);
  } catch (err) { next(err); }
};

// Permanently delete the authenticated user and all their data.
// Required by Google Play for any app with account creation.
// Deletes in FK-dependency order inside a transaction (no schema cascades assumed).
const deleteMe = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const userId = req.userId;
    await client.query('BEGIN');

    // Preserve the welcome-bonus flag so deleting + re-signing-up with the same
    // Google account can't re-farm the 50-coin bonus.
    const who = await client.query('SELECT google_id FROM users WHERE id=$1', [userId]);
    if (who.rows[0]?.google_id) {
      await client.query(
        `INSERT INTO account_history (google_id, bonus_granted, updated_at) VALUES ($1, TRUE, NOW())
         ON CONFLICT (google_id) DO UPDATE SET bonus_granted=TRUE, updated_at=NOW()`,
        [who.rows[0].google_id]
      );
    }

    // 1. Other users' completions earned on THIS user's campaigns
    //    (FK completions.task_id -> tasks.id, so these must go before the tasks)
    await client.query(
      `DELETE FROM completions
        WHERE task_id IN (
          SELECT t.id FROM tasks t
          JOIN channels c ON c.id = t.channel_id
          WHERE c.user_id = $1
        )`,
      [userId]
    );

    // 2. This user's own completions on other people's campaigns
    await client.query('DELETE FROM completions WHERE user_id = $1', [userId]);

    // 3. This user's campaigns (owned via their channels)
    await client.query(
      `DELETE FROM tasks WHERE channel_id IN (SELECT id FROM channels WHERE user_id = $1)`,
      [userId]
    );

    // 4. Coin ledger
    await client.query('DELETE FROM transactions WHERE user_id = $1', [userId]);

    // 5. Anti-cheat device links
    await client.query('DELETE FROM device_accounts WHERE user_id = $1', [userId]);

    // 6. Channels
    await client.query('DELETE FROM channels WHERE user_id = $1', [userId]);

    // 7. The user record itself (also wipes stored Google/YouTube tokens)
    const r = await client.query('DELETE FROM users WHERE id = $1 RETURNING id', [userId]);

    if (!r.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }

    await client.query('COMMIT');
    res.json({ ok: true, message: 'Account permanently deleted.' });
  } catch (err) { await client.query('ROLLBACK'); next(err); }
  finally { client.release(); }
};

module.exports = { getMe, deleteMe };
