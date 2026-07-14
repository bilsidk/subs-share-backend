// Locks in the platform economy nudge invariants (src/lib/platform.js):
//  - web = base; mobile = per-type % (ceil cost / floor payout); watch = FLAT ±1
//  - the flat watch offset composes exactly on top of the TIERED watch curve
//    (cfg.watchRewardFor / cfg.slotCostFor — compose-from-atoms 2026-07-11)
//  - mint-safety: mobile payout ≤ slot_cost for every type × creation platform
const { mobileCampaignCost, mobileEarnPayout } = require('../src/lib/platform');
const cfg = require('../src/config');

describe('platform nudge — percentage types', () => {
  test('mobile cost is ceil(base×(1+s)) and payout floor(base×(1−p)); web-safe direction', () => {
    for (const t of ['subscribe', 'like', 'like_comment', 'subscribe_like']) {
      const cost = cfg.SLOT_COSTS[t];
      const reward = cfg.REWARDS[t];
      expect(mobileCampaignCost(cost, t)).toBeGreaterThanOrEqual(cost); // owner never pays less than base
      expect(mobileEarnPayout(reward, t)).toBeLessThanOrEqual(reward); // earner never gets more than base
    }
    expect(mobileCampaignCost(15, 'subscribe')).toBe(18);
    expect(mobileEarnPayout(12, 'subscribe')).toBe(10);
  });

  test('unknown type is a no-op (base rates)', () => {
    expect(mobileCampaignCost(15, 'nope')).toBe(15);
    expect(mobileEarnPayout(12, 'nope')).toBe(12);
  });
});

describe('platform nudge — watch flat offset over the tiered curve', () => {
  test('mobile = tiered value ±1 flat at every duration (charge +1, payout −1)', () => {
    for (let m = 1; m <= 60; m++) {
      const reward = cfg.watchRewardFor(m);
      const cost = cfg.slotCostFor('watch', m);
      expect(mobileCampaignCost(cost, 'watch')).toBe(cost + cfg.MOBILE_WATCH_COST_FLAT);
      // payout −1 flat, but never reduces a >0 web payout to 0 (reward ≥ 2 here)
      expect(mobileEarnPayout(reward, 'watch')).toBe(reward - cfg.MOBILE_WATCH_EARN_FLAT);
    }
  });

  test('mint-safety: mobile payout ≤ slot_cost for every duration × creation platform', () => {
    for (let m = 1; m <= 60; m++) {
      const reward = cfg.watchRewardFor(m);
      const cost = cfg.slotCostFor('watch', m);
      const payout = mobileEarnPayout(reward, 'watch');
      expect(payout).toBeLessThanOrEqual(cost);                              // web-created campaign
      expect(payout).toBeLessThanOrEqual(mobileCampaignCost(cost, 'watch')); // mobile-created
    }
  });

  test('never reduces a >0 web payout to 0 (admin sets coins_watch low)', () => {
    expect(mobileEarnPayout(1, 'watch')).toBe(1); // flat has no room → base, not 0
    expect(mobileEarnPayout(0, 'watch')).toBe(0); // web pays 0 → mobile pays 0 (no mint)
    expect(mobileEarnPayout(2, 'watch')).toBe(1);
    expect(mobileEarnPayout(4, 'watch')).toBe(3);
  });
});

describe('platform nudge — mint-safety cross-product (all types)', () => {
  test('mobile payout ≤ base slot_cost for every task type', () => {
    for (const t of Object.keys(cfg.SLOT_COSTS)) {
      const bonus = t === 'like_comment' ? cfg.COMMENT_BONUS : 0;
      const payout = mobileEarnPayout(cfg.REWARDS[t], t) + (bonus ? mobileEarnPayout(bonus, t) : 0);
      expect(payout).toBeLessThanOrEqual(cfg.SLOT_COSTS[t]); // even vs the CHEAPER web-created slot
    }
  });
});
