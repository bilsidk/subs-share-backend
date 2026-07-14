const { earnedKeysFor, sanitizeExampleIds, commentMeetsMinimum } = require('../src/lib/economy');
const cfg = require('../src/config');

// Compose-from-atoms economy (Economy & Watch Redesign 2026-07-11): 4 atoms
// (subscribe 12, like 5, watch_base 2, comment_bonus 8), combos derive, owner
// slot_cost = ceil(reward × (1 + margin 0.25)). Watch reward is TIERED.
describe('watchRewardFor — tiered watch curve', () => {
  test('spec anchor points: 1→2, 10→11, 20→31, 30→61', () => {
    expect(cfg.watchRewardFor(1)).toBe(2);
    expect(cfg.watchRewardFor(10)).toBe(11);   // +1/min for minutes 2–10
    expect(cfg.watchRewardFor(20)).toBe(31);   // +2/min for minutes 11–20
    expect(cfg.watchRewardFor(30)).toBe(61);   // +3/min for minutes 21+
  });
  test('tier boundaries: 11th minute adds +2, 21st adds +3', () => {
    expect(cfg.watchRewardFor(11) - cfg.watchRewardFor(10)).toBe(2);
    expect(cfg.watchRewardFor(21) - cfg.watchRewardFor(20)).toBe(3);
  });
  test('0/negative/garbage minutes clamp to 1 minute (base)', () => {
    expect(cfg.watchRewardFor(0)).toBe(2);
    expect(cfg.watchRewardFor(-5)).toBe(2);
    expect(cfg.watchRewardFor('x')).toBe(2);
  });
  test('admin-overridden watch base shifts the whole curve', () => {
    expect(cfg.watchRewardFor(10, 5)).toBe(14); // 5 base + 9 tier-1 minutes
  });
});

describe('rewardFor — combos derive from atoms', () => {
  test('atoms: subscribe 12, like 5', () => {
    expect(cfg.rewardFor('subscribe')).toBe(12);
    expect(cfg.rewardFor('like')).toBe(5);
  });
  test('derived combos: subscribe_like 17, like_comment 13 (like + comment bonus)', () => {
    expect(cfg.rewardFor('subscribe_like')).toBe(17);
    expect(cfg.rewardFor('like_comment')).toBe(13);
  });
  test('live admin atoms override the defaults (combos recompute)', () => {
    const atoms = { subscribe: 20, like: 10, comment_bonus: 4 };
    expect(cfg.rewardFor('subscribe_like', 1, atoms)).toBe(30);
    expect(cfg.rewardFor('like_comment', 1, atoms)).toBe(14);
  });
  test('unknown type → 0', () => expect(cfg.rewardFor('nope')).toBe(0));
});

describe('slotCostFor — cost = ceil(reward × (1+margin)), never below reward', () => {
  test('default 25% margin: subscribe 15, like 7, like_comment 17, subscribe_like 22, watch(1) 3', () => {
    expect(cfg.slotCostFor('subscribe')).toBe(15);
    expect(cfg.slotCostFor('like')).toBe(7);
    expect(cfg.slotCostFor('like_comment')).toBe(17);
    expect(cfg.slotCostFor('subscribe_like')).toBe(22);
    expect(cfg.slotCostFor('watch', 1)).toBe(3);
  });
  test('negative margin clamps to 0 (cost can never drop below reward → no minting)', () => {
    expect(cfg.slotCostFor('subscribe', 1, undefined, -5)).toBe(12);
  });
  test('NO-MINT invariant: reward ≤ slotCost for every type × watch duration', () => {
    for (const t of cfg.TASK_TYPES) {
      for (const m of [1, 2, 10, 11, 15, 20, 21, 30, 60]) {
        expect(cfg.rewardFor(t, m)).toBeLessThanOrEqual(cfg.slotCostFor(t, m));
      }
    }
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
