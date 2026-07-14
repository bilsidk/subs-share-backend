const cron = require('node-cron');
const { runAudit } = require('./auditService');
const { getSubscriberCount } = require('./youtubeService');
const pool = require('../db/pool');

async function refreshSubscriberCounts() {
  try {
    const { rows } = await pool.query(
      'SELECT id, youtube_channel_id FROM channels WHERE youtube_channel_id IS NOT NULL'
    );
    let updated = 0;
    for (const ch of rows) {
      const count = await getSubscriberCount(ch.youtube_channel_id);
      await pool.query(
        'UPDATE channels SET subscriber_count=$1 WHERE id=$2',
        [count, ch.id]
      );
      // Keep users.subscriber_count in sync — the admin/user list reads it,
      // and it is otherwise only written at sign-in.
      await pool.query(
        'UPDATE users SET subscriber_count=$1 WHERE youtube_channel_id=$2',
        [count, ch.youtube_channel_id]
      );
      updated++;
    }
    console.log(`[SUBS] Refreshed subscriber counts for ${updated} channels`);
    return updated;
  } catch (e) {
    console.error('[SUBS] Refresh failed:', e.message);
    return 0;
  }
}

function startAuditScheduler() {
  // Audit completions every 15 min
  cron.schedule('*/15 * * * *', async () => {
    try { await runAudit(); } catch (e) { console.error('[AUDIT] Scheduler error:', e.message); }
  });

  // Reconcile crypto purchases whose crediting IPN was never delivered (endpoint down /
  // IPN secret misconfigured) — ask NOWPayments for the true status and credit the buyer
  // exactly-once via the same path the IPN uses. Every 20 min. No-ops if NOWPayments
  // isn't configured. (Lazy require mirrors the voided-purchase reconcile below.)
  cron.schedule('*/20 * * * *', async () => {
    try { await require('../controllers/paymentController').reconcilePendingCryptoPayments(); }
    catch (e) { console.error('[RECONCILE] pending-crypto reconcile failed:', e.message); }
  });

  // Refresh subscriber counts daily at 3am UTC + reap abandoned task_starts
  cron.schedule('0 3 * * *', async () => {
    await refreshSubscriberCounts();
    try {
      const r = await pool.query("DELETE FROM task_starts WHERE started_at < NOW() - INTERVAL '7 days'");
      if (r.rowCount) console.log(`[CLEANUP] Removed ${r.rowCount} stale task_starts`);
    } catch (e) { console.error('[CLEANUP] task_starts reap failed:', e.message); }
    // Claw back coins for Google Play purchases that were later refunded/charged-back
    // (voided). Best-effort; no-ops if the Play service account isn't configured.
    try { await require('../controllers/paymentController').reconcileVoidedGooglePurchases(); }
    catch (e) { console.error('[CLEANUP] voided-purchase reconcile failed:', e.message); }
  });

  console.log('🕒 Audit scheduler started (every 15 min) + crypto reconcile (every 20 min) + subscriber refresh (daily 3am UTC)');
}

module.exports = { startAuditScheduler, refreshSubscriberCounts };
