const youtubeService = require('../services/youtubeService');
const pool = require('../db/pool');

const addChannel = async (req, res, next) => {
  try {
    const { youtube_channel_id, channel_name, channel_url } = req.body;

    if (!youtube_channel_id || !channel_name || !channel_url) {
      return res.status(400).json({ error: 'youtube_channel_id, channel_name, and channel_url are required' });
    }

    // Resolve handle to real UC... channel ID
    let resolvedChannelId = youtube_channel_id;
    if (!youtube_channel_id.startsWith('UC')) {
      try {
        const resolved = await youtubeService.resolveHandleToChannelId(youtube_channel_id);
        if (resolved) resolvedChannelId = resolved;
      } catch (e) {
        console.error('Could not resolve channel handle:', e.message);
      }
    }

    const existing = await pool.query(
      'SELECT id FROM channels WHERE user_id = $1',
      [req.userId]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'You already have a registered channel.' });
    }

    const result = await pool.query(
      `INSERT INTO channels (user_id, youtube_channel_id, channel_name, channel_url)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.userId, resolvedChannelId, channel_name, channel_url]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
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
