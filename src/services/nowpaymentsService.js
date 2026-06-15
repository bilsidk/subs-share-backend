const crypto = require('crypto');

const NOWPAYMENTS_API = 'https://api.nowpayments.io/v1';

function isSandbox() { return process.env.NOWPAYMENTS_SANDBOX === 'true'; }

function getApiKey() {
  const key = process.env.NOWPAYMENTS_API_KEY;
  if (!key) throw new Error('NOWPAYMENTS_API_KEY not set');
  return key;
}

async function createInvoice({ price_amount, order_id, order_description, ipn_callback_url, success_url, cancel_url, case: _case }) {
  const body = {
    price_amount,
    price_currency: 'usd',
    ipn_callback_url,
    order_id,
    order_description,
    success_url,
    cancel_url,
    is_fixed_rate: true,
  };
  if (isSandbox() && _case) body.case = _case;
  const res = await fetch(`${NOWPAYMENTS_API}/invoice`, {
    method: 'POST',
    headers: {
      'x-api-key': getApiKey(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`NowPayments invoice error: ${err}`);
  }
  return res.json();
}

function verifyIPN(body, signature) {
  const secret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!secret) throw new Error('NOWPAYMENTS_IPN_SECRET not set');
  if (!signature || typeof signature !== 'string') return false;
  // Must reproduce NowPayments' signing byte-for-byte: JSON with top-level keys
  // sorted and null fields KEPT (their canonical method). The previous version
  // stripped nulls, so any IPN carrying a null field (common on early statuses)
  // failed verification and the payment never credited.
  const data = JSON.stringify(body, Object.keys(body).sort());
  const digest = crypto.createHmac('sha512', secret).update(data).digest('hex');
  // Constant-time compare to avoid leaking the signature via response timing.
  const a = Buffer.from(digest);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { createInvoice, verifyIPN };
