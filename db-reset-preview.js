/**
 * READ-ONLY reset preview. Shows the current test data and what a launch reset would
 * clear — changes NOTHING. Run this, review, then we build the matching reset script.
 *
 * Usage (from D:\react\subs\SubsShare-Backend):
 *   node db-reset-preview.js "postgresql://USER:PASS@HOST/neondb?sslmode=require"
 */
const { Pool } = require('pg');
const conn = process.argv[2] || process.env.DATABASE_URL;
if (!conn) { console.error('Provide a connection string as arg 1 or set DATABASE_URL.'); process.exit(1); }
const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false } });
const OWNER = (process.env.OWNER_EMAIL || 'bilsidk@gmail.com').toLowerCase();

const line = (s = '') => console.log(s);
const h = (s) => { line(); line('='.repeat(60)); line(s); line('='.repeat(60)); };
async function q(sql, p) { try { return (await pool.query(sql, p)).rows; } catch (e) { return [{ ERROR: e.message }]; } }
function table(rows) {
  if (!rows.length) { line('  (none)'); return; }
  if (rows[0].ERROR) { line('  ⚠ ' + rows[0].ERROR); return; }
  const cols = Object.keys(rows[0]);
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  line('  ' + cols.map((c, i) => c.padEnd(w[i])).join('  '));
  line('  ' + cols.map((c, i) => '-'.repeat(w[i])).join('  '));
  for (const r of rows) line('  ' + cols.map((c, i) => String(r[c] ?? '').padEnd(w[i])).join('  '));
}

(async () => {
  try {
    h('1. ALL USERS (balances + role)');
    table(await q(`SELECT id, email, role, coins, is_banned,
                          (SELECT COUNT(*) FROM completions WHERE user_id=users.id) AS completions
                   FROM users ORDER BY coins DESC`));

    h('2. TABLE ROW COUNTS (what a full data reset would clear)');
    for (const t of ['tasks', 'completions', 'transactions', 'earned_targets', 'task_starts', 'referrals', 'google_purchases', 'pending_payments', 'device_accounts', 'account_history']) {
      line(`  ${t.padEnd(20)} ${await q(`SELECT COUNT(*) AS n FROM "${t}"`).then(r => r[0].n)}`);
    }

    h('3. ACTIVE CAMPAIGNS (these show in the Earn feed for real users)');
    table(await q(`SELECT t.id, t.task_type, t.status, t.remaining_slots, c.channel_name, u.email AS owner
                   FROM tasks t JOIN channels c ON c.id=t.channel_id JOIN users u ON u.id=c.user_id
                   WHERE t.status='active' ORDER BY t.id`));

    h('4. TOTAL COINS IN CIRCULATION');
    const tot = await q(`SELECT COALESCE(SUM(coins),0) AS total,
                                COALESCE(SUM(coins) FILTER (WHERE LOWER(email)<>$1),0) AS non_owner
                         FROM users`, [OWNER]);
    line(`  total = ${tot[0].total}   (non-owner = ${tot[0].non_owner})`);

    line();
    line('This is a PREVIEW only — nothing was changed.');
    line('Decide the reset scope, then we build the execute script:');
    line('  A) Zero all non-owner coin balances only (keep accounts, campaigns, history)');
    line('  B) Full clean slate: zero coins + clear tasks/completions/transactions/');
    line('     earned_targets/task_starts/referrals/pending_payments (keep user accounts + channels)');
    line('  C) Full clean slate + also delete non-owner test user accounts');
  } catch (e) {
    console.error('Preview failed:', e.message);
    process.exitCode = 1;
  } finally { await pool.end(); }
})();
