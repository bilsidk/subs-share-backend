const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const youtubeService = require('../services/youtubeService');

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const googleSignIn = async (req, res, next) => {
  try {
    const { idToken, serverAuthCode, accessToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'idToken required' });

    const ticket = await client.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
    const { sub: google_id, email, name, picture: avatar } = ticket.getPayload();

    let ytAccessToken = accessToken || null;
    let ytRefreshToken = null;
    let ytExpiry = null;

    if (accessToken) {
      ytAccessToken = accessToken;
      ytExpiry = new Date(Date.now() + 3600 * 1000);
    }

    const result = await pool.query(
      `INSERT INTO users (google_id, email, name, avatar, youtube_access_token, youtube_refresh_token, youtube_token_expiry)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (google_id) DO UPDATE
       SET email=EXCLUDED.email, name=EXCLUDED.name, avatar=EXCLUDED.avatar,
           youtube_access_token  = COALESCE(EXCLUDED.youtube_access_token,  users.youtube_access_token),
           youtube_refresh_token = COALESCE(EXCLUDED.youtube_refresh_token, users.youtube_refresh_token),
           youtube_token_expiry  = COALESCE(EXCLUDED.youtube_token_expiry,  users.youtube_token_expiry)
       RETURNING *`,
      [google_id, email, name, avatar, ytAccessToken, ytRefreshToken, ytExpiry]
    );
    const user = result.rows[0];
    const isNew = new Date(user.created_at).getTime() > Date.now() - 5000;

    if (isNew) {
      // Store structured key instead of English string
      await pool.query(
        `INSERT INTO transactions (user_id,amount,type,description) VALUES ($1,50,'bonus','tx:welcome_bonus')`,
        [user.id]
      );
      await pool.query('UPDATE users SET coins = coins + 50 WHERE id = $1', [user.id]);
    }

    if (ytAccessToken) {
      try {
        const yt = require('googleapis').google.youtube({
          version: 'v3',
          auth: (() => {
            const oauth2 = new (require('google-auth-library').OAuth2Client)(
              process.env.GOOGLE_CLIENT_ID,
              process.env.GOOGLE_CLIENT_SECRET
            );
            oauth2.setCredentials({ access_token: ytAccessToken });
            return oauth2;
          })()
        });

        const chRes = await yt.channels.list({ part: 'id,snippet', mine: true, maxResults: 1 });
        const ch = chRes.data.items?.[0];
        if (ch) {
          const channelId = ch.id;
          const channelName = ch.snippet.title;
          const channelUrl = `https://www.youtube.com/channel/${channelId}`;

          await pool.query('UPDATE users SET youtube_channel_id = $1 WHERE id = $2', [channelId, user.id]);

          const existingChannel = await pool.query('SELECT id FROM channels WHERE user_id = $1', [user.id]);
          if (!existingChannel.rows.length) {
            await pool.query(
              `INSERT INTO channels (user_id, youtube_channel_id, channel_name, channel_url) VALUES ($1,$2,$3,$4)`,
              [user.id, channelId, channelName, channelUrl]
            );
          } else {
            await pool.query(
              `UPDATE channels SET youtube_channel_id=$1, channel_name=$2, channel_url=$3 WHERE user_id=$4`,
              [channelId, channelName, channelUrl, user.id]
            );
          }
          user.youtube_channel_id = channelId;
          user.channel_name = channelName;
        }
      } catch (e) {
        console.error('Could not auto-register channel:', e.message);
      }
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });

    delete user.youtube_access_token;
    delete user.youtube_refresh_token;
    delete user.youtube_token_expiry;

    res.json({ token, user, youtube_connected: !!ytAccessToken });
  } catch (err) { next(err); }
};

module.exports = { googleSignIn };
