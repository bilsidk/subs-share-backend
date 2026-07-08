const pool = require('../db/pool');
const cfg = require('../config');
const { createInvoice, verifyIPN } = require('../services/nowpaymentsService');
const googlePlay = require('../services/googlePlayService');
const { MIN_PURCHASE_USD, calcPurchase, REWARDS, WATCH_COST_PER_EXTRA_MIN, WATCH_REWARD_PER_EXTRA_MIN, COMMENT_BONUS } = require('../config');
const settings = require('../services/settingsService');

// Only let the client choose the post-payment return origin from a known list,
// so the success/cancel redirect can't be turned into an open redirect.
const RETURN_ALLOWLIST = ['app.viralboostnow.com', 'viralboostnow.com', 'subs-share-backend-production.up.railway.app', 'localhost'];
function resolveReturnBase(url) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') return null;
    // Exact-host allowlist only. A blanket `.railway.app` subdomain match would let any
    // Railway-hosted page become the post-payment redirect target (open redirect /
    // payment-status spoof), so the known deployment host is pinned explicitly instead.
    return RETURN_ALLOWLIST.includes(u.hostname) ? u.origin : null;
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
      like_comment:   (s.coins_like_comment   ?? 10) + (s.house_margin ?? 3) + (s.comment_bonus ?? 4),
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
    // Google Play coin packs: { productId: coins }. The app queries Play for the
    // localized price of each id and shows the coin amount from here.
    google_products: cfg.GOOGLE_PLAY_PRODUCTS,
  });
}

async function createCheckout(req, res, next) {
  try {
    // USD is charged and stored as a whole number of dollars (the pending_payments.usd
    // column is INTEGER), so normalize up front to keep the charge, the credited coins,
    // and the ledger perfectly consistent — no fractional divergence.
    const amount = Math.round(Number(req.body.amount));
    if (!Number.isFinite(amount) || amount < MIN_PURCHASE_USD)
      return res.status(400).json({ error: `Minimum purchase is $${MIN_PURCHASE_USD}` });
    if (amount > 100000)
      return res.status(400).json({ error: 'Amount too large' });

    const tier = calcPurchase(amount);
    const order_id = `CS_${req.userId}_${Date.now()}`;
    const bonus = Math.floor(tier.coins * tier.bonus_pct / 100);
    const total_coins = tier.coins + bonus;

    // Never derive the IPN callback from the client-supplied Host header (spoofable —
    // an attacker could redirect payment notifications). Use the configured API_URL,
    // falling back to the known production host.
    const apiUrl = process.env.API_URL || 'https://subs-share-backend-production.up.railway.app';
    const appUrl = resolveReturnBase(req.body.return_url) || process.env.APP_URL || 'https://app.viralboostnow.com';

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
  try {
    // verifyIPN throws if the IPN secret is unset — keep it inside try so a
    // misconfiguration returns a clean 500 instead of an unhandled rejection.
    const signature = req.headers['x-nowpayments-sig'];
    if (!signature || !verifyIPN(req.body, signature)) {
      return res.status(403).json({ error: 'Invalid signature' });
    }

    const { invoice_id, order_id, payment_status, actually_paid } = req.body;
    if (!invoice_id) return res.status(400).json({ error: 'Missing invoice_id' });

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
    } else if (payment_status === 'refunded') {
      // The payment was refunded upstream. If we already credited coins for this invoice,
      // claw them back. The atomic finished->refunded transition fires the reversal at
      // most once (idempotent against retried IPNs); GREATEST(0,…) so a user who already
      // spent the coins can't go negative.
      const dbc = await pool.connect();
      try {
        await dbc.query('BEGIN');
        const claim = await dbc.query(
          `UPDATE pending_payments SET status='refunded' WHERE invoice_id=$1 AND status='finished'`,
          [String(invoice_id)]
        );
        if (claim.rowCount === 1) {
          const bonus = Math.floor(payment.coins * payment.bonus_pct / 100);
          const total_coins = payment.coins + bonus;
          await dbc.query('UPDATE users SET coins = GREATEST(0, coins - $1) WHERE id = $2', [total_coins, payment.user_id]);
          await dbc.query(
            `INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, 'spent', $3)`,
            [payment.user_id, total_coins, `tx:purchase_refunded|coins:${total_coins}|invoice:${invoice_id}`]
          );
        } else {
          // Never credited (still pending) or already reversed — record the status only.
          await dbc.query(
            `UPDATE pending_payments SET status='refunded' WHERE invoice_id=$1 AND status NOT IN ('finished','refunded')`,
            [String(invoice_id)]
          );
        }
        await dbc.query('COMMIT');
      } catch (e) { await dbc.query('ROLLBACK'); throw e; } finally { dbc.release(); }
    } else if (payment_status === 'partially_refunded') {
      // Ambiguous amount on a fixed-rate invoice — don't guess how many coins to reclaim.
      // Flag for manual review rather than risk an incorrect deduction.
      console.warn(`[payments] partially_refunded invoice=${invoice_id} — manual review needed`);
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

// POST /payments/google/verify  { product_id, purchase_token }
// Called by the Android app after a Google Play purchase. Verifies the token with
// Google, credits coins exactly-once, and acknowledges the purchase.
async function verifyGooglePlay(req, res, next) {
  const { product_id, purchase_token } = req.body || {};
  if (!product_id || !purchase_token)
    return res.status(400).json({ error: 'product_id and purchase_token are required' });

  const product = cfg.GOOGLE_PLAY_PRODUCTS[product_id];
  if (!product) return res.status(400).json({ error: 'Unknown product', code: 'BAD_PRODUCT' });
  const coins = product.coins;

  try {
    // 1) Verify the token with Google (source of truth — never trust the client).
    let info;
    try {
      info = await googlePlay.verifyProductPurchase(product_id, purchase_token);
    } catch (e) {
      console.error('[gplay] verify error:', e.message);
      return res.status(502).json({ error: 'Could not verify purchase right now. Try again.', code: 'VERIFY_RETRY' });
    }
    if (info.pending) return res.status(202).json({ pending: true, code: 'PURCHASE_PENDING' });
    if (!info.purchased) return res.status(400).json({ error: 'Purchase is not valid.', code: 'NOT_PURCHASED' });

    // 2) Exactly-once credit, keyed on the purchase token (unique per transaction).
    const dbc = await pool.connect();
    let alreadyCredited = false;
    try {
      await dbc.query('BEGIN');
      const claim = await dbc.query(
        `INSERT INTO google_purchases (purchase_token, order_id, user_id, product_id, coins)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (purchase_token) DO NOTHING`,
        [purchase_token, info.orderId, req.userId, product_id, coins]
      );
      if (claim.rowCount === 0) {
        alreadyCredited = true;           // duplicate/retried verify — do not credit again
        await dbc.query('ROLLBACK');
      } else {
        await dbc.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [coins, req.userId]);
        await dbc.query(
          `INSERT INTO transactions (user_id, amount, type, description) VALUES ($1,$2,'purchase',$3)`,
          [req.userId, coins, `tx:purchase|coins:${coins}|product:${product_id}|order:${info.orderId || ''}`]
        );
        await dbc.query('COMMIT');
      }
    } catch (e) { await dbc.query('ROLLBACK'); throw e; }
    finally { dbc.release(); }

    // 3) Acknowledge with Google (best-effort; prevents auto-refund after 3 days).
    googlePlay.acknowledgeProductPurchase(product_id, purchase_token).catch(() => {});

    const bal = await pool.query('SELECT coins FROM users WHERE id=$1', [req.userId]);
    return res.json({
      ok: true,
      already_credited: alreadyCredited,
      coins_added: alreadyCredited ? 0 : coins,
      new_balance: bal.rows[0]?.coins ?? null,
    });
  } catch (err) { next(err); }
}

// Reconcile Google Play refunds / chargebacks / revocations. Google exposes these via
// the Voided Purchases API (there is no verify-time signal). For any voided token we
// previously credited (google_purchases.status='credited'), claw the coins back exactly
// once — the credited->voided transition is the idempotency guard, GREATEST(0,…) avoids
// underflow, and a token whose user was deleted (user_id NULL via ON DELETE SET NULL) is
// skipped. Best-effort; called from the daily scheduler. No-ops if the Play service
// account isn't configured (listVoidedPurchases throws → caught here).
async function reconcileVoidedGooglePurchases() {
  let voided;
  try {
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000; // look back 30 days each run
    voided = await googlePlay.listVoidedPurchases(since);
  } catch (e) {
    console.error('[gplay] voided-purchases list failed:', e.message);
    return { checked: 0, reversed: 0 };
  }
  let reversed = 0;
  for (const v of voided) {
    const dbc = await pool.connect();
    try {
      await dbc.query('BEGIN');
      const claim = await dbc.query(
        `UPDATE google_purchases SET status='voided' WHERE purchase_token=$1 AND status='credited' RETURNING user_id, coins`,
        [v.purchaseToken]
      );
      if (claim.rows.length) {
        const { user_id, coins } = claim.rows[0];
        if (user_id != null && coins > 0) {
          await dbc.query('UPDATE users SET coins = GREATEST(0, coins - $1) WHERE id = $2', [coins, user_id]);
          await dbc.query(
            `INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, 'spent', $3)`,
            [user_id, coins, `tx:purchase_voided|coins:${coins}`]
          );
        }
        reversed++;
      }
      await dbc.query('COMMIT');
    } catch (e) { await dbc.query('ROLLBACK'); console.error('[gplay] void reverse failed', v.purchaseToken, e.message); }
    finally { dbc.release(); }
  }
  if (reversed) console.log(`[gplay] reconciled ${reversed} voided purchase(s) of ${voided.length} checked`);
  return { checked: voided.length, reversed };
}

module.exports = { getTiers, createCheckout, handleIPN, verifyGooglePlay, reconcileVoidedGooglePurchases };
