# SubsShare — Security Fixes (applied)

Date: 2026-07-04. All changes are **backend + web + mobile source**. The three coin-farming
categories and the earlier audit findings are addressed. Re-audited adversarially after patching:
all 8 farming vectors confirmed closed, no new farming hole introduced.

## Deployment order & impact

1. **Backend** — deploy first. `migrate.js` runs on boot (idempotent) and adds:
   - `UNIQUE INDEX completions(task_id,user_id)` (dedups existing rows first)
   - `tasks.slot_cost` column (+ backfill `reward+3`)
   - `earned_targets` ledger table (+ backfill from `completions`)
   No manual SQL needed. **Published app keeps working** — API is backward compatible
   (the published clients already send `device_id` and call `/start`).
2. **Web** — redeploy `web/` static files. Also **decommission or resync the stale
   `namecheap-upload` deploy** (it was `?v=6`, lacks `/start`, and predates these fixes).
3. **Mobile** — the two mobile fixes require an app build only when you next release;
   they are UX/robustness, not required for the backend fixes to take effect.

## Coin-farming vectors closed

| Vector | Fix | Files |
|---|---|---|
| V1 concurrent double-credit | UNIQUE index + in-txn `INSERT … ON CONFLICT (task_id,user_id) DO NOTHING RETURNING id`; credit only if a row was inserted | migrate.js, taskController.js |
| V2 repeat-campaign re-pay | Permanent `earned_targets` ledger (sub:/like:/watch: keys); feed `NOT EXISTS` filter + in-txn once-per-target guard | migrate.js, taskController.js |
| V3 refund arbitrage | Refund uses stored `task.slot_cost`, never live-recomputed price | migrate.js, campaignController.js |
| V4 honor/pending never reclaimed | Audit job now includes `verify_status='pending'`; promotes pending→verified when valid, reclaims when not | auditService.js |
| V5 uncapped watch honor | `MAX_WATCH_PER_DAY=20` daily cap (+ ledger blocks same-video re-earn) | config/index.js, taskController.js |
| V6 device-farm bypass | `device_id` now **mandatory** (≥6 chars) on verify | taskController.js |
| V7 forged `started_at` | Delay measured only from server-stamped `task_starts`; missing stamp is auto-created + full wait enforced | taskController.js |
| V8 like_comment | (already sound) bonus only when comment verified | taskController.js |

## Other hardening

- **Global ban gate**: new `requireNotBanned` middleware on all state-changing routes
  (create/start/verify/complete/pause/resume/cancel, add-channel, create-checkout).
- **JWT**: algorithm pinned to `HS256`.
- **Web XSS**: i18n `t()` HTML-escapes interpolated values (preserving template markup);
  `watch_minutes`/`remaining_slots` wrapped in `esc()`.
- **Mobile**: session no longer wiped on transient network error at launch (only on 401);
  token save retries Keychain before any plaintext fallback; device-id padded to fixed length.

## Round 2 — deep sweep of payment / auth / admin / web (also fixed)

- **Welcome-bonus race (was Medium):** concurrent sign-ins for a brand-new account could each add 50 coins. Now granted in one atomic, race-safe transaction gated on `account_history` (INSERT … ON CONFLICT DO UPDATE … WHERE … RETURNING) — credits exactly once, delete+resignup still blocked. (authController.js)
- **Ban/role-change the owner (was Medium):** admin endpoints could ban or demote the owner account. Now `banUser`/`setRole` refuse `OWNER_EMAIL` and any `role='owner'`. (adminController.js)
- **Fractional USD ledger mismatch (was Medium):** purchase amount now rounded to a whole dollar so charge, credited coins, and the stored ledger stay consistent (usd column is INTEGER). (paymentController.js)
- **IPN unhandled rejection (was Low):** `verifyIPN` signature check moved inside try/catch — a misconfigured IPN secret now returns a clean 500 instead of crashing the promise. (paymentController.js)
- **Web inline-handler hardening:** task cards no longer serialize the whole task object into an `onclick`; they pass the numeric id and look it up. (web/app.js)
- **Web new-code handling:** the web verify flow now handles `NOT_STARTED` (restarts the wait), and `ALREADY_EARNED`/`ALREADY_COMPLETED`/`CAMPAIGN_*` (drops the task and closes) instead of showing a raw error. (web/app.js)

Verified correct: payment credit remains exactly-once/HMAC-verified; Google idToken fully verified (audience/issuer/expiry); admin authz re-checked from DB every call; `/promote` still cannot grant owner; no IDOR; no SQL injection; error handler hides stack traces; DB clients always released.

## Still requires manual action (not code)

- **Rotate the Sentry auth token** in `SubsShare/android/sentry.properties` & `ios/sentry.properties`
  (exposed to anything reading the folder; gitignored but live).
- **Re-key / change the release keystore password** (currently weak/PII-derived).
- `npm audit fix` for the 5 moderate uuid/googleapis advisories (low practical risk).

## Residual low-severity notes

- Web: several **numeric** API fields (reward, coins, tx amounts, progress) are still
  interpolated into innerHTML without `esc()` — not exploitable while they stay numeric,
  but wrap them for defense-in-depth.
- Degraded (honor) mode still auto-triggers on 25 API failures/5min; pending completions
  are reconciled once live. Bounded by daily caps + ledger.
