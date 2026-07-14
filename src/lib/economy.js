// Pure, side-effect-free economy/verification helpers. No DB, no network — so they
// are unit-testable in isolation (see tests/economy.test.js) and are the SINGLE
// source of truth for this logic (taskController imports from here).
// NOTE: watch/combo PRICING lives in src/config (rewardFor / slotCostFor /
// watchRewardFor — compose-from-atoms, Economy & Watch Redesign 2026-07-11).
const cfg = require('../config');

// The permanent "already earned" ledger keys a completed task implies. A user may be
// paid at most once per key, across all campaigns, forever.
function earnedKeysFor(task) {
  const keys = [];
  const ch = task.target_channel_id, vid = task.target_video_id;
  if ((task.task_type === 'subscribe' || task.task_type === 'subscribe_like') && ch)  keys.push('sub:' + ch);
  if ((task.task_type === 'like' || task.task_type === 'like_comment' || task.task_type === 'subscribe_like') && vid) keys.push('like:' + vid);
  if (task.task_type === 'watch' && vid) keys.push('watch:' + vid);
  return keys;
}

// Owner-selected curated example indices: unique ints in range, capped.
function sanitizeExampleIds(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  for (const v of raw) {
    const n = parseInt(v, 10);
    if (Number.isInteger(n) && n >= 0 && n < cfg.CURATED_COMMENT_COUNT) seen.add(n);
  }
  return Array.from(seen).slice(0, cfg.MAX_COMMENT_EXAMPLES);
}

// like_comment quality floor: at least minWords words OR minChars characters (the char
// fallback covers space-less languages: zh/ja/th).
function commentMeetsMinimum(text, minWords, minChars) {
  const txt = String(text || '').trim();
  const words = txt ? txt.split(/\s+/).filter(Boolean).length : 0;
  const chars = txt.replace(/\s+/g, '').length;
  return words >= minWords || chars >= minChars;
}

module.exports = { earnedKeysFor, sanitizeExampleIds, commentMeetsMinimum };
