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

    if (serverAuthCode) {
      try {
        const oauth = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, 'postmessage');
        const { tokens } = await oauth.getToken(serverAuthCode);
        ytAccessToken   = tokens.access_token || ytAccessToken;
        ytRefreshToken  = tokens.refresh_token || null;
        ytExpiry        = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
      } catch (e) { console.error('serverAuthCode exchange failed:', e.message); }
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
      await pool.query(`INSERT INTO transactions (user_id,amount,type,description) VALUES ($1,50,'bonus','Welcome bonus')`, [user.id]);
    }

    if (ytAccessToken && !user.youtube_channel_id) {
      try {
        const chId = await youtubeService.fetchOwnChannelId(user.id);
        if (chId) {
          await pool.query('UPDATE users SET youtube_channel_id=$1 WHERE id=$2', [chId, user.id]);
          user.youtube_channel_id = chId;
        }
      } catch (e) { console.error('fetchOwnChannelId error:', e.message); }
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });

    delete user.youtube_access_token;
    delete user.youtube_refresh_token;
    delete user.youtube_token_expiry;

    res.json({ token, user, youtube_connected: !!ytAccessToken });
  } catch (err) { next(err); }
};

module.exports = { googleSignIn };
