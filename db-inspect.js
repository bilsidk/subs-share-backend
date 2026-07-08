// Read-only schema inspector. Prints tables / columns / constraints / indexes for the
// live DB using DATABASE_URL from .env. It ONLY reads the catalog (information_schema /
// pg_catalog) — it never SELECTs row data and never writes/alters anything. Safe to run
// against production. Usage:  node db-inspect.js
require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('Set DATABASE_URL in .env first (a read-only Neon string).'); process.exit(1); }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const cols = await client.query(`
      SELECT table_name, ordinal_position, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema='public' ORDER BY table_name, ordinal_position`);
    const byTable = {};
    for (const r of cols.rows) (byTable[r.table_name] = byTable[r.table_name] || []).push(r);

    const cons = await client.query(`
      SELECT tc.table_name, tc.constraint_type, tc.constraint_name, cc.check_clause,
             kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_col
      FROM information_schema.table_constraints tc
      LEFT JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name=tc.constraint_name AND kcu.table_schema='public'
      LEFT JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name=tc.constraint_name AND ccu.table_schema='public'
      LEFT JOIN information_schema.check_constraints cc
        ON cc.constraint_name=tc.constraint_name
      WHERE tc.table_schema='public' ORDER BY tc.table_name, tc.constraint_type`);

    const idx = await client.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename, indexname`);

    console.log('# TABLES & COLUMNS');
    for (const t of Object.keys(byTable).sort()) {
      console.log('\n## ' + t);
      for (const c of byTable[t])
        console.log('  ' + c.column_name + '  ' + c.data_type +
          (c.is_nullable === 'NO' ? ' NOT NULL' : '') +
          (c.column_default ? ' DEFAULT ' + c.column_default : ''));
    }
    console.log('\n# CONSTRAINTS');
    for (const r of cons.rows)
      console.log('  ' + r.table_name + '  ' + r.constraint_type + '  ' + r.constraint_name +
        (r.column_name ? ' (' + r.column_name + ')' : '') +
        (r.ref_table ? ' -> ' + r.ref_table + '.' + r.ref_col : '') +
        (r.check_clause ? ' CHECK ' + r.check_clause : ''));
    console.log('\n# INDEXES');
    for (const r of idx.rows) console.log('  ' + r.indexdef);
  } finally { await client.end(); }
})().catch((e) => { console.error('inspect failed:', e.message); process.exit(1); });
