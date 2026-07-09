// Platform detection + economy multipliers for the "steer users to the web version"
// nudge. The MOBILE app is made pricier to advertise on and lower-paying to earn on,
// so users prefer the lower-fee web (crypto) experience. Web is unchanged.
//
// Detection is ORIGIN/REFERER based on purpose: it must work for GET requests (feed,
// /payments/tiers) as well as POST, so it can't depend on req.body.platform (which the
// integrity gate's isTrustedWebRequest does). A real browser sends an Origin header on
// cross-origin API calls; the React Native app does not. (A savvy mobile user could forge
// an Origin to get web rates — that only defeats the nudge, it can't mint coins or steal,
// so it's an accepted limitation, not a security hole.)
const cfg = require('../config');

// Every origin the web SPA can be served from — mirrors paymentController's RETURN_ALLOWLIST
// so the two never drift. Includes the Railway host (the backend also serves web/) so web
// users who open it there aren't wrongly detected as mobile and penalized.
const WEB_ORIGINS = (process.env.WEB_ORIGINS || process.env.ALLOWED_ORIGINS ||
  'https://app.viralboostnow.com,https://viralboostnow.com,https://subs-share-backend-production.up.railway.app')
  .split(',').map(s => s.trim()).filter(o => o && o !== '*');

function isWebRequest(req) {
  // Misconfigured (no origins) → treat everyone as web so we never accidentally penalize
  // legitimate web users; the nudge simply switches off until WEB_ORIGINS is set.
  if (!WEB_ORIGINS.length) return true;
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';
  // Dev: the SPA served by the backend on localhost (any port) is still "web".
  if (origin.startsWith('http://localhost') || referer.startsWith('http://localhost')) return true;
  return WEB_ORIGINS.some(o => origin === o || referer === o || referer.startsWith(o + '/'));
}

function isMobileRequest(req) { return !isWebRequest(req); }

// Campaign cost on mobile: per-type surcharge, rounded UP (owner pays at least the
// surcharge — house-safe). taskType selects the rate; unknown/absent type → no change.
// WATCH is a flat per-slot offset (composes per minute — a percentage of the composed
// total can't be displayed exactly by per-part clients; flat keeps shown = charged).
function mobileCampaignCost(baseCost, taskType) {
  if (taskType === 'watch') return Math.round(baseCost) + (Number(cfg.MOBILE_WATCH_COST_FLAT) || 0);
  const s = Number((cfg.MOBILE_SURCHARGE_BY_TYPE || {})[taskType]) || 0;
  return s > 0 ? Math.ceil(baseCost * (1 + s)) : Math.round(baseCost);
}

// Earn payout on mobile: per-type penalty, rounded DOWN (earner never gets more than base
// — house-safe, and always <= slot_cost so no coin minting is possible). WATCH: flat −N.
function mobileEarnPayout(baseReward, taskType) {
  if (taskType === 'watch') {
    // Apply the flat only when there's room above it — a mobile earner must never be
    // reduced to 0 for a task that pays >0 on web (e.g. an admin lowering coins_watch
    // to 1 must not turn mobile watch into unpaid work). Never exceeds baseReward.
    const flat = Number(cfg.MOBILE_WATCH_EARN_FLAT) || 0;
    const base = Math.round(baseReward);
    return base > flat ? base - flat : base;
  }
  const p = Number((cfg.MOBILE_PENALTY_BY_TYPE || {})[taskType]) || 0;
  return p > 0 ? Math.floor(baseReward * (1 - p)) : Math.round(baseReward);
}

module.exports = { WEB_ORIGINS, isWebRequest, isMobileRequest, mobileCampaignCost, mobileEarnPayout };
