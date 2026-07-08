// One-off: refresh subscriber_count for every channel + user, right now.
// Needs two env vars (copy both from Railway → Variables):
//   PowerShell:  $env:YOUTUBE_API_KEY="..."; $env:DATABASE_URL="..."; node backfill-subs.js
const { google } = require('googleapis');
const { Pool } = require('pg');

(async () => {
  const key = process.env.YOUTUBE_API_KEY;
  const dbUrl = process.env.DATABASE_URL;
  if (!key)  { console.log('Missing YOUTUBE_API_KEY'); process.exit(1); }
  if (!dbUrl){ console.log('Missing DATABASE_URL');   process.exit(1); }

  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  const yt = google.youtube({ version: 'v3', auth: key });

  const { rows } = await pool.query(
    'SELECT id, youtube_channel_id FROM channels WHERE youtube_channel_id IS NOT NULL'
  );
  console.log(`Found ${rows.length} channels. Refreshing...`);

  let ok = 0;
  for (const ch of rows) {
    try {
      const res = await yt.channels.list({ part: 'statistics', id: ch.youtube_channel_id });
      const raw = res.data.items?.[0]?.statistics?.subscriberCount;
      const count = raw ? parseInt(raw, 10) : 0;
      await pool.query('UPDATE channels SET subscriber_count=$1 WHERE id=$2', [count, ch.id]);
      await pool.query('UPDATE users SET subscriber_count=$1 WHERE youtube_channel_id=$2', [count, ch.youtube_channel_id]);
      console.log(`  ${ch.youtube_channel_id} -> ${count}`);
      ok++;
    } catch (e) {
      console.log(`  ${ch.youtube_channel_id} FAILED: ${e.message}`);
    }
  }
  console.log(`\nDone. Updated ${ok}/${rows.length} channels (+ their users).`);
  await pool.end();
  process.exit(0);
})();
