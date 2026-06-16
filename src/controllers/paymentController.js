const pool = require('../db/pool');
const { createInvoice, verifyIPN } = require('../services/nowpaymentsService');
const { MIN_PURCHASE_USD, calcPurchase, REWARDS, WATCH_COST_PER_EXTRA_MIN, WATCH_REWARD_PER_EXTRA_MIN, COMMENT_BONUS } = require('../config');
const settings = require('../services/settingsService');

// Only let the client choose the post-payment return origin from a known list,
// so the success/cancel redirect can't be turned into an open redirect.
const RETURN_ALLOWLIST = ['app.viralboostnow.com', 'viralboostnow.com', 'localhost'];
function resolveReturnBase(url) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') return null;
    const ok = RETURN_ALLOWLIST.includes(u.hostname) || u.hostname.endsWith('.railway.app');
    return ok ? u.origin : null;
  } catch { return null; }
}

async function getTiers(req, res) {
  const s = await settings.getSettings();
  res.json({
    min_usd: MIN_PURCHASE_USD,
    rate: 200,
    slot_costs: {
      subscribe:      (s.coins_subscribe      ?? 12) + (s.house_margin ?? 3),
      like:           (s.coins_like           ?? 6)  + (s.house_margin ?? 3),
      like_comment:   (s.coins_like_comment   ?? 10) + (s.house_margin ?? 3),
      subscribe_like: (s.coins_subscribe_like ?? 17) + (s.house_margin ?? 3),
      watch:          (s.coins_watch          ?? 4)  + (s.house_margin ?? 3),
    },
    reward_per_type: {
      subscribe:      s.coins_subscribe      ?? 12,
      like:           s.coins_like           ?? 6,
      like_comment:   s.coins_like_comment   ?? 10,
      subscribe_like: s.coins_subscribe_like ?? 17,
      watch:          s.coins_watch          ?? 4,
    },
    house_margin: s.house_margin ?? 3,
    watch_extra_min_cost: WATCH_COST_PER_EXTRA_MIN,
    watch_extra_min_reward: WATCH_REWARD_PER_EXTRA_MIN,
  });
}

async function createCheckout(req, res, next) {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < MIN_PURCHASE_USD)
      return res.status(400).json({ error: `Minimum purchase is $${MIN_PURCHASE_USD}` });
    if (amount > 100000)
      return res.status(400).json({ error: 'Amount too large' });

    const tier = calcPurchase(amount);
    const order_id = `CS_${req.userId}_${Date.now()}`;
    const bonus = Math.floor(tier.coins * tier.bonus_pct / 100);
    const total_coins = tier.coins + bonus;

    const apiUrl = process.env.API_URL;
    const appUrl = resolveReturnBase(req.body.return_url) || process.env.APP_URL || apiUrl;

    const invoice = await createInvoice({
      price_amount: tier.usd,
      order_id,
      order_description: `${total_coins} coins (${tier.coins} + ${bonus} bonus)`,
      ipn_callback_url: `${apiUrl}/payments/ipn`,
      success_url: `${appUrl}/?payment=success`,
      cancel_url: `${appUrl}/?payment=cancelled`,
    });

    await pool.query(
      `INSERT INTO pending_payments (invoice_id, order_id, user_id, usd, coins, bonus_pct, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [String(invoice.id), order_id, req.userId, tier.usd, tier.coins, tier.bonus_pct]
    );

    res.json({ invoice_url: invoice.invoice_url, invoice_id: invoice.id });
  } catch (err) { next(err); }
}

async function handleIPN(req, res) {
  const signature = req.headers['x-nowpayments-sig'];
  if (!signature || !verifyIPN(req.body, signature)) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  const { invoice_id, order_id, payment_status, actually_paid } = req.body;
  if (!invoice_id) return res.status(400).json({ error: 'Missing invoice_id' });

  try {
    const pp = await pool.query('SELECT * FROM pending_payments WHERE invoice_id=$1', [String(invoice_id)]);
    if (!pp.rows.length) return res.status(404).json({ error: 'Invoice not found' });

    const payment = pp.rows[0];
    if (payment.status === 'finished') return res.json({ ok: true });

    if (payment_status === 'finished') {
      // Exactly-once credit: claim the row atomically so duplicate/retried IPNs
      // (NowPayments retries) can't double-credit. The whole claim+credit runs in
      // one transaction, so a failure rolls the claim back and a retry can re-run.
      const dbc = await pool.connect();
      try {
        await dbc.query('BEGIN');
        const claim = await dbc.query(
          `UPDATE pending_payments SET status='finished' WHERE invoice_id=$1 AND status <> 'finished'`,
          [String(invoice_id)]
        );
        if (claim.rowCount === 0) { await dbc.query('ROLLBACK'); return res.json({ ok: true }); }

        const bonus = Math.floor(payment.coins * payment.bonus_pct / 100);
        const total_coins = payment.coins + bonus;
        await dbc.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [total_coins, payment.user_id]);
        await dbc.query(
          `INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, 'purchase', $3)`,
          [payment.user_id, total_coins, `tx:purchase|coins:${total_coins}|usd:${payment.usd}|invoice:${invoice_id}`]
        );
        await dbc.query('COMMIT');
      } catch (e) { await dbc.query('ROLLBACK'); throw e; }
      finally { dbc.release(); }
    } else if (['failed', 'expired', 'cancelled'].includes(payment_status)) {
      await pool.query(
        `UPDATE pending_payments SET status=$1 WHERE invoice_id=$2 AND status <> 'finished'`,
        [payment_status, String(invoice_id)]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[payments] IPN error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { getTiers, createCheckout, handleIPN };
