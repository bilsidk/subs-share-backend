const { watchPricing, earnedKeysFor, sanitizeExampleIds, commentMeetsMinimum } = require('../src/lib/economy');
const cfg = require('../src/config');

describe('watchPricing', () => {
  test('1 minute = base reward; slotCost = reward + margin', () => {
    expect(watchPricing(1, 4, 3)).toEqual({ reward: 4, slotCost: 7 });
  });
  test('extra minutes add per-minute reward', () => {
    const per = cfg.WATCH_REWARD_PER_EXTRA_MIN;
    expect(watchPricing(5, 4, 3)).toEqual({ reward: 4 + 4 * per, slotCost: 4 + 4 * per + 3 });
  });
  test('0/negative minutes clamps extras to 0', () => {
    expect(watchPricing(0, 4, 3).reward).toBe(4);
  });
});

describe('earnedKeysFor', () => {
  test('subscribe → sub key', () => {
    expect(earnedKeysFor({ task_type: 'subscribe', target_channel_id: 'UC1' })).toEqual(['sub:UC1']);
  });
  test('subscribe_like → sub + like keys', () => {
    expect(earnedKeysFor({ task_type: 'subscribe_like', target_channel_id: 'UC1', target_video_id: 'v1' }))
      .toEqual(['sub:UC1', 'like:v1']);
  });
  test('like_comment → like key', () => {
    expect(earnedKeysFor({ task_type: 'like_comment', target_video_id: 'v1' })).toEqual(['like:v1']);
  });
  test('watch → watch key', () => {
    expect(earnedKeysFor({ task_type: 'watch', target_video_id: 'v1' })).toEqual(['watch:v1']);
  });
  test('missing ids → no keys', () => {
    expect(earnedKeysFor({ task_type: 'subscribe' })).toEqual([]);
  });
});

describe('sanitizeExampleIds', () => {
  test('keeps unique in-range ints, caps at MAX_COMMENT_EXAMPLES', () => {
    const out = sanitizeExampleIds([0, 1, 2, 3, '2']);
    expect(out.length).toBeLessThanOrEqual(cfg.MAX_COMMENT_EXAMPLES);
    expect(new Set(out).size).toBe(out.length); // all unique
    out.forEach((n) => { expect(n).toBeGreaterThanOrEqual(0); expect(n).toBeLessThan(cfg.CURATED_COMMENT_COUNT); });
  });
  test('drops out-of-range + non-ints', () => {
    expect(sanitizeExampleIds([-1, 9999, 'x', null])).toEqual([]);
  });
  test('non-array → []', () => {
    expect(sanitizeExampleIds('nope')).toEqual([]);
    expect(sanitizeExampleIds(undefined)).toEqual([]);
  });
});

describe('commentMeetsMinimum', () => {
  test('enough words passes', () => {
    expect(commentMeetsMinimum('this was a really great video', 5, 15)).toBe(true);
  });
  test('too few words AND too few chars fails (one-word spam)', () => {
    expect(commentMeetsMinimum('nice', 5, 15)).toBe(false);
  });
  test('space-less language passes on the character fallback', () => {
    expect(commentMeetsMinimum('这个视频看起来太棒了我等不及要在家尝试', 5, 15)).toBe(true);
  });
  test('empty / whitespace / null fails', () => {
    expect(commentMeetsMinimum('   ', 5, 15)).toBe(false);
    expect(commentMeetsMinimum(null, 5, 15)).toBe(false);
    expect(commentMeetsMinimum('', 5, 15)).toBe(false);
  });
});
