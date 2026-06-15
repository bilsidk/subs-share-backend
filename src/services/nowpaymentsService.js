const crypto = require('crypto');

const NOWPAYMENTS_API = 'https://api.nowpayments.io/v1';

function getApiKey() {
  const key = process.env.NOWPAYMENTS_API_KEY;
  if (!key) throw new Error('NOWPAYMENTS_API_KEY not set');
  return key;
}

async function createInvoice({ price_amount, order_id, order_description, ipn_callback_url, success_url, cancel_url }) {
  const res = await fetch(`${NOWPAYMENTS_API}/invoice`, {
    method: 'POST',
    headers: {
      'x-api-key': getApiKey(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      price_amount,
      price_currency: 'usd',
      ipn_callback_url,
      order_id,
      order_description,
      success_url,
      cancel_url,
      is_fixed_rate: true,
    }),
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
  const hmac = crypto.createHmac('sha512', secret);
  const sorted = Object.keys(body).sort().reduce((acc, k) => {
    if (body[k] !== null && body[k] !== undefined) acc[k] = body[k];
    return acc;
  }, {});
  const data = JSON.stringify(sorted);
  hmac.update(data);
  return hmac.digest('hex') === signature;
}

module.exports = { createInvoice, verifyIPN };
