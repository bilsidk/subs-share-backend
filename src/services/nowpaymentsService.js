const crypto = require('crypto');

const API_BASE = 'https://api.nowpayments.io/v1';

function getApiKey() {
  const key = process.env.NOWPAYMENTS_API_KEY;
  if (!key) throw new Error('NOWPAYMENTS_API_KEY not set');
  return key;
}

async function createInvoice({ price_amount, order_id, order_description, ipn_callback_url, success_url, cancel_url }) {
  const body = {
    price_amount,
    price_currency: 'usd',
    // Leave pay_currency UNSET by default so the hosted checkout shows the full
    // method picker (all cryptos + the card/fiat on-ramp). Setting a fixed currency
    // (via NOWPAYMENTS_PAY_CURRENCY) locks the checkout to that coin and hides card.
    ...(process.env.NOWPAYMENTS_PAY_CURRENCY ? { pay_currency: process.env.NOWPAYMENTS_PAY_CURRENCY } : {}),
    ipn_callback_url,
    order_id,
    order_description,
    success_url,
    cancel_url,
    is_fixed_rate: true,
  };
  // Bound the wait: a hung NowPayments API must not pin the checkout request open
  // indefinitely. AbortController → the fetch rejects (AbortError) after ~10s and the
  // caller returns a clean 500 instead of hanging. Successful responses are unchanged.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let res;
  try {
    res = await fetch(`${API_BASE}/invoice`, {
      method: 'POST',
      headers: {
        'x-api-key': getApiKey(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`NowPayments invoice error: ${err}`);
  }
  return res.json();
}

// Read-only status lookups used by the reconcile cron (paymentController) to recover
// crypto purchases whose crediting IPN was never delivered (endpoint down / IPN secret
// misconfigured). These NEVER supply coin amounts — those stay server-side in
// pending_payments — they only report NowPayments' true payment_status. Both are wrapped
// in an AbortController timeout so a hung upstream can't stall the scheduler.

// GET /v1/payment/{payment_id} — single payment by its NowPayments payment_id.
async function getPaymentStatus(paymentId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${API_BASE}/payment/${encodeURIComponent(paymentId)}`, {
      headers: { 'x-api-key': getApiKey() },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`NowPayments payment status error: ${res.status}`);
    return res.json();
  } finally { clearTimeout(timer); }
}

// GET /v1/payment/ — recent account payments (each row carries its invoice_id), so the
// reconcile can map our stored invoice_id → true status even when NO IPN ever arrived
// (we only have the invoice_id, never a payment_id, in that failure mode). Paginated;
// we scan a bounded recent window. Returns the raw payment rows (possibly empty).
async function listRecentPayments({ dateFrom, dateTo, limit = 500 } = {}) {
  const params = new URLSearchParams();
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  params.set('limit', String(limit));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${API_BASE}/payment/?${params.toString()}`, {
      headers: { 'x-api-key': getApiKey() },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`NowPayments payment list error: ${res.status}`);
    const json = await res.json();
    return Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
  } finally { clearTimeout(timer); }
}

// NowPayments' canonical signing: keys sorted RECURSIVELY (at every level), null
// fields kept. Object.keys().sort() as a replacer only sorts the top level and drops
// nested keys, so use a recursive sort instead. Byte-identical to the old code for
// flat payloads (the normal case), but correct if a payload ever nests.
function sortedStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(sortedStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + sortedStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

function verifyIPN(body, signature) {
  const secret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!secret) throw new Error('NOWPAYMENTS_IPN_SECRET not set');
  if (!signature || typeof signature !== 'string') return false;
  const data = sortedStringify(body);
  const digest = crypto.createHmac('sha512', secret).update(data).digest('hex');
  // Constant-time compare to avoid leaking the signature via response timing.
  const a = Buffer.from(digest);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { createInvoice, verifyIPN, getPaymentStatus, listRecentPayments };
