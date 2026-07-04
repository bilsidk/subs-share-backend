const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { getSubscriberCount } = require('../services/youtubeService');

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const googleSignIn = async (req, res, next) => {
  try {
    const { idToken, serverAuthCode, accessToken, web } = req.body;

    if (!idToken && !serverAuthCode)
      return res.status(400).json({ error: 'idToken required' });

    let ytAccessToken = accessToken || null;
    let ytRefreshToken = null;
    let ytExpiry = null;
    let idTokenToVerify = idToken || null;

    // Exchange serverAuthCode for long-lived refresh token
    // This is the proper fix — refresh token never expires
    if (serverAuthCode) {
      try {
        // Native mobile: no redirect URI (OOB was deprecated 2022).
        // Web popup (GIS code client): redirect URI must be 'postmessage'.
        const oauth2 = new OAuth2Client(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET,
          web ? 'postmessage' : undefined
        );
        const { tokens } = await oauth2.getToken(serverAuthCode);
        if (tokens.access_token)  ytAccessToken  = tokens.access_token;
        if (tokens.refresh_token) ytRefreshToken = tokens.refresh_token;
        if (tokens.expiry_date)   ytExpiry       = new Date(tokens.expiry_date);
        // Web flow sends only the code; the exchange returns the id_token
        if (!idTokenToVerify && tokens.id_token) idTokenToVerify = tokens.id_token;
        console.log('[Auth] Token exchange success. Has refresh token:', !!ytRefreshToken);
      } catch (e) {
        // Exchange failed — fall back to accessToken from mobile
        console.warn('[Auth] serverAuthCode exchange failed:', e.message);
        if (accessToken) {
          ytAccessToken = accessToken;
          ytExpiry = new Date(Date.now() + 3600 * 1000);
        }
      }
    } else if (accessToken) {
      // No serverAuthCode — use accessToken directly (shorter lived)
      ytAccessToken = accessToken;
      ytExpiry = new Date(Date.now() + 3600 * 1000);
    }

    if (!idTokenToVerify) return res.status(400).json({ error: 'idToken required' });

    const ticket = await client.verifyIdToken({ idToken: idTokenToVerify, audience: process.env.GOOGLE_CLIENT_ID });
    const { sub: google_id, email, name, picture: avatar } = ticket.getPayload();

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
      // Welcome bonus exactly once per Google account — even after delete + re-signup,
      // and race-safe against concurrent sign-ins. The account_history row is the gate:
      // only the request that actually transitions bonus_granted FALSE→TRUE (returns a
      // row) credits the coins. Concurrent requests block on the row and re-evaluate the
      // WHERE against the now-TRUE row, so at most one credit ever happens.
      const bc = await pool.connect();
      try {
        await bc.query('BEGIN');
        const claim = await bc.query(
          `INSERT INTO account_history (google_id, bonus_granted, updated_at)
           VALUES ($1, TRUE, NOW())
           ON CONFLICT (google_id) DO UPDATE SET bonus_granted=TRUE, updated_at=NOW()
           WHERE account_history.bonus_granted IS DISTINCT FROM TRUE
           RETURNING google_id`,
          [google_id]
        );
        if (claim.rowCount === 1) {
          await bc.query(`INSERT INTO transactions (user_id,amount,type,description) VALUES ($1,50,'bonus','tx:welcome_bonus')`, [user.id]);
          await bc.query('UPDATE users SET coins = coins + 50 WHERE id = $1', [user.id]);
        }
        await bc.query('COMMIT');
      } catch (e) { await bc.query('ROLLBACK'); console.error('[Auth] welcome bonus grant failed:', e.message); }
      finally { bc.release(); }
    }

    // Auto-register YouTube channel
    if (ytAccessToken) {
      try {
        const oauth2Client = new OAuth2Client(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET
        );
        oauth2Client.setCredentials({
          access_token: ytAccessToken,
          refresh_token: ytRefreshToken,
          expiry_date: ytExpiry ? ytExpiry.getTime() : null,
        });

        // Save refreshed tokens if they update
        oauth2Client.on('tokens', async (tokens) => {
          try {
            await pool.query(
              `UPDATE users SET
                 youtube_access_token  = COALESCE($1, youtube_access_token),
                 youtube_refresh_token = COALESCE($2, youtube_refresh_token),
                 youtube_token_expiry  = COALESCE($3, youtube_token_expiry)
               WHERE google_id = $4`,
              [tokens.access_token, tokens.refresh_token || null,
               tokens.expiry_date ? new Date(tokens.expiry_date) : null, google_id]
            );
          } catch (e) { console.error('Token persist error on signin:', e.message); }
        });

        const yt = google.youtube({ version: 'v3', auth: oauth2Client });
        const chRes = await yt.channels.list({ part: 'id,snippet', mine: true, maxResults: 1 });
        const ch = chRes.data.items?.[0];

        if (ch) {
          const channelId   = ch.id;
          const channelName = ch.snippet.title;
          const channelUrl  = `https://www.youtube.com/channel/${channelId}`;
          const subscriberCount = await getSubscriberCount(channelId);

          await pool.query('UPDATE users SET youtube_channel_id=$1, subscriber_count=$2 WHERE id=$3', [channelId, subscriberCount, user.id]);

          const existing = await pool.query('SELECT id FROM channels WHERE user_id=$1', [user.id]);
          if (!existing.rows.length) {
            await pool.query(
              `INSERT INTO channels (user_id, youtube_channel_id, channel_name, channel_url, subscriber_count) VALUES ($1,$2,$3,$4,$5)`,
              [user.id, channelId, channelName, channelUrl, subscriberCount]
            );
          } else {
            await pool.query(
              `UPDATE channels SET youtube_channel_id=$1, channel_name=$2, channel_url=$3, subscriber_count=$4 WHERE user_id=$5`,
              [channelId, channelName, channelUrl, subscriberCount, user.id]
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

    res.json({ token, user, youtube_connected: !!ytAccessToken, has_refresh_token: !!ytRefreshToken });
  } catch (err) { next(err); }
};

module.exports = { googleSignIn };
