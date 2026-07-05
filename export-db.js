/**
 * Standalone database export — dumps every table to CSV + a restorable INSERT .sql,
 * using the `pg` package already in this project (no pg_dump / no version matching).
 *
 * Usage (from D:\react\subs\SubsShare-Backend):
 *   node export-db.js "postgresql://USER:PASS@HOST/db?sslmode=require"
 * or, if DATABASE_URL is set in your env:
 *   node export-db.js
 *
 * Output: ./db-backup-<timestamp>/  containing one <table>.csv per table and a
 * single data.sql of INSERT statements. Pair data.sql with your existing schema.sql
 * to restore onto any Postgres:  psql "TARGET_URL" -f schema.sql -f data.sql
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const conn = process.argv[2] || process.env.DATABASE_URL;
if (!conn) { console.error('Provide a connection string as the first argument or set DATABASE_URL.'); process.exit(1); }

// Neon requires SSL; don't verify the cert chain here so it works from any machine.
const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false } });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(process.cwd(), `db-backup-${stamp}`);
fs.mkdirSync(outDir, { recursive: true });

function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`; // json/jsonb/arrays
  return `'${String(v).replace(/'/g, "''")}'`;
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = (typeof v === 'object' && !(v instanceof Date)) ? JSON.stringify(v) : String(v);
  if (v instanceof Date) s = v.toISOString();
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

(async () => {
  try {
    const { rows: tables } = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
    );
    if (!tables.length) { console.log('No tables found in schema public.'); await pool.end(); return; }

    const sqlPath = path.join(outDir, 'data.sql');
    const sqlOut = fs.createWriteStream(sqlPath);
    sqlOut.write('-- SubsShare data export\n-- Restore with your schema first:  psql "URL" -f schema.sql -f data.sql\nBEGIN;\n\n');

    let grandTotal = 0;
    for (const { tablename } of tables) {
      const { rows, fields } = await pool.query(`SELECT * FROM "${tablename}"`);
      const cols = fields.map(f => f.name);

      // CSV
      const csvPath = path.join(outDir, `${tablename}.csv`);
      const csv = fs.createWriteStream(csvPath);
      csv.write(cols.join(',') + '\n');
      for (const r of rows) csv.write(cols.map(c => csvCell(r[c])).join(',') + '\n');
      csv.end();

      // SQL INSERTs (batched)
      if (rows.length) {
        const colList = cols.map(c => `"${c}"`).join(',');
        for (const r of rows) {
          const vals = cols.map(c => sqlLiteral(r[c])).join(',');
          sqlOut.write(`INSERT INTO "${tablename}" (${colList}) VALUES (${vals});\n`);
        }
        sqlOut.write('\n');
      }
      grandTotal += rows.length;
      console.log(`  ${tablename.padEnd(22)} ${rows.length} rows`);
    }

    sqlOut.write('COMMIT;\n');
    sqlOut.end();
    await new Promise(res => sqlOut.on('finish', res));
    console.log(`\n✅ Exported ${tables.length} tables, ${grandTotal} rows total`);
    console.log(`   Folder: ${outDir}`);
  } catch (e) {
    console.error('Export failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
