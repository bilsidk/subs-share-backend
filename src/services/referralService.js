const pool = require('../db/pool');
const cfg = require('../config');

// No ambiguous chars (0/O, 1/I) so codes are easy to read/share.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode(len = 6) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

// Ensure the user has a referral_code (lazy — generated on first need). Returns it.
async function ensureReferralCode(userId) {
  const r = await pool.query('SELECT referral_code FROM users WHERE id=$1', [userId]);
  if (r.rows[0]?.referral_code) return r.rows[0].referral_code;
  for (let i = 0; i < 8; i++) {
    const code = randomCode();
    try {
      const upd = await pool.query(
        'UPDATE users SET referral_code=$1 WHERE id=$2 AND referral_code IS NULL RETURNING referral_code',
        [code, userId]
      );
      if (upd.rows.length) return code;
      const again = await pool.query('SELECT referral_code FROM users WHERE id=$1', [userId]);
      if (again.rows[0]?.referral_code) return again.rows[0].referral_code; // set concurrently
    } catch (_) { /* unique collision — retry with a new code */ }
  }
  return null;
}

// Called at signup for a brand-new user who entered a code. Records a PENDING
// referral only — NO coins are minted here. Both bonuses pay out later, when the
// referee completes their first real (API-verified) task. That gating is what
// makes the program hard to farm: a throwaway account earns nothing.
async function applyReferralAtSignup(refereeId, code) {
  if (!code || typeof code !== 'string') return;
  const c = code.trim().toUpperCase();
  if (!c) return;
  const ref = await pool.query('SELECT id FROM users WHERE referral_code=$1', [c]);
  const referrerId = ref.rows[0]?.id;
  if (!referrerId || referrerId === refereeId) return; // unknown code or self-referral
  await pool.query(
    `INSERT INTO referrals (referee_id, referrer_id, status) VALUES ($1,$2,'pending')
     ON CONFLICT (referee_id) DO NOTHING`,
    [refereeId, referrerId]
  );
  await pool.query('UPDATE users SET referred_by=$1 WHERE id=$2 AND referred_by IS NULL', [referrerId, refereeId]);
}

// Called after a referee completes a real, API-verified task. Pays both sides
// exactly once. Everything (lock, guards, payout) happens inside ONE transaction
// with `FOR UPDATE` on the referral row, so guards can't be raced (no TOCTOU) and
// the payout can't double-fire. Anti-farm guards:
//   - referrer must exist and not be banned
//   - referrer must be an ACTIVE user (has a device footprint) — a "referrer" who
//     never earned anything can't cash referrals; this also guarantees we have a
//     device to compare against. If not yet active, we leave the referral PENDING
//     so it can pay on a later referee task once the referrer becomes active.
//   - the referee's device must NOT match any of the referrer's devices (self-referral)
async function rewardReferralIfPending(refereeId, deviceId) {
  const dbc = await pool.connect();
  try {
    await dbc.query('BEGIN');
    const pend = await dbc.query(
      `SELECT referrer_id FROM referrals WHERE referee_id=$1 AND status='pending' FOR UPDATE`,
      [refereeId]
    );
    if (!pend.rows.length) { await dbc.query('ROLLBACK'); return; }
    const referrerId = pend.rows[0].referrer_id;

    const rb = await dbc.query('SELECT is_banned, device_id FROM users WHERE id=$1', [referrerId]);
    if (!rb.rows.length || rb.rows[0].is_banned) {
      await dbc.query(`UPDATE referrals SET status='blocked' WHERE referee_id=$1`, [refereeId]);
      await dbc.query('COMMIT');
      return;
    }

    // Collect the referrer's known devices (stamped + all historical registrations).
    const refDev = await dbc.query('SELECT device_id FROM device_accounts WHERE user_id=$1', [referrerId]);
    const referrerDevices = new Set(refDev.rows.map(r => r.device_id));
    if (rb.rows[0].device_id) referrerDevices.add(rb.rows[0].device_id);

    // Referrer must be an active user (has at least one device on record). If not,
    // hold the referral as pending (don't reward, don't block) and retry later.
    if (referrerDevices.size === 0) { await dbc.query('ROLLBACK'); return; }

    // Self-referral / same-device guard.
    if (deviceId && referrerDevices.has(deviceId)) {
      await dbc.query(`UPDATE referrals SET status='blocked' WHERE referee_id=$1`, [refereeId]);
      await dbc.query('COMMIT');
      return;
    }

    // Claim + pay (row is locked and still pending).
    await dbc.query(`UPDATE referrals SET status='rewarded', rewarded_at=NOW() WHERE referee_id=$1`, [refereeId]);
    await dbc.query('UPDATE users SET coins=coins+$1 WHERE id=$2', [cfg.REFEREE_BONUS, refereeId]);
    await dbc.query('UPDATE users SET coins=coins+$1 WHERE id=$2', [cfg.REFERRER_BONUS, referrerId]);
    await dbc.query(`INSERT INTO transactions (user_id,amount,type,description) VALUES ($1,$2,'bonus','tx:referral_referee')`, [refereeId, cfg.REFEREE_BONUS]);
    await dbc.query(`INSERT INTO transactions (user_id,amount,type,description) VALUES ($1,$2,'bonus','tx:referral_referrer')`, [referrerId, cfg.REFERRER_BONUS]);
    await dbc.query('COMMIT');
  } catch (e) { await dbc.query('ROLLBACK'); console.error('[referral] reward failed', e.message); }
  finally { dbc.release(); }
}

// Clawback: reverse a rewarded referral when the referee turns out to be a bad
// actor (banned / repeatedly reclaimed). Pulls the bonus back from BOTH sides.
async function reverseReferralForReferee(refereeId) {
  const dbc = await pool.connect();
  try {
    await dbc.query('BEGIN');
    const r = await dbc.query(
      `SELECT referrer_id FROM referrals WHERE referee_id=$1 AND status='rewarded' FOR UPDATE`,
      [refereeId]
    );
    if (r.rows.length) {
      const referrerId = r.rows[0].referrer_id;
      await dbc.query(`UPDATE referrals SET status='reversed' WHERE referee_id=$1`, [refereeId]);
      await dbc.query('UPDATE users SET coins=GREATEST(0,coins-$1) WHERE id=$2', [cfg.REFEREE_BONUS, refereeId]);
      await dbc.query('UPDATE users SET coins=GREATEST(0,coins-$1) WHERE id=$2', [cfg.REFERRER_BONUS, referrerId]);
      await dbc.query(`INSERT INTO transactions (user_id,amount,type,description) VALUES ($1,$2,'spent','tx:referral_reversed')`, [refereeId, cfg.REFEREE_BONUS]);
      await dbc.query(`INSERT INTO transactions (user_id,amount,type,description) VALUES ($1,$2,'spent','tx:referral_reversed')`, [referrerId, cfg.REFERRER_BONUS]);
    }
    await dbc.query('COMMIT');
  } catch (e) { await dbc.query('ROLLBACK'); console.error('[referral] reverse failed', e.message); }
  finally { dbc.release(); }
}

async function getReferralInfo(userId) {
  const code = await ensureReferralCode(userId);
  const c = await pool.query(`SELECT COUNT(*) AS n FROM referrals WHERE referrer_id=$1 AND status='rewarded'`, [userId]);
  const p = await pool.query(`SELECT COUNT(*) AS n FROM referrals WHERE referrer_id=$1 AND status='pending'`, [userId]);
  return {
    code,
    rewarded: parseInt(c.rows[0].n, 10) || 0,
    pending: parseInt(p.rows[0].n, 10) || 0,
    referrer_bonus: cfg.REFERRER_BONUS,
    referee_bonus: cfg.REFEREE_BONUS,
  };
}

module.exports = { ensureReferralCode, applyReferralAtSignup, rewardReferralIfPending, reverseReferralForReferee, getReferralInfo };
