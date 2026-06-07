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
      updated++;
    }
    console.log(`[SUBS] Refreshed subscriber counts for ${updated} channels`);
  } catch (e) {
    console.error('[SUBS] Refresh failed:', e.message);
  }
}

function startAuditScheduler() {
  // Audit completions every 15 min
  cron.schedule('*/15 * * * *', async () => {
    try { await runAudit(); } catch (e) { console.error('[AUDIT] Scheduler error:', e.message); }
  });

  // Refresh subscriber counts daily at 3am UTC
  cron.schedule('0 3 * * *', async () => {
    await refreshSubscriberCounts();
  });

  console.log('🕒 Audit scheduler started (every 15 min) + subscriber refresh (daily 3am UTC)');
}

module.exports = { startAuditScheduler, refreshSubscriberCounts };
