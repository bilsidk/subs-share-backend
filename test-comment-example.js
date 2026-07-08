// Exercises the app's REAL geminiService (same code the server uses) to show the
// example comments earners will see, in several languages, with word counts.
//   PowerShell:  $env:GEMINI_API_KEY="AQ...."; node test-comment-example.js
//   Custom title: node test-comment-example.js "Your video title here"
const gemini = require('./src/services/geminiService');

(async () => {
  if (!gemini.available()) { console.log('GEMINI_API_KEY not set — set it and retry.'); return; }
  const title = process.argv[2] || 'How to make the perfect homemade pizza';
  const langs = ['en', 'ar', 'ja', 'es', 'fr', 'zh-CN'];
  console.log('Video title:', title, '\n');
  for (const l of langs) {
    const ex = await gemini.generateExampleComment(title, l);
    const words = ex ? ex.trim().split(/\s+/).filter(Boolean).length : 0;
    const chars = ex ? ex.replace(/\s+/g, '').length : 0;
    console.log(`[${l}] (${words} words / ${chars} chars)  ${ex || '(null — would fall back to templates)'}`);
  }
  console.log('\nGood signs: each line is a full sentence, ≥5 words (or ≥15 chars for zh/ja), in the right language.');
})();
