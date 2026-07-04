const pool = require('../db/pool');
const settings = require('./settingsService');
const {
  MIN_SECONDS_BETWEEN_TASKS, MAX_TASKS_PER_HOUR,
  MAX_ACCOUNTS_PER_DEVICE, RECLAIMS_BEFORE_BAN,
  TRUST_FLOOR_BAN, TRUST_PENALTY,
} = require('../config');

function cheatError(message, code, status = 403) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

async function assertNotBanned(userId) {
  const r = await pool.query('SELECT is_banned, ban_reason FROM users WHERE id = $1', [userId]);
  if (r.rows[0]?.is_banned) {
    throw cheatError(r.rows[0].ban_reason || 'Account suspended for policy violations', 'BANNED', 403);
  }
}

async function assertVelocityOk(userId) {
  const cfg = await settings.getSettings();

  const r = await pool.query(
    `SELECT last_task_at, role,
            (SELECT COUNT(*) FROM completions
             WHERE user_id = $1 AND completed_at > NOW() - INTERVAL '1 hour') AS last_hour,
            (SELECT COUNT(*) FROM completions
             WHERE user_id = $1 AND completed_at > NOW()::date) AS today
     FROM users WHERE id = $1`,
    [userId]
  );
  const row = r.rows[0];
  if (!row) return;

  // Per-second velocity
  if (row.last_task_at) {
    const since = (Date.now() - new Date(row.last_task_at).getTime()) / 1000;
    if (since < MIN_SECONDS_BETWEEN_TASKS) {
      throw cheatError(
        `Slow down — wait ${Math.ceil(MIN_SECONDS_BETWEEN_TASKS - since)}s before the next task.`,
        'TOO_FAST', 429
      );
    }
  }

  // Hourly limit
  if (parseInt(row.last_hour, 10) >= MAX_TASKS_PER_HOUR) {
    throw cheatError('Hourly task limit reached. Come back later.', 'HOURLY_LIMIT', 429);
  }

  // Daily limit by role (from live settings)
  const dailyLimit = row.role === 'owner' ? Infinity
    : row.role === 'premium' ? cfg.daily_limit_premium
    : cfg.daily_limit_user;

  if (parseInt(row.today, 10) >= dailyLimit) {
    throw cheatError(
      `Daily limit reached (${dailyLimit} tasks/day). Come back tomorrow!`,
      'DAILY_LIMIT', 429
    );
  }
}

async function assertDeviceOk(userId, deviceId) {
  if (!deviceId) return;
  const r = await pool.query(
    'SELECT COUNT(DISTINCT user_id) AS n FROM device_accounts WHERE device_id = $1',
    [deviceId]
  );
  if (parseInt(r.rows[0].n, 10) >= MAX_ACCOUNTS_PER_DEVICE) {
    throw cheatError('Too many accounts detected on this device.', 'DEVICE_FARM', 403);
  }
}

async function registerDevice(userId, deviceId) {
  if (!deviceId) return;
  await pool.query('UPDATE users SET device_id = $1 WHERE id = $2', [deviceId, userId]);
  await pool.query(
    `INSERT INTO device_accounts (device_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [deviceId, userId]
  );
}

async function stampTask(userId) {
  await pool.query('UPDATE users SET last_task_at = NOW() WHERE id = $1', [userId]);
}

async function penalizeReclaim(userId) {
  const r = await pool.query(
    `UPDATE users SET reclaim_count = reclaim_count + 1,
            trust_score = GREATEST(0, trust_score - $2)
     WHERE id = $1 RETURNING reclaim_count, trust_score`,
    [userId, TRUST_PENALTY]
  );
  const { reclaim_count, trust_score } = r.rows[0];
  if (reclaim_count >= RECLAIMS_BEFORE_BAN || trust_score <= TRUST_FLOOR_BAN) {
    await pool.query(
      `UPDATE users SET is_banned = TRUE, banned_at = NOW(),
              ban_reason = 'Repeatedly undid completed tasks after earning coins'
       WHERE id = $1 AND is_banned = FALSE`,
      [userId]
    );
    return { banned: true, reclaim_count, trust_score };
  }
  return { banned: false, reclaim_count, trust_score };
}

module.exports = {
  assertNotBanned, assertVelocityOk, assertDeviceOk,
  registerDevice, stampTask, penalizeReclaim,
};
