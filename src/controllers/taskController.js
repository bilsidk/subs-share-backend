const pool = require('../db/pool');
const youtubeService = require('../services/youtubeService');
const settings       = require('../services/settingsService');
const antiCheat      = require('../services/antiCheatService');
const cfg            = require('../config');

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

function watchPricing(minutes, baseReward, margin) {
  const extraMins = Math.max(0, minutes - 1);
  const reward = baseReward + (extraMins * cfg.WATCH_REWARD_PER_EXTRA_MIN);
  return { reward, slotCost: reward + margin };
}

// GET /tasks
const getAvailableTasks = async (req, res, next) => {
  try {
    const { type } = req.query;
    const params = [req.userId];
    let typeFilter = '';
    if (type) { params.push(type); typeFilter = `AND t.task_type=$${params.length}`; }

    const r = await pool.query(
      `SELECT t.id, t.task_type, t.reward, t.remaining_slots, t.total_slots,
              t.target_video_id, t.target_video_url, t.watch_minutes, t.created_at,
              c.channel_name, COALESCE(c.channel_url, '') AS channel_url, c.youtube_channel_id,
              u.name AS owner_name, u.avatar AS owner_avatar, u.role AS owner_role,
              CASE u.role WHEN 'owner' THEN 1 WHEN 'premium' THEN 2 ELSE 3 END AS tier,
              CASE WHEN COALESCE(t.total_slots,t.remaining_slots)>0
                   THEN (COALESCE(t.total_slots,t.remaining_slots)-t.remaining_slots)::float
                        /COALESCE(t.total_slots,t.remaining_slots)
                   ELSE 0 END AS progress_ratio
       FROM tasks t
       JOIN channels c ON c.id=t.channel_id
       JOIN users u    ON u.id=c.user_id
       LEFT JOIN completions co ON co.task_id=t.id AND co.user_id=$1
       WHERE t.status='active' AND t.remaining_slots>0 AND c.user_id!=$1 AND co.id IS NULL ${typeFilter}
       ORDER BY tier ASC, progress_ratio ASC, t.created_at DESC LIMIT 80`,
      params
    );
    res.json(r.rows);
  } catch (err) { next(err); }
};

// POST /tasks
const createTask = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { channel_id, task_type='subscribe', subscribers_wanted, target_video_url, watch_minutes } = req.body;
    const slots = parseInt(subscribers_wanted, 10);

    const requiresChannel = ['subscribe', 'subscribe_like'].includes(task_type);
    if (requiresChannel && !channel_id)
      return res.status(400).json({ error: 'channel_id required for subscribe tasks' });
    if (!slots || slots < 1)
      return res.status(400).json({ error: 'Slot count required' });
    if (!cfg.REWARDS[task_type])
      return res.status(400).json({ error: 'Invalid task_type' });

    const appSettings = await settings.getSettings();
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
      const activeCount = await client.query(
        `SELECT COUNT(*) FROM tasks t JOIN channels c ON c.id=t.channel_id
         WHERE c.user_id=$1 AND t.status IN ('active','paused')`,
        [req.userId]
      );
      if (parseInt(activeCount.rows[0].count) >= appSettings.max_campaigns_per_user) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Maximum ${appSettings.max_campaigns_per_user} active campaigns allowed.` });
      }

      const uRes = await client.query('SELECT coins FROM users WHERE id=$1 FOR UPDATE', [req.userId]);
      if (uRes.rows[0].coins < totalCost) {
        await client.query('ROLLBACK');
        return res.status(402).json({ error: 'Insufficient coins', required: totalCost, available: uRes.rows[0].coins });
      }
      await client.query('UPDATE users SET coins=coins-$1 WHERE id=$2', [totalCost, req.userId]);
    }

    const taskRes = await client.query(
      `INSERT INTO tasks (channel_id,task_type,reward,remaining_slots,total_slots,
                          target_video_id,target_video_url,watch_minutes,video_duration_sec,owner_tier)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [effectiveChannelId, task_type, taskReward, slots,
       target_video_id, target_video_url||null,
       watch_minutes||cfg.MIN_WATCH_MINUTES, video_duration_sec, ownerTier]
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
  const dbc = await pool.connect();
  try {
    const taskId = parseInt(req.params.id, 10);
    const { started_at, device_id } = req.body;

    try {
      await antiCheat.assertNotBanned(req.userId);
      await antiCheat.assertVelocityOk(req.userId);
      await antiCheat.assertDeviceOk(req.userId, device_id);
    } catch (e) { return res.status(e.status||403).json({ error: e.message, code: e.code }); }

    if (!started_at) return res.status(400).json({ error: 'started_at required' });

    const appSettings = await settings.getSettings();
    const delaySeconds = appSettings.completion_delay_seconds || cfg.COMPLETION_DELAY_SECONDS;
    const elapsed = (Date.now() - started_at) / 1000;
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

    const dup = await pool.query('SELECT id FROM completions WHERE task_id=$1 AND user_id=$2', [taskId, req.userId]);
    if (dup.rows.length) return res.status(409).json({ error: 'Already completed' });

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
            pool.query(
              `UPDATE tasks SET status='paused' WHERE id=$1
               AND (SELECT COUNT(*) FROM completions WHERE task_id=$1 AND verify_status='verified') = 0
               AND remaining_slots = total_slots`,
              [taskId]
            ).catch(() => {});
            return res.status(400).json({ verified: false, error: 'Subscription not detected. Make sure you subscribed and the channel still exists, then try again.' });
          }
        }
        if (VERIFIABLE_LIKE.has(task.task_type)) {
          const likeOk = await youtubeService.verifyLike(req.userId, task.target_video_id);
          if (!likeOk) return res.status(400).json({ verified: false, error: 'Like not detected. Like the video first, then try again.' });
        }
        if (task.task_type === 'like_comment') {
          try {
            const cr = await youtubeService.verifyComment(req.userId, task.target_video_id);
            if (cr.found) {
              commentVerified = true;
              const s = await settings.getSettings();
              bonusCoins = s.comment_bonus ?? cfg.COMMENT_BONUS;
            }
          } catch (e) { console.error('Comment check error (non-fatal):', e.message); }
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

    const totalCoins = task.reward + bonusCoins;

    await dbc.query('BEGIN');
    const lockRes = await dbc.query('SELECT remaining_slots FROM tasks WHERE id=$1 AND remaining_slots>0 FOR UPDATE', [taskId]);
    if (!lockRes.rows.length) {
      await dbc.query('ROLLBACK');
      return res.status(409).json({ error: 'Someone just took the last slot — try another task!', code: 'CAMPAIGN_FULL' });
    }

    await dbc.query(
      `INSERT INTO completions (task_id,user_id,verify_method,verify_status,coins_awarded,bonus_coins,
              comment_verified,last_audit_at,target_channel_id,target_video_id,task_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8,$9,$10)`,
      [taskId, req.userId, verifyMethod, verifyMethod==='api' ? 'verified' : 'pending',
       totalCoins, bonusCoins, commentVerified,
       task.target_channel_id, task.target_video_id, task.task_type]
    );
    await dbc.query(
      `UPDATE tasks SET remaining_slots=remaining_slots-1,
              status=CASE WHEN remaining_slots-1<=0 THEN 'completed' ELSE status END WHERE id=$1`,
      [taskId]
    );
    await dbc.query('UPDATE users SET coins=coins+$1 WHERE id=$2', [totalCoins, req.userId]);

    // Structured transaction key
    const txKey = commentVerified
      ? `tx:task_completed_comment|type:${task.task_type}|bonus:${bonusCoins}`
      : `tx:task_completed|type:${task.task_type}`;

    await dbc.query(
      `INSERT INTO transactions (user_id,amount,type,description) VALUES ($1,$2,'earned',$3)`,
      [req.userId, totalCoins, txKey]
    );
    await dbc.query('COMMIT');

    await antiCheat.stampTask(req.userId);
    if (device_id) await antiCheat.registerDevice(req.userId, device_id);

    const bal = await pool.query('SELECT coins FROM users WHERE id=$1', [req.userId]);
    res.json({
      verified: true, method: verifyMethod, degraded,
      coins_earned: task.reward, bonus_coins: bonusCoins, total_coins: totalCoins,
      comment_verified: commentVerified, new_balance: bal.rows[0].coins,
      message: commentVerified
        ? `✅ Like & Comment verified! +${totalCoins} coins (includes +${bonusCoins} comment bonus)`
        : verifyMethod === 'api' ? `✅ Verified by YouTube! +${totalCoins} coins`
        : degraded ? `⚠️ Verification offline — coins awarded, may be checked later.`
        : `Coins awarded. This task may be spot-checked.`,
    });
  } catch (err) { await dbc.query('ROLLBACK'); next(err); }
  finally { dbc.release(); }
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

module.exports = { getAvailableTasks, createTask, verifyTask, getMyTasks };
