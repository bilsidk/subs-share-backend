const pool = require('../db/pool');

const addChannel = async (req, res, next) => {
  try {
    const { youtube_channel_id, channel_name, channel_url } = req.body;
    if (!youtube_channel_id || !channel_name || !channel_url)
      return res.status(400).json({ error: 'youtube_channel_id, channel_name, channel_url required' });

    const existing = await pool.query('SELECT id FROM channels WHERE user_id=$1', [req.userId]);
    if (existing.rows.length)
      return res.status(409).json({ error: 'You already have a channel registered' });

    const r = await pool.query(
      'INSERT INTO channels (user_id,youtube_channel_id,channel_name,channel_url) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.userId, youtube_channel_id, channel_name, channel_url]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { next(err); }
};

const getMyChannels = async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT c.*,
              COUNT(DISTINCT t.id) AS active_campaigns,
              COALESCE(SUM(CASE WHEN t.status='active' THEN t.remaining_slots ELSE 0 END),0) AS pending_subscribers
       FROM channels c LEFT JOIN tasks t ON t.channel_id=c.id
       WHERE c.user_id=$1 GROUP BY c.id ORDER BY c.created_at DESC`,
      [req.userId]
    );
    res.json(r.rows);
  } catch (err) { next(err); }
};

module.exports = { addChannel, getMyChannels };
