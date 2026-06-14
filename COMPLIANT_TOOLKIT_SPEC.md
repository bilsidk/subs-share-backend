# SubsShare → CreatorCircle — Compliant Toolkit Spec

The policy-clean product that ships to Play Store with **no `youtube.readonly` scope**,
**no OAuth verification wall**, and **no sub4sub**. Same backend, same coins, same dark theme.
The exchange loop stays web-only, opt-in, never advertised from the store app.

Working name: **CreatorCircle** (drop "Subs" — it signals sub-exchange to reviewers).

---

## 1. CORE IDEA

Small YouTubers don't actually want fake subscribers (those hurt reach). They want:
**honest feedback, a bigger real audience, and collaborators.** Sell them *that*.

Engagement happens **inside our app** (feedback, votes, challenges) — never as actions
performed on YouTube for payment. YouTube appears only as **embedded videos** (allowed)
and a **channel link the user pastes themselves** (no API needed).

---

## 2. COIN ECONOMY (reuses existing coins/transactions/trust tables)

### Earn coins (sources) — all in-app, all verifiable by us
| Action | Coins | Why it's clean |
|---|---|---|
| Give structured feedback on a video (rate thumbnail/title/hook + 1 written note) | 8 | Feedback isn't a YouTube metric — paying for it breaks no policy |
| Vote in a thumbnail/title A/B test | 2 | In-app vote, our data |
| Daily streak check-in | 3 (scaling) | Retention, no platform action |
| Complete profile / add channel | 20 once | Onboarding |
| Refer a creator (they sign up + post) | 30 | Incentivizing OUR growth is fine |
| Win/participate in a weekly challenge | 10–50 | In-app event |

### Spend coins (sinks) — all in-app visibility
| Spend | Cost | What they get |
|---|---|---|
| Request feedback on my video (N reviewers) | 10/reviewer | N creators give structured feedback |
| Run a thumbnail/title A/B test (N votes) | 3/vote | Real humans vote which performs better |
| Featured slot in the creator directory (24h) | 100 | Discovery placement |
| Boost a feedback request to top of queue | 25 | Priority |
| Highlight in niche feed | 40 | Visibility in their category |

House margin (the 3-coin spread you already have) applies to every sink → revenue model intact.

---

## 3. SCREENS (web app + Play app share these)

1. **Home / Niche Feed** — videos from creators in your niche, embedded. Tap to give feedback (earn) or just watch. Replaces the "Earn" task list.
2. **Feedback Inbox** — feedback YOU received on your videos (the core value — "100 honest reactions to your thumbnail").
3. **Create** (replaces campaign create):
   - *Request Feedback* — paste video URL, pick how many reviewers, pay coins
   - *A/B Test* — upload 2 thumbnails or 2 titles, pick vote count, pay coins
   - *Feature my channel* — buy a directory/feed slot
4. **Directory** — browse creators by niche; filter by size; "open collab" badge for those seeking partners.
5. **Collab Match** — opt-in: similar-size creators in your niche you could cross-promote with (mutual, organic — no coins per action, just introductions).
6. **Challenges** — weekly themed events ("best 15s hook"), leaderboard, coin prizes.
7. **Wallet** — coins + transaction history (already built).
8. **Profile** — channel link, niche, stats, sign out, delete (already built).

---

## 4. CHANNEL OWNERSHIP — without the YouTube API scope

Problem: we can't call `youtube.readonly` (that's the scope that triggers verification + ban risk).
Solution: **paste-and-verify**, the same trick link-in-bio tools use:
1. User pastes their channel URL.
2. We generate a short code (`creatorcircle-7h2k`).
3. User adds it to their channel description (or a pinned community post) for 60 seconds.
4. We fetch the **public** channel page (no auth, no scope) and confirm the code is present.
5. Verified → store channel ID, subscriber count from the public page. User removes the code.

This proves ownership, needs **zero OAuth scope**, and kills the 100-user ceiling entirely.
Sign-in becomes plain Google identity (email/profile only) → no sensitive scope → no verification wall.

---

## 5. BACKEND REUSE MAP (~70% as-is)

| Existing | Becomes | Change |
|---|---|---|
| `users`, coins, JWT auth | same | Drop YouTube token columns; Google sign-in = identity only |
| `transactions` + tx-key system | same | New tx keys: `feedback_given`, `ab_vote`, `feature_purchased`, etc. |
| `tasks` table | `requests` (feedback/AB/feature) | Rename; `task_type` → `request_type`; reuse slots/remaining/status/cost |
| `completions` | `feedback` / `votes` | Add fields: ratings, written note, which variant voted |
| `channels` | same | Populate via paste-verify instead of API auto-register |
| `antiCheatService` (velocity/device/trust) | same | Keep entirely — abuse rules still apply |
| `auditService` / scheduler | repurpose | Audit feedback quality (flag low-effort/spam reviewers) instead of re-checking YT |
| `settingsService` (live config, degraded mode) | same | Keep; "degraded" no longer needed but harmless |
| admin panel | same | Adjust coin values, ban, promote — unchanged |
| Web SPA (shipped today) | foundation | Add the new screens; exchange mode behind an opt-in flag |

New work (the ~30%): feedback/AB data model + UI, directory query, collab matching (simple
niche+size filter to start), challenges (a cron + a leaderboard query), paste-verify endpoint.

---

## 6. THE TWO-TIER SPLIT

- **Play app (CreatorCircle):** everything above. No exchange. No YT scope. Fully useful alone.
  Scales without limit. Nothing for Google to object to.
- **Web app:** identical product **+** a "Classic Mode" (the current sub/like exchange) behind
  an explicit opt-in toggle that users find on their own. Never linked or mentioned from the
  Play app. Carries a clear risk disclosure the user accepts. Treated as a **temporary seed**
  to bootstrap the user base — wound down once the legit loops out-retain it.

---

## 7. ROLLOUT ORDER

1. Split Google developer accounts ($25) — before any submission.
2. Rename to CreatorCircle; strip YT scope from web sign-in; add paste-verify.
3. Build Feedback Request + Niche Feed + Feedback Inbox (the core loop) on web first.
4. Add A/B testing + Directory.
5. Wrap web as PWA (manifest + service worker) — instant cross-platform, no store.
6. Ship the Play app (same screens, exchange hidden).
7. Add Collab Match + Challenges.
8. Measure retention: feedback loop vs. classic exchange. Wind exchange down as legit wins.

Same plan applies to InstaGrowth (feedback on Reels/posts, IG embeds, paste-verify via bio).
