const pool = require('../db/pool');
const { google } = require('googleapis');
const { Resend } = require('resend');

let _modeCache = { mode: 'live', reason: null, at: 0 };
let _settingsCache = { data: null, at: 0 };
const TTL_MS = 30 * 1000;

let _failWindow = [];
// A low threshold is SAFE because reaching it only triggers the probe —
// probeYouTubeApi() must still confirm a REAL outage before the mode flips
// (user-side/bad-token failures keep the app LIVE). 25-in-5min was tuned for
// high traffic; at the current small user base it would never trip during a
// genuine outage, so honor mode would never engage (owner call, 2026-07-11).
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_THRESHOLD = 5;

const RECOVERY_INTERVAL_MS = 30 * 60 * 1000;
let _recoveryTimer = null;

// Bound a single external call so a YouTube/Resend stall can never hang the caller —
// resolves/rejects within `ms` regardless of what the wrapped promise does afterward.
const PROBE_TIMEOUT_MS = 5000;  // outage-probe bound — must fail fast so degrade logic can trip
const ALERT_TIMEOUT_MS = 8000;  // outbound alert-email bound
function _withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label} timed out after ${ms}ms`);
      e.code = 'TIMEOUT';
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Default settings fallback
const DEFAULTS = {
  daily_limit_user: 100,
  daily_limit_premium: 200,
  // Economy redesign (2026-07-11): only the 4 ATOMS + margin are settable. Sub+Like and
  // Like+Comment rewards are DERIVED (sum of atoms) — no longer independently configurable —
  // so coins_subscribe_like / coins_like_comment are intentionally removed, and the flat
  // house_margin is replaced by a percentage margin_pct (owner cost = ceil(earn*(1+margin_pct))).
  coins_subscribe: 12,
  coins_like: 5,
  coins_watch: 2,
  comment_bonus: 8,
  margin_pct: 0.25,
  completion_delay_seconds: 45,
  max_campaigns_per_user: 5,
  max_watch_per_day: 0,      // 0 = NO watch-specific daily cap (owner decision 2026-07-09).
                             // Watch stays bounded by the GLOBAL daily_limit_user/premium above,
                             // the 40/hr velocity cap, real-time watch spacing, and earned_targets.
  // Admin controls — empty list = every task type enabled; empty string = no banner.
  disabled_task_types: [],   // e.g. ['subscribe'] hides+blocks that type app-wide
  // Per-type daily caps (owner decision 2026-07-09): subscribe 20/day, like 30/day,
  // like_comment 30/day; watch uncapped (see max_watch_per_day). Values the admin saves
  // in app_settings override PER KEY; set a key to 0 for unlimited.
  daily_cap_by_type: { subscribe: 20, like: 30, like_comment: 30 },
  maintenance_message: '',   // non-empty = shown as a persistent top banner in the app
  // One-time announcement POPUP shown when a user opens the app — dismissible, and
  // re-shows only when the text changes (client remembers the last-dismissed text).
  // announcement_link (optional, http/https only) renders as a clickable button.
  announcement_message: '',
  announcement_link: '',
  announcement_platform: 'both',   // 'both' | 'web' | 'mobile' — which app(s) show the popup
};

// ─── Email ────────────────────────────────────────────────────────────────────

async function _sendAlert(subject, text) {
  const to = process.env.ALERT_EMAIL;
  if (!to) { console.warn('[ALERT] ALERT_EMAIL not set — skipping email'); return; }
  if (!process.env.RESEND_API_KEY) { console.warn('[ALERT] RESEND_API_KEY not set — skipping email'); return; }
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await _withTimeout(
      resend.emails.send({
        from: 'SubsShare <onboarding@resend.dev>',
        to,
        subject,
        text,
      }),
      ALERT_TIMEOUT_MS,
      'Resend alert'
    );
    console.log(`[ALERT] Email sent: ${subject}`);
  } catch (err) {
    console.error('[ALERT] Email failed', err.message);
  }
}

// ─── YouTube API probe ────────────────────────────────────────────────────────

async function probeYouTubeApi() {
  try {
    // Grab any valid token from DB
    const res = await pool.query(
      `SELECT youtube_access_token, youtube_refresh_token, youtube_token_expiry
       FROM users
       WHERE youtube_access_token IS NOT NULL AND youtube_token_expiry > NOW()
       ORDER BY last_task_at DESC NULLS LAST LIMIT 1`
    );
    if (!res.rows.length) {
      // No tokens — just ping the YouTube API endpoint
      const youtube = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });
      await _withTimeout(
        youtube.videos.list({ part: ['id'], id: ['dQw4w9WgXcQ'], maxResults: 1 }),
        PROBE_TIMEOUT_MS,
        'YouTube probe'
      );
      return true;
    }
    const row = res.rows[0];
    const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
    oauth2.setCredentials({
      access_token: row.youtube_access_token,
      refresh_token: row.youtube_refresh_token,
      expiry_date: row.youtube_token_expiry ? new Date(row.youtube_token_expiry).getTime() : null,
    });
    const youtube = google.youtube({ version: 'v3', auth: oauth2 });
    await _withTimeout(
      youtube.channels.list({ part: ['id'], mine: true, maxResults: 1 }),
      PROBE_TIMEOUT_MS,
      'YouTube probe'
    );
    return true;
  } catch (err) {
    const status = err.code || err.response?.status;
    // 401/403 means API is reachable but auth issue — YouTube itself is UP
    if (status === 401 || status === 403 || status === '401' || status === '403') return true;
    // Also catches our own TIMEOUT (err.code === 'TIMEOUT') from _withTimeout — a stalled
    // probe means YouTube can't be confirmed up, so it fails the same as any other error.
    console.warn('[PROBE] YouTube API probe failed:', err.message);
    return false;
  }
}

// ─── Recovery timer ───────────────────────────────────────────────────────────

function _stopRecoveryTimer() {
  if (_recoveryTimer) {
    clearInterval(_recoveryTimer);
    _recoveryTimer = null;
  }
}

function _startRecoveryTimer() {
  if (_recoveryTimer) return;
  console.log('[RECOVERY] Starting 30-min recovery check timer');
  _recoveryTimer = setInterval(async () => {
    try {
      const current = await getMode();
      if (current.mode !== 'degraded') { _stopRecoveryTimer(); return; }

      console.log('[RECOVERY] Probing YouTube API...');
      const ok = await probeYouTubeApi();
      if (ok) {
        await setMode('live', null);
        _stopRecoveryTimer();
        _failWindow = [];
        await _sendAlert(
          '✅ SubsShare — API recovered (auto)',
          `YouTube API is responding again.\nMode switched back to LIVE automatically at ${new Date().toISOString()}.`
        );
      } else {
        console.log('[RECOVERY] YouTube API still down — staying degraded');
      }
    } catch (err) {
      console.error('[RECOVERY] Timer error:', err.message);
    }
  }, RECOVERY_INTERVAL_MS);
}

// ─── Core ─────────────────────────────────────────────────────────────────────

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
    `UPDATE app_settings SET settings = settings || $1::jsonb, updated_at = NOW() WHERE id = 1`,
    [JSON.stringify(updates)]
  );
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
  // Wrapped end-to-end so this is always safe to call fire-and-forget (no await) from
  // a hot request path: it must never throw/reject and never block on anything slow.
  try {
    const now = Date.now();
    _failWindow.push(now);
    _failWindow = _failWindow.filter((t) => now - t < FAIL_WINDOW_MS);
    if (_failWindow.length >= FAIL_THRESHOLD) {
      const current = await getMode();
      if (current.mode !== 'degraded') {
        // Confirm it's a REAL outage via a server-side probe before dropping
        // verification. If YouTube responds, the failures are user-side (expired/
        // revoked tokens, or someone trying to force honor mode) — so STAY LIVE and
        // reset the window. Only a confirmed YouTube outage degrades the app.
        const apiDown = !(await probeYouTubeApi());
        if (!apiDown) {
          _failWindow = [];
          console.warn(`[APP MODE] ${FAIL_THRESHOLD}+ verify failures in ${FAIL_WINDOW_MS / 60000}m, but YouTube probe is OK — staying LIVE (user-side/bad tokens, last: ${kind})`);
          return;
        }
        const reason = `Auto: ${_failWindow.length} API failures in 5m + server probe confirmed YouTube is DOWN (last: ${kind})`;
        await setMode('degraded', reason);
        _startRecoveryTimer();

        // Fire-and-forget: the alert email is bounded (ALERT_TIMEOUT_MS) internally and
        // must never delay/interrupt the caller of recordApiFailure.
        _sendAlert(
          '🚨 SubsShare — API degraded, switching to honor mode',
          `Switched to HONOR (degraded) mode.\n\nReason: ${reason}\nTime: ${new Date().toISOString()}\n\nThe app will auto-probe YouTube API every 30 minutes and recover automatically when it comes back.`
        ).catch((e) => console.error('[ALERT] recordApiFailure alert error (non-blocking):', e.message));
      }
    }
  } catch (err) {
    console.error('[recordApiFailure] error (non-blocking):', err.message);
  }
}

async function recordApiSuccess() {
  _failWindow = [];
}

// Called once on app boot — resumes recovery timer if server restarted while degraded
async function initOnBoot() {
  try {
    const current = await getMode();
    if (current.mode === 'degraded') {
      console.log('[BOOT] App started in degraded mode — starting recovery timer');
      _startRecoveryTimer();
    }
  } catch (err) {
    console.error('[BOOT] initOnBoot error:', err.message);
  }
}

module.exports = {
  getMode, getSettings, updateSettings, setMode,
  recordApiFailure, recordApiSuccess,
  probeYouTubeApi, initOnBoot,
  DEFAULTS,
};
