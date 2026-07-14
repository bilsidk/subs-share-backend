const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { getSubscriberCount } = require('../services/youtubeService');

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ── Fail-safe deadline for Google network calls ─────────────────────────────
// The standalone OAuth2Client calls below (getToken / verifyIdToken) fetch over the
// network with NO built-in deadline; a stalled connection can hang the promise forever
// and stall EVERY sign-in. withTimeout bounds them so a hung call REJECTS instead of
// hanging. It never RESOLVES with a synthetic value — it only rejects on timeout or
// passes through the real result — so verification/security OUTCOMES are unchanged:
//   • getToken timeout  → existing catch → fall back to the mobile accessToken.
//   • verifyIdToken timeout → outer catch → next(err): login fails rather than issuing
//     a JWT on an unverified idToken. A timeout can never produce a valid-looking ticket.
const GOOGLE_TIMEOUT_MS = 8000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
        const { tokens } = await withTimeout(oauth2.getToken(serverAuthCode), GOOGLE_TIMEOUT_MS, 'getToken');
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

    const ticket = await withTimeout(
      client.verifyIdToken({ idToken: idTokenToVerify, audience: process.env.GOOGLE_CLIENT_ID }),
      GOOGLE_TIMEOUT_MS, 'verifyIdToken'
    );
    const { sub: google_id, email, name, picture: avatar, email_verified } = ticket.getPayload();

    // Owner elevation keys off the email, so never trust an email Google flags as
    // unverified. email_verified===false means Google could not confirm the address;
    // a missing/undefined claim (some federated tokens) is left as-is to avoid locking
    // out legitimate accounts (normal gmail sign-ins are always verified).
    if (email_verified === false)
      return res.status(403).json({ error: 'Your Google email is not verified. Verify it with Google, then sign in again.', code: 'EMAIL_UNVERIFIED' });

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

    // Referral: give this user a code, and if they're new and entered a valid
    // code, record the pending referral (coins pay out on their first verified task).
    try {
      const referralService = require('../services/referralService');
      await referralService.ensureReferralCode(user.id);
      if (isNew && req.body.referralCode) {
        await referralService.applyReferralAtSignup(user.id, req.body.referralCode);
      }
    } catch (e) { console.error('[Auth] referral setup:', e.message); }

    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });

    delete user.youtube_access_token;
    delete user.youtube_refresh_token;
    delete user.youtube_token_expiry;

    // Auto-register the YouTube channel ON the login path, but BOUNDED to 8s total so a
    // brand-new user has their channel in the DB before the response returns (prevents the
    // race where creating a campaign right after first login hit "add your channel first"),
    // while a slow/hung YouTube API can never delay sign-in past the deadline. Best-effort:
    // a timeout/failure is swallowed — login still succeeds, and the register self-heals
    // (its internal work continues even if the outer deadline fires; next sign-in retries).
    if (ytAccessToken) {
      try {
        const ch = await withTimeout(
          registerUserChannel({ user, google_id, ytAccessToken, ytRefreshToken, ytExpiry }),
          GOOGLE_TIMEOUT_MS, 'channelRegister'
        );
        if (ch) { user.youtube_channel_id = ch.channelId; user.subscriber_count = ch.subscriberCount; }
      } catch (e) { console.error('Could not auto-register channel:', e.message); }
    }

    res.json({ token, user, youtube_connected: !!ytAccessToken, has_refresh_token: !!ytRefreshToken });
  } catch (err) { next(err); }
};

// Enrich the user's YouTube channel (id / name / subscriber count) and register it.
// Awaited on the sign-in path but wrapped by the caller in an 8s deadline, and each
// external call is also individually bounded, so it can neither hang login nor run
// unbounded. Returns { channelId, subscriberCount } when a channel is found (so the
// caller can reflect it in the response), else undefined. The existing SELECT-then-
// INSERT/UPDATE is the only idempotency guard (the base `channels` schema has no
// UNIQUE(user_id)) — unchanged here.
async function registerUserChannel({ user, google_id, ytAccessToken, ytRefreshToken, ytExpiry }) {
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
  // Per-call timeout so a hung channels.list can't leave this job pending forever.
  const chRes = await yt.channels.list({ part: 'id,snippet', mine: true, maxResults: 1 }, { timeout: GOOGLE_TIMEOUT_MS });
  const ch = chRes.data.items?.[0];

  if (ch) {
    const channelId   = ch.id;
    const channelName = ch.snippet.title;
    const channelUrl  = `https://www.youtube.com/channel/${channelId}`;
    // Bounded; on timeout fall back to 0 so channel registration still proceeds.
    const subscriberCount = await withTimeout(getSubscriberCount(channelId), GOOGLE_TIMEOUT_MS, 'getSubscriberCount').catch(() => 0);

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
    return { channelId, subscriberCount };
  }
}

module.exports = { googleSignIn };
