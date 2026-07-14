// ── Compose-from-atoms economy (spec: "Economy & Watch Redesign 2026-07-11") ────────
// Only 4 ATOMIC earn values exist (web/base). Every combo reward and every owner slot
// cost DERIVES from them, so the two can never drift or be configured inconsistently.
// Admin overrides live in app_settings (coins_subscribe / coins_like / coins_watch /
// comment_bonus / margin_pct); the derived combos + watch tiers ALWAYS recompute from
// whatever atoms are live (see rewardFor / slotCostFor + taskController).
const ATOMS = { subscribe: 12, like: 5, watch_base: 2, comment_bonus: 8 };
const MARGIN_PCT = 0.25;   // owner slot_cost = ceil(earner_reward * (1 + MARGIN_PCT))

// Watch reward is TIERED to reward genuine long watches — farm-safe only because of the
// in-video "Still watching?" presence probe. Minute 1 = watch_base; each further minute
// adds per its tier. Increments are FIXED (not admin-settable); only the minute-1 base
// (the watch_base atom) is overridable. e.g. 10 min → 11, 20 min → 31, 30 min → 61.
const WATCH_TIERS = [
  { upToMin: 10,       perMin: 1 },   // minutes 2–10:  +1/min
  { upToMin: 20,       perMin: 2 },   // minutes 11–20: +2/min
  { upToMin: Infinity, perMin: 3 },   // minutes 21+:   +3/min
];
function watchRewardFor(minutes, watchBase) {
  const base = Number.isFinite(+watchBase) ? +watchBase : ATOMS.watch_base;
  const m = Math.max(1, Math.floor(Number(minutes)) || 1);
  let total = base;                                 // minute 1
  for (let min = 2; min <= m; min++) {
    const tier = WATCH_TIERS.find((t) => min <= t.upToMin);
    total += tier ? tier.perMin : 0;
  }
  return total;
}

// Earner reward (web/base) for a task type. Combos derive; watch is tiered by minutes.
// `atoms` lets callers pass the LIVE admin-overridden atoms (createTask does); it defaults
// to the built-in ATOMS. NOTE: for like_comment this returns the FULL value (like + comment
// bonus) so slotCostFor funds the MAX payout — the controller stores the LIKE base in
// tasks.reward and funds the comment bonus separately (paid only when the comment verifies).
function rewardFor(taskType, watchMinutes = 1, atoms = ATOMS) {
  const A = { ...ATOMS, ...(atoms || {}) };
  switch (taskType) {
    case 'subscribe':      return A.subscribe;
    case 'like':           return A.like;
    case 'like_comment':   return A.like + A.comment_bonus;
    case 'subscribe_like': return A.subscribe + A.like;
    case 'watch':          return watchRewardFor(watchMinutes, A.watch_base);
    default:               return 0;
  }
}

// Owner slot cost = ceil(earner reward × (1 + margin)). Margin is clamped ≥ 0 so the cost
// is ALWAYS ≥ the reward — the earner payout can never exceed what the owner funded, on
// any task type or watch duration. This is the no-coin-minting invariant at the source.
function slotCostFor(taskType, watchMinutes = 1, atoms = ATOMS, marginPct = MARGIN_PCT) {
  const m = Number.isFinite(+marginPct) ? Math.max(0, +marginPct) : MARGIN_PCT;
  return Math.ceil(rewardFor(taskType, watchMinutes, atoms) * (1 + m));
}

const TASK_TYPES = ['subscribe', 'like', 'like_comment', 'subscribe_like', 'watch'];

// Legacy flat views — DERIVED from the atoms above (single source of truth). Kept ONLY so
// existing readers keep resolving a value: the createTask validity check, campaignController's
// legacy-row (pre-slot_cost) refund fallback, and paymentController's tier display. New
// pricing goes exclusively through rewardFor / slotCostFor. `like_comment` reward here is the
// LIKE base (the comment bonus is funded + paid separately), matching what tasks.reward stores.
const REWARDS = {
  subscribe:      ATOMS.subscribe,
  like:           ATOMS.like,
  like_comment:   ATOMS.like,                    // base only; bonus funded separately
  subscribe_like: ATOMS.subscribe + ATOMS.like,
  watch:          ATOMS.watch_base,              // 1-min base
};
const SLOT_COSTS = {
  subscribe:      slotCostFor('subscribe'),
  like:           slotCostFor('like'),
  like_comment:   slotCostFor('like_comment'),
  subscribe_like: slotCostFor('subscribe_like'),
  watch:          slotCostFor('watch', 1),
};

module.exports = {
  OWNER_EMAIL: (process.env.OWNER_EMAIL || 'bilsidk@gmail.com').toLowerCase(),

  // Compose-from-atoms economy (see block above). ATOMS + MARGIN_PCT are the source of
  // truth; rewardFor/slotCostFor compose everything else. REWARDS/SLOT_COSTS are derived
  // legacy views for backward-compat only.
  ATOMS,
  MARGIN_PCT,
  WATCH_TIERS,
  watchRewardFor,
  rewardFor,
  slotCostFor,
  TASK_TYPES,
  REWARDS,
  SLOT_COSTS,

  // First watch tier increment, exposed for legacy per-extra-minute display math. The new
  // reward is TIERED (see WATCH_TIERS) — these describe the FIRST tier (minutes 2–10) only.
  WATCH_COST_PER_EXTRA_MIN: 1,
  WATCH_REWARD_PER_EXTRA_MIN: 1,

  // Current default comment bonus = the comment_bonus atom. Only a fallback for rows whose
  // funded per-task comment_bonus is somehow absent (legacy rows are backfilled by migrate.js).
  COMMENT_BONUS: ATOMS.comment_bonus,

  // Platform economy nudge — steer users to the lower-fee WEB version. Web = base (these
  // values, unchanged). MOBILE pays a bit more per campaign slot and earns a bit less per
  // task, per type. Watch is gentler (its tiny base rounds harshly): no earn penalty +
  // mild cost bump. Applied server-side by request origin (src/lib/platform.js); existing
  // campaigns keep their locked slot_cost. Set a type's rate to 0 to disable that lever.
  MOBILE_SURCHARGE_BY_TYPE: { subscribe: 0.20, like: 0.20, like_comment: 0.20, subscribe_like: 0.20, watch: 0 },
  MOBILE_PENALTY_BY_TYPE:   { subscribe: 0.15, like: 0.15, like_comment: 0.15, subscribe_like: 0.15, watch: 0 },
  // Watch uses FLAT per-slot offsets instead of percentages: its price composes per
  // minute (base + tiered increments), and a percentage of the composed total can't be
  // shown exactly by a client that composes per-part — flat offsets keep shown = charged =
  // paid EXACT at every duration on every client. Web better both ways at all durations.
  MOBILE_WATCH_COST_FLAT: 1,   // mobile watch slot costs +1 coin at any duration
  MOBILE_WATCH_EARN_FLAT: 1,   // mobile watch payout is −1 coin at any duration

  // like_comment quality floor — the posted comment must have at least this many
  // words OR characters (the char fallback covers space-less languages: zh/ja/th).
  // Verified against the real comment text returned by the YouTube API.
  MIN_COMMENT_WORDS: 5,
  MIN_COMMENT_CHARS: 15,
  // Number of built-in curated example templates (indices 0..N-1). The owner may
  // select up to 3; clients render them from their own locale file by index.
  CURATED_COMMENT_COUNT: 12,
  MAX_COMMENT_EXAMPLES: 3,

  MIN_WATCH_MINUTES: 1,
  MAX_WATCH_MINUTES: 60,
  // "Full length" watch campaigns auto-price from the video's own duration (rounded UP to a
  // whole minute), but are CAPPED here so a very long video still fills (earners watch this
  // many minutes, not the whole thing). The verify time-floor caps the required watch at the
  // real video length, so a full-length campaign is always achievable.
  FULL_LENGTH_WATCH_CAP_MINUTES: 15,

  COMPLETION_DELAY_SECONDS: 45,

  TIER: { OWNER: 1, PREMIUM: 2, USER: 3 },

  // Referral bonuses — both paid only when the referee completes their first
  // API-verified task (see referralService), so throwaway accounts earn nothing.
  REFERRER_BONUS: 150,
  REFEREE_BONUS: 100,
  // Referral pays out only after the referee has genuinely used the app: their account
  // must be at least REFERRAL_MIN_REFEREE_HOURS old AND they must have completed at
  // least REFERRAL_MIN_REFEREE_TASKS verified tasks. Raises the cost of farming the bonus.
  REFERRAL_MIN_REFEREE_TASKS: 5,
  REFERRAL_MIN_REFEREE_HOURS: 24,

  MIN_SECONDS_BETWEEN_TASKS: 20,
  MAX_TASKS_PER_HOUR: 40,
  // Types that share ONE daily bucket (owner decision 2026-07-09): like and
  // like_comment count TOGETHER against the cap (e.g. 18 likes + 12 like_comments
  // = 30 → both types blocked for the day). A type not listed counts alone.
  DAILY_CAP_GROUP: { like: ['like', 'like_comment'], like_comment: ['like', 'like_comment'] },

  // Watch-specific daily cap fallback — 0 = no watch-specific cap (owner decision
  // 2026-07-09). Honor-system abuse is still bounded by the GLOBAL per-role daily limit
  // (settings daily_limit_user/premium), MAX_TASKS_PER_HOUR, the real-time watch
  // spacing/time-floor, and the once-per-video earned_targets ledger.
  MAX_WATCH_PER_DAY: 0,
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
