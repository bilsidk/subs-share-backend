const pool = require('../db/pool');

let _modeCache = { mode: 'live', reason: null, at: 0 };
let _settingsCache = { data: null, at: 0 };
const TTL_MS = 30 * 1000;

let _failWindow = [];
const FAIL_WINDOW_MS = 5 * 60 * 1000;
const FAIL_THRESHOLD = 25;

// Default settings fallback
const DEFAULTS = {
  daily_limit_user: 100,
  daily_limit_premium: 200,
  coins_subscribe: 10,
  coins_like: 8,
  coins_like_comment: 10,
  coins_subscribe_like: 16,
  coins_watch: 5,
  comment_bonus: 4,
  coins_per_slot: 10,
  completion_delay_seconds: 45,
  max_campaigns_per_user: 5,
};

async function getMode() {
  const now = Date.now();
  if (now - _modeCache.at < TTL_MS) return _modeCache;
  try {
    const res = await pool.query('SELECT api_mode, degraded_reason FROM app_settings WHERE id = 1');
    const row = res.rows[0] || { api_mode: 'live', degraded_reason: null };
    _modeCache = { mode: row.api_mode, reason: row.degraded_reason, at: now };
  } catch (e) {
    _modeCache = { mode: 'live', reason: null, at: now };
  }
  return _modeCache;
}

async function getSettings() {
  const now = Date.now();
  if (_settingsCache.data && now - _settingsCache.at < TTL_MS) return _settingsCache.data;
  try {
    const res = await pool.query('SELECT settings FROM app_settings WHERE id = 1');
    const data = { ...DEFAULTS, ...(res.rows[0]?.settings || {}) };
    _settingsCache = { data, at: now };
    return data;
  } catch (e) {
    return DEFAULTS;
  }
}

async function updateSettings(updates) {
  await pool.query(
    `UPDATE app_settings
     SET settings = settings || $1::jsonb, updated_at = NOW()
     WHERE id = 1`,
    [JSON.stringify(updates)]
  );
  // Bust cache
  _settingsCache = { data: null, at: 0 };
}

async function setMode(mode, reason = null) {
  await pool.query(
    `UPDATE app_settings SET api_mode = $1, degraded_reason = $2, updated_at = NOW() WHERE id = 1`,
    [mode, reason]
  );
  _modeCache = { mode, reason, at: Date.now() };
  console.log(`[APP MODE] switched to "${mode}"${reason ? ' — ' + reason : ''}`);
}

async function recordApiFailure(kind) {
  const now = Date.now();
  _failWindow.push(now);
  _failWindow = _failWindow.filter((t) => now - t < FAIL_WINDOW_MS);
  if (_failWindow.length >= FAIL_THRESHOLD) {
    const current = await getMode();
    if (current.mode !== 'degraded') {
      await setMode('degraded', `Auto: ${_failWindow.length} API failures in 5m (last: ${kind})`);
    }
  }
}

async function recordApiSuccess() {
  _failWindow = [];
  const current = await getMode();
  if (current.mode === 'degraded' && current.reason?.startsWith('Auto:')) {
    await setMode('live', null);
  }
}

module.exports = { getMode, getSettings, updateSettings, setMode, recordApiFailure, recordApiSuccess, DEFAULTS };
