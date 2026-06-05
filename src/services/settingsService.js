const pool = require('../db/pool');

let _cache = { mode: 'live', reason: null, at: 0 };
const TTL_MS = 30000;
let _failWindow = [];
const FAIL_WINDOW_MS = 5 * 60 * 1000;
const FAIL_THRESHOLD = 25;

async function getMode() {
  const now = Date.now();
  if (now - _cache.at < TTL_MS) return _cache;
  try {
    const res = await pool.query('SELECT api_mode, degraded_reason FROM app_settings WHERE id=1');
    const row = res.rows[0] || { api_mode: 'live', degraded_reason: null };
    _cache = { mode: row.api_mode, reason: row.degraded_reason, at: now };
  } catch { _cache = { mode: 'live', reason: null, at: now }; }
  return _cache;
}

async function setMode(mode, reason = null) {
  await pool.query('UPDATE app_settings SET api_mode=$1, degraded_reason=$2, updated_at=NOW() WHERE id=1', [mode, reason]);
  _cache = { mode, reason, at: Date.now() };
  console.log(`[APP MODE] → "${mode}"${reason ? ' — ' + reason : ''}`);
}

async function recordApiFailure(kind) {
  const now = Date.now();
  _failWindow.push(now);
  _failWindow = _failWindow.filter(t => now - t < FAIL_WINDOW_MS);
  if (_failWindow.length >= FAIL_THRESHOLD) {
    const cur = await getMode();
    if (cur.mode !== 'degraded')
      await setMode('degraded', `Auto: ${_failWindow.length} failures in 5m (${kind})`);
  }
}

async function recordApiSuccess() {
  _failWindow = [];
  const cur = await getMode();
  if (cur.mode === 'degraded' && cur.reason?.startsWith('Auto:'))
    await setMode('live', null);
}

module.exports = { getMode, setMode, recordApiFailure, recordApiSuccess };
