# SubsShare — PROJECT STATE

---

## 1. TECH STACK & ARCHITECTURE

**Backend:** Node.js + Express · Railway PostgreSQL · JWT auth · google-auth-library + googleapis (YouTube Data API v3)
**Mobile:** React Native 0.8x (`D:\react\subs\SubsShare`, package `com.subsshare`, minSdk 24 / Android 7+)
**Web:** Buildless static SPA in `/web` (vanilla JS, dark theme) — served same-origin by the backend ✨ NEW 2026-06-12

**Repos:**
- Backend: `D:\react\subs\SubsShare-Backend` → `https://github.com/bilsidk/subs-share-backend` (branch: **master**) → auto-deploys to Railway `subs-share-backend-production`
- Mobile: `D:\react\subs\SubsShare` — **no git remote yet** (history contains keystore password — scrub/rotate before pushing)

**Live URLs:**
- Backend + Web app: `https://subs-share-backend-production.up.railway.app`
- Website: `viralboostnow.com` (`/privacy.html`, `/terms.html`, `/delete-account.html`)

**Google OAuth (project `subs-share`):**
- Web client ID (used by mobile `webClientId`, backend audience, AND web app):
  `59298470844-ldipur31o2rbe3la0oecsin3jd65pklq.apps.googleusercontent.com`
- Scope: `youtube.readonly` (+ openid email profile on web)
- Two Android clients (debug SHA-1 + Play App Signing SHA-1)
- ⚠️ PENDING: add the Railway URL to the web client's **Authorized JavaScript origins**

**Auth flows:**
```
Mobile: GoogleSignin → idToken + serverAuthCode → POST /auth/google
Web:    GIS popup code client → code → POST /auth/google {serverAuthCode, web:true}
        (backend exchanges with redirect_uri='postmessage', takes id_token from exchange)
Both:   backend verifies idToken, stores YouTube refresh token, auto-registers channel,
        returns 30d JWT
```

**Railway env vars:** `DATABASE_URL, JWT_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_ORIGINS, OWNER_EMAIL, NODE_ENV=production`

---

## 2. ECONOMY (src/config + app_settings overrides)

| type | earner reward | slot cost (reward+3 margin) |
|------|------|------|
| subscribe | 12 | 15 |
| like | 6 | 9 |
| like_comment | 10 (+4 comment bonus) | 13 |
| subscribe_like | 17 | 20 |
| watch | 4 base +1/extra min | 7 base +1/extra min |

Watch: 1–60 min, video must be ≥ required length. Completion delay 45s.
Anti-cheat: 20s between tasks, 40/hr, daily limits (user 50 / premium 150), 3 accounts/device,
trust score 100 (−15/reclaim, ban at ≤25 or 3 reclaims).

---

## 3. CORE API ENDPOINTS

```
POST   /auth/google          {idToken?, serverAuthCode?, accessToken?, web?} → {token, user, youtube_connected}
GET    /users/me             DELETE /users/me
GET    /channels             POST /channels
GET    /tasks?type=          → available tasks (excludes own + completed)
GET    /tasks/my             → my campaigns with progress/can_* flags
POST   /tasks                {channel_id?, task_type, subscribers_wanted, target_video_url?, watch_minutes?}
POST   /tasks/:id/verify     {started_at, device_id} → verify via YouTube API (honor in degraded mode)
PATCH  /tasks/:id/pause|resume    DELETE /tasks/:id (cancel+refund)
GET    /transactions?page=
GET    /admin/status  PATCH /admin/settings  POST /admin/mode|promote|ban  GET /admin/users
GET    /health
```
Rate limits: global 200/15m · auth 10/15m · verify 30/15m · campaigns 20/hr · admin 60/15m.

---

## 4. CURRENT WORKING STATE

### Web app — added 2026-06-12 (commit `9351be2`)
- `/web/index.html` + `/web/app.js` — buildless SPA, same dark theme as mobile (#0A0A0F / #6C63FF)
- Tabs: Earn (feed + filters + verify modal with 45s countdown) · Grow (create campaign,
  pause/resume/cancel) · Wallet (translated tx history) · Profile (sign out, delete account)
- Sign-in: GIS popup **code flow** (one click grants identity + youtube.readonly)
- Backend changes: `web:true` flag → OAuth2Client redirect `postmessage`; id_token taken from
  code exchange; helmet CSP off + COOP `same-origin-allow-popups`; express.static serves /web
- Same-origin API calls → no CORS/ALLOWED_ORIGINS change needed
- Purpose: covers users on Android < 7 (mobile app floor is minSdk 24) and desktop

### Mobile (Play Store)
- Internal testing track, versionCode 3, versionName 1.0
- Release keystore: `android/app/release.keystore` (passwords in gitignored `keystore.properties`)
- Play App Signing SHA-1 registered as separate OAuth client (DEVELOPER_ERROR fixed 2026-06-11)

### Verification (Plan A/B)
- Plan A: YouTube Data API — subscriptions.list (subscribe), videos.getRating (like),
  commentThreads (comment bonus); watch tasks are honor-only
- Plan B: honor mode after 25 API failures/5min; Resend email alert; 30-min auto-recovery probe
- Audits: 2h + 48h re-verification passes (auditService + auditScheduler)

### PENDING
1. Add `https://subs-share-backend-production.up.railway.app` to web OAuth client's
   **Authorized JavaScript origins** (Google Cloud Console) — web sign-in fails until then
2. Mobile repo: scrub keystore password from git history, add remote, push
3. Optional: custom domain for web app (e.g. app.viralboostnow.com → Railway)

### Known Issues
- Admin panel not in web app (use mobile)
- Web app is English-only (mobile has 15 locales — port `utils/locales` later if needed)
- Untracked in mobile repo: screenshots/, feature-graphic.*, terms.html, delete-account.html
