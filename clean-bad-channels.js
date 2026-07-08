// Find (and optionally remove) channel rows with an invalid YouTube ID.
// A real channel id looks like UC + 22 chars. Anything else can never be
// verified, so it's dead data (e.g. the legacy "htttt" row).
//
// Report only:   $env:DATABASE_URL="..."; node clean-bad-channels.js
// Delete safe:   $env:DATABASE_URL="..."; node clean-bad-channels.js --delete
//   (only deletes invalid channels that have NO campaigns attached)
const { Pool } = require('pg');

(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.log('Missing DATABASE_URL'); process.exit(1); }
  const doDelete = process.argv.includes('--delete');
  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  const { rows } = await pool.query(`
    SELECT c.id, c.user_id, c.youtube_channel_id, c.channel_url, u.email,
           (SELECT COUNT(*) FROM tasks t WHERE t.channel_id = c.id) AS task_count
    FROM channels c LEFT JOIN users u ON u.id = c.user_id
    WHERE c.youtube_channel_id !~ '^UC[A-Za-z0-9_-]{20,}$' OR c.youtube_channel_id IS NULL
    ORDER BY c.id`);

  if (!rows.length) { console.log('No invalid channels. Clean.'); await pool.end(); process.exit(0); }

  console.log(`Found ${rows.length} invalid channel row(s):\n`);
  for (const r of rows) {
    console.log(`  ch#${r.id}  id="${r.youtube_channel_id}"  url="${r.channel_url}"  owner=${r.email || r.user_id}  campaigns=${r.task_count}`);
  }

  if (!doDelete) {
    console.log('\n(report only) Re-run with  --delete  to remove the ones with 0 campaigns.');
    // Also null out any junk ids on the users table so those users re-register cleanly at next sign-in.
    const u = await pool.query(`SELECT COUNT(*) FROM users WHERE youtube_channel_id IS NOT NULL AND youtube_channel_id !~ '^UC[A-Za-z0-9_-]{20,}$'`);
    if (Number(u.rows[0].count) > 0) console.log(`Also: ${u.rows[0].count} user(s) have a junk youtube_channel_id — --delete will clear those too (they re-register on next login).`);
    await pool.end(); process.exit(0);
  }

  let del = 0, kept = 0;
  for (const r of rows) {
    if (Number(r.task_count) === 0) {
      await pool.query('DELETE FROM channels WHERE id=$1', [r.id]);
      del++;
    } else {
      console.log(`  KEPT ch#${r.id} — has ${r.task_count} campaign(s); resolve those first.`);
      kept++;
    }
  }
  // Clear junk ids on users so auto-registration fixes them at next sign-in.
  const cleared = await pool.query(
    `UPDATE users SET youtube_channel_id = NULL
     WHERE youtube_channel_id IS NOT NULL AND youtube_channel_id !~ '^UC[A-Za-z0-9_-]{20,}$'`);
  console.log(`\nDeleted ${del} channel(s), kept ${kept} (had campaigns), cleared ${cleared.rowCount} junk user id(s).`);
  await pool.end(); process.exit(0);
})();
