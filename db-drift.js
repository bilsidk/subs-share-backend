/**
 * READ-ONLY drift diagnostic. For each account that didn't reconcile in db-audit.js,
 * prints its balance, every transactions row, its account_history (welcome-bonus gate),
 * and its completions — so we can see exactly which coins have no matching ledger entry.
 *
 * Usage (from D:\react\subs\SubsShare-Backend):
 *   node db-drift.js "postgresql://USER:PASS@HOST/neondb?sslmode=require"
 */
const { Pool } = require('pg');
const conn = process.argv[2] || process.env.DATABASE_URL;
if (!conn) { console.error('Provide a connection string as arg 1 or set DATABASE_URL.'); process.exit(1); }
const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false } });

const IDS = [11, 55, 61, 53, 60, 62]; // the drifting accounts from db-audit.js
const line = (s='') => console.log(s);

async function q(sql, params) { try { return (await pool.query(sql, params)).rows; } catch (e) { return [{ ERROR: e.message }]; } }
function table(rows, indent='    ') {
  if (!rows.length) { line(indent + '(none)'); return; }
  if (rows[0].ERROR) { line(indent + '⚠ ' + rows[0].ERROR); return; }
  const cols = Object.keys(rows[0]);
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  line(indent + cols.map((c,i) => c.padEnd(w[i])).join('  '));
  line(indent + cols.map((c,i) => '-'.repeat(w[i])).join('  '));
  for (const r of rows) line(indent + cols.map((c,i) => String(r[c] ?? '').padEnd(w[i])).join('  '));
}

(async () => {
  try {
    for (const id of IDS) {
      const u = (await q(`SELECT id, email, coins, role, google_id FROM users WHERE id=$1`, [id]))[0];
      if (!u) { line(`\n#${id}: (user not found)`); continue; }
      line('\n' + '='.repeat(64));
      line(`USER ${u.id}  ${u.email}   balance=${u.coins}  role=${u.role || 'user'}`);
      line('='.repeat(64));

      const tx = await q(`SELECT amount, type, description, created_at FROM transactions WHERE user_id=$1 ORDER BY created_at`, [id]);
      const ledger = tx.reduce((s, r) => s + (r.type === 'spent' ? -Number(r.amount) : ['earned','bonus','purchase'].includes(r.type) ? Number(r.amount) : 0), 0);
      line(`  transactions (ledger net = ${ledger}, balance = ${u.coins}, DRIFT = ${u.coins - ledger}):`);
      table(tx);

      line('  account_history (welcome-bonus gate):');
      table(await q(`SELECT google_id, bonus_granted, updated_at FROM account_history WHERE google_id=$1`, [u.google_id]));

      line('  completions (earned via tasks):');
      table(await q(`SELECT id, task_id, verify_method, verify_status, coins_awarded, completed_at FROM completions WHERE user_id=$1 ORDER BY completed_at`, [id]));
    }
    line('\nDONE — copy everything above back to Claude.');
  } catch (e) {
    console.error('Diagnostic failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
