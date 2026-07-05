/**
 * READ-ONLY database audit for SubsShare. Runs every check below with SELECTs only —
 * it never writes, updates, or deletes anything. Prints one report to the console;
 * copy the whole output back to Claude for analysis.
 *
 * Usage (from D:\react\subs\SubsShare-Backend):
 *   node db-audit.js "postgresql://USER:PASS@HOST/neondb?sslmode=require"
 * or set DATABASE_URL and run:  node db-audit.js
 */
const { Pool } = require('pg');
const conn = process.argv[2] || process.env.DATABASE_URL;
if (!conn) { console.error('Provide a connection string as arg 1 or set DATABASE_URL.'); process.exit(1); }
const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false } });

const line = (s='') => console.log(s);
const h = (s) => { line(); line('='.repeat(60)); line(s); line('='.repeat(60)); };

async function q(sql, params) { try { return (await pool.query(sql, params)).rows; } catch (e) { return [{ ERROR: e.message }]; } }
async function scalar(sql, params) { const r = await q(sql, params); return r[0] ? Object.values(r[0])[0] : null; }
function table(rows) {
  if (!rows.length) { line('  (none)'); return; }
  if (rows[0].ERROR) { line('  ⚠ query error: ' + rows[0].ERROR); return; }
  const cols = Object.keys(rows[0]);
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  line('  ' + cols.map((c,i) => c.padEnd(w[i])).join('  '));
  line('  ' + cols.map((c,i) => '-'.repeat(w[i])).join('  '));
  for (const r of rows) line('  ' + cols.map((c,i) => String(r[c] ?? '').padEnd(w[i])).join('  '));
}

(async () => {
  try {
    h('1. TABLES & ROW COUNTS');
    const tables = (await q(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).map(r => r.tablename);
    for (const t of tables) line(`  ${t.padEnd(24)} ${await scalar(`SELECT COUNT(*) FROM "${t}"`)}`);

    h('2. USERS OVERVIEW');
    table(await q(`SELECT
        COUNT(*) AS total_users,
        COUNT(*) FILTER (WHERE is_banned) AS banned,
        COUNT(*) FILTER (WHERE role='premium') AS premium,
        COUNT(*) FILTER (WHERE role='owner') AS owner,
        COUNT(*) FILTER (WHERE youtube_channel_id IS NOT NULL) AS has_channel,
        COUNT(*) FILTER (WHERE referral_code IS NOT NULL) AS has_ref_code,
        COUNT(*) FILTER (WHERE referred_by IS NOT NULL) AS were_referred,
        COALESCE(SUM(coins),0) AS total_coins,
        COALESCE(MAX(coins),0) AS max_balance,
        COALESCE(MIN(coins),0) AS min_balance
      FROM users`));

    h('3. LEDGER INTEGRITY (the money invariants)');
    line('Negative balances (should be 0 — coins_nonneg guards this):');
    table(await q(`SELECT id, email, coins FROM users WHERE coins < 0`));
    line();
    line('coins_nonneg constraint present?');
    table(await q(`SELECT conname FROM pg_constraint WHERE conname='users_coins_nonneg'`));
    line();
    line('Balance vs transaction-ledger reconciliation (per-user drift; empty = perfectly consistent):');
    table(await q(`
      SELECT u.id, u.email, u.coins AS balance, COALESCE(t.net,0) AS ledger_net,
             u.coins - COALESCE(t.net,0) AS drift
      FROM users u
      LEFT JOIN (
        SELECT user_id,
               SUM(CASE WHEN type IN ('earned','bonus','purchase') THEN amount
                        WHEN type='spent' THEN -amount ELSE 0 END) AS net
        FROM transactions GROUP BY user_id
      ) t ON t.user_id = u.id
      WHERE u.coins - COALESCE(t.net,0) <> 0
      ORDER BY ABS(u.coins - COALESCE(t.net,0)) DESC
      LIMIT 25`));

    h('4. COMPLETIONS (earning integrity)');
    table(await q(`SELECT verify_method, verify_status, COUNT(*) AS n, COALESCE(SUM(coins_awarded),0) AS coins
                   FROM completions GROUP BY verify_method, verify_status ORDER BY n DESC`));
    line();
    line('Duplicate (task_id,user_id) pairs (should be 0 — unique index guards this):');
    table(await q(`SELECT task_id, user_id, COUNT(*) FROM completions GROUP BY task_id,user_id HAVING COUNT(*)>1`));
    line();
    line('Orphaned completions (task no longer exists):');
    line(`  count = ${await scalar(`SELECT COUNT(*) FROM completions c LEFT JOIN tasks t ON t.id=c.task_id WHERE t.id IS NULL`)}`);

    h('5. TASKS / CAMPAIGNS');
    table(await q(`SELECT status, task_type, COUNT(*) AS n, COALESCE(SUM(remaining_slots),0) AS open_slots
                   FROM tasks GROUP BY status, task_type ORDER BY status, task_type`));
    line();
    line('Anomaly: negative remaining_slots (should be 0):');
    line(`  count = ${await scalar(`SELECT COUNT(*) FROM tasks WHERE remaining_slots < 0`)}`);

    h('6. REFERRALS (new system)');
    table(await q(`SELECT status, COUNT(*) AS n FROM referrals GROUP BY status ORDER BY n DESC`));
    line();
    line('Self-referrals (referrer = referee — should be 0):');
    line(`  count = ${await scalar(`SELECT COUNT(*) FROM referrals WHERE referrer_id = referee_id`)}`);
    line();
    line('Rewarded referrals where referrer & referee share a device (possible farm — should be 0):');
    table(await q(`
      SELECT r.referee_id, r.referrer_id
      FROM referrals r
      WHERE r.status='rewarded' AND EXISTS (
        SELECT 1 FROM device_accounts da1 JOIN device_accounts da2 ON da1.device_id=da2.device_id
        WHERE da1.user_id=r.referrer_id AND da2.user_id=r.referee_id
      ) LIMIT 25`));
    line();
    line('Referrals pointing at a missing user:');
    line(`  count = ${await scalar(`SELECT COUNT(*) FROM referrals r LEFT JOIN users u ON u.id=r.referrer_id WHERE u.id IS NULL`)}`);

    h('7. PURCHASES (real money)');
    table(await q(`SELECT status, COUNT(*) AS n, COALESCE(SUM(coins),0) AS coins_credited
                   FROM google_purchases GROUP BY status ORDER BY n DESC`));
    line();
    line('Duplicate purchase tokens (should be 0 — primary key guards this):');
    table(await q(`SELECT purchase_token, COUNT(*) FROM google_purchases GROUP BY purchase_token HAVING COUNT(*)>1`));

    h('8. ANTI-ABUSE SIGNALS');
    line('Devices linked to more than 3 accounts (MAX_ACCOUNTS_PER_DEVICE=3):');
    table(await q(`SELECT device_id, COUNT(DISTINCT user_id) AS accounts
                   FROM device_accounts GROUP BY device_id HAVING COUNT(DISTINCT user_id) > 3
                   ORDER BY accounts DESC LIMIT 25`));
    line();
    line('Low-trust / high-reclaim users (top 15):');
    table(await q(`SELECT id, email, coins, trust_score, reclaim_count, is_banned
                   FROM users WHERE reclaim_count > 0 OR trust_score < 100
                   ORDER BY reclaim_count DESC, trust_score ASC LIMIT 15`));

    h('9. APP SETTINGS / MODE');
    table(await q(`SELECT id, api_mode, degraded_reason, updated_at FROM app_settings WHERE id=1`));

    h('DONE — copy everything above back to Claude.');
  } catch (e) {
    console.error('Audit failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
