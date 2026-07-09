const pool = require('../db/pool');
const youtubeService = require('../services/youtubeService');
const settings       = require('../services/settingsService');
const antiCheat      = require('../services/antiCheatService');
const integrity      = require('../services/integrityService');
const gemini         = require('../services/geminiService');
const cfg            = require('../config');
const { watchPricing, earnedKeysFor, sanitizeExampleIds, commentMeetsMinimum } = require('../lib/economy');
const { isMobileRequest, mobileCampaignCost, mobileEarnPayout } = require('../lib/platform');

// GET /tasks/integrity-nonce — issues a short-lived nonce for the Play Integrity
// token request. The client requests a Google-signed token bound to this nonce and
// sends it back on /verify.
const getIntegrityNonce = async (req, res) => {
  res.json({ nonce: integrity.issueNonce(req.userId) });
};

// GET /tasks/config — client-visible runtime flags (safe subset of app_settings), so
// the app can hide disabled task types and show a maintenance banner without an update.
const getClientConfig = async (req, res, next) => {
  try {
    const s = await settings.getSettings();
    res.json({
      disabled_task_types: Array.isArray(s.disabled_task_types) ? s.disabled_task_types : [],
      // Same per-key default merge as verify, so clients display the caps actually enforced.
      daily_cap_by_type: { ...settings.DEFAULTS.daily_cap_by_type,
        ...((s.daily_cap_by_type && typeof s.daily_cap_by_type === 'object') ? s.daily_cap_by_type : {}) },
      maintenance_message: typeof s.maintenance_message === 'string' ? s.maintenance_message : '',
    });
  } catch (err) { next(err); }
};

const VERIFIABLE_SUB  = new Set(['subscribe', 'subscribe_like']);
const VERIFIABLE_LIKE = new Set(['like', 'like_comment', 'subscribe_like']);

async function getUserMeta(userId) {
  const r = await pool.query('SELECT role, email, is_premium FROM users WHERE id=$1', [userId]);
  return r.rows[0] || { role: 'user', email: '' };
}

function tierFor(role) {
  if (role === 'owner')   return cfg.TIER.OWNER;
  if (role === 'premium') return cfg.TIER.PREMIUM;
  return cfg.TIER.USER;
}

// Origins the real web SPA is served from. A client claiming platform:'web' (to be
// exempt from the Android-only Play Integrity gate) must actually be a browser request
// FROM one of these origins — otherwise a repackaged Android app could just POST
// platform:'web' to skip integrity entirely. Not a hard boundary on its own (headers
// are forgeable), but it removes the trivial body-field bypass; the real device-trust
// wall is Play Integrity (Android) + the device/velocity caps (web). Reuses the CORS
// allowlist so the two never drift; falls back to the platform claim if unconfigured
// so it can never lock out a correctly-configured web deployment.
const WEB_ORIGINS = (process.env.WEB_ORIGINS || process.env.ALLOWED_ORIGINS ||
  'https://app.viralboostnow.com,https://viralboostnow.com')
  .split(',').map(s => s.trim()).filter(o => o && o !== '*');

function isTrustedWebRequest(req) {
  if (req.body.platform !== 'web') return false;
  if (!WEB_ORIGINS.length) return true; // not configured — keep prior behavior, no regression
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';
  return WEB_ORIGINS.some(o => origin === o || referer === o || referer.startsWith(o + '/'));
}

// watchPricing / earnedKeysFor / sanitizeExampleIds / commentMeetsMinimum now live in
// src/lib/economy.js (pure + unit-tested) and are imported at the top of this file.

// GET /tasks
const getAvailableTasks = async (req, res, next) => {
  try {
    const { type } = req.query;
    const params = [req.userId];
    let typeFilter = '';
    if (type) { params.push(type); typeFilter = `AND t.task_type=$${params.length}`; }

    // Admin kill switch: hide disabled task types from the feed (default-safe: empty = all shown).
    const feedSettings = await settings.getSettings();
    const disabledTypes = Array.isArray(feedSettings.disabled_task_types) ? feedSettings.disabled_task_types : [];
    let disabledFilter = '';
    if (disabledTypes.length) { params.push(disabledTypes); disabledFilter = `AND NOT (t.task_type = ANY($${params.length}))`; }

    const r = await pool.query(
      // NOTE: remaining_slots / total_slots / progress are deliberately NOT selected —
      // campaign capacity is private to the owner (My Campaigns / Admin). The feed only
      // needs enough to render a task; ordering still uses the fill ratio internally.
      `SELECT t.id, t.task_type, t.reward,
              t.target_video_id, t.target_video_url, t.watch_minutes, t.created_at,
              c.channel_name, COALESCE(c.channel_url, '') AS channel_url, c.youtube_channel_id,
              u.name AS owner_name, u.avatar AS owner_avatar, u.role AS owner_role,
              CASE u.role WHEN 'owner' THEN 1 WHEN 'premium' THEN 2 ELSE 3 END AS tier
       FROM tasks t
       JOIN channels c ON c.id=t.channel_id
       JOIN users u    ON u.id=c.user_id
       LEFT JOIN completions co ON co.task_id=t.id AND co.user_id=$1
       WHERE t.status='active' AND t.remaining_slots>0 AND c.user_id!=$1 AND co.id IS NULL
         -- Hide targets this user has ALREADY earned for (any past campaign), so a
         -- re-created campaign on a channel/video they already actioned can't re-pay.
         AND NOT EXISTS (
           SELECT 1 FROM earned_targets et WHERE et.user_id=$1 AND et.target_key = ANY(
             CASE t.task_type
               WHEN 'subscribe'      THEN ARRAY['sub:'||c.youtube_channel_id]
               WHEN 'subscribe_like' THEN ARRAY['sub:'||c.youtube_channel_id, 'like:'||COALESCE(t.target_video_id,'')]
               WHEN 'like'           THEN ARRAY['like:'||COALESCE(t.target_video_id,'')]
               WHEN 'like_comment'   THEN ARRAY['like:'||COALESCE(t.target_video_id,'')]
               WHEN 'watch'          THEN ARRAY['watch:'||COALESCE(t.target_video_id,'')]
               ELSE ARRAY[]::text[]
             END)
         ) ${typeFilter} ${disabledFilter}
       -- Feed ranking: premium block above regular (tier), then inside each block the
       -- LEAST-completed campaign (by fill RATIO, fair to all sizes) first, and on equal
       -- ratios the OLDEST campaign first — so no campaign is starved by newer arrivals.
       ORDER BY tier ASC,
                (CASE WHEN COALESCE(t.total_slots,t.remaining_slots)>0
                      THEN (COALESCE(t.total_slots,t.remaining_slots)-t.remaining_slots)::float
                           /COALESCE(t.total_slots,t.remaining_slots)
                      ELSE 0 END) ASC,
                t.created_at ASC, t.id ASC LIMIT 80`,
      params
    );
    const rows = r.rows;
    // Mobile earn penalty — show the REAL (reduced) payout in the feed so mobile earners
    // aren't misled; web keeps full rewards. /verify pays this same reduced amount.
    if (isMobileRequest(req)) for (const t of rows) t.reward = mobileEarnPayout(t.reward, t.task_type);
    res.json(rows);
  } catch (err) { next(err); }
};

// POST /tasks
const createTask = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { channel_id, task_type='subscribe', subscribers_wanted, target_video_url, watch_minutes } = req.body;
    const slots = parseInt(subscribers_wanted, 10);
    const commentExampleIds = task_type === 'like_comment' ? sanitizeExampleIds(req.body.comment_example_ids) : [];

    const requiresChannel = ['subscribe', 'subscribe_like'].includes(task_type);
    if (requiresChannel && !channel_id)
      return res.status(400).json({ error: 'channel_id required for subscribe tasks' });
    if (!slots || slots < 1)
      return res.status(400).json({ error: 'Slot count required' });
    if (slots > 100000)
      return res.status(400).json({ error: 'Slot count too large (max 100000 per campaign).' });
    if (!cfg.REWARDS[task_type])
      return res.status(400).json({ error: 'Invalid task_type' });

    const appSettings = await settings.getSettings();
    // Admin kill switch: block creating a temporarily-disabled campaign type.
    if ((Array.isArray(appSettings.disabled_task_types) ? appSettings.disabled_task_types : []).includes(task_type))
      return res.status(403).json({ error: 'This campaign type is temporarily disabled. Please try another type.', code: 'TASK_TYPE_DISABLED' });
    const margin = appSettings.house_margin ?? 3;
    const rewardMap = {
      subscribe:       appSettings.coins_subscribe,
      like:            appSettings.coins_like,
      like_comment:    appSettings.coins_like_comment,
      subscribe_like:  appSettings.coins_subscribe_like,
      watch:           appSettings.coins_watch,
    };

    let target_video_id = null;
    let video_duration_sec = null;
    let taskReward = rewardMap[task_type] ?? cfg.REWARDS[task_type];
    let slotCost = taskReward + margin;
    // like_comment can pay a comment bonus ON TOP of the reward when the comment is
    // verified. The owner must fund that too, otherwise each verified comment pays out
    // more than the slot cost (10 reward + 4 bonus = 14 vs a 13 charge) — minting coins.
    // Lock the funded bonus onto the task (stored below) so a later admin change to the
    // comment_bonus setting can't make the earner payout exceed what the owner funded.
    let commentBonusFunded = 0;
    if (task_type === 'like_comment') {
      commentBonusFunded = appSettings.comment_bonus ?? cfg.COMMENT_BONUS;
      slotCost += commentBonusFunded;
    }
    // Persisted watch length: only meaningful for watch tasks (set from the validated
    // `mins` below). Defaults to MIN for every other type so a junk req.body.watch_minutes
    // can never reach the INSERT (it would raise a type error → 500).
    let storedWatchMinutes = cfg.MIN_WATCH_MINUTES;

    if (task_type !== 'subscribe') {
      if (!target_video_url)
        return res.status(400).json({ error: 'target_video_url required for this task type' });
      target_video_id = youtubeService.parseVideoId(target_video_url);
      if (!target_video_id)
        return res.status(400).json({ error: 'Could not parse a valid YouTube video ID from that URL' });

      const videoInfo = await youtubeService.getVideoDuration(target_video_id);
      if (!videoInfo)
        return res.status(400).json({ error: 'Video not found or is private' });

      if (task_type === 'watch') {
        const mins = parseInt(watch_minutes, 10) || cfg.MIN_WATCH_MINUTES;
        if (mins < cfg.MIN_WATCH_MINUTES || mins > cfg.MAX_WATCH_MINUTES)
          return res.status(400).json({ error: `watch_minutes must be ${cfg.MIN_WATCH_MINUTES}–${cfg.MAX_WATCH_MINUTES}` });
        storedWatchMinutes = mins;
        const requiredSec = mins * 60;
        if (videoInfo.durationSec < requiredSec)
          return res.status(400).json({
            error: `Video "${videoInfo.title}" is ${Math.floor(videoInfo.durationSec/60)}m ${videoInfo.durationSec%60}s — shorter than your required ${mins} minute(s).`,
            video_duration_sec: videoInfo.durationSec,
          });
        video_duration_sec = videoInfo.durationSec;
        const pricing = watchPricing(mins, rewardMap.watch ?? cfg.REWARDS.watch, margin);
        taskReward = pricing.reward;
        slotCost = pricing.slotCost;
      }
    }

    // Mobile surcharge (steer owners to the lower-fee web version). Applied to the locked
    // per-slot cost so it sticks for this campaign's life; web is unchanged and existing
    // campaigns keep their stored slot_cost. Owners (isOwner) pay 0 regardless.
    if (isMobileRequest(req)) slotCost = mobileCampaignCost(slotCost, task_type);

    const me = await getUserMeta(req.userId);
    const isOwner = me.role === 'owner' || me.email?.toLowerCase() === cfg.OWNER_EMAIL;
    const totalCost = isOwner ? 0 : slots * slotCost;
    const ownerTier = tierFor(isOwner ? 'owner' : me.role);

    await client.query('BEGIN');

    if (requiresChannel) {
      const chRes = await client.query('SELECT id, youtube_channel_id FROM channels WHERE id=$1 AND user_id=$2', [channel_id, req.userId]);
      if (!chRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Channel not found or not yours' });
      }
      // A subscribe target must be a real YouTube channel id (UC…). Legacy/garbage
      // channels can't be verified by anyone, so block the campaign at the source
      // rather than charging coins for a task that can never complete.
      if (!/^UC[A-Za-z0-9_-]{20,}$/.test(chRes.rows[0].youtube_channel_id || '')) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'This channel has an invalid YouTube ID. Remove it and re-add the channel using its real youtube.com/@handle or /channel/UC… link.' });
      }
    }

    // Every campaign must hang off an owner channel — the feed, "my campaigns",
    // and verify queries all INNER JOIN channels. Subscribe tasks pass an explicit
    // channel_id; video tasks (like/like_comment/watch) don't, so fall back to the
    // user's own channel. Without this, a video campaign charges coins but is then
    // invisible everywhere (null channel_id is dropped by every JOIN) and can never
    // be completed — the owner just loses the coins.
    let effectiveChannelId = channel_id;
    if (!effectiveChannelId) {
      const own = await client.query(
        `SELECT id FROM channels WHERE user_id=$1
         ORDER BY (youtube_channel_id = (SELECT youtube_channel_id FROM users WHERE id=$1)) DESC NULLS LAST, id ASC
         LIMIT 1`,
        [req.userId]
      );
      if (!own.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Add your YouTube channel before creating a campaign.' });
      }
      effectiveChannelId = own.rows[0].id;
    }

    if (!isOwner) {
      // Lock the user row FIRST so the campaign-count cap AND the coin check are
      // serialized per user. Reading the count before the lock let concurrent
      // POST /tasks each see the pre-lock count and both slip past the cap.
      const uRes = await client.query('SELECT coins FROM users WHERE id=$1 FOR UPDATE', [req.userId]);
      if (!uRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }

      const activeCount = await client.query(
        `SELECT COUNT(*) FROM tasks t JOIN channels c ON c.id=t.channel_id
         WHERE c.user_id=$1 AND t.status IN ('active','paused')`,
        [req.userId]
      );
      if (parseInt(activeCount.rows[0].count) >= appSettings.max_campaigns_per_user) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Maximum ${appSettings.max_campaigns_per_user} active campaigns allowed.` });
      }

      if (uRes.rows[0].coins < totalCost) {
        await client.query('ROLLBACK');
        return res.status(402).json({ error: 'Insufficient coins', required: totalCost, available: uRes.rows[0].coins });
      }
      await client.query('UPDATE users SET coins=coins-$1 WHERE id=$2', [totalCost, req.userId]);
    }

    const taskRes = await client.query(
      `INSERT INTO tasks (channel_id,task_type,reward,remaining_slots,total_slots,
                          target_video_id,target_video_url,watch_minutes,video_duration_sec,owner_tier,slot_cost,comment_bonus,comment_example_ids)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [effectiveChannelId, task_type, taskReward, slots,
       target_video_id, target_video_url||null,
       storedWatchMinutes, video_duration_sec, ownerTier, slotCost, commentBonusFunded,
       commentExampleIds.length ? commentExampleIds : null]
    );

    // Structured transaction key — frontend translates this
    const txKey = isOwner
      ? `tx:campaign_created|type:${task_type}|slots:${slots}|free:true`
      : `tx:campaign_created|type:${task_type}|slots:${slots}|cost:${slotCost}`;

    await client.query(
      `INSERT INTO transactions (user_id,amount,type,description) VALUES ($1,$2,'spent',$3)`,
      [req.userId, totalCost, txKey]
    );

    await client.query('COMMIT');
    res.status(201).json({ task: taskRes.rows[0], coins_spent: totalCost, slot_cost: slotCost, earner_reward: taskReward, owner: isOwner });
  } catch (err) { await client.query('ROLLBACK'); next(err); }
  finally { client.release(); }
};

// POST /tasks/:id/verify
const verifyTask = async (req, res, next) => {
  // The dedicated pooled client is acquired ONLY for the BEGIN..COMMIT block far below
  // (just before BEGIN). Every pre-transaction read uses the shared pool, so we never
  // hold a connection idle across the (potentially slow) YouTube API calls — that could
  // starve the pool under load.
  let dbc = null;
  try {
    const taskId = parseInt(req.params.id, 10);
    const { device_id } = req.body;

    // A device signal is mandatory for earning — without it the per-device
    // multi-account cap can't be enforced (it used to silently no-op).
    if (!device_id || typeof device_id !== 'string' || device_id.length < 6)
      return res.status(400).json({ error: 'Device identification required. Please update the app.', code: 'DEVICE_REQUIRED' });

    try {
      await antiCheat.assertNotBanned(req.userId);
      await antiCheat.assertVelocityOk(req.userId);
      await antiCheat.assertDeviceOk(req.userId, device_id);
    } catch (e) { return res.status(e.status||403).json({ error: e.message, code: e.code }); }

    // Play Integrity gate. SOFT by default: verify a token if the app sent one, but
    // only reject when INTEGRITY_ENFORCE=true — so existing clients that don't send a
    // token keep working until enforcement is switched on server-side.
    const integrityToken = req.body.integrity_token;
    if (integrityToken) {
      try {
        const v = await integrity.verifyIntegrity(integrityToken, req.userId);
        if (!v.ok) {
          if (cfg.INTEGRITY_ENFORCE)
            return res.status(403).json({ error: 'This device failed a security check.', code: 'INTEGRITY_FAILED', reason: v.reason });
          console.warn(`[integrity] soft-fail user=${req.userId} reason=${v.reason} verdicts=${JSON.stringify(v.verdicts)}`);
        }
      } catch (e) {
        if (cfg.INTEGRITY_ENFORCE)
          return res.status(503).json({ error: 'Could not verify device security, please try again.', code: 'INTEGRITY_ERROR' });
        console.warn('[integrity] verify error (soft):', e.message);
      }
    } else if (cfg.INTEGRITY_ENFORCE && !isTrustedWebRequest(req)) {
      // Web can't produce a Play Integrity token — it's a separate (lower) trust tier,
      // governed by the device/velocity guards instead. The web exemption requires a
      // genuine browser request from a known web origin (isTrustedWebRequest), so an
      // Android client can't just claim platform:'web' to skip attestation. Android is
      // hard-required to attest; a real web client is unaffected.
      return res.status(426).json({ error: 'Please update the app to continue earning.', code: 'INTEGRITY_REQUIRED' });
    }

    const appSettings = await settings.getSettings();
    let delaySeconds = appSettings.completion_delay_seconds || cfg.COMPLETION_DELAY_SECONDS;
    // Watch tasks must be watched for their FULL requested duration — the server floor
    // is watch_minutes×60 (capped at the actual video length so it's always achievable),
    // not the flat 45s. This is the anti-cheat backstop behind the in-app player timer.
    const wfloor = await pool.query('SELECT task_type, watch_minutes, video_duration_sec FROM tasks WHERE id=$1', [taskId]);
    if (wfloor.rows.length && wfloor.rows[0].task_type === 'watch') {
      const need = (wfloor.rows[0].watch_minutes || cfg.MIN_WATCH_MINUTES) * 60;
      const vidLen = wfloor.rows[0].video_duration_sec || need;
      delaySeconds = Math.max(delaySeconds, Math.min(need, vidLen));
    }

    // The completion delay is measured ONLY from the server-stamped start
    // (POST /tasks/:id/start). The old client-supplied started_at fallback is gone
    // — it let a forged timestamp skip the wait entirely.
    const startRow = await pool.query('SELECT started_at FROM task_starts WHERE user_id=$1 AND task_id=$2', [req.userId, taskId]);
    if (!startRow.rows.length) {
      // No server-stamped start yet (e.g. the app's fire-and-forget /start was
      // dropped). Stamp it NOW and make the user wait the full delay measured from
      // this server time — keeps the anti-bypass guarantee without hard-failing an
      // already-published client that didn't reach /start.
      await pool.query(
        `INSERT INTO task_starts (user_id, task_id, started_at) VALUES ($1,$2,NOW())
         ON CONFLICT (user_id, task_id) DO NOTHING`,
        [req.userId, taskId]
      );
      return res.status(400).json({ error: `Wait ${delaySeconds} more seconds`, remaining: delaySeconds, code: 'NOT_STARTED' });
    }
    const startedMs = new Date(startRow.rows[0].started_at).getTime();
    const elapsed = (Date.now() - startedMs) / 1000;
    if (elapsed < delaySeconds)
      return res.status(400).json({ error: `Wait ${Math.ceil(delaySeconds - elapsed)} more seconds`, remaining: Math.ceil(delaySeconds - elapsed) });

    const taskRes = await pool.query(
      `SELECT t.*, c.user_id AS owner_id, c.youtube_channel_id AS target_channel_id
       FROM tasks t JOIN channels c ON c.id=t.channel_id WHERE t.id=$1`,
      [taskId]
    );
    if (!taskRes.rows.length) return res.status(404).json({ error: 'Task not found' });
    const task = taskRes.rows[0];

    if (task.status === 'paused')    return res.status(409).json({ error: 'Campaign is paused', code: 'CAMPAIGN_PAUSED' });
    if (task.status === 'cancelled') return res.status(409).json({ error: 'Campaign was cancelled', code: 'CAMPAIGN_CANCELLED' });
    if (task.status !== 'active' || task.remaining_slots <= 0)
      return res.status(409).json({ error: 'Campaign no longer available', code: 'CAMPAIGN_UNAVAILABLE' });
    if (task.owner_id === req.userId) return res.status(403).json({ error: 'Cannot complete your own campaign' });

    // Watch tasks can't be verified against any YouTube API, so bound abuse with a
    // per-user daily cap (the earned-target ledger already blocks re-earning the
    // same video).
    if (task.task_type === 'watch') {
      const wc = await pool.query(
        `SELECT COUNT(*) AS n FROM completions WHERE user_id=$1 AND task_type='watch' AND completed_at > NOW() - INTERVAL '24 hours'`,
        [req.userId]
      );
      // 0 / unset = no watch-specific cap (the global per-role daily limit still applies).
      const watchCap = parseInt(appSettings.max_watch_per_day, 10) || cfg.MAX_WATCH_PER_DAY;
      if (watchCap > 0 && parseInt(wc.rows[0].n, 10) >= watchCap)
        return res.status(429).json({ error: `Daily watch limit reached (${watchCap}). Come back tomorrow.`, code: 'WATCH_DAILY_LIMIT' });

      // Anti-parallel-farm: watch tasks can't be verified against YouTube, so a user
      // could /start many at once, let one clock elapse, and claim them all. Require
      // consecutive watch claims to be spaced by ~this task's watch time, so N watch
      // rewards genuinely cost N × the duration of real time (not one shared window).
      const lastW = await pool.query(
        `SELECT completed_at FROM completions WHERE user_id=$1 AND task_type='watch' ORDER BY completed_at DESC LIMIT 1`,
        [req.userId]
      );
      if (lastW.rows.length) {
        const gap = (Date.now() - new Date(lastW.rows[0].completed_at).getTime()) / 1000;
        const need = (task.watch_minutes || cfg.MIN_WATCH_MINUTES) * 60 * 0.9; // 10% grace for UX
        if (gap < need)
          return res.status(429).json({ error: 'Finish watching this video before claiming the next one.', code: 'WATCH_TOO_SOON', remaining: Math.ceil(need - gap) });
      }
    }

    // Admin per-type daily cap (default-safe: 0/absent = unlimited). Applies to every
    // task type; watch also keeps its own hard MAX_WATCH_PER_DAY above.
    // Effective per-type caps = code defaults overlaid with whatever the admin saved —
    // per KEY, so an admin who only ever set e.g. `subscribe` still gets the default
    // like/like_comment caps (an explicit 0 on a key = unlimited for that type).
    const capMap = { ...settings.DEFAULTS.daily_cap_by_type,
      ...((appSettings.daily_cap_by_type && typeof appSettings.daily_cap_by_type === 'object') ? appSettings.daily_cap_by_type : {}) };
    const typeCap = parseInt(capMap[task.task_type], 10);
    // like + like_comment share ONE daily bucket (DAILY_CAP_GROUP) — count them together.
    const capTypes = cfg.DAILY_CAP_GROUP[task.task_type] || [task.task_type];
    if (typeCap > 0) {
      const cc = await pool.query(
        `SELECT COUNT(*) AS n FROM completions WHERE user_id=$1 AND task_type = ANY($2) AND completed_at > NOW() - INTERVAL '24 hours'`,
        [req.userId, capTypes]
      );
      if (parseInt(cc.rows[0].n, 10) >= typeCap)
        return res.status(429).json({ error: 'Daily limit reached for this task type — try a different one or come back tomorrow.', code: 'TYPE_DAILY_LIMIT' });
    }

    // Fast pre-checks (authoritative enforcement is inside the transaction below).
    const targetKeys = earnedKeysFor(task);
    const dup = await pool.query('SELECT id FROM completions WHERE task_id=$1 AND user_id=$2', [taskId, req.userId]);
    if (dup.rows.length) return res.status(409).json({ error: 'Already completed', code: 'ALREADY_COMPLETED' });
    if (targetKeys.length) {
      const et = await pool.query('SELECT 1 FROM earned_targets WHERE user_id=$1 AND target_key = ANY($2) LIMIT 1', [req.userId, targetKeys]);
      if (et.rows.length) return res.status(409).json({ error: 'You already earned coins for this channel or video.', code: 'ALREADY_EARNED' });
    }

    const mode = await settings.getMode();
    const degraded = mode.mode === 'degraded';
    let verifyMethod = 'honor';
    let commentVerified = false;
    let bonusCoins = 0;

    if (!degraded && task.task_type !== 'watch') {
      verifyMethod = 'api';
      try {
        if (VERIFIABLE_SUB.has(task.task_type)) {
          const subOk = await youtubeService.verifySubscription(req.userId, task.target_channel_id);
          if (!subOk) {
            // Auto-pause a brand-new campaign ONLY when its target channel is genuinely
            // gone (deleted/invalid), verified server-side with the public API key. A
            // single earner who simply didn't subscribe must never be able to pause a
            // healthy competitor's campaign (griefing) — a present or unknown (API error)
            // channel result leaves the campaign untouched.
            youtubeService.channelExists(task.target_channel_id).then((exists) => {
              if (exists === false) {
                pool.query(
                  `UPDATE tasks SET status='paused' WHERE id=$1
                   AND (SELECT COUNT(*) FROM completions WHERE task_id=$1 AND verify_status='verified') = 0
                   AND remaining_slots = total_slots`,
                  [taskId]
                ).catch(() => {});
              }
            }).catch(() => {});
            return res.status(400).json({ verified: false, error: 'Subscription not detected. Make sure you subscribed and the channel still exists, then try again.' });
          }
        }
        if (VERIFIABLE_LIKE.has(task.task_type)) {
          const likeOk = await youtubeService.verifyLike(req.userId, task.target_video_id);
          if (!likeOk) {
            // Auto-pause an untouched campaign ONLY if the target VIDEO is genuinely gone
            // (deleted/private), confirmed via the public API. A user who simply didn't
            // like must never pause a healthy campaign — a present or unknown (API error →
            // getVideoDuration throws → swallowed) result leaves the campaign untouched.
            youtubeService.getVideoDuration(task.target_video_id).then((info) => {
              if (info === null) {
                pool.query(
                  `UPDATE tasks SET status='paused' WHERE id=$1
                   AND (SELECT COUNT(*) FROM completions WHERE task_id=$1 AND verify_status='verified') = 0
                   AND remaining_slots = total_slots`,
                  [taskId]
                ).catch(() => {});
              }
            }).catch(() => {});
            return res.status(400).json({ verified: false, error: 'Like not detected. Like the video first, then try again.' });
          }
        }
        if (task.task_type === 'like_comment') {
          // The advertiser is paying for a like AND a comment, so the comment is
          // REQUIRED to complete — otherwise a like-only (or channel-less) user
          // would consume the slot and get paid for a comment that never lands.
          // API errors still throw and are handled by the outer catch (degraded/401).
          const cr = await youtubeService.verifyComment(req.userId, task.target_video_id);
          if (!cr.found) {
            if (cr.reason === 'no_channel_id')
              return res.status(400).json({ verified: false, code: 'NO_CHANNEL', error: 'You need a YouTube channel to comment. Create one on YouTube (free), then try again — or pick a like-only task.' });
            if (cr.disabled)
              return res.status(400).json({ verified: false, code: 'COMMENTS_DISABLED', error: "Comments are turned off on this video, so this task can't be completed." });
            return res.status(400).json({ verified: false, error: 'Comment not detected. Post your comment on the video, then try again.' });
          }
          // Quality floor (pure helper in lib/economy): ≥ MIN_COMMENT_WORDS words OR
          // ≥ MIN_COMMENT_CHARS chars (char fallback for space-less languages) so
          // one-word "nice" spam can't claim. Verified against the real comment text.
          if (!commentMeetsMinimum(cr.commentText, cfg.MIN_COMMENT_WORDS, cfg.MIN_COMMENT_CHARS)) {
            return res.status(400).json({ verified: false, code: 'COMMENT_TOO_SHORT',
              min_words: cfg.MIN_COMMENT_WORDS,
              error: `Your comment is too short — write at least ${cfg.MIN_COMMENT_WORDS} words so it looks genuine.` });
          }
          commentVerified = true;
          // Pay the bonus the OWNER FUNDED at creation (locked onto the task row), NOT
          // the current live setting — otherwise an admin raising comment_bonus later
          // would pay earners more than was charged on every outstanding campaign.
          // Legacy rows are backfilled to the historical default (4) by migrate.js.
          bonusCoins = Number.isInteger(task.comment_bonus) ? task.comment_bonus : cfg.COMMENT_BONUS;
        }
        await settings.recordApiSuccess();
      } catch (e) {
        const status = e.code === 'NO_YOUTUBE_ACCESS' ? 'noaccess'
                     : (e.code === 401 || e.response?.status === 401) ? 401
                     : e.response?.status || 'other';
        if (status === 'noaccess') return res.status(403).json({ error: 'YouTube access required. Sign out and sign in again.', code: 'NO_YOUTUBE_ACCESS' });
        if (status === 401) { await settings.recordApiFailure('401'); return res.status(401).json({ error: 'YouTube session expired. Sign in again.', code: 'YOUTUBE_REAUTH' }); }
        await settings.recordApiFailure(String(status));
        const after = await settings.getMode();
        if (after.mode === 'degraded') { verifyMethod = 'honor'; }
        else return res.status(502).json({ error: 'Could not verify right now. Try again shortly.', code: 'VERIFY_RETRY' });
      }
    }

    // Mobile earn penalty (steer earners to the web version). Web pays full; mobile pays
    // less and the house keeps the difference. Payout is always <= slot_cost, so no mint.
    const mobileEarn = isMobileRequest(req);
    const payoutReward = mobileEarn ? mobileEarnPayout(task.reward, task.task_type) : task.reward;
    const payoutBonus  = mobileEarn ? mobileEarnPayout(bonusCoins,  task.task_type) : bonusCoins;
    const totalCoins = payoutReward + payoutBonus;

    dbc = await pool.connect();
    await dbc.query('BEGIN');
    // Serialize THIS user's concurrent verifies by locking their row first, so the
    // per-user daily caps below (and the balance credit) can't be beaten by a burst of
    // parallel /verify requests that each read a pre-credit count. (The earlier COUNTs
    // are fast pre-checks outside any transaction; these are the authoritative ones.)
    await dbc.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [req.userId]);

    // Watch hard cap — re-checked under the lock.
    if (task.task_type === 'watch') {
      const wc2 = await dbc.query(
        `SELECT COUNT(*) AS n FROM completions WHERE user_id=$1 AND task_type='watch' AND completed_at > NOW() - INTERVAL '24 hours'`,
        [req.userId]
      );
      const watchCap2 = parseInt(appSettings.max_watch_per_day, 10) || cfg.MAX_WATCH_PER_DAY;
      if (watchCap2 > 0 && parseInt(wc2.rows[0].n, 10) >= watchCap2) {
        await dbc.query('ROLLBACK');
        return res.status(429).json({ error: `Daily watch limit reached (${watchCap2}). Come back tomorrow.`, code: 'WATCH_DAILY_LIMIT' });
      }
    }
    // Admin per-type daily cap — re-checked under the lock.
    const typeCap2 = parseInt(capMap[task.task_type], 10);
    if (typeCap2 > 0) {
      const cc2 = await dbc.query(
        `SELECT COUNT(*) AS n FROM completions WHERE user_id=$1 AND task_type = ANY($2) AND completed_at > NOW() - INTERVAL '24 hours'`,
        [req.userId, capTypes]
      );
      if (parseInt(cc2.rows[0].n, 10) >= typeCap2) {
        await dbc.query('ROLLBACK');
        return res.status(429).json({ error: 'Daily limit reached for this task type — try a different one or come back tomorrow.', code: 'TYPE_DAILY_LIMIT' });
      }
    }

    // Lock the row and re-read status INSIDE the transaction — a concurrent pause/
    // cancel between the earlier pre-check and here must not slip through.
    const lockRes = await dbc.query('SELECT remaining_slots, status FROM tasks WHERE id=$1 AND remaining_slots>0 FOR UPDATE', [taskId]);
    if (!lockRes.rows.length) {
      await dbc.query('ROLLBACK');
      return res.status(409).json({ error: 'Someone just took the last slot — try another task!', code: 'CAMPAIGN_FULL' });
    }
    if (lockRes.rows[0].status !== 'active') {
      await dbc.query('ROLLBACK');
      return res.status(409).json({ error: 'Campaign is no longer available.', code: 'CAMPAIGN_UNAVAILABLE' });
    }

    // Authoritative once-per-task guard, backed by the UNIQUE(task_id,user_id)
    // index. If a concurrent request already inserted the completion, this does
    // nothing and we bail — no double-credit possible under a slot race.
    const compIns = await dbc.query(
      `INSERT INTO completions (task_id,user_id,verify_method,verify_status,coins_awarded,bonus_coins,
              comment_verified,last_audit_at,target_channel_id,target_video_id,task_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8,$9,$10)
       ON CONFLICT (task_id,user_id) DO NOTHING
       RETURNING id`,
      [taskId, req.userId, verifyMethod, verifyMethod==='api' ? 'verified' : 'pending',
       totalCoins, payoutBonus, commentVerified,
       task.target_channel_id, task.target_video_id, task.task_type]
    );
    if (!compIns.rows.length) {
      await dbc.query('ROLLBACK');
      return res.status(409).json({ error: 'Already completed', code: 'ALREADY_COMPLETED' });
    }

    // Authoritative once-per-target guard. Every applicable key must be NEWLY
    // inserted; if any already existed (a different campaign on the same channel/
    // video, or a concurrent request) the user was already paid for it — undo all.
    if (targetKeys.length) {
      const etIns = await dbc.query(
        `INSERT INTO earned_targets (user_id, target_key)
         SELECT $1, k FROM unnest($2::text[]) AS k
         ON CONFLICT DO NOTHING RETURNING target_key`,
        [req.userId, targetKeys]
      );
      if (etIns.rows.length !== targetKeys.length) {
        await dbc.query('ROLLBACK');
        return res.status(409).json({ error: 'You already earned coins for this channel or video.', code: 'ALREADY_EARNED' });
      }
    }

    await dbc.query(
      `UPDATE tasks SET remaining_slots=remaining_slots-1,
              status=CASE WHEN remaining_slots-1<=0 THEN 'completed' ELSE status END WHERE id=$1`,
      [taskId]
    );
    await dbc.query('UPDATE users SET coins=coins+$1 WHERE id=$2', [totalCoins, req.userId]);

    // Structured transaction key
    const txKey = commentVerified
      ? `tx:task_completed_comment|type:${task.task_type}|bonus:${payoutBonus}`
      : `tx:task_completed|type:${task.task_type}`;

    await dbc.query(
      `INSERT INTO transactions (user_id,amount,type,description) VALUES ($1,$2,'earned',$3)`,
      [req.userId, totalCoins, txKey]
    );
    // Honor/degraded-mode like_comment: the earner was paid the base reward but the comment
    // couldn't be API-verified during the outage, so the owner-funded comment bonus wasn't
    // paid to anyone. Return it to the owner instead of letting it fall to the house.
    if (task.task_type === 'like_comment' && !commentVerified) {
      const ownerBonus = Number.isInteger(task.comment_bonus) ? task.comment_bonus : cfg.COMMENT_BONUS;
      if (ownerBonus > 0 && task.owner_id) {
        await dbc.query('UPDATE users SET coins=coins+$1 WHERE id=$2', [ownerBonus, task.owner_id]);
        await dbc.query(`INSERT INTO transactions (user_id,amount,type,description) VALUES ($1,$2,'earned','tx:comment_bonus_refunded_owner')`, [task.owner_id, ownerBonus]);
      }
    }
    await dbc.query('COMMIT');

    await antiCheat.stampTask(req.userId);
    if (device_id) await antiCheat.registerDevice(req.userId, device_id);
    pool.query('DELETE FROM task_starts WHERE user_id=$1 AND task_id=$2', [req.userId, taskId]).catch(() => {});

    // Referral payout: only on a real API-verified task (never honor mode), after
    // the device is registered so the self-referral device check is accurate.
    if (verifyMethod === 'api') {
      require('../services/referralService').rewardReferralIfPending(req.userId, device_id).catch(() => {});
    }

    const bal = await pool.query('SELECT coins FROM users WHERE id=$1', [req.userId]);
    res.json({
      verified: true, method: verifyMethod, degraded,
      coins_earned: payoutReward, bonus_coins: payoutBonus, total_coins: totalCoins,
      comment_verified: commentVerified, new_balance: bal.rows[0].coins,
      message: commentVerified
        ? `✅ Like & Comment verified! +${totalCoins} coins (includes +${payoutBonus} comment bonus)`
        : verifyMethod === 'api' ? `✅ Verified by YouTube! +${totalCoins} coins`
        : degraded ? `⚠️ Verification offline — coins awarded, may be checked later.`
        : `Coins awarded. This task may be spot-checked.`,
    });
  } catch (err) { if (dbc) await dbc.query('ROLLBACK').catch(() => {}); next(err); }
  finally { if (dbc) dbc.release(); }
};

// GET /tasks/my
const getMyTasks = async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT t.*, c.channel_name, c.channel_url,
              (SELECT COUNT(*) FROM completions co WHERE co.task_id=t.id) AS completions_count,
              CASE WHEN COALESCE(t.total_slots,t.remaining_slots)>0
                   THEN ROUND(100.0*(COALESCE(t.total_slots,t.remaining_slots)-t.remaining_slots)
                        /COALESCE(t.total_slots,t.remaining_slots)) ELSE 0 END AS progress_pct,
              (t.status='active') AS can_pause,
              (t.status='paused' AND t.remaining_slots>0) AS can_resume,
              (t.status IN ('active','paused')) AS can_cancel
       FROM tasks t JOIN channels c ON c.id=t.channel_id
       WHERE c.user_id=$1 ORDER BY t.created_at DESC`,
      [req.userId]
    );
    res.json(r.rows);
  } catch (err) { next(err); }
};

// POST /tasks/:id/start — stamp the moment the user opened a task, server-side,
// so the verify delay can't be skipped with a forged client started_at.
const startTask = async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    if (!taskId) return res.status(400).json({ error: 'Invalid task id' });
    // Watch tasks are honor-mode (no YouTube verification), so their only real cost is
    // TIME. To stop a user from starting many watch tasks in parallel and letting one
    // clock satisfy all of them, allow only ONE open (un-completed) watch start at a
    // time: starting a new watch task clears the user's other pending watch starts.
    const tt = await pool.query(
      `SELECT t.task_type, t.target_video_id, t.status, t.remaining_slots, c.youtube_channel_id AS target_channel_id
       FROM tasks t JOIN channels c ON c.id=t.channel_id WHERE t.id=$1`,
      [taskId]
    );
    if (!tt.rows.length) return res.status(404).json({ error: 'Task not found', code: 'TASK_NOT_FOUND' });
    const stTask = tt.rows[0];
    // Reject BEFORE the user does any real work if they've already earned this target.
    // A stale feed (e.g. a like AND a like_comment shown for the same video) must never
    // let them like/comment/etc. for free only to be rejected at verify afterwards.
    const startKeys = earnedKeysFor(stTask);
    if (startKeys.length) {
      const et = await pool.query('SELECT 1 FROM earned_targets WHERE user_id=$1 AND target_key = ANY($2) LIMIT 1', [req.userId, startKeys]);
      if (et.rows.length) return res.status(409).json({ error: 'You already earned coins for this channel or video.', code: 'ALREADY_EARNED' });
    }
    // Reject before the user acts if the campaign is no longer takeable (stale feed) —
    // otherwise they'd do real work only for verify to reject them for the same reason.
    if (stTask.status === 'paused')    return res.status(409).json({ error: 'Campaign is paused', code: 'CAMPAIGN_PAUSED' });
    if (stTask.status === 'cancelled') return res.status(409).json({ error: 'Campaign was cancelled', code: 'CAMPAIGN_CANCELLED' });
    if (stTask.status !== 'active' || stTask.remaining_slots <= 0)
      return res.status(409).json({ error: 'Campaign no longer available', code: 'CAMPAIGN_UNAVAILABLE' });
    if (stTask.task_type === 'watch') {
      await pool.query(
        `DELETE FROM task_starts ts
         WHERE ts.user_id = $1 AND ts.task_id <> $2
           AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = ts.task_id AND t.task_type = 'watch')
           AND NOT EXISTS (SELECT 1 FROM completions cp WHERE cp.user_id = $1 AND cp.task_id = ts.task_id)`,
        [req.userId, taskId]
      );
    }
    await pool.query(
      `INSERT INTO task_starts (user_id, task_id, started_at) VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, task_id) DO UPDATE SET started_at = NOW()`,
      [req.userId, taskId]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
};

// GET /tasks/:id/comment-help?lang=xx — what to comment for a like_comment task:
// the owner's chosen curated template indices (client renders them per-locale) plus,
// if Gemini is configured, ONE fresh video-specific example in the user's language
// (cached once per task+lang). Everything degrades to templates if AI is unavailable.
const getCommentHelp = async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const lang = String(req.query.lang || 'en').slice(0, 12);
    const r = await pool.query('SELECT task_type, target_video_id, comment_example_ids FROM tasks WHERE id=$1', [taskId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Task not found' });
    const task = r.rows[0];
    const out = {
      min_words: cfg.MIN_COMMENT_WORDS,
      min_chars: cfg.MIN_COMMENT_CHARS,
      template_ids: Array.isArray(task.comment_example_ids) ? task.comment_example_ids : [],
      ai_example: null,
    };
    if (task.task_type !== 'like_comment') return res.json(out);

    const cached = await pool.query('SELECT text FROM comment_ai_examples WHERE task_id=$1 AND lang=$2', [taskId, lang]);
    if (cached.rows.length) { out.ai_example = cached.rows[0].text; return res.json(out); }

    if (gemini.available() && task.target_video_id) {
      let title = '';
      try { const vi = await youtubeService.getVideoDuration(task.target_video_id); title = vi?.title || ''; } catch (_) {}
      const ex = await gemini.generateExampleComment(title, lang);
      if (ex) {
        out.ai_example = ex;
        pool.query('INSERT INTO comment_ai_examples (task_id, lang, text) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [taskId, lang, ex]).catch(() => {});
      }
    }
    res.json(out);
  } catch (err) { next(err); }
};

module.exports = { getAvailableTasks, createTask, verifyTask, getMyTasks, startTask, getIntegrityNonce, getCommentHelp, getClientConfig };
