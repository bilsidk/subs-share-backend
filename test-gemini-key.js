// Lists the Gemini models your key can use (and which support generateContent),
// then tries a sample generation with the first available flash model.
//   PowerShell:  $env:GEMINI_API_KEY="AQ...."; node test-gemini-key.js
(async () => {
  const key = process.env.GEMINI_API_KEY;
  console.log('GEMINI_API_KEY set:', key ? `yes (…${key.slice(-4)})` : 'NO — MISSING');
  if (!key) return;

  // 1) List models
  let models = [];
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
    const data = await res.json();
    if (!res.ok) { console.log(`ListModels failed (HTTP ${res.status}):`, data?.error?.message); return; }
    models = (data.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'));
    console.log('\nModels that support generateContent:');
    for (const m of models) console.log('  ', m.name.replace('models/', ''));
  } catch (e) { console.log('ListModels error:', e.message); return; }

  // 2) Pick a good flash model and test it
  const names = models.map(m => m.name.replace('models/', ''));
  const pick = names.find(n => /2\.5-flash$/.test(n))
            || names.find(n => /2\.0-flash$/.test(n))
            || names.find(n => /flash/.test(n) && !/thinking|exp|preview/.test(n))
            || names[0];
  if (!pick) { console.log('\nNo usable model found.'); return; }
  console.log(`\nTesting generation with: ${pick}`);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${pick}:generateContent?key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Write ONE short natural YouTube comment for a cooking video. Return only the comment.' }] }], generationConfig: { temperature: 1.0, maxOutputTokens: 60 } }),
    });
    const data = await res.json();
    if (!res.ok) { console.log(`Generation failed (HTTP ${res.status}):`, data?.error?.message); return; }
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '(no text)';
    console.log('\n✅ Works! Sample comment:\n  ', text.trim());
    console.log(`\n=> Set these in Railway:  GEMINI_API_KEY=<your key>   GEMINI_MODEL=${pick}`);
  } catch (e) { console.log('Generation error:', e.message); }
})();
