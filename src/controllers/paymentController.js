const pool = require('../db/pool');
const { createInvoice, verifyIPN } = require('../services/nowpaymentsService');

const TIERS = [
  { usd: 5, coins: 1000, bonus_pct: 0 },
  { usd: 10, coins: 2200, bonus_pct: 10 },
  { usd: 25, coins: 6000, bonus_pct: 20 },
  { usd: 50, coins: 13000, bonus_pct: 30 },
];

async function getTiers(req, res) {
  res.json({ tiers: TIERS });
}

async function createCheckout(req, res, next) {
  try {
    const { tier_index } = req.body;
    const tier = TIERS[tier_index];
    if (!tier) return res.status(400).json({ error: 'Invalid tier' });

    const order_id = `CS_${req.userId}_${Date.now()}`;
    const bonus = Math.floor(tier.coins * tier.bonus_pct / 100);
    const total_coins = tier.coins + bonus;

    const apiUrl = process.env.API_URL || `https://${req.get('host')}`;
    const appUrl = process.env.APP_URL || apiUrl;

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
      const bonus = Math.floor(payment.coins * payment.bonus_pct / 100);
      const total_coins = payment.coins + bonus;

      await pool.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [total_coins, payment.user_id]);
      await pool.query(
        `INSERT INTO transactions (user_id, amount, type, description)
         VALUES ($1, $2, 'purchase', $3)`,
        [payment.user_id, total_coins, `tx:purchase|coins:${total_coins}|usd:${payment.usd}|invoice:${invoice_id}`]
      );
      await pool.query('UPDATE pending_payments SET status = $1 WHERE invoice_id = $2', ['finished', String(invoice_id)]);
    } else if (['failed', 'expired', 'cancelled'].includes(payment_status)) {
      await pool.query('UPDATE pending_payments SET status = $1 WHERE invoice_id = $2', [payment_status, String(invoice_id)]);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[payments] IPN error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { getTiers, createCheckout, handleIPN };
