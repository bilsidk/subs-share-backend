const pool = require('../db/pool');
const { getSubscriberCount } = require('../services/youtubeService');

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

const addChannel = async (req, res, next) => {
  try {
    const { youtube_channel_id, channel_name, channel_url } = req.body;

    if (!youtube_channel_id || !channel_name || !channel_url) {
      return res.status(400).json({ error: 'youtube_channel_id, channel_name, and channel_url are required' });
    }

    // Validate channel URL format
    if (!isValidChannelUrl(channel_url)) {
      return res.status(400).json({ error: 'Invalid YouTube channel URL. Use format: youtube.com/@yourhandle' });
    }

    // Sanitize channel name
    const safeName = sanitizeText(channel_name, 100);
    if (safeName.length < 1) {
      return res.status(400).json({ error: 'Channel name is required' });
    }

    // Sanitize channel ID
    const safeChannelId = sanitizeText(youtube_channel_id, 50);
    const safeUrl = channel_url.trim().slice(0, 200);

    const subscriberCount = await getSubscriberCount(safeChannelId);
    const result = await pool.query(
      `INSERT INTO channels (user_id, youtube_channel_id, channel_name, channel_url, subscriber_count)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.userId, safeChannelId, safeName, safeUrl, subscriberCount]
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
