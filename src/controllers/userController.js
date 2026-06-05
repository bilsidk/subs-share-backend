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

module.exports = { getMe };
