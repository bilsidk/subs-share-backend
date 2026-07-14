const pool = require('../db/pool');
const cfg  = require('../config');
const settings = require('../services/settingsService');

async function assertOwnsTask(taskId, userId) {
  const r = await pool.query(
    `SELECT t.*, c.user_id AS channel_owner_id, u.email, u.role
     FROM tasks t JOIN channels c ON c.id=t.channel_id JOIN users u ON u.id=$2
     WHERE t.id=$1`,
    [taskId, userId]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const isOwner = row.channel_owner_id===userId || row.email?.toLowerCase()===cfg.OWNER_EMAIL || row.role==='owner';
  return isOwner ? row : null;
}

const pauseCampaign = async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const task = await assertOwnsTask(taskId, req.userId);
    if (!task) return res.status(403).json({ error: 'Campaign not found or not yours' });
    if (task.status !== 'active') return res.status(400).json({ error: `Campaign is already ${task.status}` });
    const r = await pool.query("UPDATE tasks SET status='paused' WHERE id=$1 AND status='active'", [taskId]);
    if (!r.rowCount) return res.status(409).json({ error: 'Campaign is no longer active.' });
    res.json({ ok: true, message: 'Campaign paused.', status: 'paused', remaining_slots: task.remaining_slots });
  } catch (err) { next(err); }
};

const resumeCampaign = async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const task = await assertOwnsTask(taskId, req.userId);
    if (!task) return res.status(403).json({ error: 'Campaign not found or not yours' });
    if (task.status !== 'paused') return res.status(400).json({ error: `Campaign is ${task.status}` });
    if (task.remaining_slots <= 0) return res.status(400).json({ error: 'No slots remaining' });
    const r = await pool.query("UPDATE tasks SET status='active' WHERE id=$1 AND status='paused'", [taskId]);
    if (!r.rowCount) return res.status(409).json({ error: 'Campaign is no longer paused.' });
    res.json({ ok: true, message: 'Campaign resumed.', status: 'active', remaining_slots: task.remaining_slots });
  } catch (err) { next(err); }
};

const cancelCampaign = async (req, res, next) => {
  let client = null;
  try {
    const taskId = parseInt(req.params.id, 10);
    const task = await assertOwnsTask(taskId, req.userId);
    if (!task) return res.status(403).json({ error: 'Campaign not found or not yours' });
    if (['cancelled','completed'].includes(task.status))
      return res.status(400).json({ error: `Campaign is already ${task.status}` });

    const isAppOwner = task.role==='owner' || task.email?.toLowerCase()===cfg.OWNER_EMAIL;
    // Refund exactly what was charged per slot at creation time (stored on the
    // task). Never recompute from live settings — a price change between create
    // and cancel would otherwise refund more (or less) than was actually paid.
    // Fall back to a recomputed cost only for legacy rows created before slot_cost
    // existed (migrate.js backfills these, so this is belt-and-suspenders). Composed
    // from the LIVE atoms + margin via the same helper createTask uses.
    const appSettings = await settings.getSettings();
    const atoms = {
      subscribe: appSettings.coins_subscribe, like: appSettings.coins_like,
      watch_base: appSettings.coins_watch, comment_bonus: appSettings.comment_bonus,
    };
    const legacySlotCost = cfg.slotCostFor(task.task_type, task.watch_minutes || 1, atoms, appSettings.margin_pct);
    const slotCost = Number.isFinite(task.slot_cost) && task.slot_cost != null ? task.slot_cost : legacySlotCost;

    client = await pool.connect();
    await client.query('BEGIN');
    // AUTHORITATIVE: lock the task row and re-read remaining_slots + status INSIDE the
    // transaction. verifyTask locks the same row FOR UPDATE before decrementing a slot,
    // so this serialises the two: an earner can't be paid for a slot that we then also
    // refund (coin minting), and a second concurrent cancel sees status='cancelled' and
    // bails (no double refund). The earlier assertOwnsTask read was unlocked/stale.
    const locked = await client.query(
      'SELECT remaining_slots, status FROM tasks WHERE id=$1 FOR UPDATE', [taskId]);
    if (!locked.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Campaign not found' }); }
    const remainingSlots = locked.rows[0].remaining_slots;
    if (['cancelled','completed'].includes(locked.rows[0].status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Campaign is already ${locked.rows[0].status}` });
    }
    const refundCoins = isAppOwner ? 0 : remainingSlots * slotCost;
    await client.query('UPDATE tasks SET status=\'cancelled\' WHERE id=$1', [taskId]);
    if (refundCoins > 0) {
      await client.query('UPDATE users SET coins=coins+$1 WHERE id=$2', [refundCoins, req.userId]);
      await client.query(`INSERT INTO transactions (user_id,amount,type,description) VALUES ($1,$2,'earned',$3)`,
        [req.userId, refundCoins, `tx:campaign_cancelled|type:${task.task_type}|slots:${remainingSlots}|refund:${refundCoins}`]);
    }
    await client.query('COMMIT');
    const bal = await pool.query('SELECT coins FROM users WHERE id=$1', [req.userId]);
    res.json({ ok: true, refunded_coins: refundCoins, refunded_slots: remainingSlots, new_balance: bal.rows[0].coins,
      message: refundCoins > 0 ? `Campaign cancelled. ${refundCoins} coins refunded.` : 'Campaign cancelled.' });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    next(err);
  } finally { if (client) client.release(); }
};

module.exports = { pauseCampaign, resumeCampaign, cancelCampaign };
