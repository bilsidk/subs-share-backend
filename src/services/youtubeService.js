const { google } = require('googleapis');
const pool = require('../db/pool');

async function getYouTubeClient(userId) {
  const r = await pool.query(
    'SELECT youtube_access_token, youtube_refresh_token, youtube_token_expiry FROM users WHERE id=$1',
    [userId]
  );
  if (!r.rows.length) throw new Error('User not found');
  const { youtube_access_token, youtube_refresh_token, youtube_token_expiry } = r.rows[0];
  if (!youtube_access_token) {
    const e = new Error('YouTube access not granted'); e.code = 'NO_YOUTUBE_ACCESS'; throw e;
  }
  // Token expired with no refresh token → user must re-authenticate
  const isExpired = youtube_token_expiry && new Date(youtube_token_expiry).getTime() < Date.now();
  if (isExpired && !youtube_refresh_token) {
    const e = new Error('YouTube session expired — please sign in again');
    e.code = 'NO_YOUTUBE_ACCESS'; throw e;
  }
  const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  oauth2.setCredentials({
    access_token: youtube_access_token,
    refresh_token: youtube_refresh_token,
    expiry_date: youtube_token_expiry ? new Date(youtube_token_expiry).getTime() : null,
  });
  // Only attach the token handler once per userId to avoid duplicates on concurrent calls
  if (!oauth2._tokenHandlerAttached) {
    oauth2._tokenHandlerAttached = true;
    oauth2.on('tokens', async (tokens) => {
      try {
        await pool.query(
          `UPDATE users SET
             youtube_access_token  = COALESCE($1, youtube_access_token),
             youtube_refresh_token = COALESCE($2, youtube_refresh_token),
             youtube_token_expiry  = COALESCE($3, youtube_token_expiry)
           WHERE id=$4`,
          [tokens.access_token, tokens.refresh_token || null,
           tokens.expiry_date ? new Date(tokens.expiry_date) : null, userId]
        );
      } catch (e) { console.error('Token persist error:', e.message); }
    });
  }
  return google.youtube({ version: 'v3', auth: oauth2 });
}

function rethrowAuthError(e) {
  const msg = e.message || '';
  const isAuthErr = e.response?.status === 401
    || msg.includes('No refresh token')
    || msg.includes('invalid_grant')
    || msg.includes('Token has been expired');
  if (isAuthErr) { const ae = new Error('YouTube session expired — please sign in again'); ae.code = 'NO_YOUTUBE_ACCESS'; throw ae; }
  throw e;
}

async function verifySubscription(userId, targetChannelId) {
  const yt = await getYouTubeClient(userId);
  try {
    const res = await yt.subscriptions.list({
      part: 'snippet', mine: true, forChannelId: targetChannelId, maxResults: 1,
    });
    return (res.data.items || []).length > 0;
  } catch (e) { rethrowAuthError(e); }
}
async function verifyLike(userId, videoId) {
  const yt = await getYouTubeClient(userId);
  try {
    const res = await yt.videos.getRating({ id: videoId });
    const items = res.data.items || [];
    return items.length > 0 && items[0].rating === 'like';
  } catch (e) { rethrowAuthError(e); }
}

// Look for the user's own top-level comment on a video. Returns:
//   { found:true, commentText, exhausted:true }                  — comment present
//   { found:false, reason:'no_channel_id', exhausted:false }     — user has no channel
//   { found:false, disabled:true, exhausted:false }              — comments disabled
//   { found:false, exhausted:true }   — CONCLUSIVE: paged to the end, genuinely absent
//   { found:false, exhausted:false }  — INCONCLUSIVE: page cap hit before the end
// `exhausted` distinguishes a real "not there" from "not found yet in the pages we
// scanned". Callers that PENALIZE on a negative (e.g. audit bonus clawback) must act
// ONLY when exhausted===true, so a buried comment on a very busy video is never wrongly
// clawed back. Real-time verify still treats any not-found as a (retryable) reject.
async function verifyComment(userId, videoId) {
  const yt = await getYouTubeClient(userId);
  const userRow = await pool.query('SELECT youtube_channel_id FROM users WHERE id=$1', [userId]);
  const authorChannelId = userRow.rows[0]?.youtube_channel_id;
  if (!authorChannelId) return { found: false, reason: 'no_channel_id', exhausted: false };

  const MAX_PAGES = 10; // up to ~1000 most-recent comments. A freshly-posted comment is
  // newest-first (order:'time'), so this deep margin keeps a genuine comment verifiable
  // even on a busy video, while a conclusive not-found (exhausted) still means absent.
  let pageToken;
  let exhausted = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    let res;
    try {
      res = await yt.commentThreads.list({
        part: 'snippet', videoId, maxResults: 100, order: 'time',
        ...(pageToken ? { pageToken } : {}),
      });
    } catch (e) {
      if (e.response?.data?.error?.errors?.[0]?.reason === 'commentsDisabled')
        return { found: false, disabled: true, exhausted: false };
      throw e;
    }
    for (const item of (res.data.items || [])) {
      const top = item.snippet?.topLevelComment?.snippet;
      if (top?.authorChannelId?.value === authorChannelId)
        return { found: true, commentText: top.textOriginal, exhausted: true };
    }
    pageToken = res.data.nextPageToken;
    if (!pageToken) { exhausted = true; break; }
  }
  return { found: false, exhausted };
}

// Definitively check whether a channel still exists, using the public API key (so it
// works for any target channel, not just the caller's). Returns true if present, false
// if YouTube returns zero items (deleted/invalid id), or null on any API error
// (INCONCLUSIVE — callers must not treat null as "gone").
async function channelExists(channelId) {
  if (!channelId) return null;
  try {
    const yt = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });
    const res = await yt.channels.list({ part: 'id', id: channelId });
    return (res.data.items || []).length > 0;
  } catch (e) {
    console.error('[YouTube] channelExists failed:', e.message);
    return null;
  }
}

async function getVideoDuration(videoId) {
  const yt = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });
  const res = await yt.videos.list({ part: 'contentDetails,snippet', id: videoId });
  const items = res.data.items || [];
  if (!items.length) return null;
  const iso = items[0].contentDetails.duration;
  const title = items[0].snippet.title;
  return { durationSec: parseDuration(iso), title, videoId };
}

function parseDuration(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

async function getSubscriberCount(channelId) {
  if (!channelId) return 0;
  try {
  const yt = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });
    const res = await yt.channels.list({ part: 'statistics', id: channelId });
    const count = res.data.items?.[0]?.statistics?.subscriberCount;
    return count ? parseInt(count, 10) : 0;
  } catch (e) {
    console.error('[YouTube] getSubscriberCount failed:', e.message);
    return 0;
  }
}

async function fetchOwnChannelId(userId) {
  const yt = await getYouTubeClient(userId);
  const res = await yt.channels.list({ part: 'id', mine: true, maxResults: 1 });
  const items = res.data.items || [];
  return items.length ? items[0].id : null;
}

function parseVideoId(url) {
  if (!url) return null;
  const patterns = [/[?&]v=([\w-]{11})/, /youtu\.be\/([\w-]{11})/, /youtube\.com\/shorts\/([\w-]{11})/];
  for (const p of patterns) { const m = url.match(p); if (m) return m[1]; }
  if (/^[\w-]{11}$/.test(url.trim())) return url.trim();
  return null;
}

// Resolve any channel URL / @handle / UC id to {id, name, subs}. Uses the public
// API key so a user can add a channel that isn't their own. Returns null if not found.
async function resolveChannel(input) {
  const raw = (input || '').trim();
  if (!raw) return null;
  const yt = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });
  const pick = (ch) => ch ? {
    id: ch.id,
    name: ch.snippet?.title || 'Channel',
    subs: ch.statistics?.subscriberCount ? parseInt(ch.statistics.subscriberCount, 10) : 0,
  } : null;
  try {
    const idm = raw.match(/channel\/(UC[\w-]{20,})/) || raw.match(/^(UC[\w-]{20,})$/);
    if (idm) return pick((await yt.channels.list({ part: 'id,snippet,statistics', id: idm[1] })).data.items?.[0]);

    const hm = raw.match(/@([\w.\-]+)/);
    if (hm) {
      const ch = pick((await yt.channels.list({ part: 'id,snippet,statistics', forHandle: '@' + hm[1] })).data.items?.[0]);
      if (ch) return ch;
    }
    const um = raw.match(/\/user\/([\w\-]+)/);
    if (um) {
      const ch = pick((await yt.channels.list({ part: 'id,snippet,statistics', forUsername: um[1] })).data.items?.[0]);
      if (ch) return ch;
    }
    return null;
  } catch (e) {
    console.error('[YouTube] resolveChannel failed:', e.message);
    return null;
  }
}

module.exports = {
  verifySubscription, verifyLike, verifyComment,
  getVideoDuration, fetchOwnChannelId, getSubscriberCount,
  parseVideoId, resolveChannel, channelExists,
};
