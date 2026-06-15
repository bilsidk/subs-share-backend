const crypto = require('crypto');

function isSandbox() { return process.env.NOWPAYMENTS_SANDBOX === 'true'; }

// Sandbox keys only authenticate against the sandbox host — switch the base URL
// to match, otherwise a sandbox key hits the prod endpoint and always 401s.
function apiBase() {
  return isSandbox() ? 'https://api-sandbox.nowpayments.io/v1' : 'https://api.nowpayments.io/v1';
}

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
  const res = await fetch(`${apiBase()}/invoice`, {
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
  const data = await res.json();
  // Sandbox returns invoice_url on the production checkout host, where a sandbox
  // invoice doesn't exist ("Partner not found"). Repoint it at the sandbox host
  // so the hosted checkout page can actually load it.
  if (isSandbox() && typeof data.invoice_url === 'string') {
    data.invoice_url = data.invoice_url.replace('://nowpayments.io', '://sandbox.nowpayments.io');
  }
  return data;
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
