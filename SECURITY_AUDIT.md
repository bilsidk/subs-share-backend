# SubsShare Backend — Security / Abuse Audit

_Audit date: 2026-07-04. Scope: `SubsShare-Backend/src` (the live Railway backend, `subs-share-backend-production.up.railway.app`). Mobile app on Play Store consumes this API — all fixes below are backend-only and deploy via master → Railway with no app update needed._

## Context from chat
- **CreatorHub** and **CreatorMatch** were earlier names/versions of **SubsShare** — same project, NOT separate apps. (A stale CreatorMatch-branded `terms.html` was still live at `viralboostnow.com/terms.html`; replaced with the SubsShare version 2026-07-09.)
- "Old" SubsShare = the `subs/` folder tree. Newer full rewrite = `subs/SubsShare` (mobile, native android/ios) + `subs/SubsShare-Backend` (this API). Live backend runs the newer code.
- YouTube Shorts ARE accepted: `youtubeService.parseVideoId()` matches `watch?v=`, `youtu.be/`, and `youtube.com/shorts/`, plus bare 11-char ID. Web input has no restriction; tasks render as `watch?v=<id>` which still plays Shorts.
- Completions are never re-shown to a user (feed excludes by `task_id` via `LEFT JOIN completions ... co.id IS NULL`; dup check returns 409). Reclaimed coins keep the completion row. Audit re-verifies via YouTube API: quick 2h, deep 48h, re-audit every 72h up to MAX_AUDITS=3.

## What's already well-defended
Server-stamped task start (`/tasks/:id/start` → `task_starts`), API re-verification on verify, background audit + coin reclaim + trust/ban, per-Google-account welcome bonus (survives delete via `account_history`), exactly-once crypto payments (atomic claim on `pending_payments`), IPN signature check, return-URL allowlist, owner-only admin guard, per-endpoint rate limiters.

## Findings (by severity)

### HIGH — free coins for no work
1. **Repeat campaign on same channel/video re-pays already-subscribed users.**
   Dup check + feed filter key on `task_id`, not `target_channel_id` / `target_video_id`. A new campaign for a channel a user already subscribed to reappears in their feed and `verifySubscription` passes instantly → instant re-payout; owner also re-pays for subs he already has.
   Fix: key dup check + feed exclusion on channel/video id for subscribe/like types, e.g.
   ```sql
   SELECT id FROM completions
   WHERE user_id=$1 AND target_channel_id=$2
     AND task_type IN ('subscribe','subscribe_like')
     AND verify_status <> 'reclaimed';
   ```

2. **Cross-campaign unsub/resub farming.** Even with #1, subscribe to campaign A (paid) → unsub → new campaign B for same channel pays again. Audit reclaims only up to MAX_AUDITS=3 and bans after 3 reclaims; a patient farmer stays under the threshold.
   Fix: permanent `earned_channel` ledger so any given channel can only ever pay a given user once.

3. **`like_comment` comment deletion never audited.** `auditService.checkValid` only re-checks the like for `like_comment`. Earn +4 comment bonus, delete comment, keep coins.
   Fix: re-check comment in audit, or don't exempt the bonus from reclaim.

4. **`watch` tasks are pure honor system.** `verifyTask` skips API verification for `task_type==='watch'`; audit `checkValid` returns true for watch. Zero watch-time still collects. Likely unavoidable (no YouTube watch API) but currently has no check or cap at all — known economy leak.

### MEDIUM — abuse / cost
5. **Degraded (honor) mode is an unaudited farming window, remotely triggerable.** On enough API failures the app flips to honor mode and awards coins for unverified subscribe/like (`verify_status='pending'`). Audit only checks `verify_status='verified'`, so pending completions are NEVER reclaimed. Attacker who spikes API failures (or waits for an outage) farms freely.
   Fix: audit `pending` completions once API recovers.

6. **Device-farm cap is client-supplied and optional.** `device_id` comes from request body; omit it and `assertDeviceOk`/`registerDevice` no-op. `MAX_ACCOUNTS_PER_DEVICE=3` bypassed by not sending the field.
   Fix: require device_id (or a server-derived signal) for earn actions.

7. **Client `started_at` fallback still trusted.** If client skips `/start`, `verifyTask` trusts client `started_at` with plausibility checks; a forged timestamp exactly `delaySeconds+30` in the past passes. Minor.
   Fix: drop the fallback now that the app ships `/start`.

### LOW — hardening
8. Mixed env keys: `resolveChannel` uses `YOUTUBE_API_KEY`, `getSubscriberCount` uses `GOOGLE_API_KEY`. If one is unset, sub counts silently read 0 (feeds targeting/pricing).
9. `isNew` welcome-bonus uses a fragile 5s `created_at` window, but the real guard is `account_history` (fine).
10. No upper bound on `subscribers_wanted` for non-owners beyond coin balance.

## Recommended fix order
1. #5 (pending completions never audited) — biggest silent leak.
2. #1 / #2 (channel-level dedup + permanent earned-channel ledger).
3. #3 (comment audit).
Fixes for #1, #3, #5 were offered to be written — not yet implemented as of this audit.
