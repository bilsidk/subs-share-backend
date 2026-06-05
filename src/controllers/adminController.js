const pool = require('../db/pool');
const settings = require('../services/settingsService');
const cfg = require('../config');

async function requireOwner(req, res) {
  const r = await pool.query('SELECT role, email FROM users WHERE id=$1', [req.userId]);
  const u = r.rows[0];
  const isOwner = u && (u.role==='owner' || u.email?.toLowerCase()===cfg.OWNER_EMAIL);
  if (!isOwner) { res.status(403).json({ error: 'Owner only' }); return false; }
  return true;
}

const getStatus = async (req, res, next) => {
  try {
    if (!await requireOwner(req, res)) return;
    const mode = await settings.getMode();
    const stats = await pool.query(`
      SELECT (SELECT COUNT(*) FROM users) AS users,
             (SELECT COUNT(*) FROM users WHERE role='premium') AS premium_users,
             (SELECT COUNT(*) FROM tasks WHERE status='active') AS active_tasks,
             (SELECT COUNT(*) FROM completions WHERE verify_status='verified') AS verified_completions,
             (SELECT COUNT(*) FROM completions WHERE verify_status='pending') AS pending_completions,
             (SELECT COUNT(*) FROM completions WHERE verify_status='reclaimed') AS reclaimed_completions
    `);
    res.json({ api_mode: mode.mode, degraded_reason: mode.reason, stats: stats.rows[0] });
  } catch (err) { next(err); }
};

const setModeManual = async (req, res, next) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { mode, reason } = req.body;
    if (!['live','degraded'].includes(mode)) return res.status(400).json({ error: "mode must be 'live' or 'degraded'" });
    await settings.setMode(mode, reason || (mode==='degraded' ? 'Manual: owner switch' : null));
    res.json({ ok: true, api_mode: mode });
  } catch (err) { next(err); }
};

const setRole = async (req, res, next) => {
  try {
    if (!await requireOwner(req, res)) return;
    const { email, role } = req.body;
    if (!['premium','user'].includes(role)) return res.status(400).json({ error: "role must be 'premium' or 'user'" });
    const r = await pool.query(
      `UPDATE users SET role=$1, is_premium=$2 WHERE LOWER(email)=LOWER($3) RETURNING id, email, role`,
      [role, role==='premium', email]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true, user: r.rows[0] });
  } catch (err) { next(err); }
};

module.exports = { getStatus, setModeManual, setRole };
