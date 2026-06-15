module.exports = {
  OWNER_EMAIL: (process.env.OWNER_EMAIL || 'bilsidk@gmail.com').toLowerCase(),

  // What earners receive per task type
  REWARDS: {
    subscribe:       12,
    like:            6,
    like_comment:    10,
    subscribe_like:  17,
    watch:           4,   // base for 1 min; +1 per extra minute
  },

  // What campaign owners pay per slot (earner reward + 3 coin house margin)
  SLOT_COSTS: {
    subscribe:       15,
    like:            9,
    like_comment:    13,
    subscribe_like:  20,
    watch:           7,   // base for 1 min; +1 per extra minute
  },

  WATCH_COST_PER_EXTRA_MIN: 1,   // added to both owner cost and earner reward
  WATCH_REWARD_PER_EXTRA_MIN: 1,

  COMMENT_BONUS: 4,

  MIN_WATCH_MINUTES: 1,
  MAX_WATCH_MINUTES: 60,

  COMPLETION_DELAY_SECONDS: 45,

  TIER: { OWNER: 1, PREMIUM: 2, USER: 3 },

  MIN_SECONDS_BETWEEN_TASKS: 20,
  MAX_TASKS_PER_HOUR: 40,
  MAX_ACCOUNTS_PER_DEVICE: 3,
  RECLAIMS_BEFORE_BAN: 3,
  TRUST_FLOOR_BAN: 25,
  TRUST_PENALTY: 15,

  // NowPayments price tiers
  PRICE_TIERS: [
    { usd: 5,  coins: 1000,  bonus_pct: 0  },
    { usd: 10, coins: 2200,  bonus_pct: 10 },
    { usd: 25, coins: 6000,  bonus_pct: 20 },
    { usd: 50, coins: 13000, bonus_pct: 30 },
  ],
};
