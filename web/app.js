/* SubsShare Web — buildless SPA served same-origin with the API */
'use strict';

const GOOGLE_CLIENT_ID = '59298470844-ldipur31o2rbe3la0oecsin3jd65pklq.apps.googleusercontent.com';
// Same-origin when served by the backend itself; absolute URL when hosted elsewhere (e.g. Namecheap)
const API_BASE = location.hostname === 'localhost'
  ? '' : 'https://viralboostnow.com/api';
const YT_SCOPE = 'openid email profile https://www.googleapis.com/auth/youtube.readonly';
const COMPLETION_DELAY = 45; // server enforces the real value; this drives the UI countdown

// Mirrors backend src/config — display estimates only, server is authoritative. These
// objects are REPLACED IN PLACE from GET /payments/tiers on load (see init) so an admin
// re-price is reflected on web too; the static values here are just the offline fallback.
// Economy & Watch Redesign 2026-07-11: compose-from-atoms (subscribe 12, like 5, comment
// bonus 8, watch base 2 + tiered) with a 25% margin. Combos derive: subscribe_like =
// 12+5=17, like_comment = 5+8=13. Watch is priced via the tiered curve below, not this table.
const SLOT_COSTS = { subscribe: 15, like: 6, like_comment: 16, subscribe_like: 21 };
const REWARDS    = { subscribe: 12, like: 5,  like_comment: 13, subscribe_like: 17 };
const MARGIN_MULT = 1.25; // display estimate mirrors the 25% house margin — server authoritative
const FULL_LENGTH_CAP_MIN = 15; // "Full length" watch campaigns cap at this many required minutes

// Tiered watch REWARD (earner payout) — escalates per minute to reward genuine long
// watches: min 1 = 2, min 2–10 = +1/min, min 11–20 = +2/min, min 21+ = +3/min
// (10 min -> 11, 20 min -> 31, 30 min -> 61). Display estimate — server is authoritative.
function tieredWatchReward(mins) {
  const n = Math.max(1, Math.min(60, parseInt(mins, 10) || 1));
  let total = 0;
  for (let m = 1; m <= n; m++) total += m === 1 ? 2 : m <= 10 ? 1 : m <= 20 ? 2 : 3;
  return total;
}
function tieredWatchCost(mins) { return Math.ceil(tieredWatchReward(mins) * MARGIN_MULT); }

const TASK_TYPES = ['subscribe', 'like', 'like_comment', 'subscribe_like', 'watch'];
const TASK_ICON = { subscribe: '🔔', like: '👍', like_comment: '💬', subscribe_like: '⭐', watch: '▶️' };
// translate shortcut (named `tr` to avoid clashing with the `t` task var in .map callbacks)
const tr = (k, v) => window.I18N.t(k, v);
const taskLabel = (type) => tr('task.' + type);
function changeLang(lang) { window.I18N.setLang(lang); render(); }
// Per-view document title — nicer history/UX and a small SPA-route SEO signal (the
// static <title> still covers non-JS crawlers).
// Localize the browser-tab title from EXISTING i18n keys (no new keys needed).
const TAB_TITLE_KEYS = { home: 'tabs.home', earn: 'tabs.earn', grow: 'tabs.grow', wallet: 'tabs.wallet', buy: 'buy.title', referral: 'referral.title', profile: 'tabs.profile', admin: 'profile.admin' };
function setDocTitle(tab) { const k = TAB_TITLE_KEYS[tab]; const name = k ? tr(k) : ''; document.title = (name ? name + ' · ' : '') + 'SubsShare'; }

// ── state ─────────────────────────────────────────────────────────────────────
const S = {
  token: localStorage.getItem('token') || null,
  user: null,
  tab: 'earn',
  tasks: [], taskFilter: null,
  myTasks: [], channels: [], txs: [],
  modal: null, // {task, status:'idle'|'countdown'|'ready'|'verifying'|'done', countdown, startedAt, error, message}
  busy: false, loginError: '', payNotice: '',
  referralCode: '', referral: null,
  openingTaskId: null, // id of the task card currently running its pre-flight /start check — drives the card spinner and blocks a double-tap
};
let countdownTimer = null;

function deviceId() {
  let id = localStorage.getItem('device_id');
  if (!id) {
    let rand;
    if (crypto?.randomUUID) rand = crypto.randomUUID().replace(/-/g, '');
    else if (crypto?.getRandomValues) rand = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
    else rand = Math.random().toString(36).slice(2) + Date.now().toString(36);
    id = 'web_' + rand;
    localStorage.setItem('device_id', id);
  }
  return id;
}

// ── api ───────────────────────────────────────────────────────────────────────
const REQUEST_TIMEOUT = 15000; // ms — mirrors mobile src/services/api.js; without this a bare fetch() can hang forever on a slow (not down) backend
async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.token) headers.Authorization = 'Bearer ' + S.token;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch(API_BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: controller.signal });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || 'Unexpected response' }; }
    if (res.status === 401 && S.token) { signOut(); throw new Error(tr('common.sessionExpired')); }
    if (!res.ok) { const e = new Error(data.error || tr('common.requestFailed')); e.code = data.code; e.data = data; e.status = res.status; throw e; }
    return data;
  } catch (e) {
    // Abort has no e.status, so reqRetry() below still treats it as a transient
    // failure (retries) and every existing caller's catch(e) block still fires.
    if (e.name === 'AbortError') throw new Error(tr('common.timeout'));
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
// Retry through TRANSIENT failures only (network drop / 5xx); never retry 4xx.
// Used for the /start stamp so a connectivity blip at task-open doesn't force a
// redo at claim time (server returns NOT_STARTED otherwise).
async function reqRetry(method, path, body, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await req(method, path, body); }
    catch (e) {
      lastErr = e;
      if (e.status && e.status >= 400 && e.status < 500) throw e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}
const api = {
  signIn: (code, referralCode) => req('POST', '/auth/google', { serverAuthCode: code, web: true, referralCode: referralCode || undefined }),
  getReferral: () => req('GET', '/users/referral'),
  // /users/me returns the user object directly (not wrapped in {user}); normalize either shape
  me: () => req('GET', '/users/me').then(d => (d && d.user) ? d.user : d),
  deleteAccount: () => req('DELETE', '/users/me'),
  channels: () => req('GET', '/channels'),
  addChannel: (channel_url) => req('POST', '/channels', { channel_url }),
  tasks: (type) => req('GET', '/tasks' + (type ? '?type=' + encodeURIComponent(type) : '')),
  myTasks: () => req('GET', '/tasks/my'),
  createTask: (d) => req('POST', '/tasks', d),
  start: (id) => reqRetry('POST', `/tasks/${id}/start`), // server-stamps the start; may reject 409 (ALREADY_EARNED / CAMPAIGN_*) — callers gate on it before any real work
  verify: (id, startedAt) => req('POST', `/tasks/${id}/verify`, { started_at: startedAt, device_id: deviceId(), platform: 'web' }),
  commentHelp: (id, lang) => req('GET', `/tasks/${id}/comment-help?lang=${encodeURIComponent(lang || 'en')}`),
  pause: (id) => req('PATCH', `/tasks/${id}/pause`),
  resume: (id) => req('PATCH', `/tasks/${id}/resume`),
  cancel: (id) => req('DELETE', `/tasks/${id}`),
  txs: (page = 1) => req('GET', '/transactions?page=' + page),
  tiers: () => req('GET', '/payments/tiers'),
  buyCoins: (amount) => req('POST', '/payments/create-checkout', { amount, return_url: location.origin }),
  adminStatus: () => req('GET', '/admin/status'),
  adminStats: () => req('GET', '/admin/stats'),
  config: (lang) => req('GET', '/tasks/config' + (lang ? '?lang=' + encodeURIComponent(lang) : '')),
  adminSaveSettings: (d) => req('PATCH', '/admin/settings', d),
  adminMode: (mode) => req('POST', '/admin/mode', { mode }),
  adminUsers: (params) => { const qs = new URLSearchParams(params || {}).toString(); return req('GET', '/admin/users' + (qs ? '?' + qs : '')); },
  adminBan: (email, unban) => req('POST', '/admin/ban', { email, unban }),
  adminAddCoins: (email, amount) => req('POST', '/admin/coins', { email, amount }),
  adminPromote: (email, role) => req('POST', '/admin/promote', { email, role }),
};

// Admin panel draft state
const A = { stats: {}, mode: 'live', settings: {}, userQuery: '', users: [], saving: false, msg: '', err: '', userErr: '' };
// Like+Comment / Sub+Like are DERIVED from the atoms below (Economy & Watch Redesign
// 2026-07-11) — no longer separate admin inputs; see adminDerivedHTML() for the
// read-only preview. margin_pct replaces the old flat house_margin (owner cost =
// ceil(earn * (1 + margin_pct/100))).
const ADMIN_FIELDS = [
  ['coins_subscribe', 'Subscribe reward'], ['coins_like', 'Like reward'],
  ['coins_watch', 'Watch reward'], ['comment_bonus', 'Comment bonus'],
  ['margin_pct', 'Margin %'], ['completion_delay_seconds', 'Verify delay (s)'],
  ['daily_limit_user', 'Daily limit (user)'], ['daily_limit_premium', 'Daily limit (premium)'],
  ['max_campaigns_per_user', 'Max campaigns/user'], ['max_watch_per_day', 'Watch tasks/day'],
];
// The backend stores margin_pct as a FRACTION (0.25); the admin field is labeled "%"
// and holds a WHOLE PERCENT (25). Convert on load (×100) and on save (÷100) — same
// pattern as mobile AdminScreen. adminDerivedHTML's /100 assumes whole-percent too.
function adminSettingsIn(s) {
  const out = { ...s };
  if (out.margin_pct != null) out.margin_pct = Math.round(Number(out.margin_pct) * 100);
  return out;
}
// Read-only preview of the derived combo rewards/costs — recomputed from the current
// (possibly unsaved) draft values so an admin sees the effect before hitting Save.
function adminDerivedHTML() {
  const sub = Number(A.settings.coins_subscribe) || 0;
  const like = Number(A.settings.coins_like) || 0;
  const cbonus = Number(A.settings.comment_bonus) || 0;
  const marginPct = Number(A.settings.margin_pct) || 0;
  const mult = 1 + marginPct / 100;
  const cost = (earn) => Math.ceil(earn * mult);
  const subLike = sub + like;
  const likeComment = like + cbonus;
  return `
    <div class="row"><span class="l">Sub+Like reward (derived)</span><span>${subLike} 🪙 · cost ${cost(subLike)}</span></div>
    <div class="row"><span class="l">Like+Comment reward (derived)</span><span>${likeComment} 🪙 · cost ${cost(likeComment)}</span></div>`;
}
function updateAdminDerived() { const el = document.getElementById('admin-derived'); if (el) el.innerHTML = adminDerivedHTML(); }

// ── buy coins (NowPayments) ───────────────────────────────────────────────────
const COIN_PACKAGES = [20, 50, 100, 250];
// Mirrors backend config.calcPurchase — display only; the server is authoritative.
function pkgInfo(usd) {
  const coins = Math.floor(usd * 200);
  const bonusPct = Math.min(Math.floor(usd / 50) * 10, 50);
  return { usd, coins, bonusPct, total: coins + Math.floor(coins * bonusPct / 100) };
}
const B = { busy: 0, error: '', customUsd: '' }; // busy = the $ amount currently being processed

// ── auth ──────────────────────────────────────────────────────────────────────
function signIn() {
  S.loginError = '';
  if (!window.google?.accounts?.oauth2) { S.loginError = tr('login.loading'); return render(); }
  // Capture the optional referral code from the login field before the OAuth popup.
  const refEl = document.getElementById('ref-code');
  const referralCode = refEl ? refEl.value.trim().toUpperCase() : '';
  const codeClient = google.accounts.oauth2.initCodeClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: YT_SCOPE,
    ux_mode: 'popup',
    callback: async (resp) => {
      if (!resp.code) { S.loginError = tr('login.cancelled'); return render(); }
      // The YouTube permission is optional on Google's screen (unchecked by default).
      // If the granted scopes don't include it, guide the user instead of failing later.
      if (resp.scope && !resp.scope.includes('youtube.readonly')) {
        S.loginError = tr('login.permissionMsg'); return render();
      }
      S.busy = true; render();
      try {
        const data = await api.signIn(resp.code, referralCode);
        S.token = data.token; localStorage.setItem('token', data.token);
        S.user = data.user;
        S.busy = false;
        await loadTab('home');
      } catch (e) {
        S.busy = false;
        const code = e.code || (e.data && e.data.code);
        const em = (e.message || '');
        if (code === 'NO_YOUTUBE_ACCESS' || /youtube/i.test(em)) S.loginError = tr('login.permissionMsg');
        else if (/network|failed to fetch|timed out|connection/i.test(em)) S.loginError = tr('login.networkMsg');
        else S.loginError = tr('login.genericMsg');
        render();
      }
    },
    error_callback: () => { S.busy = false; S.loginError = tr('login.closed'); render(); },
  });
  codeClient.requestCode();
}

function signOut() {
  localStorage.removeItem('token');
  S.token = null; S.user = null; S.modal = null;
  render();
}

// ── helpers ───────────────────────────────────────────────────────────────────
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// Escape a value going into a SINGLE-QUOTED JS string inside an inline HTML handler
// (onclick="fn('VALUE')"). HTML entities are decoded before JS runs, so quotes must be
// JS-escaped with a backslash (survives decoding); < > " & are still HTML-encoded so
// the value can't break out of the attribute or inject a tag. esc() alone is unsafe here.
function jsAttr(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── themed dialogs (replace native alert()/confirm() so nothing looks unstyled) ──
let _dlgStyled = false;
function _ensureDlgStyles() {
  if (_dlgStyled) return; _dlgStyled = true;
  const st = document.createElement('style');
  st.textContent = `
  .dlg-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:9999;padding:24px}
  .dlg-card{width:100%;max-width:380px;background:var(--card,#14141c);border:1px solid var(--border,#2a2a38);border-radius:20px;padding:22px}
  .dlg-title{font-size:17px;font-weight:800;color:var(--text,#fff);margin-bottom:8px;text-align:center}
  .dlg-msg{font-size:14px;color:var(--text2,#b9b9c6);line-height:1.5;text-align:center;white-space:pre-line}
  .dlg-btns{display:flex;gap:10px;margin-top:18px}
  .dlg-btn{flex:1;padding:12px;border-radius:12px;font-weight:800;font-size:14px;border:none;cursor:pointer}
  .dlg-confirm{background:var(--primary,#6C63FF);color:#fff}
  .dlg-cancel{background:transparent;border:1px solid var(--border,#2a2a38);color:var(--text2,#b9b9c6)}`;
  document.head.appendChild(st);
}
function _dlg({ message, title, confirmText, cancelText, cancel }) {
  _ensureDlgStyles();
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'dlg-overlay';
    overlay.innerHTML = `<div class="dlg-card">${title ? `<div class="dlg-title">${esc(title)}</div>` : ''}
      <div class="dlg-msg">${esc(message)}</div>
      <div class="dlg-btns">${cancel ? `<button class="dlg-btn dlg-cancel"></button>` : ''}<button class="dlg-btn dlg-confirm"></button></div></div>`;
    overlay.querySelector('.dlg-confirm').textContent = confirmText;
    const c = overlay.querySelector('.dlg-cancel'); if (c) c.textContent = cancelText;
    const close = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('.dlg-confirm').onclick = () => close(true);
    if (c) c.onclick = () => close(false);
    overlay.onclick = (e) => { if (e.target === overlay) close(false); };
    document.body.appendChild(overlay);
  });
}
function showAlert(message, title) { return _dlg({ message, title, confirmText: tr('common.ok'), cancel: false }); }
function showConfirm(message, title) { return _dlg({ message, title, confirmText: tr('common.confirm'), cancelText: tr('common.cancel'), cancel: true }); }

// Returns a real YouTube URL or null. Never a relative/garbage value, so bad
// campaign data can't send the user to a 404 on our own domain.
function taskUrl(t) {
  if (t.target_video_id && /^[\w-]{11}$/.test(t.target_video_id))
    return 'https://www.youtube.com/watch?v=' + t.target_video_id;
  const u = (t.channel_url || '').trim();
  if (u) {
    if (/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(u)) return u;
    if (/^@[\w.-]+$/.test(u)) return 'https://www.youtube.com/' + u;
    if (/^UC[\w-]{20,}$/.test(u)) return 'https://www.youtube.com/channel/' + u;
    if (/^(www\.)?(youtube\.com|youtu\.be)\//i.test(u)) return 'https://' + u.replace(/^\/+/, '');
  }
  if (t.youtube_channel_id && /^UC[\w-]{10,}$/.test(t.youtube_channel_id))
    return 'https://www.youtube.com/channel/' + t.youtube_channel_id;
  return null;
}

function txText(desc) {
  if (!desc?.startsWith('tx:')) return desc || '';
  const parts = Object.fromEntries(desc.slice(3).split('|').map(p => p.includes(':') ? p.split(':') : ['key', p]));
  const key = desc.slice(3).split('|')[0];
  const type = parts.type ? taskLabel(parts.type) : '';
  switch (key) {
    case 'welcome_bonus': return tr('tx.welcome');
    case 'campaign_created': return tr('tx.created', { type, slots: parts.slots }) + (parts.free ? tr('tx.free') : '');
    case 'task_completed': return tr('tx.completed', { type });
    case 'task_completed_comment': return tr('tx.completedComment', { type });
    case 'campaign_refund':
    case 'campaign_cancelled': return tr('tx.refund');
    case 'coins_reclaimed': return tr('tx.reclaimed', { type });
    case 'purchase': return tr('tx.purchase', { coins: parts.coins, usd: parts.usd });
    default: return desc.slice(3).replace(/\|/g, ' · ');
  }
}

function estimateCost(type, slots, watchMins) {
  const perSlot = type === 'watch' ? tieredWatchCost(watchMins) : (SLOT_COSTS[type] ?? 0);
  return perSlot * (slots || 0);
}

// Price-box HTML: total = per-slot × slots, recomputed live as the user types.
// "Full length" watch campaigns don't know the real duration until the server fetches
// it at creation, so show an "up to" estimate at the cap instead of a false-precise number.
function priceHTML() {
  const slots = parseInt(C.slots, 10) || 0;
  if (C.type === 'watch' && C.fullLength) {
    const per = tieredWatchCost(FULL_LENGTH_CAP_MIN);
    const total = per * slots;
    return tr('grow.priceFullLength', { cost: total, per, cap: FULL_LENGTH_CAP_MIN });
  }
  const mins = parseInt(C.watchMins, 10) || 1;
  const per = estimateCost(C.type, 1, mins);
  const total = per * slots;
  // Pass plain values — t() now HTML-escapes interpolated values, so markup in a
  // value would render as literal tags. (cost/per are integers; nothing to bold.)
  return tr('grow.price', { cost: total, per });
}
function updatePrice() { const el = document.getElementById('pricebox'); if (el) el.innerHTML = priceHTML(); }

// ── data loading ──────────────────────────────────────────────────────────────
async function loadTab(tab) {
  S.tab = tab; setDocTitle(tab); render();
  // Load runtime config ONCE at startup (on ANY tab) so the maintenance banner + the
  // announcement popup work on every screen — not only after visiting Earn/Grow.
  if (!S.config) api.config(window.I18N.getLang()).then(c => { S.config = c; render(); maybeShowAnnouncement(); }).catch(() => {});
  try {
    if (tab === 'earn') { S.tasks = await api.tasks(S.taskFilter); api.config(window.I18N.getLang()).then(c => { S.config = c; render(); }).catch(() => {}); }
    else if (tab === 'grow') { [S.myTasks, S.channels] = await Promise.all([api.myTasks(), api.channels()]); api.config(window.I18N.getLang()).then(c => { S.config = c; render(); }).catch(() => {}); }
    else if (tab === 'wallet') S.txs = (await api.txs(1)).transactions || [];
    else if (tab === 'home') { [S.myTasks, S.txs] = await Promise.all([api.myTasks(), api.txs(1).then(r => r.transactions || [])]); }
    else if (tab === 'referral') S.referral = await api.getReferral().catch(() => null);
    else if (tab === 'admin') { const [st, dash] = await Promise.all([api.adminStatus(), api.adminStats().catch(() => null)]); A.stats = st.stats; A.mode = st.api_mode; A.settings = adminSettingsIn(st.settings); A.dashboard = dash; }
    else if (tab === 'profile') S.user = (await api.me()) || S.user;
    if (tab !== 'profile' && S.token) { api.me().then(d => { S.user = d; render(); }).catch(() => {}); }
  } catch (e) { console.warn('load error', e.message); }
  render();
}

// ── verify flow ───────────────────────────────────────────────────────────────
async function openTask(taskId) {
  // Look the task up by id rather than trusting a blob serialized into the DOM —
  // avoids injecting server data into an inline handler attribute.
  const task = S.tasks.find(t => String(t.id) === String(taskId));
  if (!task) return;
  // Watch tasks play inside the app via the embedded YouTube player (timer bound to
  // real playback). Everything else uses the open-YouTube modal.
  if (task.task_type === 'watch') { openWatchPlayer(task); return; }
  // One /start check in flight at a time — also stops a fast double-tap from stacking
  // multiple bounded reqRetry() chains (api.start retries transient failures up to 4x).
  if (S.openingTaskId) return;
  S.openingTaskId = task.id; render(); // spinner on the tapped card BEFORE the await — no more silent freeze on a slow backend
  // Confirm eligibility server-side BEFORE showing the do-the-action modal: if the target
  // was already earned (stale feed) or the campaign is paused/cancelled/full, bail now so
  // the user never does unpaid work — drop the dead card and refresh the list.
  try {
    await api.start(task.id);
  } catch (e) {
    if (['ALREADY_EARNED', 'ALREADY_COMPLETED', 'CAMPAIGN_FULL', 'CAMPAIGN_PAUSED', 'CAMPAIGN_CANCELLED', 'CAMPAIGN_UNAVAILABLE'].includes(e.code)) {
      S.openingTaskId = null;
      S.tasks = S.tasks.filter(t => t.id !== task.id); render();
      showAlert(e.message || tr('modal.unavailable'));
      api.tasks(S.taskFilter).then(list => { S.tasks = list; render(); }).catch(() => {});
      return;
    }
    // transient/other → proceed; the /verify NOT_STARTED path re-stamps and waits.
  }
  S.openingTaskId = null;
  S.modal = { task, status: 'idle', countdown: 0, startedAt: null, error: '', message: '', help: null };
  render();
  // For like+comment, load what-to-comment help (owner templates + optional AI example).
  if (task.task_type === 'like_comment') {
    api.commentHelp(task.id, window.I18N.getLang()).then(h => {
      if (S.modal && String(S.modal.task.id) === String(task.id)) { S.modal.help = h; render(); }
    }).catch(() => {});
  }
}
function closeModal() { S.modal = null; if (countdownTimer) clearInterval(countdownTimer); render(); }

// ── in-app watch player (web) ───────────────────────────────────────────────
// Self-contained overlay appended to <body> so the app's innerHTML re-renders can't
// destroy the running YouTube iframe. Timer counts ONLY real playing seconds (and
// pauses when the tab is hidden). The server enforces the same watch-time floor.
const WP = { queue: [], idx: 0, watched: 0, required: 60, playing: false, player: null, timer: null, claimed: false, el: null, auto: false, autoCount: 0, claiming: false, nextCheck: 0 };
const WP_PRESENCE_EVERY = 4; // ask "still watching?" every N auto-advanced videos
const WP_INVIDEO_CHECK_SEC = 4 * 60; // ALSO ask "still watching?" every 4 min WITHIN the same video (closes the AFK-autoplay farm hole the tiered watch reward would otherwise open — Economy & Watch Redesign 2026-07-11 §2)
let _ytReady = false, _ytCbs = [];
function loadYT(cb) {
  if (window.YT && window.YT.Player) return cb();
  _ytCbs.push(cb);
  if (!document.getElementById('yt-api')) {
    const s = document.createElement('script'); s.id = 'yt-api'; s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
    window.onYouTubeIframeAPIReady = () => { _ytReady = true; const cbs = _ytCbs.slice(); _ytCbs = []; cbs.forEach(f => f()); };
  }
}
function wpStyles() {
  if (document.getElementById('wp-style')) return;
  const st = document.createElement('style'); st.id = 'wp-style';
  st.textContent = `
  .wp-overlay{position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9998;display:flex;align-items:center;justify-content:center;padding:16px}
  .wp-card{width:100%;max-width:640px;background:var(--card,#14141c);border:1px solid var(--border,#2a2a38);border-radius:18px;overflow:hidden}
  .wp-head{display:flex;align-items:center;gap:10px;padding:12px 14px}
  .wp-close{width:32px;height:32px;border-radius:16px;background:var(--bg,#0b0b12);border:1px solid var(--border,#2a2a38);color:var(--text,#fff);cursor:pointer;font-weight:700}
  .wp-title{flex:1;font-weight:700;color:var(--text,#fff);font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .wp-reward{background:rgba(245,196,81,.15);color:var(--gold,#f5c451);padding:4px 10px;border-radius:10px;font-weight:800;font-size:13px}
  .wp-player{position:relative;width:100%;aspect-ratio:16/9;background:#000}
  .wp-player iframe{width:100%;height:100%}
  .wp-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
  .wp-embed-err{color:var(--text2,#b9b9c6);padding:24px;text-align:center;font-size:14px}
  .wp-body{padding:16px;display:flex;flex-direction:column;gap:10px}
  .wp-queue-note{font-size:12px;color:var(--text2,#b9b9c6);text-align:center;margin-top:-4px;min-height:14px}
  .wp-track{height:10px;border-radius:99px;background:var(--bg,#0b0b12);overflow:hidden;border:1px solid var(--border,#2a2a38)}
  .wp-fill{height:100%;width:0;background:var(--primary,#6C63FF);transition:width .3s}
  .wp-time{font-size:13px;color:var(--text2,#b9b9c6);text-align:center;font-weight:600}
  .wp-status{font-size:16px;font-weight:800;color:var(--text,#fff);text-align:center}
  .wp-primary{padding:14px;border-radius:12px;border:none;background:var(--primary,#6C63FF);color:#fff;font-weight:800;font-size:15px;cursor:pointer}
  .wp-primary:disabled{opacity:.5;cursor:default}
  .wp-skip{padding:8px;background:none;border:none;color:var(--text2,#b9b9c6);font-weight:600;font-size:13px;cursor:pointer}
  .wp-auto{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:8px 4px;background:none;border:none;color:var(--text,#fff);font-weight:700;font-size:14px;cursor:pointer}
  .wp-toggle{width:46px;height:28px;border-radius:14px;background:var(--bg,#0b0b12);border:1px solid var(--border,#2a2a38);display:flex;align-items:center;padding:0 3px;flex-shrink:0;transition:background .15s}
  .wp-toggle-knob{width:20px;height:20px;border-radius:10px;background:#fff;transition:margin-left .15s}
  .wp-auto.wp-on .wp-toggle{background:var(--primary,#6C63FF);border-color:var(--primary,#6C63FF)}
  .wp-auto.wp-on .wp-toggle-knob{margin-left:auto}
  .wp-sw{position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px}
  .wp-sw-card{width:100%;max-width:360px;background:var(--card,#14141c);border:1px solid var(--border,#2a2a38);border-radius:20px;padding:24px;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center}
  .wp-sw-title{font-size:18px;font-weight:800;color:var(--text,#fff)}
  .wp-sw-msg{font-size:14px;color:var(--text2,#b9b9c6);line-height:1.5}
  .wp-sw-btn{margin-top:6px;padding:12px 20px;border:none;border-radius:12px;background:var(--primary,#6C63FF);color:#fff;font-weight:800;font-size:14px;cursor:pointer;width:100%}`;
  document.head.appendChild(st);
}
function wpCurrent() { return WP.queue[WP.idx] || null; }
function wpMMSS(s) { return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
async function openWatchPlayer(task) {
  if (WP.opening) return;           // guard against a double-tap race during the await
  WP.opening = true;
  wpStyles();
  // Render the overlay (with a spinner over the player area) SYNCHRONOUSLY, before any
  // network call — previously this awaited api.tasks('watch') first, so a slow backend
  // meant a blank screen after the tap. The tapped task always plays; the extra queue
  // (for auto-advance/skip) is merged in below once it loads, in the background.
  WP.queue = [task];
  WP.idx = 0;
  if (!WP.el) {
    const el = document.createElement('div'); el.className = 'wp-overlay';
    el.innerHTML = `<div class="wp-card"><div class="wp-head"><button class="wp-close">✕</button><div class="wp-title"></div><div class="wp-reward"></div></div>
      <div class="wp-player"><div id="wp-yt"></div><div class="wp-loading"><div class="spinner"></div></div></div>
      <div class="wp-body"><div class="wp-track"><div class="wp-fill"></div></div><div class="wp-time"></div><div class="wp-status"></div><div class="wp-queue-note"></div>
      <button class="wp-primary"></button><button class="wp-skip"></button><button class="wp-auto"><span class="wp-auto-label"></span><span class="wp-toggle"><span class="wp-toggle-knob"></span></span></button></div></div>`;
    document.body.appendChild(el); WP.el = el;
    el.querySelector('.wp-close').onclick = wpClose;
    el.querySelector('.wp-primary').onclick = () => { if (WP.claimed) wpNext(); else wpClaim(); };
    el.querySelector('.wp-skip').onclick = wpNext;
    el.querySelector('.wp-auto').onclick = () => {
      WP.auto = !WP.auto; wpUpdate();
      if (WP.auto && WP.watched >= WP.required && !WP.claimed && !WP.claiming) wpClaim();
    };
  }
  wpLoad(); // starts the tapped video right away — never blocked by the queue fetch below
  // Load the rest of the watchable queue in the background. On success, merge it in so
  // skip/auto-advance can reach it; on failure, leave the single-task queue as-is (an
  // "empty" queue is a perfectly valid state) and surface a small inline notice instead
  // of failing silently.
  try {
    const list = await api.tasks('watch');
    // Guard against a stale response: skip the merge if the overlay was closed, or the
    // user already skipped past this task, while the fetch was in flight.
    if (WP.el && wpCurrent() && wpCurrent().id === task.id) {
      const extra = (list || []).filter(x => !x.already_completed && x.id !== task.id);
      WP.queue = [task, ...extra];
      wpUpdate();
    }
  } catch (_) {
    const note = WP.el && WP.el.querySelector('.wp-queue-note');
    if (note) note.textContent = tr('common.requestFailed');
  }
  WP.opening = false;
}
async function wpLoad() {
  const t = wpCurrent(); if (!t) return wpClose();
  WP.watched = 0; WP.claimed = false; WP.playing = false;
  WP.nextCheck = WP_INVIDEO_CHECK_SEC; // reset the in-video presence-check clock per video
  if (WP.timer) { clearInterval(WP.timer); WP.timer = null; }
  WP.required = Math.max(1, (parseInt(t.watch_minutes, 10) || 1) * 60);
  // Confirm eligibility before playing — don't make the user watch a video they can't be
  // paid for (already earned / campaign gone); skip to the next task on a terminal reject.
  try {
    await api.start(t.id);
  } catch (e) {
    if (['ALREADY_EARNED', 'ALREADY_COMPLETED', 'CAMPAIGN_FULL', 'CAMPAIGN_PAUSED', 'CAMPAIGN_CANCELLED', 'CAMPAIGN_UNAVAILABLE'].includes(e.code)) {
      showAlert(e.message || tr('modal.unavailable'));
      return wpNext();
    }
    // transient/other → proceed; /verify NOT_STARTED re-stamps and waits.
  }
  if (!WP.el) return; // player was closed during the await
  // Reset the primary button back to the claim/next delegate — a previous video's
  // embed-error handler may have hijacked it to "open on YouTube".
  WP.el.querySelector('.wp-primary').onclick = () => { if (WP.claimed) wpNext(); else wpClaim(); };
  WP.el.querySelector('.wp-title').textContent = t.channel_name || t.owner_name || '';
  WP.el.querySelector('.wp-reward').textContent = '+' + t.reward + ' 🪙';
  WP.el.querySelector('.wp-player').innerHTML = '<div id="wp-yt"></div>';
  loadYT(() => {
    if (!WP.el) return;
    WP.player = new YT.Player('wp-yt', {
      videoId: t.target_video_id,
      playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1 },
      events: {
        onStateChange: (e) => wpSetPlaying(e.data === 1), // 1 = PLAYING
        onError: () => wpEmbedError(),
      },
    });
  });
  wpUpdate();
}
function wpSetPlaying(p) {
  WP.playing = p;
  if (p && !WP.timer && !WP.claimed) {
    WP.timer = setInterval(() => {
      if (document.hidden) return;
      WP.watched = Math.min(WP.required, WP.watched + 1);
      if (WP.watched >= WP.required) {
        if (WP.timer) { clearInterval(WP.timer); WP.timer = null; }
        wpUpdate();
        return;
      }
      // In-video presence check: every WP_INVIDEO_CHECK_SEC of watched time WITHIN the
      // same video, pause and require a tap — independent of the cross-video check below.
      if (WP.watched >= WP.nextCheck) { wpInVideoPresenceCheck(); return; }
      wpUpdate();
    }, 1000);
  } else if (!p && WP.timer) { clearInterval(WP.timer); WP.timer = null; }
  wpUpdate();
}
function wpUpdate() {
  if (!WP.el) return;
  const done = WP.watched >= WP.required;
  WP.el.querySelector('.wp-fill').style.width = Math.min(100, Math.round(WP.watched / WP.required * 100)) + '%';
  WP.el.querySelector('.wp-time').textContent = wpMMSS(WP.watched) + ' / ' + wpMMSS(WP.required);
  WP.el.querySelector('.wp-status').textContent = WP.claimed ? tr('watch.claimed') : done ? tr('watch.done') : WP.playing ? tr('watch.keepWatching') : tr('watch.paused');
  const primary = WP.el.querySelector('.wp-primary');
  if (WP.claimed) { primary.textContent = WP.idx < WP.queue.length - 1 ? tr('watch.nextVideo') : tr('watch.finish'); primary.disabled = false; }
  else { primary.textContent = done ? tr('watch.claim') : tr('watch.watchMore', { s: Math.max(0, WP.required - WP.watched) }); primary.disabled = !done; }
  const skip = WP.el.querySelector('.wp-skip');
  skip.style.display = (WP.queue.length > 1 && !WP.claimed) ? 'block' : 'none';
  skip.textContent = tr('watch.skipToNext');
  const auto = WP.el.querySelector('.wp-auto');
  if (auto) { const lbl = auto.querySelector('.wp-auto-label'); if (lbl) lbl.textContent = tr('watch.autoplay'); auto.classList.toggle('wp-on', WP.auto); auto.style.display = WP.claimed ? 'none' : 'flex'; }
  // Auto-claim the instant the full required watch time is reached.
  if (WP.auto && done && !WP.claimed && !WP.claiming) wpClaim();
}
async function wpClaim() {
  const t = wpCurrent(); if (!t || WP.watched < WP.required || WP.claimed || WP.claiming) return;
  WP.claiming = true;
  try {
    const res = await api.verify(t.id, null);
    WP.claimed = true; WP.claiming = false;
    api.me().then(d => { S.user = d; }).catch(() => {});
    S.tasks = (S.tasks || []).filter(x => x.id !== t.id);
    wpUpdate();
    if (WP.auto) {
      WP.autoCount++;
      if (WP.autoCount >= WP_PRESENCE_EVERY) wpStillWatching();          // periodic presence check
      else setTimeout(() => { if (WP.el && WP.auto) wpNext(); }, 1500);  // auto-advance
    } else {
      showAlert(tr('watch.claimedMsg', { coins: res.total_coins ?? res.coins_earned ?? t.reward }), tr('watch.claimedTitle'));
    }
  } catch (e) {
    WP.claiming = false;
    // Turn auto-play OFF on a failed claim so the auto-claim trigger in wpUpdate()
    // can't hammer in a tight loop while offline. Coins aren't lost — the button
    // stays available to retry manually.
    if (WP.auto) { WP.auto = false; wpUpdate(); }
    const code = e.code;
    if (code === 'WATCH_DAILY_LIMIT') showAlert(tr('earn.typeLimitMessage'), tr('earn.typeLimitTitle'));
    else if (code === 'WATCH_TOO_SOON') showAlert(e.data?.remaining ? tr('modal.waitMore', { s: e.data.remaining }) : (e.message || tr('common.requestFailed')));
    else if (code === 'ALREADY_EARNED' || code === 'ALREADY_COMPLETED') { WP.claimed = true; showAlert(e.message || tr('modal.unavailable')); }
    else showAlert(e.message || tr('common.requestFailed'));
  }
}
// Shared "Still watching?" tap-to-continue overlay — used both by the cross-video
// (every WP_PRESENCE_EVERY auto-advanced videos) and the in-video (every
// WP_INVIDEO_CHECK_SEC seconds within the SAME video) presence checks.
function wpPresenceOverlay(onContinue) {
  wpStyles();
  const old = document.getElementById('wp-sw'); if (old) old.remove(); // no stacked dupes
  const ov = document.createElement('div'); ov.className = 'wp-sw'; ov.id = 'wp-sw';
  ov.innerHTML = `<div class="wp-sw-card"><div style="font-size:40px">👀</div><div class="wp-sw-title"></div><div class="wp-sw-msg"></div><button class="wp-sw-btn"></button></div>`;
  ov.querySelector('.wp-sw-title').textContent = tr('watch.stillTitle');
  ov.querySelector('.wp-sw-msg').textContent = tr('watch.stillMsg');
  const btn = ov.querySelector('.wp-sw-btn'); btn.textContent = tr('watch.continue');
  btn.onclick = () => { ov.remove(); onContinue(); };
  document.body.appendChild(ov);
}
function wpStillWatching() {
  wpPresenceOverlay(() => { WP.autoCount = 0; if (WP.el) wpNext(); });
}
// In-video presence check (NEW — closes the AFK-autoplay hole the tiered watch reward
// would otherwise open): pause the SAME video and require a tap to resume, every
// WP_INVIDEO_CHECK_SEC of watched time. Directly stops the counting timer (rather than
// waiting on the async YT onStateChange round-trip) so no extra seconds sneak in while
// the overlay is up; tapping "continue" resumes playback and the existing onStateChange
// handler (wpSetPlaying) restarts the timer on its own.
function wpInVideoPresenceCheck() {
  WP.playing = false;
  if (WP.timer) { clearInterval(WP.timer); WP.timer = null; }
  try { WP.player && WP.player.pauseVideo && WP.player.pauseVideo(); } catch (_) {}
  wpUpdate();
  wpPresenceOverlay(() => {
    WP.nextCheck += WP_INVIDEO_CHECK_SEC;
    try { WP.player && WP.player.playVideo && WP.player.playVideo(); } catch (_) {}
  });
}
function wpNext() {
  if (WP.idx < WP.queue.length - 1) { WP.idx++; wpLoad(); return; }
  // Ran out of watchable queue. In autoplay this used to end silently — now stop
  // cleanly and tell the user why (no more tasks / possibly today's cap), instead of
  // just closing the player with no explanation.
  const wasAuto = WP.auto;
  wpClose();
  if (wasAuto) showAlert(tr('watch.queueEndMsg'), tr('watch.queueEndTitle'));
}
function wpEmbedError() {
  if (!WP.el) return;
  if (WP.timer) { clearInterval(WP.timer); WP.timer = null; }
  WP.el.querySelector('.wp-player').innerHTML = `<div class="wp-embed-err">${esc(tr('watch.embedMsg'))}</div>`;
  const primary = WP.el.querySelector('.wp-primary');
  primary.textContent = tr('watch.openYoutube'); primary.disabled = false;
  primary.onclick = () => { const t = wpCurrent(); if (t) window.open('https://www.youtube.com/watch?v=' + t.target_video_id, '_blank', 'noopener'); };
  // Always offer a way out of an un-embeddable video.
  const skip = WP.el.querySelector('.wp-skip');
  skip.style.display = 'block';
  skip.textContent = WP.idx < WP.queue.length - 1 ? tr('watch.skipToNext') : tr('watch.finish');
}
function wpClose() {
  if (WP.timer) { clearInterval(WP.timer); WP.timer = null; }
  if (WP.player && WP.player.destroy) { try { WP.player.destroy(); } catch (_) {} }
  WP.player = null;
  const sw = document.getElementById('wp-sw'); if (sw) sw.remove();
  WP.claiming = false; WP.autoCount = 0;
  if (WP.el) { WP.el.remove(); WP.el = null; }
  loadTab('earn');
}

function modalOpenYouTube() {
  const m = S.modal; if (!m) return;
  const url = taskUrl(m.task);
  if (!url) { m.error = tr('modal.invalidLink'); render(); return; }
  window.open(url, '_blank', 'noopener');
  if (m.status === 'idle') {
    api.start(m.task.id).catch(() => {}); // re-stamp the real start time (eligibility already gated in openTask)
    m.startedAt = Date.now();        // kept as fallback for the delay UI
    m.status = 'countdown'; m.countdown = COMPLETION_DELAY;
    countdownTimer = setInterval(() => {
      if (!S.modal) return clearInterval(countdownTimer);
      S.modal.countdown--;
      if (S.modal.countdown <= 0) { clearInterval(countdownTimer); S.modal.status = 'ready'; }
      render();
    }, 1000);
  }
  render();
}

async function modalVerify() {
  const m = S.modal; if (!m || m.status === 'verifying' || m.status === 'done') return;
  m.status = 'verifying'; m.error = ''; render();
  try {
    const res = await api.verify(m.task.id, m.startedAt);
    m.status = 'done';
    m.message = res.message || `+${res.total_coins ?? res.coins_earned} coins`;
    api.me().then(d => { S.user = d; render(); }).catch(() => {});
    S.tasks = S.tasks.filter(t => t.id !== m.task.id);
    // Refetch the feed so any sibling task on the SAME target (e.g. a like_comment on a
    // video whose like we just earned) is filtered out server-side and can't be done for
    // free from a now-stale list.
    api.tasks(S.taskFilter).then(list => { S.tasks = list; render(); }).catch(() => {});
  } catch (e) {
    const code = e.data?.code;
    if (code === 'NOT_STARTED') {
      // Server hadn't stamped a start yet — it has now. Restart the wait instead of
      // showing a raw error; the user can claim once the delay elapses.
      m.startedAt = Date.now();
      m.status = 'countdown';
      m.countdown = e.data.remaining || COMPLETION_DELAY;
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = setInterval(() => {
        if (!S.modal) return clearInterval(countdownTimer);
        S.modal.countdown--;
        if (S.modal.countdown <= 0) { clearInterval(countdownTimer); S.modal.status = 'ready'; }
        render();
      }, 1000);
      m.error = tr('modal.waitMore', { s: m.countdown });
    } else if (['ALREADY_EARNED', 'ALREADY_COMPLETED', 'CAMPAIGN_FULL', 'CAMPAIGN_PAUSED', 'CAMPAIGN_CANCELLED', 'CAMPAIGN_UNAVAILABLE'].includes(code)) {
      // No longer claimable — drop it from the feed and close out cleanly.
      S.tasks = S.tasks.filter(t => t.id !== m.task.id);
      m.status = 'done';
      m.message = e.message || tr('modal.unavailable');
    } else if (code === 'COMMENT_TOO_SHORT') {
      m.status = 'ready';
      m.error = tr('earn.commentTooShortMessage', { min: e.data?.min_words || 5 });
    } else if (code === 'TYPE_DAILY_LIMIT' || code === 'TASK_TYPE_DISABLED') {
      S.tasks = S.tasks.filter(t => t.id !== m.task.id);
      m.status = 'done';
      m.message = e.message;
    } else if (code === 'NO_CHANNEL' || code === 'COMMENTS_DISABLED') {
      m.status = 'ready';
      m.error = e.message; // server sends a clear, specific message
    } else {
      m.status = 'ready';
      m.error = e.data?.remaining ? tr('modal.waitMore', { s: e.data.remaining }) : e.message;
    }
  }
  render();
}

// ── create campaign ───────────────────────────────────────────────────────────
const C = { type: 'subscribe', slots: '', videoUrl: '', watchMins: '1', fullLength: false, creating: false, error: '', ok: '', channelId: null, newChannelUrl: '', addingChannel: false, exampleIds: [] };
// "Full length" toggle for watch campaigns — required minutes become ceil(video
// length/60) capped at FULL_LENGTH_CAP_MIN, computed server-side at creation.
function toggleFullLength() { C.fullLength = !C.fullLength; render(); }
function toggleCExample(id) {
  const i = C.exampleIds.indexOf(id);
  if (i >= 0) C.exampleIds.splice(i, 1);
  else if (C.exampleIds.length < 3) C.exampleIds.push(id);
  render();
}

async function addChannelWeb() {
  const url = (C.newChannelUrl || '').trim();
  C.error = ''; C.ok = '';
  if (!url) { C.error = tr('grow.errChannelUrl'); return render(); }
  C.addingChannel = true; render();
  try {
    const ch = await api.addChannel(url);
    S.channels = await api.channels();
    C.channelId = ch.id;            // auto-select the channel just added
    C.newChannelUrl = '';
    C.ok = `${tr('grow.channelAdded')} ${ch.channel_name}`;
  } catch (e) { C.error = e.message; }
  C.addingChannel = false; render();
}

async function createCampaign() {
  C.error = ''; C.ok = '';
  const slots = parseInt(C.slots, 10);
  if (!slots || slots < 1) { C.error = tr('grow.errSlots'); return render(); }
  const needsVideo = C.type !== 'subscribe';
  if (needsVideo && !C.videoUrl.trim()) { C.error = tr('grow.errVideo'); return render(); }
  const needsChannel = ['subscribe', 'subscribe_like'].includes(C.type);
  const channel = S.channels.find(c => String(c.id) === String(C.channelId)) || S.channels[0];
  if (needsChannel && !channel) { C.error = tr('grow.errChannel'); return render(); }

  C.creating = true; render();
  try {
    const res = await api.createTask({
      channel_id: needsChannel ? channel.id : undefined,
      task_type: C.type,
      subscribers_wanted: slots,
      target_video_url: needsVideo ? C.videoUrl.trim() : undefined,
      watch_minutes: (C.type === 'watch' && !C.fullLength) ? (parseInt(C.watchMins, 10) || 1) : undefined,
      full_length: (C.type === 'watch' && C.fullLength) ? true : undefined,
      comment_example_ids: C.type === 'like_comment' ? C.exampleIds : undefined,
    });
    C.ok = res.owner ? tr('grow.createdFree') : tr('grow.created', { coins: res.coins_spent });
    C.slots = ''; C.videoUrl = ''; C.exampleIds = []; C.fullLength = false;
    [S.myTasks, S.user] = [await api.myTasks(), await api.me()];
  } catch (e) { C.error = e.message; }
  C.creating = false; render();
}

async function campaignAction(id, action) {
  if (action === 'cancel' && !(await showConfirm(tr('grow.cancelConfirm')))) return;
  try {
    if (action === 'pause') await api.pause(id);
    else if (action === 'resume') await api.resume(id);
    else await api.cancel(id);
    S.myTasks = await api.myTasks();
    api.me().then(d => { S.user = d; render(); }).catch(() => {});
  } catch (e) { showAlert(e.message); }
  render();
}

async function deleteAccount() {
  if (!(await showConfirm(tr('profile.deleteConfirm')))) return;
  try { await api.deleteAccount(); signOut(); } catch (e) { showAlert(e.message); }
}

// ── buy coins ─────────────────────────────────────────────────────────────────
async function buyCoins(usd) {
  if (B.busy) return;
  B.error = ''; B.busy = usd; render();
  // Open the tab synchronously inside the click gesture so it isn't popup-blocked;
  // we point it at the hosted checkout once the invoice is created.
  const win = window.open('about:blank', '_blank');
  if (win) { try { win.document.write('<p style="font:16px sans-serif;padding:24px">Opening secure checkout…</p>'); } catch (_) {} }
  try {
    const res = await api.buyCoins(usd);
    if (res && res.invoice_url) {
      if (win) win.location.href = res.invoice_url;       // checkout opens in the new tab
      else window.location.href = res.invoice_url;        // popup blocked → fall back to this tab
      B.busy = 0;
      if (win) loadTab('wallet');                         // keep this tab on the wallet
      return;
    }
    if (win) win.close();
    B.error = tr('buy.noInvoice');
  } catch (e) { if (win) win.close(); B.error = e.message; }
  B.busy = 0; render();
}

// Live coins+bonus readout for the custom-amount field — recomputed on each
// keystroke without a full re-render, so the input keeps focus.
function customCoinsHTML(usd) {
  const p = pkgInfo(usd);
  return `🪙 <b style="color:var(--gold);font-size:18px">${p.total.toLocaleString()}</b> ${tr('buy.coins')}`
    + (p.bonusPct ? ` <span style="color:var(--success)">(+${p.bonusPct}% ${tr('buy.bonus')})</span>` : '');
}
function updateCustomBuy() {
  const inp = document.getElementById('custom-usd'); if (!inp) return;
  B.customUsd = inp.value;
  const usd = parseInt(inp.value, 10) || 0;
  const valid = usd >= 20;
  const out = document.getElementById('custom-coins');
  const btn = document.getElementById('custom-buy-btn');
  if (out) out.innerHTML = valid ? customCoinsHTML(usd) : `<span class="hint">${tr('buy.min')}</span>`;
  if (btn) btn.disabled = valid && !B.busy ? false : true;
}
function buyCoinsCustom() {
  const usd = parseInt(B.customUsd, 10) || 0;
  if (usd < 20) { B.error = tr('buy.min'); return render(); }
  buyCoins(usd);
}

// ── admin ───────────────────────────────────────────────────────────────────
function gotoAdmin() { loadTab('admin'); }

function adminToggleType(type) {
  const cur = Array.isArray(A.settings.disabled_task_types) ? A.settings.disabled_task_types : [];
  A.settings.disabled_task_types = cur.includes(type) ? cur.filter(x => x !== type) : [...cur, type];
  adminSave(); // persist immediately for instant effect
}
async function adminSave() {
  A.msg = ''; A.err = ''; A.saving = true; render();
  try {
    const payload = {};
    ADMIN_FIELDS.forEach(([k]) => { if (A.settings[k] !== '' && A.settings[k] != null) payload[k] = k === 'margin_pct' ? parseFloat(A.settings[k]) / 100 : parseInt(A.settings[k], 10); });
    if (Array.isArray(A.settings.disabled_task_types)) payload.disabled_task_types = A.settings.disabled_task_types;
    if (A.settings.daily_cap_by_type && typeof A.settings.daily_cap_by_type === 'object') payload.daily_cap_by_type = A.settings.daily_cap_by_type;
    if (typeof A.settings.maintenance_message === 'string') payload.maintenance_message = A.settings.maintenance_message;
    if (typeof A.settings.announcement_message === 'string') payload.announcement_message = A.settings.announcement_message;
    if (typeof A.settings.announcement_link === 'string') payload.announcement_link = A.settings.announcement_link;
    if (A.settings.announcement_platform) payload.announcement_platform = A.settings.announcement_platform;
    const res = await api.adminSaveSettings(payload);
    A.settings = adminSettingsIn(res.settings);
    A.msg = 'Settings saved.';
  } catch (e) { A.err = e.message; }
  A.saving = false; render();
}

async function adminSetMode(mode) {
  A.msg = ''; A.err = '';
  try { await api.adminMode(mode); A.mode = mode; A.msg = `Mode set to ${mode}.`; }
  catch (e) { A.err = e.message; }
  render();
}

async function adminSearchUsers() {
  A.userErr = '';
  try { A.users = (await api.adminUsers({ email: A.userQuery.trim() })).users || []; }
  catch (e) { A.userErr = e.message; }
  render();
}
async function adminTopCreators() {
  A.userErr = '';
  try { A.users = (await api.adminUsers({ sort: 'subs' })).users || []; }
  catch (e) { A.userErr = e.message; }
  render();
}

async function adminBanUser(email, unban) {
  if (!unban && !(await showConfirm(`Ban ${email}?`))) return;
  try { await api.adminBan(email, unban); await adminSearchUsers(); } catch (e) { showAlert(e.message); }
}
async function adminPromoteUser(email, role) {
  try { await api.adminPromote(email, role); await adminSearchUsers(); } catch (e) { showAlert(e.message); }
}

// ── views ─────────────────────────────────────────────────────────────────────
function vLogin() {
  return `
  <div class="center">
    <img class="logo" src="logo.png" alt="SubsShare" width="76" height="76" style="border-radius:18px">
    <h1 style="font-size:28px">SubsShare</h1>
    <p style="color:var(--text2);margin:10px 0 30px;line-height:1.5">${tr('login.tagline')}</p>
    <input id="ref-code" type="text" maxlength="12" placeholder="${tr('login.referralPlaceholder')}" value="${esc(S.referralCode || '')}"
      style="text-transform:uppercase;text-align:center;letter-spacing:2px;max-width:280px;margin:0 auto 12px;display:block">
    <button class="gbtn" data-act="signIn" ${S.busy ? 'disabled' : ''}>
      <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>
      ${S.busy ? tr('login.signingIn') : tr('login.continue')}
    </button>
    <p class="hint" style="margin-top:14px">${tr('login.disclaimer')}<br>
      <a href="https://viralboostnow.com/privacy.html" target="_blank" rel="noopener">${tr('common.privacy')}</a> ·
      <a href="https://viralboostnow.com/terms.html" target="_blank" rel="noopener">${tr('common.terms')}</a></p>
    ${S.loginError ? `<p class="error">${esc(S.loginError)}</p>` : ''}
  </div>`;
}

function vHeader(title) {
  return `<div class="header"><h1>${title}</h1><span class="coins">🪙 ${S.user?.coins ?? '…'}</span></div>`;
}

function vEarn() {
  const chips = [null, ...TASK_TYPES].map(t =>
    `<button class="chip ${S.taskFilter === t ? 'active' : ''}" data-act="setFilter"${t ? ` data-a="${t}"` : ''}>${t ? taskLabel(t) : tr('earn.all')}</button>`
  ).join('');
  const list = S.tasks.length ? S.tasks.map(t => {
    const opening = S.openingTaskId === t.id;
    // While ANY card's /start check is in flight, dim the others so a second tap can't
    // stack another retry chain (openTask() also guards this in JS) — only the tapped
    // card gets the spinner.
    const blocked = !!S.openingTaskId && !opening;
    return `
    <div class="card task${opening ? ' opening' : ''}"${blocked ? ' style="opacity:.5;pointer-events:none"' : ''} data-act="openTask" data-a="${esc(String(t.id))}">
      <div class="avatar">${t.owner_avatar ? `<img src="${esc(t.owner_avatar)}" alt="" referrerpolicy="no-referrer">` : (TASK_ICON[t.task_type] || '📺')}</div>
      <div class="info">
        <div class="name">${esc(t.channel_name || t.owner_name)}</div>
        <div class="meta">${taskLabel(t.task_type)}${t.task_type === 'watch' ? ` · ${esc(t.watch_minutes)} ${tr('earn.min')}` : ''}</div>
      </div>
      ${opening ? '<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0"></div>' : `<div class="reward">+${t.reward} 🪙</div>`}
    </div>`;
  }).join('')
    : `<div class="empty">${tr('earn.none')}<br>${tr('earn.checkBack')}</div>`;
  return vHeader(tr('earn.title')) + `<div class="screen"><div class="chips">${chips}</div>${list}</div>`;
}

// What-to-comment block for a like+comment task: owner-selected curated templates
// (rendered from the viewer's locale) + an optional AI example for this video.
function vCommentHelp(help) {
  const min = (help && help.min_words) || 5;
  const arr = window.I18N.t('earn.commentExamples');
  const examples = Array.isArray(arr) ? arr : [];
  const ai = (help && help.ai_example)
    ? `<div style="background:rgba(108,99,255,.12);border-radius:8px;padding:8px;margin-bottom:6px"><div style="font-size:11px;font-weight:700;color:var(--primary,#6C63FF)">${esc(tr('earn.commentAiSuggestion'))}</div><div style="font-style:italic;font-size:13px">“${esc(help.ai_example)}”</div></div>`
    : '';
  const ids = (help && Array.isArray(help.template_ids)) ? help.template_ids : [];
  const items = ids.map(id => examples[id] ? `<div style="font-size:13px;color:var(--text2,#b9b9c6)">• ${esc(examples[id])}</div>` : '').join('');
  return `<div style="background:var(--card,#14141c);border:1px solid var(--border,#2a2a38);border-radius:10px;padding:10px;margin:8px 0;text-align:left">
    <div style="font-weight:800;font-size:13px">${esc(tr('earn.commentExamplesTitle'))}</div>
    <div style="font-size:12px;color:var(--text2,#b9b9c6);margin-bottom:6px">${esc(tr('earn.commentExamplesHint', { min }))}</div>
    ${ai}${items}
  </div>`;
}

function vModal() {
  const m = S.modal; if (!m) return '';
  const t = m.task;
  let action;
  if (m.status === 'done') {
    action = `<p class="success-text">${esc(m.message)}</p><button class="btn" style="margin-top:12px" data-act="closeModal">${tr('modal.done')}</button>`;
  } else {
    const label = m.status === 'verifying' ? tr('modal.verifying')
      : m.status === 'countdown' ? tr('modal.verifyIn', { s: m.countdown })
      : tr('modal.verify');
    action = `
      <button class="btn secondary" data-act="modalOpenYouTube">${tr('modal.open')}</button>
      ${m.status === 'countdown' ? `<div class="countdown">${m.countdown}s</div>` : ''}
      <button class="btn" style="margin-top:10px" data-act="modalVerify" ${m.status === 'ready' ? '' : 'disabled'}>${label}</button>
      ${m.status === 'idle' ? `<p class="hint" style="text-align:center">${tr('modal.openFirst')}</p>` : ''}
      ${m.error ? `<p class="error">${esc(m.error)}</p>` : ''}`;
  }
  return `
  <div class="modal-backdrop" data-act="modalBackdrop">
    <div class="modal">
      <h2>${TASK_ICON[t.task_type] || ''} ${taskLabel(t.task_type)} — +${t.reward} 🪙</h2>
      <div class="meta" style="color:var(--text2);font-size:13px">${esc(t.channel_name || t.owner_name)}</div>
      <div class="steps">${tr('steps.' + t.task_type, { min: t.watch_minutes })}</div>
      ${t.task_type === 'like_comment' && m.status !== 'done' ? vCommentHelp(m.help) : ''}
      ${m.status !== 'done' ? `<div style="font-size:12px;color:var(--gold);background:rgba(245,196,81,0.1);border-radius:10px;padding:10px;margin:10px 0;text-align:left;line-height:1.5">${tr('modal.clawbackWarning')}</div>` : ''}
      ${action}
    </div>
  </div>`;
}

function vGrow() {
  const needsVideo = C.type !== 'subscribe';
  const needsChannel = ['subscribe', 'subscribe_like'].includes(C.type);
  const disabled = (S.config && Array.isArray(S.config.disabled_task_types)) ? S.config.disabled_task_types : [];
  if (disabled.includes(C.type)) { const alt = TASK_TYPES.find(t => !disabled.includes(t)); if (alt) C.type = alt; }
  const chips = TASK_TYPES.filter(t => !disabled.includes(t)).map(t =>
    `<button class="chip ${C.type === t ? 'active' : ''}" data-act="setCType" data-a="${t}">${TASK_ICON[t]} ${taskLabel(t)}</button>`).join('');
  const myList = S.myTasks.length ? S.myTasks.map(t => `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <b>${TASK_ICON[t.task_type] || ''} ${taskLabel(t.task_type)}</b>
        <span class="badge ${esc(t.status)}">${esc(tr('status.' + t.status))}</span>
      </div>
      <div class="hint">${t.completions_count}/${t.total_slots} ${tr('grow.done')} · ${t.progress_pct}%</div>
      <div style="display:flex;gap:8px;margin-top:10px">
        ${t.can_pause ? `<button class="btn small secondary" data-act="campaignAction" data-a="${t.id}" data-b="pause">${tr('grow.pause')}</button>` : ''}
        ${t.can_resume ? `<button class="btn small secondary" data-act="campaignAction" data-a="${t.id}" data-b="resume">${tr('grow.resume')}</button>` : ''}
        ${t.can_cancel ? `<button class="btn small danger-outline" data-act="campaignAction" data-a="${t.id}" data-b="cancel">${tr('grow.cancel')}</button>` : ''}
      </div>
    </div>`).join('') : `<div class="empty">${tr('grow.none')}</div>`;
  return vHeader(tr('grow.title')) + `
  <div class="screen">
    <div class="label">${tr('grow.type')}</div>
    <div class="chips">${chips}</div>
    ${needsChannel ? `<div class="label">${tr('grow.channelLabel')}</div>
      ${S.channels.length ? `<select data-model="C.channelId" data-on="render" style="width:100%">${S.channels.map(c => `<option value="${esc(String(c.id))}" ${String(C.channelId) === String(c.id) ? 'selected' : ''}>${esc(c.channel_name)}${c.subscriber_count != null ? ' · ' + c.subscriber_count + ' subs' : ''}</option>`).join('')}</select>` : `<p class="hint">${tr('grow.noChannelYet')}</p>`}
      <div style="display:flex;gap:8px;margin-top:8px">
        <input type="text" placeholder="youtube.com/@handle" value="${esc(C.newChannelUrl)}" data-model="C.newChannelUrl" style="flex:1">
        <button class="btn small secondary" style="white-space:nowrap" data-act="addChannelWeb" ${C.addingChannel ? 'disabled' : ''}>${C.addingChannel ? tr('grow.adding') : '+ ' + tr('grow.addChannel')}</button>
      </div>` : ''}
    ${needsVideo ? `<div class="label">${tr('grow.videoUrl')}</div>
      <input id="c-video" type="url" placeholder="https://youtube.com/watch?v=…" value="${esc(C.videoUrl)}" data-model="C.videoUrl">` : ''}
    ${C.type === 'like_comment' ? `<div class="label">${esc(tr('earn.pickCommentExamples'))}</div>
      <div style="display:flex;flex-direction:column;gap:6px">${(Array.isArray(window.I18N.t('earn.commentExamples')) ? window.I18N.t('earn.commentExamples') : []).map((s, id) => `<button type="button" class="chip ${C.exampleIds.includes(id) ? 'active' : ''}" style="text-align:left;white-space:normal" data-act="toggleCExample" data-a="${id}">${C.exampleIds.includes(id) ? '✓ ' : ''}${esc(s)}</button>`).join('')}</div>` : ''}
    ${C.type === 'watch' ? `<div class="label">${tr('grow.minutes')}</div>
      <input id="c-mins" type="number" min="1" max="60" value="${esc(C.watchMins)}" data-model="C.watchMins" data-on="updatePrice" ${C.fullLength ? 'disabled' : ''}>
      <button type="button" class="chip ${C.fullLength ? 'active' : ''}" style="margin-top:8px" data-act="toggleFullLength">${C.fullLength ? '✅' : '☐'} ${tr('grow.fullLength')}</button>
      <p class="hint" style="margin-top:4px">${tr('grow.fullLengthHint', { cap: FULL_LENGTH_CAP_MIN })}</p>
      <p class="hint" style="margin-top:6px;line-height:1.5">${tr('grow.tieredHint')}</p>` : ''}
    <div class="label">${C.type === 'subscribe' ? tr('grow.howManySubs') : tr('grow.howManyCompletions')}</div>
    <input id="c-slots" type="number" min="1" placeholder="10" value="${esc(C.slots)}" data-model="C.slots" data-on="updatePrice">
    <div class="pricebox" id="pricebox">${priceHTML()}</div>
    <button class="btn" style="margin-top:14px" data-act="createCampaign" ${C.creating ? 'disabled' : ''}>${C.creating ? tr('grow.creating') : tr('grow.create')}</button>
    ${C.error ? `<p class="error">${esc(C.error)}</p>` : ''}${C.ok ? `<p class="success-text">${esc(C.ok)}</p>` : ''}
    <div class="label" style="margin-top:26px">${tr('grow.mine')}</div>
    ${myList}
  </div>`;
}

function vWallet() {
  const notice = S.payNotice
    ? `<div class="card" style="border-color:var(--success);color:var(--success);text-align:center;font-weight:600">${esc(S.payNotice)}</div>` : '';
  const list = S.txs.length ? S.txs.map(tx => `
    <div class="tx">
      <div><div class="d">${esc(txText(tx.description))}</div><div class="t">${new Date(tx.created_at).toLocaleString()}</div></div>
      <div class="amt ${tx.type === 'spent' ? 'minus' : 'plus'}">${tx.type === 'spent' ? '−' : '+'}${tx.amount}</div>
    </div>`).join('') : `<div class="empty">${tr('wallet.none')}</div>`;
  return vHeader(tr('wallet.title')) + `<div class="screen">
    ${notice}
    <button class="btn" style="margin-bottom:12px" data-act="loadTab" data-a="buy">💰 ${tr('buy.title')}</button>
    <div class="card">${list}</div></div>`;
}

function vBuy() {
  const cards = COIN_PACKAGES.map(usd => {
    const p = pkgInfo(usd);
    const busy = B.busy === usd;
    return `
    <div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:12px">
      <div>
        <div style="font-size:19px;font-weight:800;color:var(--gold)">🪙 ${p.total.toLocaleString()}</div>
        <div class="hint">${p.bonusPct ? `<b style="color:var(--success)">+${p.bonusPct}%</b> · ` : ''}$${usd} USDT</div>
      </div>
      <button class="btn small" style="white-space:nowrap;min-width:104px" data-act="buyCoins" data-a="${usd}" ${B.busy ? 'disabled' : ''}>${busy ? tr('buy.redirecting') : tr('buy.buyNow')}</button>
    </div>`;
  }).join('');
  const cu = parseInt(B.customUsd, 10) || 0;
  const cValid = cu >= 20;
  return vHeader(tr('buy.title')) + `
  <div class="screen">
    <button class="btn small secondary" style="display:inline-block;width:auto" data-act="loadTab" data-a="wallet">← ${tr('buy.back')}</button>
    <div style="background:rgba(255,183,3,0.12);border:1px solid var(--warning);border-radius:12px;padding:12px 14px;margin:12px 0">
      <div style="font-weight:800;color:var(--warning);font-size:12px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px">⚠️ ${tr('buy.readFirst')}</div>
      <div style="font-size:13.5px;color:var(--text2);line-height:1.5">${tr('buy.warnCrypto')}</div>
      <div style="font-size:13.5px;color:var(--text2);line-height:1.5;margin-top:4px">${tr('buy.warnInstant')}</div>
    </div>
    <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px;margin:0 0 12px">
      <div style="font-weight:800;font-size:14px;margin-bottom:8px">${tr('buy.howTitle')}</div>
      <ol style="margin:0;padding-left:18px;color:var(--text2);font-size:13.5px;line-height:1.7">
        <li>${tr('buy.howStep1')}</li>
        <li>${tr('buy.howStep2')}</li>
        <li>${tr('buy.howStep3')}</li>
        <li>${tr('buy.howStep4')}</li>
      </ol>
      <div style="margin-top:10px;font-size:12.5px;color:var(--warning);line-height:1.5">${tr('buy.howWarn')}</div>
    </div>
    ${cards}
    <div class="label">${tr('buy.custom')}</div>
    <div class="card">
      <input id="custom-usd" type="number" min="20" step="1" inputmode="numeric" placeholder="20" value="${esc(String(B.customUsd || ''))}" data-on="updateCustomBuy">
      <div id="custom-coins" style="margin-top:10px;font-size:14.5px">${cValid ? customCoinsHTML(cu) : `<span class="hint">${tr('buy.min')}</span>`}</div>
      <button id="custom-buy-btn" class="btn" style="margin-top:12px" data-act="buyCoinsCustom" ${(!cValid || B.busy) ? 'disabled' : ''}>${(B.busy === cu && cu) ? tr('buy.redirecting') : tr('buy.buyNow')}</button>
    </div>
    ${B.error ? `<p class="error">${esc(B.error)}</p>` : ''}
    <p class="hint" style="margin-top:14px">${tr('buy.secure')}</p>
  </div>`;
}

function vProfile() {
  const u = S.user || {};
  const L = window.I18N.LANGS, curLang = window.I18N.getLang();
  const flagImg = (cc) => `<img src="https://flagcdn.com/24x18/${cc}.png" width="22" height="16" alt="">`;
  const langMenu = Object.entries(L).map(([code, info]) =>
    `<button data-act="changeLang" data-a="${code}">${flagImg(info.cc)} ${esc(info.native)}</button>`).join('');
  return vHeader(tr('profile.title')) + `
  <div class="screen">
    <div class="profile-head">
      ${u.avatar ? `<img src="${esc(u.avatar)}" alt="" referrerpolicy="no-referrer">` : `<div class="ph">${esc((u.name || 'U')[0].toUpperCase())}</div>`}
      <h2>${esc(u.name || '')}</h2>
      <div class="email">${esc(u.email || '')}</div>
    </div>
    <div class="card">
      <div class="row"><span class="l">${tr('profile.coins')}</span><span class="v" style="color:var(--gold)">🪙 ${u.coins ?? 0}</span></div>
      <div class="row"><span class="l">${tr('profile.role')}</span><span class="v">${esc(u.role || 'user')}</span></div>
      ${u.youtube_channel_id ? `<div class="row"><span class="l">${tr('profile.channel')}</span><span class="v">✅ ${tr('profile.linked')}</span></div>` : ''}
    </div>
    <div class="card">
      <div class="row"><span class="l">${tr('profile.language')}</span>
        <details class="langpick"><summary>${flagImg(L[curLang].cc)} ${esc(L[curLang].native)} ▾</summary><div class="langmenu">${langMenu}</div></details></div>
    </div>
    <div class="card">
      <div class="row"><span class="l">${tr('profile.support')}</span><a class="v" href="mailto:support@viralboostnow.com">support@viralboostnow.com</a></div>
      <div class="row"><span class="l">${tr('common.privacy')}</span><a class="v" href="https://viralboostnow.com/privacy.html" target="_blank" rel="noopener">↗</a></div>
      <div class="row"><span class="l">${tr('common.terms')}</span><a class="v" href="https://viralboostnow.com/terms.html" target="_blank" rel="noopener">↗</a></div>
    </div>
    <button class="btn" style="margin-top:8px" data-act="loadTab" data-a="referral">🎁 ${tr('referral.invite')}</button>
    ${u.is_admin ? `<button class="btn" style="margin-top:8px" data-act="loadTab" data-a="admin">🛠 ${tr('profile.admin')}</button>` : ''}
    <button class="btn secondary" style="margin-top:8px" data-act="signOut">${tr('profile.signOut')}</button>
    <button class="btn danger-outline" style="margin-top:26px" data-act="deleteAccount">${tr('profile.deleteAccount')}</button>
  </div>`;
}

function vReferral() {
  const r = S.referral || {};
  const code = r.code || '…';
  const referrerBonus = r.referrer_bonus ?? 150;
  const refereeBonus = r.referee_bonus ?? 100;
  return vHeader(tr('referral.title')) + `
  <div class="screen">
    <button class="btn small secondary" style="display:inline-block;width:auto" data-act="loadTab" data-a="profile">← ${tr('common.back')}</button>
    <div class="card" style="text-align:center;padding:24px">
      <div style="font-size:42px">🎁</div>
      <p class="hint" style="margin:8px 0 16px">${tr('referral.subtitle', { referrer: referrerBonus, referee: refereeBonus })}</p>
      <div class="hint">${tr('referral.yourCode')}</div>
      <div style="font-size:32px;font-weight:800;color:var(--gold);letter-spacing:6px;margin:6px 0">${esc(code)}</div>
      ${r.code ? `<div class="hint" style="margin-top:6px;word-break:break-all;opacity:.8">${esc(referralLink(code))}</div>` : ''}
      <div style="margin-top:12px;font-size:12.5px;color:var(--gold);background:rgba(245,196,81,.1);border-radius:10px;padding:10px;line-height:1.5">${tr('referral.condition')}</div>
      <button class="btn" style="margin-top:10px" data-act="shareReferral">${tr('referral.share')}</button>
    </div>
    <div style="display:flex;gap:10px">
      <div class="card" style="flex:1;text-align:center;margin-bottom:0"><div style="font-size:22px;font-weight:800">${r.rewarded ?? 0}</div><div class="hint">${tr('referral.joined')}</div></div>
      <div class="card" style="flex:1;text-align:center;margin-bottom:0"><div style="font-size:22px;font-weight:800">${r.pending ?? 0}</div><div class="hint">${tr('referral.pending')}</div></div>
      <div class="card" style="flex:1;text-align:center;margin-bottom:0"><div style="font-size:22px;font-weight:800">${((r.rewarded ?? 0) * referrerBonus).toLocaleString()}</div><div class="hint">${tr('referral.earned')}</div></div>
    </div>
    <p class="hint" style="margin-top:14px;text-align:center">${tr('referral.note')}</p>
  </div>`;
}

function referralLink(code) { return location.origin + '/?ref=' + encodeURIComponent(code); }

async function shareReferral() {
  const code = S.referral?.code;
  if (!code) return;
  const link = referralLink(code);
  const msg = tr('referral.shareMessage', { code }) + '\n' + link;
  try {
    if (navigator.share) await navigator.share({ text: msg });
    else { await navigator.clipboard.writeText(link); showAlert(tr('referral.copied')); }
  } catch (_) {}
}

function vHome() {
  const u = S.user || {};
  const recent = (S.txs || []).slice(0, 5);
  return vHeader(tr('tabs.home')) + `
  <div class="screen">
    <div class="card" style="text-align:center;padding:24px">
      <div class="hint">${tr('home.balance')}</div>
      <div style="font-size:40px;font-weight:800;color:var(--gold);margin:6px 0">🪙 ${u.coins ?? 0}</div>
      <div class="hint">${tr('home.coinHint')}</div>
    </div>
    <div style="display:flex;gap:10px">
      <div class="card" style="flex:1;text-align:center;margin-bottom:0"><div style="font-size:22px;font-weight:800">${S.myTasks.length}</div><div class="hint">${tr('home.campaigns')}</div></div>
      <div class="card" style="flex:1;text-align:center;margin-bottom:0"><div style="font-size:22px;font-weight:800">${u.tasks_completed ?? 0}</div><div class="hint">${tr('home.completed')}</div></div>
    </div>
    <div style="display:flex;gap:10px;margin-top:10px">
      <button class="btn" style="flex:1" data-act="loadTab" data-a="earn">${tr('home.earnCoins')}</button>
      <button class="btn secondary" style="flex:1" data-act="loadTab" data-a="grow">${tr('home.getSubs')}</button>
    </div>
    <div class="label" style="margin-top:22px">${tr('home.recentActivity')}</div>
    <div class="card">${recent.length ? recent.map(tx => `
      <div class="tx"><div><div class="d">${esc(txText(tx.description))}</div><div class="t">${new Date(tx.created_at).toLocaleDateString()}</div></div>
      <div class="amt ${tx.type === 'spent' ? 'minus' : 'plus'}">${tx.type === 'spent' ? '−' : '+'}${tx.amount}</div></div>`).join('') : `<div class="empty">${tr('home.noTransactions')}</div>`}</div>
  </div>`;
}

async function adminAddCoins(email, input) {
  if (A.coinBusy) return;                       // guard against double-click double-apply
  const amt = parseInt(input && input.value, 10);
  if (!Number.isInteger(amt) || amt === 0) { showAlert('Enter a non-zero amount (e.g. 100, or -50 to remove).'); return; }
  A.coinBusy = true;
  try {
    const r = await api.adminAddCoins(email, amt);
    A.users = A.users.map(u => u.email === email ? { ...u, coins: r.user.coins } : u);
    render();
    showAlert(`${r.applied >= 0 ? 'Added' : 'Removed'} ${Math.abs(r.applied)} coins. ${email} now has 🪙${r.user.coins}.`);
  } catch (e) { showAlert(e.message || 'Failed to update coins.'); }
  finally { A.coinBusy = false; }
}
// One-time announcement popup — shows if targeted to web and the exact text hasn't been
// dismissed yet (re-shows automatically when the admin changes the message).
function maybeShowAnnouncement() {
  const c = S.config; if (!c || !c.announcement_message) return;
  const plat = c.announcement_platform || 'both';
  if (plat !== 'both' && plat !== 'web') return;
  if (localStorage.getItem('ann_seen') === c.announcement_message) return;
  S.announcement = { message: c.announcement_message, link: c.announcement_link || '' };
  render();
}

function vAdmin() {
  const s = A.stats || {};
  const tile = (label, val) => `<div class="card" style="flex:1;min-width:110px;text-align:center;margin-bottom:0"><div style="font-size:20px;font-weight:800">${val ?? 0}</div><div class="hint">${label}</div></div>`;
  const fields = ADMIN_FIELDS.map(([k, label]) => `
    <div class="row"><span class="l">${label}</span>
      <input type="number" min="0" ${k === 'margin_pct' ? 'step="0.1"' : ''} value="${esc(A.settings[k] ?? '')}" data-model="A.settings.${k}" data-on="updateAdminDerived" style="width:90px;padding:8px;text-align:right"></div>`).join('');
  const users = A.users.map(u => `
    <div class="card">
      <div><b>${esc(u.name || u.email)}</b> <span style="color:var(--gold)">🔔 ${u.subscriber_count ?? 0} subs</span>
        <div class="hint">${esc(u.email)} · ${esc(u.role)} · 🪙${u.coins} · ${u.tasks_completed} done${u.is_banned ? ' · ⛔ banned' : ''}${u.youtube_channel_id ? ` · <a href="https://www.youtube.com/channel/${esc(u.youtube_channel_id)}" target="_blank" rel="noopener">channel ↗</a>` : ''}</div></div>
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
        ${u.is_banned ? `<button class="btn small secondary" data-act="adminBanUser" data-a="${esc(u.email)}" data-b="1">Unban</button>`
                      : `<button class="btn small danger-outline" data-act="adminBanUser" data-a="${esc(u.email)}" data-b="0">Ban</button>`}
        ${u.role === 'premium' ? `<button class="btn small secondary" data-act="adminPromoteUser" data-a="${esc(u.email)}" data-b="user">↓ User</button>`
                               : `<button class="btn small secondary" data-act="adminPromoteUser" data-a="${esc(u.email)}" data-b="premium">↑ Premium</button>`}
      </div>
      <div style="display:flex;gap:6px;margin-top:6px">
        <input type="number" class="coin-input" placeholder="± coins" style="width:110px;padding:6px;text-align:right">
        <button class="btn small" data-act="adminAddCoins" data-a="${esc(u.email)}">Add / remove coins</button>
      </div>
    </div>`).join('');
  return vHeader('🛠 Admin') + `
  <div class="screen">
    <button class="btn small secondary" style="display:inline-block;width:auto" data-act="loadTab" data-a="profile">← Back</button>
    <div class="label" style="margin-top:14px">Stats</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${tile('Users', s.users)}${tile('Active campaigns', s.active_tasks)}${tile('Coins in circ.', s.total_coins_in_circulation)}${tile('Banned', s.banned_users)}
    </div>
    <div class="label" style="margin-top:18px">API mode (currently: ${esc(A.mode)})</div>
    <div style="display:flex;gap:8px">
      <button class="btn ${A.mode === 'live' ? '' : 'secondary'}" style="flex:1" data-act="adminSetMode" data-a="live">Live (API verify)</button>
      <button class="btn ${A.mode === 'degraded' ? '' : 'secondary'}" style="flex:1" data-act="adminSetMode" data-a="degraded">Honor mode</button>
    </div>
    <div class="label" style="margin-top:18px">Economy & limits</div>
    <div class="card">${fields}</div>
    <div class="card" id="admin-derived" style="font-size:13px">${adminDerivedHTML()}</div>
    <div class="label" style="margin-top:18px">Task types (tap to enable / disable)</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      ${TASK_TYPES.map(t => { const off = (A.settings.disabled_task_types || []).includes(t);
        return `<button class="chip ${off ? '' : 'active'}" data-act="adminToggleType" data-a="${t}">${off ? '🚫' : '✅'} ${taskLabel(t)}</button>`; }).join('')}
    </div>
    <div class="label" style="margin-top:14px">Daily cap per type (0 = unlimited)</div>
    <div class="card">${TASK_TYPES.map(t => `<div class="row"><span class="l">${taskLabel(t)}</span><input type="number" min="0" value="${esc(String((A.settings.daily_cap_by_type || {})[t] || 0))}" data-on="dailyCap" data-a="${t}" style="width:90px;padding:8px;text-align:right"></div>`).join('')}</div>
    <div class="label" style="margin-top:14px">Maintenance banner (empty = none)</div>
    <textarea data-model="A.settings.maintenance_message" style="width:100%;min-height:52px;padding:8px;box-sizing:border-box" placeholder="Shown as a banner to all users">${esc(A.settings.maintenance_message || '')}</textarea>
    <div class="label" style="margin-top:14px">Announcement popup (empty = none) — shows once when a user opens the app</div>
    <textarea data-model="A.settings.announcement_message" style="width:100%;min-height:52px;padding:8px;box-sizing:border-box" placeholder="e.g. We're moving to the web — your coins are already here!">${esc(A.settings.announcement_message || '')}</textarea>
    <input type="text" data-model="A.settings.announcement_link" value="${esc(A.settings.announcement_link || '')}" placeholder="Optional clickable link (https://…)" style="width:100%;margin-top:6px;padding:8px;box-sizing:border-box">
    <div style="display:flex;gap:6px;margin-top:6px">
      ${['both','web','mobile'].map(p => `<button class="chip ${((A.settings.announcement_platform)||'both')===p?'active':''}" data-act="adminSetAnnPlatform" data-a="${p}">${p==='both'?'📱+🌐 Both':p==='web'?'🌐 Web':'📱 Mobile'}</button>`).join('')}
    </div>
    ${A.dashboard ? `<div class="label" style="margin-top:18px">Campaigns by type (active · slots left)</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${(A.dashboard.campaigns_by_type || []).map(c => tile(taskLabel(c.task_type), `${c.active} · ${c.remaining_slots}`)).join('')}</div>
      <div class="label" style="margin-top:14px">Today</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${tile('New users', A.dashboard.users?.new_today)}${tile('Active/week', A.dashboard.users?.active_week)}${tile('Earned', A.dashboard.economy?.earned_today)}${tile('Spent', A.dashboard.economy?.spent_today)}</div>` : ''}
    <button class="btn" style="margin-top:14px" data-act="adminSave" ${A.saving ? 'disabled' : ''}>${A.saving ? 'Saving…' : 'Save settings'}</button>
    ${A.err ? `<p class="error">${esc(A.err)}</p>` : ''}${A.msg ? `<p class="success-text">${esc(A.msg)}</p>` : ''}
    <div class="label" style="margin-top:22px">Users</div>
    <div style="display:flex;gap:8px">
      <input type="text" placeholder="Search email or name…" value="${esc(A.userQuery)}" data-model="A.userQuery" style="flex:1">
      <button class="btn small secondary" style="white-space:nowrap" data-act="adminSearchUsers">Search</button>
      <button class="btn small" style="white-space:nowrap" data-act="adminTopCreators">🔔 Top creators</button>
    </div>
    ${A.userErr ? `<p class="error">${esc(A.userErr)}</p>` : ''}
    <div style="margin-top:10px">${users || `<div class="hint">Search for a user by email.</div>`}</div>
  </div>`;
}

function vTabbar() {
  const tabs = [['home', '🏠'], ['earn', '📋'], ['grow', '📈'], ['wallet', '🪙'], ['profile', '👤']];
  return `<div class="tabbar">${tabs.map(([k, i]) =>
    `<button class="${S.tab === k ? 'active' : ''}" data-act="loadTab" data-a="${k}"><span class="ico">${i}</span>${tr('tabs.' + k)}</button>`).join('')}</div>`;
}

// ── glue ──────────────────────────────────────────────────────────────────────
function setFilter(t) { S.taskFilter = t; loadTab('earn'); }
function setCType(t) { C.type = t; C.error = ''; C.ok = ''; render(); }

function render() {
  const root = document.getElementById('app');
  if (!S.token) { root.innerHTML = vLogin(); return; }
  const view = { home: vHome, earn: vEarn, grow: vGrow, wallet: vWallet, profile: vProfile, admin: vAdmin, buy: vBuy, referral: vReferral }[S.tab] || vEarn;
  const maint = (S.config && S.config.maintenance_message)
    ? `<div style="background:rgba(245,196,81,.15);color:var(--gold,#f5c451);padding:10px 14px;text-align:center;font-weight:700;font-size:13px">🚧 ${esc(S.config.maintenance_message)}</div>` : '';
  const ann = S.announcement ? `<div class="ann-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px">
    <div class="card" style="max-width:360px;width:100%;margin:0">
      <div style="font-weight:800;font-size:16px;margin-bottom:8px">🔔 Announcement</div>
      <div style="white-space:pre-wrap;line-height:1.5">${esc(S.announcement.message)}</div>
      ${(S.announcement.link && /^https?:\/\//i.test(S.announcement.link)) ? `<a class="btn" href="${esc(S.announcement.link)}" target="_blank" rel="noopener" data-act="dismissAnnouncement" style="margin-top:12px;display:block;text-align:center;text-decoration:none">Open</a>` : ''}
      <button class="btn secondary" data-act="dismissAnnouncement" style="margin-top:8px;width:100%">Got it</button>
    </div></div>` : '';
  root.innerHTML = maint + view() + vTabbar() + vModal() + ann;
}

// ── event delegation ──────────────────────────────────────────────────────────
// There are NO inline on* handlers in the rendered HTML, so the CSP drops
// script-src 'unsafe-inline'. Clickable elements carry data-act (+ data-a / data-b
// string params); form fields carry data-model (writes this.value into the store)
// and/or data-on (a follow-up action). A single set of delegated listeners on
// `document` survives every #app innerHTML re-render and also covers the body-level
// overlays (modal, watch player, themed dialogs).
const ACTIONS = {
  signIn,
  openTask: (el) => openTask(el.dataset.a),
  setFilter: (el) => setFilter(el.dataset.a || null),
  closeModal,
  modalBackdrop: (el, e) => { if (e.target === el) closeModal(); },
  modalOpenYouTube,
  modalVerify,
  loadTab: (el) => loadTab(el.dataset.a),
  campaignAction: (el) => campaignAction(Number(el.dataset.a), el.dataset.b),
  createCampaign,
  addChannelWeb,
  buyCoins: (el) => buyCoins(Number(el.dataset.a)),
  buyCoinsCustom,
  changeLang: (el) => changeLang(el.dataset.a),
  shareReferral,
  toggleCExample: (el) => toggleCExample(Number(el.dataset.a)),
  setCType: (el) => setCType(el.dataset.a),
  toggleFullLength,
  signOut,
  deleteAccount,
  adminToggleType: (el) => adminToggleType(el.dataset.a),
  adminSave,
  adminSetMode: (el) => adminSetMode(el.dataset.a),
  adminAddCoins: (el) => adminAddCoins(el.dataset.a, el.closest('.card') && el.closest('.card').querySelector('.coin-input')),
  adminSetAnnPlatform: (el) => { A.settings.announcement_platform = el.dataset.a; render(); },
  dismissAnnouncement: () => { if (S.announcement) { localStorage.setItem('ann_seen', S.announcement.message); S.announcement = null; render(); } },
  adminSearchUsers,
  adminTopCreators,
  adminBanUser: (el) => adminBanUser(el.dataset.a, el.dataset.b === '1'),
  adminPromoteUser: (el) => adminPromoteUser(el.dataset.a, el.dataset.b),
};
const INPUT_ACTIONS = {
  updatePrice,
  render,
  updateCustomBuy,
  updateAdminDerived,
  dailyCap: (el) => { A.settings.daily_cap_by_type = Object.assign({}, A.settings.daily_cap_by_type, { [el.dataset.a]: parseInt(el.value, 10) || 0 }); },
};
function _setModel(el) {
  const path = el.dataset.model; if (!path) return;
  const v = el.value;
  if (path.startsWith('A.settings.')) A.settings[path.slice(11)] = v;
  else if (path.startsWith('A.')) A[path.slice(2)] = v;
  else if (path.startsWith('C.')) C[path.slice(2)] = v;
  else if (path.startsWith('B.')) B[path.slice(2)] = v;
}
function _delegateClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;                 // clicks on the WP/dialog overlays (own .onclick) fall through
  const fn = ACTIONS[el.dataset.act];
  if (fn) fn(el, e);
}
function _delegateInput(e) {
  const el = e.target;
  if (!el || !el.dataset) return;
  if (el.dataset.model) _setModel(el);
  const on = el.dataset.on;
  if (on && INPUT_ACTIONS[on]) INPUT_ACTIONS[on](el);
}
document.addEventListener('click', _delegateClick);
document.addEventListener('input', _delegateInput);
document.addEventListener('change', _delegateInput);

// Legacy global exposure (no longer required now handlers are delegated, kept harmless).
Object.assign(window, { signIn, signOut, loadTab, setFilter, setCType, toggleFullLength, openTask, closeModal, modalOpenYouTube, modalVerify, createCampaign, campaignAction, deleteAccount, changeLang, addChannelWeb, updatePrice, render, C, A, B, S, buyCoins, buyCoinsCustom, updateCustomBuy, shareReferral, toggleCExample, adminToggleType,
  gotoAdmin, adminSave, adminSetMode, adminSearchUsers, adminTopCreators, adminBanUser, adminPromoteUser });

(async function init() {
  // Pull live pricing so the grow-tab estimate matches what an admin has configured
  // (server stays authoritative for the actual charge). Static SLOT_COSTS is the
  // fallback if this fails / the user isn't signed in yet.
  api.tiers().then((p) => {
    if (p && p.slot_costs) Object.assign(SLOT_COSTS, p.slot_costs);
    if (p && p.reward_per_type) Object.assign(REWARDS, p.reward_per_type);
    if (S.tab === 'grow') render();
  }).catch(() => {});
  const params = new URLSearchParams(location.search);
  // Referral link: ?ref=CODE pre-fills the referral field so the invitee doesn't type.
  const ref = params.get('ref');
  if (ref) S.referralCode = ref.trim().toUpperCase().slice(0, 12);
  // NowPayments sends the buyer back to ?payment=success|cancelled after checkout.
  const pay = params.get('payment');
  if (pay || ref) history.replaceState({}, '', location.pathname); // clean the URL
  if (S.token) {
    try {
      S.user = await api.me();
      if (pay === 'success' || pay === 'cancelled') {
        S.payNotice = window.I18N.t(pay === 'success' ? 'buy.success' : 'buy.cancelled');
        await loadTab('wallet');
        // Credit happens server-side via IPN, which can lag the redirect by up to a
        // minute — re-pull the wallet a few times so the balance/tx appear on their own.
        if (pay === 'success') { let n = 0; const p = setInterval(() => { if (++n > 6) return clearInterval(p); loadTab('wallet'); }, 5000); }
      } else {
        await loadTab('home');
      }
    } catch { render(); }
  } else render();
})();
