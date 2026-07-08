// Optional per-video comment-example generator via Google's Gemini API (Google AI
// Studio free tier — no credit card). If GEMINI_API_KEY isn't set, or any call
// fails/times out, every function degrades to null and callers fall back to the
// curated per-locale templates. So this is purely additive and never blocks earning.
const GEMINI_KEY   = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const TIMEOUT_MS   = 6000;

const LANG_NAMES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese',
  ar: 'Arabic', hi: 'Hindi', id: 'Indonesian', ru: 'Russian', tr: 'Turkish',
  ja: 'Japanese', ko: 'Korean', bn: 'Bengali',
  'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese',
};

function available() { return !!GEMINI_KEY; }

// Returns ONE short, natural, video-relevant example comment in the target language,
// or null on any problem (missing key, timeout, bad response).
async function generateExampleComment(videoTitle, langCode) {
  if (!GEMINI_KEY) return null;
  const langName = LANG_NAMES[langCode] || 'English';
  const title = String(videoTitle || '').slice(0, 200);
  const prompt =
    `Write ONE natural YouTube comment a real viewer might post on a video titled "${title}". ` +
    `Requirements: a COMPLETE sentence of at least 8 words (never one or two words), positive, ` +
    `human, and specific-sounding. Write it in ${langName}. ` +
    `Return ONLY the comment text — no quotes, no emojis, no hashtags.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        // thinkingBudget:0 disables the 2.5 "thinking" pass (which otherwise eats the
        // token budget and returns truncated text); maxOutputTokens gives room for one
        // sentence in any language. Non-thinking models ignore thinkingConfig harmlessly.
        generationConfig: { temperature: 1.0, maxOutputTokens: 120, thinkingConfig: { thinkingBudget: 0 } },
      }),
      signal: controller.signal,
    });
    if (!res.ok) { console.warn('[gemini] non-ok', res.status); return null; }
    const data = await res.json();
    let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    text = text.trim().replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ').slice(0, 200);
    return text || null;
  } catch (e) {
    console.warn('[gemini] error:', e.message);
    return null;
  } finally { clearTimeout(timer); }
}

module.exports = { generateExampleComment, available };
