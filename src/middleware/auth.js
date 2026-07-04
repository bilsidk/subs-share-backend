const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const authenticate = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Authorization token required' });

  try {
    // Pin the algorithm — never accept a token signed with a different alg
    // (defence-in-depth against alg-confusion attacks).
    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET, {
      algorithms: ['HS256'],
    });
    req.userId = decoded.userId;
    req.email  = decoded.email;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Global ban gate. A banned user keeps a valid 30-day JWT, so a ban must be
// enforced on every state-changing route (earn, create/cancel campaign, buy,
// add channel) — not only inside the verify path. Apply AFTER authenticate.
const requireNotBanned = async (req, res, next) => {
  try {
    const r = await pool.query('SELECT is_banned, ban_reason FROM users WHERE id=$1', [req.userId]);
    if (r.rows[0]?.is_banned) {
      return res.status(403).json({
        error: r.rows[0].ban_reason || 'Account suspended for policy violations',
        code: 'BANNED',
      });
    }
    next();
  } catch (err) { next(err); }
};

module.exports = { authenticate, requireNotBanned };
