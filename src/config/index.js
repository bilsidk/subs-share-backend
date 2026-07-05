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
    like_comment:    17,   // reward 10 + margin 3 + comment bonus 4 (owner funds the bonus)
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

  // Referral bonuses — both paid only when the referee completes their first
  // API-verified task (see referralService), so throwaway accounts earn nothing.
  REFERRER_BONUS: 150,
  REFEREE_BONUS: 100,

  MIN_SECONDS_BETWEEN_TASKS: 20,
  MAX_TASKS_PER_HOUR: 40,
  // Watch tasks can't be verified against a YouTube API, so cap how many a single
  // user can bank per day to bound honor-system abuse.
  MAX_WATCH_PER_DAY: 20,
  MAX_ACCOUNTS_PER_DEVICE: 3,
  RECLAIMS_BEFORE_BAN: 3,
  TRUST_FLOOR_BAN: 25,
  TRUST_PENALTY: 15,

  // Google Play in-app products (consumable coin packs). Product IDs must match
  // exactly what you create in Play Console. Coin amounts live here so they can be
  // changed without an app update. ANDROID_PACKAGE is the app's applicationId.
  ANDROID_PACKAGE: 'com.subsshare',
  // Play Integrity: when false (default) tokens are checked-if-present but never
  // block earning — safe while old clients are still out there. Flip to true via a
  // Railway env var (INTEGRITY_ENFORCE=true) once v8+ adoption is high to HARD-require
  // a passing device+app verdict on the earn path. No app update needed to flip.
  INTEGRITY_ENFORCE: process.env.INTEGRITY_ENFORCE === 'true',
  // Each pack: coins = total credited (base + bonus). base/bonus are for display
  // ("1,400 + 100 bonus"). popular/best drive the badges. Coin totals here must
  // match the value you advertise for each Play Console product ID.
  GOOGLE_PLAY_PRODUCTS: {
    coins_600:   { coins: 600,   base: 600,   bonus: 0 },
    coins_1500:  { coins: 1500,  base: 1400,  bonus: 100 },
    coins_3200:  { coins: 3200,  base: 2600,  bonus: 600,  popular: true },
    coins_7000:  { coins: 7000,  base: 5000,  bonus: 2000 },
    coins_15000: { coins: 15000, base: 10000, bonus: 5000, best: true },
  },

  // Custom-amount purchases (web only — Google Play can't do arbitrary amounts).
  // The user enters the base coins they pay for (200 coins per $1); bonus coins are
  // added on top per tier. Minimum 600 base coins ($3).
  COINS_PER_USD: 200,
  MIN_CUSTOM_COINS: 600,
  CUSTOM_BONUS_TIERS: [   // [minBaseCoins, bonusPct] — highest matching tier applies
    [10000, 50],
    [5000, 40],
    [2600, 23],
    [1400, 7],
    [600, 0],
  ],
  // Compute price + bonus for a custom base-coin amount. Returns null if invalid.
  calcCustomCoins(baseCoins) {
    const base = Math.floor(Number(baseCoins));
    if (!Number.isFinite(base) || base < this.MIN_CUSTOM_COINS) return null;
    if (base > 2000000) return null; // sane upper bound
    let pct = 0;
    for (const [min, p] of this.CUSTOM_BONUS_TIERS) { if (base >= min) { pct = p; break; } }
    const bonus = Math.round(base * pct / 100);
    const total = base + bonus;
    const usd = Math.round((base / this.COINS_PER_USD) * 100) / 100; // 2 decimals
    return { base, bonus, total, bonus_pct: pct, usd };
  },

  // NowPayments price tiers
  MIN_PURCHASE_USD: 20,
  calcPurchase(usd) {
    const coins = Math.floor(usd * 200);
    const bonus_pct = Math.min(Math.floor(usd / 50) * 10, 50);
    const total = coins + Math.floor(coins * bonus_pct / 100);
    return { usd, coins, bonus_pct, total };
  },
};
