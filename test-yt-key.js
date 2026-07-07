// Diagnostic: does YOUTUBE_API_KEY actually work?
// Run ON Railway (where the env var lives):  node test-yt-key.js
// or locally with:  YOUTUBE_API_KEY=xxxx node test-yt-key.js
const { google } = require('googleapis');

(async () => {
  const key = process.env.YOUTUBE_API_KEY;
  console.log('YOUTUBE_API_KEY set:', key ? `yes (…${key.slice(-4)})` : 'NO — MISSING');
  console.log('GOOGLE_API_KEY set:', process.env.GOOGLE_API_KEY ? 'yes (old typo var)' : 'no');
  if (!key) { console.log('\n=> Set YOUTUBE_API_KEY in Railway Variables, then redeploy.'); process.exit(1); }

  const yt = google.youtube({ version: 'v3', auth: key });
  const testChannel = 'UCBR8-60-B28hp2BmDPdntcQ'; // YouTube Spotlight (stable, huge)
  try {
    const res = await yt.channels.list({ part: 'statistics', id: testChannel });
    const subs = res.data.items?.[0]?.statistics?.subscriberCount;
    console.log('\nAPI call OK. Test channel subscriberCount =', subs);
    console.log('=> Key works. If your DB is still 0, redeploy the fixed backend and have users sign in again (or run the subscriber refresh).');
  } catch (e) {
    console.log('\nAPI call FAILED:', e.message);
    const reason = e.errors?.[0]?.reason || e.response?.data?.error?.errors?.[0]?.reason;
    console.log('reason:', reason || '(none)');
    if (reason === 'accessNotConfigured') console.log('=> Enable "YouTube Data API v3" for this key\'s Google Cloud project.');
    else if (reason === 'keyInvalid') console.log('=> The key value is wrong.');
    else if (reason === 'ipRefererBlocked' || String(e.message).includes('referer')) console.log('=> Key has an HTTP-referrer/app restriction that blocks server calls. Set it to "None" or restrict by API only.');
    else if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') console.log('=> Daily quota exhausted.');
    process.exit(1);
  }
})();
