// Locks in the platform economy nudge invariants (src/lib/platform.js):
//  - web = base; mobile = per-type % (ceil cost / floor payout); watch = FLAT ±1
//  - display parity: a client composing base + extras×unit lands EXACTLY on the
//    server's charge/payout at every watch duration
//  - mint-safety: mobile payout ≤ slot_cost for every type × creation platform
const { mobileCampaignCost, mobileEarnPayout } = require('../src/lib/platform');
const { watchPricing } = require('../src/lib/economy');
const cfg = require('../src/config');

const MARGIN = 3;

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

describe('platform nudge — watch flat offset', () => {
  test('display parity: composed client math == server charge/payout for 1..60 min', () => {
    const tiersCost = mobileCampaignCost(cfg.REWARDS.watch + MARGIN, 'watch'); // slot_costs.watch (mobile)
    const tiersRew = mobileEarnPayout(cfg.REWARDS.watch, 'watch');             // reward_per_type.watch (mobile)
    for (let m = 1; m <= 60; m++) {
      const p = watchPricing(m, cfg.REWARDS.watch, MARGIN);
      const charge = mobileCampaignCost(p.slotCost, 'watch'); // createTask
      const payout = mobileEarnPayout(p.reward, 'watch');     // verify / feed
      expect(tiersCost + (m - 1) * cfg.WATCH_COST_PER_EXTRA_MIN).toBe(charge);
      expect(tiersRew + (m - 1) * cfg.WATCH_REWARD_PER_EXTRA_MIN).toBe(payout);
    }
  });

  test('mint-safety: mobile payout ≤ slot_cost for every duration × creation platform', () => {
    for (let m = 1; m <= 60; m++) {
      const p = watchPricing(m, cfg.REWARDS.watch, MARGIN);
      const payout = mobileEarnPayout(p.reward, 'watch');
      expect(payout).toBeLessThanOrEqual(p.slotCost);                        // web-created campaign
      expect(payout).toBeLessThanOrEqual(mobileCampaignCost(p.slotCost, 'watch')); // mobile-created
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
