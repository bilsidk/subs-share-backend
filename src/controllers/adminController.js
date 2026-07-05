const pool = require('../db/pool');
const settings = require('../services/settingsService');
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
    const allowed = [
      'daily_limit_user', 'daily_limit_premium',
      'coins_subscribe', 'coins_like', 'coins_like_comment',
      'coins_subscribe_like', 'coins_watch', 'comment_bonus',
      'house_margin', 'completion_delay_seconds', 'max_campaigns_per_user',
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        const val = parseInt(req.body[key], 10);
        if (!isNaN(val) && val >= 0) updates[key] = val;
      }
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
    const email = req.query.email ? `%${req.query.email.toLowerCase()}%` : null;
    const where = email ? 'WHERE LOWER(email) LIKE $3' : '';
    const params = email ? [limit, offset, email] : [limit, offset];
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
      email ? 'SELECT COUNT(*) FROM users WHERE LOWER(email) LIKE $1' : 'SELECT COUNT(*) FROM users',
      email ? [email] : []
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

module.exports = { getStatus, getAppSettings, updateAppSettings, setModeManual, setRole, getUsers, banUser };
