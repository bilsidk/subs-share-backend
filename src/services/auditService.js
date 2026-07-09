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

// Partial clawback: the like is still valid but the user deleted their comment after
// claiming the +bonus. Pull back ONLY the bonus (keep the like credit), once.
async function clawbackCommentBonus(c) {
  const dbc = await pool.connect();
  try {
    await dbc.query('BEGIN');
    const upd = await dbc.query(
      `UPDATE completions SET comment_verified=FALSE, bonus_coins=0,
              coins_awarded=GREATEST(0, coins_awarded-$2)
       WHERE id=$1 AND comment_verified=TRUE RETURNING id`,
      [c.id, c.bonus_coins]
    );
    if (upd.rows.length) {
      await dbc.query('UPDATE users SET coins=GREATEST(0,coins-$1) WHERE id=$2', [c.bonus_coins, c.user_id]);
      await dbc.query(`INSERT INTO transactions (user_id,amount,type,description) VALUES ($1,$2,'spent','tx:comment_bonus_reclaimed')`, [c.user_id, c.bonus_coins]);
      // Return the owner-funded bonus to the campaign owner — they paid for a comment that
      // no longer exists, so the coins go back to them rather than vanishing to the house.
      if (c.task_id) {
        const own = await dbc.query(`SELECT ch.user_id AS owner_id FROM tasks t JOIN channels ch ON ch.id=t.channel_id WHERE t.id=$1`, [c.task_id]);
        if (own.rows.length && own.rows[0].owner_id) {
          await dbc.query('UPDATE users SET coins=coins+$1 WHERE id=$2', [c.bonus_coins, own.rows[0].owner_id]);
          await dbc.query(`INSERT INTO transactions (user_id,amount,type,description) VALUES ($1,$2,'earned','tx:comment_bonus_refunded_owner')`, [own.rows[0].owner_id, c.bonus_coins]);
        }
      }
    }
    await dbc.query('COMMIT');
  } catch (e) { await dbc.query('ROLLBACK'); console.error('[AUDIT] comment bonus clawback failed', c.id, e.message); }
  finally { dbc.release(); }
}

async function reclaim(c) {
  const dbc = await pool.connect();
  let claimed = false;
  try {
    await dbc.query('BEGIN');
    // Atomic claim: only the pass that actually transitions this completion OUT of an
    // active state does the reversal. A second overlapping audit pass (cadence overrun,
    // manual run racing the cron) sees no row and no-ops — so coins are never
    // double-deducted and remaining_slots is never double-incremented.
    const claim = await dbc.query(
      `UPDATE completions SET verify_status='reclaimed', last_audit_at=NOW(), audit_count=audit_count+1, quick_audited=TRUE
       WHERE id=$1 AND verify_status IN ('verified','pending') RETURNING id`,
      [c.id]
    );
    if (!claim.rows.length) { await dbc.query('COMMIT'); return; }
    // Lock the balance so we can tell whether the reward was fully recovered.
    const balRow = await dbc.query('SELECT coins FROM users WHERE id=$1 FOR UPDATE', [c.user_id]);
    const before = balRow.rows.length ? Number(balRow.rows[0].coins) : 0;
    const fullyRecovered = before >= c.coins_awarded;
    await dbc.query('UPDATE users SET coins=GREATEST(0,coins-$1) WHERE id=$2', [c.coins_awarded, c.user_id]);
    await dbc.query(`INSERT INTO transactions (user_id,amount,type,description) VALUES ($1,$2,'spent',$3)`, [c.user_id, Math.min(before, c.coins_awarded), `tx:coins_reclaimed|type:${c.task_type}`]);
    // Only lift the per-target ledger bar when the whole reward was clawed back (a
    // genuine reversal / transient false-positive). If the user had already SPENT the
    // coins — GREATEST(0,…) can't recover them — keep the target barred; otherwise they
    // could earn → spend → get reclaimed → re-earn the same target for net profit.
    if (fullyRecovered) {
      const relKeys = [];
      if ((c.task_type === 'subscribe' || c.task_type === 'subscribe_like') && c.target_channel_id) relKeys.push('sub:' + c.target_channel_id);
      if ((c.task_type === 'like' || c.task_type === 'like_comment' || c.task_type === 'subscribe_like') && c.target_video_id) relKeys.push('like:' + c.target_video_id);
      if (c.task_type === 'watch' && c.target_video_id) relKeys.push('watch:' + c.target_video_id);
      if (relKeys.length) await dbc.query('DELETE FROM earned_targets WHERE user_id=$1 AND target_key = ANY($2)', [c.user_id, relKeys]);
    }
    // Make the campaign owner whole: the engagement they paid for was undone, so
    // return the slot to their campaign (and re-open it if it had filled up) so a
    // real earner can replace it. Cancelled campaigns are left cancelled.
    if (c.task_id) {
      const tk = await dbc.query(
        `SELECT t.status, t.slot_cost, ch.user_id AS owner_id
         FROM tasks t JOIN channels ch ON ch.id=t.channel_id WHERE t.id=$1 FOR UPDATE OF t`,
        [c.task_id]
      );
      if (tk.rows.length && tk.rows[0].status === 'cancelled') {
        // No slot to restore on a cancelled campaign — make the owner whole instead by
        // refunding what they paid for this now-undone engagement.
        const cost = Number(tk.rows[0].slot_cost) || 0;
        if (cost > 0 && tk.rows[0].owner_id) {
          await dbc.query('UPDATE users SET coins=coins+$1 WHERE id=$2', [cost, tk.rows[0].owner_id]);
          await dbc.query(`INSERT INTO transactions (user_id,amount,type,description) VALUES ($1,$2,'earned','tx:slot_refunded_owner_reclaim')`, [tk.rows[0].owner_id, cost]);
        }
      } else if (tk.rows.length) {
        await dbc.query(
          `UPDATE tasks SET remaining_slots = remaining_slots + 1,
                  status = CASE WHEN status = 'completed' THEN 'active' ELSE status END
           WHERE id = $1`,
          [c.task_id]
        );
      }
    }
    await dbc.query('COMMIT');
    claimed = true;
  } catch (e) { await dbc.query('ROLLBACK'); console.error('[AUDIT] reclaim failed', c.id, e.message); }
  finally { dbc.release(); }
  // Only penalize when THIS pass actually performed the reclaim — never on the no-op
  // path of an overlapping duplicate pass.
  if (claimed) await antiCheat.penalizeReclaim(c.user_id);
}

async function runPass(quick) {
  const delay = quick ? QUICK_DELAY_HOURS : DEEP_DELAY_HOURS;
  const due = await pool.query(
    `SELECT id, task_id, user_id, task_type, target_channel_id, target_video_id, coins_awarded, bonus_coins, comment_verified
     FROM completions
     WHERE ((verify_method='api' AND verify_status='verified') OR verify_status='pending')
       AND audit_count<$1
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
      // A pending (honor-mode) completion that now checks out is promoted to
      // verified so it stops being re-queued; watch/honor rows that can't be
      // API-verified are treated as valid here (bounded by the daily watch cap).
      await pool.query(`UPDATE completions SET last_audit_at=NOW(), audit_count=audit_count+1, quick_audited=TRUE,
                        verify_status=CASE WHEN verify_status='pending' THEN 'verified' ELSE verify_status END WHERE id=$1`, [c.id]);
      // The like is still valid, but if this was a like_comment that earned the comment
      // bonus, make sure the comment is still there — otherwise claw back just the bonus.
      if (c.task_type === 'like_comment' && c.comment_verified && c.bonus_coins > 0) {
        try {
          const cr = await youtubeService.verifyComment(c.user_id, c.target_video_id);
          // Reclaim the bonus ONLY on a CONCLUSIVE negative — paged to the end of the
          // comment list and the comment is genuinely gone. Any inconclusive result
          // (page cap hit before the end, comments disabled, no channel) errs toward the
          // user so a buried comment on a busy video isn't wrongly clawed back.
          if (cr && !cr.found && cr.exhausted === true) await clawbackCommentBonus(c);
        } catch (_) { /* comment re-check is best-effort */ }
      }
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
