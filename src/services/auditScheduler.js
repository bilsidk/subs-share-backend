const cron = require('node-cron');
const { runAudit } = require('./auditService');

function startAuditScheduler() {
  cron.schedule('*/15 * * * *', async () => {
    try { await runAudit(); } catch (e) { console.error('[AUDIT] Scheduler error:', e.message); }
  });
  console.log('🕒 Audit scheduler started (every 15 min)');
}

module.exports = { startAuditScheduler };
