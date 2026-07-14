const pool = require('../db/pool');
const settings = require('../services/settingsService');
const { refreshSubscriberCounts } = require('../services/auditScheduler');
const { OWNER_EMAIL } = require('../config');

async function requireOwner(req, res) {
  const r = await pool.query('SELECT role, email FROM users WHERE id = $1', [req.userId]);
  const u = r.rows[0];
  const isOwner = u && (u.role === 'owner' || u.email?.toLowerCase() === OWNER_EMAIL);
  if (!isOwner) { res.status(403).json({ error: 'Owner only' }); return false; }
  return true;
}

// GET /admin/status
const getStatus = async (req, res, next) => {
  try {
    if (!(await requireOwner(req, res))) return;
    const [mode, appSettings, stats] = await Promise.all([
      settings.getMode(),
      settings.getSettings(),
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM users) AS users,
          (SELECT COUNT(*) FROM users WHERE role = 'premium') AS premium_users,
          (SELECT COUNT(*) FROM users WHERE is_banned = TRUE) AS banned_users,
          (SELECT COUNT(*) FROM tasks WHERE status = 'active') AS active_tasks,
          (SELECT COUNT(*) FROM completions WHERE verify_status = 'verified') AS verified_completions,
          (SELECT COUNT(*) FROM completions WHERE verify_status = 'pending') AS pending_completions,
          (SELECT COUNT(*) FROM completions WHERE verify_status = 'reclaimed') AS reclaimed_completions,
          (SELECT COALESCE(SUM(coins),0) FROM users) AS total_coins_in_circulation
      `),
    ]);
    res.json({ api_mode: mode.mode, degraded_reason: mode.reason, settings: appSettings, stats: stats.rows[0] });
  } catch (err) { next(err); }
};

// POST /admin/refresh-subs — re-fetch subscriber counts for every channel now
const refreshSubs = async (req, res, next) => {
  try {
    if (!(await requireOwner(req, res))) return;
    const updated = await refreshSubscriberCounts();
    res.json({ ok: true, updated });
  } catch (err) { next(err); }
};

// GET /admin/stats — rich read-only dashboard (users, campaigns by type, economy).
const getStats = async (req, res, next) => {
  try {
    if (!(await requireOwner(req, res))) return;
    const [users, campaignsByType, completionsByType, economy] = await Promise.all([
      pool.query(`SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE created_at > NOW()::date) AS new_today,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS new_week,
        COUNT(*) FILTER (WHERE last_task_at > NOW() - INTERVAL '7 days') AS active_week,
        COUNT(*) FILTER (WHERE role='premium') AS premium,
        COUNT(*) FILTER (WHERE is_banned=TRUE) AS banned
        FROM users`),
      pool.query(`SELECT task_type,
        COUNT(*) FILTER (WHERE status='active') AS active,
        COALESCE(SUM(remaining_slots) FILTER (WHERE status='active'),0) AS remaining_slots,
        COALESCE(SUM(total_slots-remaining_slots),0) AS filled_slots,
        COUNT(*) FILTER (WHERE status='completed') AS completed
        FROM tasks GROUP BY task_type`),
      pool.query(`SELECT task_type,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE completed_at > NOW()::date) AS today,
        COUNT(*) FILTER (WHERE verify_status='reclaimed') AS reclaimed
        FROM completions GROUP BY task_type`),
      pool.query(`SELECT
        (SELECT COALESCE(SUM(coins),0) FROM users) AS coins_circulation,
        (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='earned' AND created_at > NOW()::date) AS earned_today,
        (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='spent' AND created_at > NOW()::date) AS spent_today,
        (SELECT COUNT(*) FROM transactions WHERE type='purchase') AS purchases_total`),
    ]);
    res.json({
      users: users.rows[0],
      campaigns_by_type: campaignsByType.rows,
      completions_by_type: completionsByType.rows,
      economy: economy.rows[0],
      generated_at: new Date().toISOString(),
    });
  } catch (err) { next(err); }
};

// GET /admin/settings
const getAppSettings = async (req, res, next) => {
  try {
    if (!(await requireOwner(req, res))) return;
    const s = await settings.getSettings();
    res.json(s);
  } catch (err) { next(err); }
};

// PATCH /admin/settings
const updateAppSettings = async (req, res, next) => {
  try {
    if (!(await requireOwner(req, res))) return;
    // Economy redesign (2026-07-11): only the 4 atoms are admin-settable now — Sub+Like
    // and Like+Comment rewards are DERIVED (sum of atoms) and no longer independently
    // configurable, so 'coins_like_comment'/'coins_subscribe_like' are deliberately absent
    // from this whitelist (any such fields in the request body are silently ignored).
    const allowed = [
      'daily_limit_user', 'daily_limit_premium',
      'coins_subscribe', 'coins_like', 'coins_watch', 'comment_bonus',
      'completion_delay_seconds', 'max_campaigns_per_user',
      'max_watch_per_day',
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        const val = parseInt(req.body[key], 10);
        if (!isNaN(val) && val >= 0) updates[key] = val;
      }
    }
    // House margin is now a % (was flat coins) — owner cost = ceil(earn * (1 + margin_pct)).
    // Clamped to [0,1] so a bad payload can never make cost < earn (no coin minting) or negative.
    if (req.body.margin_pct !== undefined) {
      const m = parseFloat(req.body.margin_pct);
      if (!isNaN(m)) updates.margin_pct = Math.min(1, Math.max(0, m));
    }
    // Non-integer admin controls (validated defensively so a bad payload can't brick the app).
    const TASK_TYPES = ['subscribe', 'like', 'like_comment', 'subscribe_like', 'watch'];
    if (Array.isArray(req.body.disabled_task_types)) {
      updates.disabled_task_types = req.body.disabled_task_types.filter(t => TASK_TYPES.includes(t));
    }
    if (req.body.daily_cap_by_type && typeof req.body.daily_cap_by_type === 'object' && !Array.isArray(req.body.daily_cap_by_type)) {
      const caps = {};
      for (const t of TASK_TYPES) {
        const v = parseInt(req.body.daily_cap_by_type[t], 10);
        if (!isNaN(v) && v > 0) caps[t] = Math.min(v, 100000);
      }
      updates.daily_cap_by_type = caps;
    }
    if (typeof req.body.maintenance_message === 'string') {
      updates.maintenance_message = req.body.maintenance_message.slice(0, 300);
    }
    if (typeof req.body.announcement_message === 'string') {
      updates.announcement_message = req.body.announcement_message.slice(0, 500);
    }
    if (typeof req.body.announcement_link === 'string') {
      const link = req.body.announcement_link.trim().slice(0, 300);
      // Only an http(s) URL (or empty to clear) — never javascript:/data: etc.
      updates.announcement_link = /^https?:\/\//i.test(link) ? link : '';
    }
    if (['both', 'web', 'mobile'].includes(req.body.announcement_platform)) {
      updates.announcement_platform = req.body.announcement_platform;
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No valid settings provided' });
    }
    await settings.updateSettings(updates);
    const fresh = await settings.getSettings();
    res.json({ ok: true, settings: fresh });
  } catch (err) { next(err); }
};

// POST /admin/mode
const setModeManual = async (req, res, next) => {
  try {
    if (!(await requireOwner(req, res))) return;
    const { mode, reason } = req.body;
    if (!['live', 'degraded'].includes(mode))
      return res.status(400).json({ error: "mode must be 'live' or 'degraded'" });
    await settings.setMode(mode, reason || (mode === 'degraded' ? 'Manual: owner switch' : null));
    res.json({ ok: true, api_mode: mode });
  } catch (err) { next(err); }
};

// POST /admin/promote
const setRole = async (req, res, next) => {
  try {
    if (!(await requireOwner(req, res))) return;
    const { email, role } = req.body;
    if (!['premium', 'user'].includes(role))
      return res.status(400).json({ error: "role must be 'premium' or 'user'" });
    if (typeof email === 'string' && email.toLowerCase() === OWNER_EMAIL)
      return res.status(400).json({ error: "The owner account's role cannot be changed." });
    const r = await pool.query(
      `UPDATE users SET role=$1, is_premium=$2 WHERE LOWER(email)=LOWER($3) AND COALESCE(role,'user') <> 'owner' RETURNING id, email, role`,
      [role, role === 'premium', email]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true, user: r.rows[0] });
  } catch (err) { next(err); }
};

// GET /admin/users?email=&page=
const getUsers = async (req, res, next) => {
  try {
    if (!(await requireOwner(req, res))) return;
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;
    // Search matches email OR name (powers the admin add-coins autocomplete).
    const q = (req.query.email || req.query.q || '').trim().toLowerCase();
    const like = q ? `%${q}%` : null;
    const where = like ? 'WHERE LOWER(email) LIKE $3 OR LOWER(COALESCE(name,\'\')) LIKE $3' : '';
    const params = like ? [limit, offset, like] : [limit, offset];
    const orderBy = req.query.sort === 'subs'
      ? 'subscriber_count DESC NULLS LAST, created_at DESC'
      : 'created_at DESC';
    const r = await pool.query(
      `SELECT id, email, name, role, coins, is_banned, ban_reason, trust_score,
              reclaim_count, created_at, subscriber_count, youtube_channel_id,
              (SELECT COUNT(*) FROM completions WHERE user_id=users.id) AS tasks_completed
       FROM users ${where}
       ORDER BY ${orderBy} LIMIT $1 OFFSET $2`,
      params
    );
    const total = await pool.query(
      like ? 'SELECT COUNT(*) FROM users WHERE LOWER(email) LIKE $1 OR LOWER(COALESCE(name,\'\')) LIKE $1' : 'SELECT COUNT(*) FROM users',
      like ? [like] : []
    );
    res.json({ users: r.rows, total: parseInt(total.rows[0].count), page, pages: Math.ceil(total.rows[0].count / limit) });
  } catch (err) { next(err); }
};

// POST /admin/ban  { email, reason }
const banUser = async (req, res, next) => {
  try {
    if (!(await requireOwner(req, res))) return;
    const { email, reason, unban } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    if (unban) {
      const r = await pool.query(
        `UPDATE users SET is_banned=FALSE, ban_reason=NULL, banned_at=NULL
         WHERE LOWER(email)=LOWER($1) RETURNING id, email, is_banned`,
        [email]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
      return res.json({ ok: true, user: r.rows[0] });
    }
    // Never ban an owner account (configured owner or any role='owner').
    if (email.toLowerCase() === OWNER_EMAIL)
      return res.status(400).json({ error: 'The owner account cannot be banned.' });
    const r = await pool.query(
      `UPDATE users SET is_banned=TRUE, ban_reason=$2, banned_at=NOW()
       WHERE LOWER(email)=LOWER($1) AND COALESCE(role,'user') <> 'owner'
       RETURNING id, email, is_banned, ban_reason`,
      [email, reason || 'Banned by admin']
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found or cannot be banned.' });
    // Claw back any referral bonus this banned user triggered as a referee.
    require('../services/referralService').reverseReferralForReferee(r.rows[0].id).catch(() => {});
    res.json({ ok: true, user: r.rows[0] });
  } catch (err) { next(err); }
};

// POST /admin/coins  { email, amount }  — add (or, with a negative amount, remove) coins
// for a user. Owner-only, row-locked, balance can never go negative, and every change is
// written to the transactions ledger for auditability.
const adjustCoins = async (req, res, next) => {
  try {
    if (!(await requireOwner(req, res))) return;
    const email = (req.body.email || '').trim();
    const amount = parseInt(req.body.amount, 10);
    if (!email || !Number.isInteger(amount) || amount === 0)
      return res.status(400).json({ error: 'email and a non-zero integer amount are required' });
    if (Math.abs(amount) > 1000000)
      return res.status(400).json({ error: 'Amount too large (max ±1,000,000).' });
    const dbc = await pool.connect();
    try {
      await dbc.query('BEGIN');
      const u = await dbc.query('SELECT id, email, name, coins FROM users WHERE LOWER(email)=LOWER($1) FOR UPDATE', [email]);
      if (!u.rows.length) { await dbc.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
      const uid = u.rows[0].id;
      const before = Number(u.rows[0].coins) || 0;
      // Clamp a removal so a balance can never go negative.
      const applied = amount < 0 ? -Math.min(before, -amount) : amount;
      if (applied === 0) { await dbc.query('ROLLBACK'); return res.status(400).json({ error: 'User has no coins to remove.' }); }
      await dbc.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [applied, uid]);
      await dbc.query(
        `INSERT INTO transactions (user_id, amount, type, description) VALUES ($1,$2,$3,$4)`,
        [uid, Math.abs(applied), applied >= 0 ? 'earned' : 'spent', `tx:admin_adjust|delta:${applied}`]
      );
      await dbc.query('COMMIT');
      res.json({ ok: true, user: { id: uid, email: u.rows[0].email, name: u.rows[0].name, coins: before + applied }, applied });
    } catch (e) { await dbc.query('ROLLBACK'); throw e; }
    finally { dbc.release(); }
  } catch (err) { next(err); }
};

module.exports = { getStatus, getStats, refreshSubs, getAppSettings, updateAppSettings, setModeManual, setRole, getUsers, banUser, adjustCoins };
