const pool = require('../db/pool');

const getTransactions = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;
    const r = await pool.query(
      'SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [req.userId, limit, offset]
    );
    const count = await pool.query('SELECT COUNT(*) FROM transactions WHERE user_id=$1', [req.userId]);
    res.json({ transactions: r.rows, total: parseInt(count.rows[0].count), page, pages: Math.ceil(count.rows[0].count / limit) });
  } catch (err) { next(err); }
};

module.exports = { getTransactions };
