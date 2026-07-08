// Play Integrity verification. The mobile app requests a signed integrity token
// from Google (bound to a server-issued nonce); here we (1) issue those nonces and
// (2) decode/verify the returned token via Google's Play Integrity API using the
// SAME service account already used for purchase verification.
//
// Rollout is SOFT by default: verifyTask checks a token if present but only BLOCKS
// when INTEGRITY_ENFORCE=true (a Railway env var), so already-published clients that
// don't send a token keep working until you flip enforcement on — no app update needed.
const crypto = require('crypto');
const { google } = require('googleapis');
const cfg = require('../config');

// Derive a DISTINCT key from JWT_SECRET so the nonce HMAC can't be used to attack the
// JWT signing key (key separation). JWT_SECRET is REQUIRED at boot (server.js fails
// fast if unset), so there is deliberately no hardcoded fallback here — a misconfig
// must never silently sign nonces with a publicly-known key.
const SECRET = (process.env.JWT_SECRET || '') + ':integrity-nonce-v1';
const NONCE_TTL_MS = 5 * 60 * 1000; // token must be produced within 5 min of the nonce

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Stateless, HMAC-signed nonce bound to the user + issue time. No DB row needed;
// replay is bounded by the 5-min TTL and by the completion uniqueness on /verify.
function issueNonce(userId) {
  const payload = `${userId}.${Date.now()}.${crypto.randomBytes(12).toString('hex')}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest();
  return `${b64url(payload)}.${b64url(sig)}`;
}

function checkNonce(nonce, userId) {
  if (!nonce || typeof nonce !== 'string') return false;
  const dot = nonce.lastIndexOf('.');
  if (dot < 1) return false;
  const payloadB64 = nonce.slice(0, dot);
  const sigB64 = nonce.slice(dot + 1);
  let payload;
  try {
    payload = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
  } catch { return false; }
  const expected = b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
  if (sigB64.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sigB64), Buffer.from(expected))) return false;
  const [uid, tsStr] = payload.split('.');
  if (String(uid) !== String(userId)) return false;
  const ts = parseInt(tsStr, 10);
  if (!ts || Date.now() - ts > NONCE_TTL_MS) return false;
  return true;
}

let _client = null;
function getClient() {
  if (_client) return _client;
  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON not set');
  const creds = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/playintegrity'],
  });
  _client = google.playintegrity({ version: 'v1', auth });
  return _client;
}

// Decode + evaluate a Play Integrity token. Returns { ok, reason, verdicts }.
// ok=true means the request came from a genuine, Play-installed, unmodified app on
// a device that meets basic integrity, and the nonce matches what we issued.
async function verifyIntegrity(token, userId) {
  const client = getClient();
  const res = await client.v1.decodeIntegrityToken({
    packageName: cfg.ANDROID_PACKAGE,
    requestBody: { integrityToken: token },
  });
  const payload = (res.data && res.data.tokenPayloadExternal) || {};
  const rd = payload.requestDetails || {};
  const app = payload.appIntegrity || {};
  const dev = payload.deviceIntegrity || {};

  if (rd.requestPackageName && rd.requestPackageName !== cfg.ANDROID_PACKAGE) {
    return { ok: false, reason: 'pkg_mismatch', verdicts: { pkg: rd.requestPackageName } };
  }
  if (!checkNonce(rd.nonce, userId)) {
    return { ok: false, reason: 'nonce_bad' };
  }

  const appOk = app.appRecognitionVerdict === 'PLAY_RECOGNIZED';
  const devVerdicts = dev.deviceRecognitionVerdict || [];
  const devOk = devVerdicts.includes('MEETS_DEVICE_INTEGRITY');

  return {
    ok: appOk && devOk,
    reason: !appOk ? 'app' : (!devOk ? 'device' : 'ok'),
    verdicts: { app: app.appRecognitionVerdict || null, device: devVerdicts },
  };
}

module.exports = { issueNonce, checkNonce, verifyIntegrity };
