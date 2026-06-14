const pool = require('../db/pool');
const { getSubscriberCount, resolveChannel } = require('../services/youtubeService');

// Validate that a string looks like a YouTube channel URL or handle
function isValidChannelUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  // Accept: youtube.com/@handle, youtube.com/channel/UC..., youtu.be, etc.
  return /^https?:\/\/(www\.)?youtube\.com\/(channel\/UC[\w-]+|@[\w.-]+|c\/[\w-]+|user\/[\w-]+)\/?$/.test(trimmed)
      || /^@[\w.-]+$/.test(trimmed); // bare handle like @mychannel
}

function sanitizeText(str, maxLen = 100) {
  if (!str || typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen).replace(/[<>]/g, '');
}

// Add any YouTube channel (not necessarily the user's own). The client just
// pastes a channel URL or @handle; we resolve it to a real channel id/name.
const addChannel = async (req, res, next) => {
  try {
    const { channel_url } = req.body;
    if (!channel_url || !isValidChannelUrl(channel_url)) {
      return res.status(400).json({ error: 'Paste a valid YouTube channel URL or @handle (e.g. youtube.com/@yourhandle).' });
    }

    const ch = await resolveChannel(channel_url);
    if (!ch || !ch.id) {
      return res.status(400).json({ error: "Couldn't find that channel on YouTube. Double-check the URL or @handle." });
    }

    // No duplicates per user
    const dup = await pool.query(
      'SELECT id FROM channels WHERE user_id=$1 AND youtube_channel_id=$2',
      [req.userId, ch.id]
    );
    if (dup.rows.length) return res.status(409).json({ error: 'You already added that channel.' });

    const safeUrl = channel_url.trim().slice(0, 200);
    const result = await pool.query(
      `INSERT INTO channels (user_id, youtube_channel_id, channel_name, channel_url, subscriber_count)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.userId, ch.id, sanitizeText(ch.name, 100) || 'Channel', safeUrl, ch.subs || 0]
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
              COUNT(DISTINCT CASE WHEN t.status='active' THEN t.id END) AS active_campaigns,
              COALESCE(SUM(CASE WHEN t.status='active' THEN t.remaining_slots ELSE 0 END),0) AS pending_subscribers
       FROM channels c LEFT JOIN tasks t ON t.channel_id=c.id
       WHERE c.user_id=$1 GROUP BY c.id ORDER BY c.created_at DESC`,
      [req.userId]
    );
    res.json(r.rows);
  } catch (err) { next(err); }
};

module.exports = { addChannel, getMyChannels };
