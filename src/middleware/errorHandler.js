const errorHandler = (err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
  if (err.code === '23505') return res.status(409).json({ error: 'Duplicate entry' });
  if (err.code === '23503') return res.status(400).json({ error: 'Referenced resource does not exist' });
  res.status(err.status || 500).json({ error: err.status === 500 || !err.status ? 'Internal server error' : err.message });
};

module.exports = { errorHandler };
