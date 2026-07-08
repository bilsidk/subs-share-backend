const { google } = require('googleapis');
const cfg = require('../config');

// Lazy-initialised Android Publisher client. Credentials come from a Google
// service-account JSON (the whole file contents) in GOOGLE_PLAY_SERVICE_ACCOUNT_JSON.
let _publisher = null;
function getPublisher() {
  if (_publisher) return _publisher;
  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON not set');
  let creds;
  try { creds = JSON.parse(raw); }
  catch { throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON'); }
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  _publisher = google.androidpublisher({ version: 'v3', auth });
  return _publisher;
}

// Verify a consumable in-app purchase with Google. Returns the purchase record.
// Throws on any API/auth error so the caller can decide how to respond.
async function verifyProductPurchase(productId, purchaseToken) {
  const publisher = getPublisher();
  const res = await publisher.purchases.products.get({
    packageName: cfg.ANDROID_PACKAGE,
    productId,
    token: purchaseToken,
  });
  const p = res.data || {};
  return {
    // purchaseState: 0 = purchased, 1 = cancelled, 2 = pending
    purchased: p.purchaseState === 0,
    pending: p.purchaseState === 2,
    orderId: p.orderId || null,
    acknowledged: p.acknowledgementState === 1,
    raw: p,
  };
}

// Acknowledge a purchase so Google doesn't auto-refund it after 3 days. Safe to
// call once; ignore "already acknowledged" errors.
async function acknowledgeProductPurchase(productId, purchaseToken) {
  const publisher = getPublisher();
  try {
    await publisher.purchases.products.acknowledge({
      packageName: cfg.ANDROID_PACKAGE,
      productId,
      token: purchaseToken,
    });
  } catch (e) {
    // 400 with "already acknowledged" is fine; rethrow anything else.
    const msg = e?.errors?.[0]?.message || e.message || '';
    if (!/already/i.test(msg)) throw e;
  }
}

// List purchases Google has VOIDED (user refund, chargeback, or developer revocation)
// since startTimeMillis. Same androidpublisher scope as verify/acknowledge. Returns
// [{ purchaseToken, orderId }]. Throws on API/auth error so the caller can decide.
async function listVoidedPurchases(startTimeMillis) {
  const publisher = getPublisher();
  const out = [];
  let token;
  do {
    const res = await publisher.purchases.voidedpurchases.list({
      packageName: cfg.ANDROID_PACKAGE,
      ...(startTimeMillis ? { startTime: String(startTimeMillis) } : {}),
      maxResults: 1000,
      ...(token ? { token } : {}),
    });
    for (const v of (res.data.voidedPurchases || [])) {
      if (v.purchaseToken) out.push({ purchaseToken: v.purchaseToken, orderId: v.orderId || null });
    }
    token = res.data.tokenPagination && res.data.tokenPagination.nextPageToken;
  } while (token);
  return out;
}

module.exports = { verifyProductPurchase, acknowledgeProductPurchase, listVoidedPurchases };
