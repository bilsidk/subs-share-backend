const pool = require('../db/pool');
const youtubeService = require('./youtubeService');
const settings = require('./settingsService');
const antiCheat = require('./antiCheatService');

const QUICK_DELAY_HOURS  = 2;
const DEEP_DELAY_HOURS   = 48;
const REAUDIT_EVERY_HOURS = 72;
const MAX_AUDITS  = 3;
const BATCH_SIZE  = 200;

async function checkValid(c) {
  if (c.task_type === 'subscribe')       return youtubeService.verifySubscription(c.user_id, c.target_channel_id);
  if (c.task_type === 'like')            return youtubeService.verifyLike(c.user_id, c.target_video_id);
  if (c.task_type === 'like_comment')    return youtubeService.verifyLike(c.user_id, c.target_video_id);
  if (c.task_type === 'subscribe_like') {
    const [s, l] = await Promise.all([
      youtubeService.verifySubscription(c.user_id, c.target_channel_id),
      youtubeService.verifyLike(c.user_id, c.target_video_id),
    ]);
    return s && l;
  }
  return true;
}

async function reclaim(c) {
  const dbc = await pool.connect();
  try {
    await dbc.query('BEGIN');
    await dbc.query(`UPDATE completions SET verify_status='reclaimed', last_audit_at=NOW(), audit_count=audit_count+1, quick_audited=TRUE WHERE id=$1`, [c.id]);
    await dbc.query('UPDATE users SET coins=GREATEST(0,coins-$1) WHERE id=$2', [c.coins_awarded, c.user_id]);
    await dbc.query(`INSERT INTO transactions (user_id,amount,type,description) VALUES ($1,$2,'spent',$3)`, [c.user_id, c.coins_awarded, `tx:coins_reclaimed|type:${c.task_type}`]);
    await dbc.query('COMMIT');
  } catch (e) { await dbc.query('ROLLBACK'); console.error('[AUDIT] reclaim failed', c.id, e.message); }
  finally { dbc.release(); }
  await antiCheat.penalizeReclaim(c.user_id);
}

async function runPass(quick) {
  const delay = quick ? QUICK_DELAY_HOURS : DEEP_DELAY_HOURS;
  const due = await pool.query(
    `SELECT id, user_id, task_type, target_channel_id, target_video_id, coins_awarded
     FROM completions
     WHERE verify_method='api' AND verify_status='verified' AND audit_count<$1
       AND ($2=TRUE AND quick_audited=FALSE OR $2=FALSE)
       AND completed_at < NOW()-($3||' hours')::interval
       AND (last_audit_at IS NULL OR last_audit_at < NOW()-($4||' hours')::interval)
     ORDER BY completed_at ASC LIMIT $5`,
    [MAX_AUDITS, quick, delay, REAUDIT_EVERY_HOURS, BATCH_SIZE]
  );
  let checked = 0, reclaimed = 0;
  for (const c of due.rows) {
    checked++;
    let valid = true;
    try { valid = await checkValid(c); await settings.recordApiSuccess(); }
    catch (e) {
      await settings.recordApiFailure('audit');
      await pool.query('UPDATE completions SET last_audit_at=NOW(), audit_count=audit_count+1 WHERE id=$1', [c.id]);
      continue;
    }
    if (valid) {
      await pool.query('UPDATE completions SET last_audit_at=NOW(), audit_count=audit_count+1, quick_audited=TRUE WHERE id=$1', [c.id]);
    } else {
      reclaimed++;
      await reclaim(c);
    }
  }
  return { checked, reclaimed };
}

async function runAudit() {
  const mode = await settings.getMode();
  if (mode.mode === 'degraded') { console.log('[AUDIT] Skipped — degraded mode'); return { skipped: true }; }
  const q = await runPass(true);
  const d = await runPass(false);
  console.log(`[AUDIT] quick(${q.checked} checked, ${q.reclaimed} reclaimed) deep(${d.checked} checked, ${d.reclaimed} reclaimed)`);
  return { quick: q, deep: d };
}

module.exports = { runAudit };
