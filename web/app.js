/* SubsShare Web — buildless SPA served same-origin with the API */
'use strict';

const GOOGLE_CLIENT_ID = '59298470844-ldipur31o2rbe3la0oecsin3jd65pklq.apps.googleusercontent.com';
// Same-origin when served by the backend itself; absolute URL when hosted elsewhere (e.g. Namecheap)
const API_BASE = location.hostname.endsWith('.railway.app') || location.hostname === 'localhost'
  ? '' : 'https://subs-share-backend-production.up.railway.app';
const YT_SCOPE = 'openid email profile https://www.googleapis.com/auth/youtube.readonly';
const COMPLETION_DELAY = 45; // server enforces the real value; this drives the UI countdown

// Mirrors backend src/config — display estimates only, server is authoritative
const SLOT_COSTS = { subscribe: 15, like: 9, like_comment: 13, subscribe_like: 20, watch: 7 };
const REWARDS    = { subscribe: 12, like: 6,  like_comment: 10, subscribe_like: 17, watch: 4 };

const TASK_TYPES = ['subscribe', 'like', 'like_comment', 'subscribe_like', 'watch'];
const TASK_ICON = { subscribe: '🔔', like: '👍', like_comment: '💬', subscribe_like: '⭐', watch: '▶️' };
// translate shortcut (named `tr` to avoid clashing with the `t` task var in .map callbacks)
const tr = (k, v) => window.I18N.t(k, v);
const taskLabel = (type) => tr('task.' + type);
function changeLang(lang) { window.I18N.setLang(lang); render(); }

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
};
let countdownTimer = null;

function deviceId() {
  let id = localStorage.getItem('device_id');
  if (!id) { id = 'web_' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('device_id', id); }
  return id;
}

// ── api ───────────────────────────────────────────────────────────────────────
async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.token) headers.Authorization = 'Bearer ' + S.token;
  const res = await fetch(API_BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || 'Unexpected response' }; }
  if (res.status === 401 && S.token) { signOut(); throw new Error(tr('common.sessionExpired')); }
  if (!res.ok) { const e = new Error(data.error || tr('common.requestFailed')); e.code = data.code; e.data = data; throw e; }
  return data;
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
  start: (id) => req('POST', `/tasks/${id}/start`).catch(() => {}), // server-stamps the start time
  verify: (id, startedAt) => req('POST', `/tasks/${id}/verify`, { started_at: startedAt, device_id: deviceId(), platform: 'web' }),
  pause: (id) => req('PATCH', `/tasks/${id}/pause`),
  resume: (id) => req('PATCH', `/tasks/${id}/resume`),
  cancel: (id) => req('DELETE', `/tasks/${id}`),
  txs: (page = 1) => req('GET', '/transactions?page=' + page),
  buyCoins: (amount) => req('POST', '/payments/create-checkout', { amount, return_url: location.origin }),
  adminStatus: () => req('GET', '/admin/status'),
  adminSaveSettings: (d) => req('PATCH', '/admin/settings', d),
  adminMode: (mode) => req('POST', '/admin/mode', { mode }),
  adminUsers: (params) => { const qs = new URLSearchParams(params || {}).toString(); return req('GET', '/admin/users' + (qs ? '?' + qs : '')); },
  adminBan: (email, unban) => req('POST', '/admin/ban', { email, unban }),
  adminPromote: (email, role) => req('POST', '/admin/promote', { email, role }),
};

// Admin panel draft state
const A = { stats: {}, mode: 'live', settings: {}, userQuery: '', users: [], saving: false, msg: '', err: '', userErr: '' };
const ADMIN_FIELDS = [
  ['coins_subscribe', 'Subscribe reward'], ['coins_like', 'Like reward'],
  ['coins_like_comment', 'Like+Comment reward'], ['coins_subscribe_like', 'Sub+Like reward'],
  ['coins_watch', 'Watch reward'], ['comment_bonus', 'Comment bonus'],
  ['house_margin', 'House margin'], ['completion_delay_seconds', 'Verify delay (s)'],
  ['daily_limit_user', 'Daily limit (user)'], ['daily_limit_premium', 'Daily limit (premium)'],
  ['max_campaigns_per_user', 'Max campaigns/user'],
];

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
      S.busy = true; render();
      try {
        const data = await api.signIn(resp.code, referralCode);
        S.token = data.token; localStorage.setItem('token', data.token);
        S.user = data.user;
        S.busy = false;
        await loadTab('home');
      } catch (e) {
        S.busy = false; S.loginError = e.message; render();
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
  let perSlot = SLOT_COSTS[type] ?? 0;
  if (type === 'watch') perSlot += Math.max(0, (watchMins || 1) - 1);
  return perSlot * (slots || 0);
}

// Price-box HTML: total = per-slot × slots, recomputed live as the user types.
function priceHTML() {
  const slots = parseInt(C.slots, 10) || 0;
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
  S.tab = tab; render();
  try {
    if (tab === 'earn') S.tasks = await api.tasks(S.taskFilter);
    else if (tab === 'grow') { [S.myTasks, S.channels] = await Promise.all([api.myTasks(), api.channels()]); }
    else if (tab === 'wallet') S.txs = (await api.txs(1)).transactions || [];
    else if (tab === 'home') { [S.myTasks, S.txs] = await Promise.all([api.myTasks(), api.txs(1).then(r => r.transactions || [])]); }
    else if (tab === 'referral') S.referral = await api.getReferral().catch(() => null);
    else if (tab === 'admin') { const st = await api.adminStatus(); A.stats = st.stats; A.mode = st.api_mode; A.settings = { ...st.settings }; }
    else if (tab === 'profile') S.user = (await api.me()) || S.user;
    if (tab !== 'profile' && S.token) { api.me().then(d => { S.user = d; render(); }).catch(() => {}); }
  } catch (e) { console.warn('load error', e.message); }
  render();
}

// ── verify flow ───────────────────────────────────────────────────────────────
function openTask(taskId) {
  // Look the task up by id rather than trusting a blob serialized into the DOM —
  // avoids injecting server data into an inline handler attribute.
  const task = S.tasks.find(t => String(t.id) === String(taskId));
  if (!task) return;
  S.modal = { task, status: 'idle', countdown: 0, startedAt: null, error: '', message: '' };
  render();
}
function closeModal() { S.modal = null; if (countdownTimer) clearInterval(countdownTimer); render(); }

function modalOpenYouTube() {
  const m = S.modal; if (!m) return;
  const url = taskUrl(m.task);
  if (!url) { m.error = 'This campaign has an invalid link — try another task.'; render(); return; }
  window.open(url, '_blank', 'noopener');
  if (m.status === 'idle') {
    api.start(m.task.id);            // server records the real start time
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
      m.message = e.message || 'This task is no longer available.';
    } else {
      m.status = 'ready';
      m.error = e.data?.remaining ? tr('modal.waitMore', { s: e.data.remaining }) : e.message;
    }
  }
  render();
}

// ── create campaign ───────────────────────────────────────────────────────────
const C = { type: 'subscribe', slots: '', videoUrl: '', watchMins: '1', creating: false, error: '', ok: '', channelId: null, newChannelUrl: '', addingChannel: false };

async function addChannelWeb() {
  const url = (C.newChannelUrl || '').trim();
  C.error = ''; C.ok = '';
  if (!url) { C.error = 'Paste a channel URL or @handle.'; return render(); }
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
      watch_minutes: C.type === 'watch' ? parseInt(C.watchMins, 10) || 1 : undefined,
    });
    C.ok = res.owner ? tr('grow.createdFree') : tr('grow.created', { coins: res.coins_spent });
    C.slots = ''; C.videoUrl = '';
    [S.myTasks, S.user] = [await api.myTasks(), await api.me()];
  } catch (e) { C.error = e.message; }
  C.creating = false; render();
}

async function campaignAction(id, action) {
  if (action === 'cancel' && !confirm(tr('grow.cancelConfirm'))) return;
  try {
    if (action === 'pause') await api.pause(id);
    else if (action === 'resume') await api.resume(id);
    else await api.cancel(id);
    S.myTasks = await api.myTasks();
    api.me().then(d => { S.user = d; render(); }).catch(() => {});
  } catch (e) { alert(e.message); }
  render();
}

async function deleteAccount() {
  if (!confirm(tr('profile.deleteConfirm'))) return;
  try { await api.deleteAccount(); signOut(); } catch (e) { alert(e.message); }
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

async function adminSave() {
  A.msg = ''; A.err = ''; A.saving = true; render();
  try {
    const payload = {};
    ADMIN_FIELDS.forEach(([k]) => { if (A.settings[k] !== '' && A.settings[k] != null) payload[k] = parseInt(A.settings[k], 10); });
    const res = await api.adminSaveSettings(payload);
    A.settings = { ...res.settings };
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
  if (!unban && !confirm(`Ban ${email}?`)) return;
  try { await api.adminBan(email, unban); await adminSearchUsers(); } catch (e) { alert(e.message); }
}
async function adminPromoteUser(email, role) {
  try { await api.adminPromote(email, role); await adminSearchUsers(); } catch (e) { alert(e.message); }
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
    <button class="gbtn" onclick="signIn()" ${S.busy ? 'disabled' : ''}>
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
    `<button class="chip ${S.taskFilter === t ? 'active' : ''}" onclick="setFilter(${t ? `'${t}'` : 'null'})">${t ? taskLabel(t) : tr('earn.all')}</button>`
  ).join('');
  const list = S.tasks.length ? S.tasks.map(t => `
    <div class="card task" onclick="openTask(${esc(String(t.id))})">
      <div class="avatar">${t.owner_avatar ? `<img src="${esc(t.owner_avatar)}" alt="" referrerpolicy="no-referrer">` : (TASK_ICON[t.task_type] || '📺')}</div>
      <div class="info">
        <div class="name">${esc(t.channel_name || t.owner_name)}</div>
        <div class="meta">${taskLabel(t.task_type)}${t.task_type === 'watch' ? ` · ${esc(t.watch_minutes)} ${tr('earn.min')}` : ''} · ${esc(t.remaining_slots)} ${tr('earn.left')}</div>
      </div>
      <div class="reward">+${t.reward} 🪙</div>
    </div>`).join('')
    : `<div class="empty">${tr('earn.none')}<br>${tr('earn.checkBack')}</div>`;
  return vHeader(tr('earn.title')) + `<div class="screen"><div class="chips">${chips}</div>${list}</div>`;
}

function vModal() {
  const m = S.modal; if (!m) return '';
  const t = m.task;
  let action;
  if (m.status === 'done') {
    action = `<p class="success-text">${esc(m.message)}</p><button class="btn" style="margin-top:12px" onclick="closeModal()">${tr('modal.done')}</button>`;
  } else {
    const label = m.status === 'verifying' ? tr('modal.verifying')
      : m.status === 'countdown' ? tr('modal.verifyIn', { s: m.countdown })
      : tr('modal.verify');
    action = `
      <button class="btn secondary" onclick="modalOpenYouTube()">${tr('modal.open')}</button>
      ${m.status === 'countdown' ? `<div class="countdown">${m.countdown}s</div>` : ''}
      <button class="btn" style="margin-top:10px" onclick="modalVerify()" ${m.status === 'ready' ? '' : 'disabled'}>${label}</button>
      ${m.status === 'idle' ? `<p class="hint" style="text-align:center">${tr('modal.openFirst')}</p>` : ''}
      ${m.error ? `<p class="error">${esc(m.error)}</p>` : ''}`;
  }
  return `
  <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
    <div class="modal">
      <h2>${TASK_ICON[t.task_type] || ''} ${taskLabel(t.task_type)} — +${t.reward} 🪙</h2>
      <div class="meta" style="color:var(--text2);font-size:13px">${esc(t.channel_name || t.owner_name)}</div>
      <div class="steps">${tr('steps.' + t.task_type, { min: t.watch_minutes })}</div>
      ${action}
    </div>
  </div>`;
}

function vGrow() {
  const needsVideo = C.type !== 'subscribe';
  const needsChannel = ['subscribe', 'subscribe_like'].includes(C.type);
  const chips = TASK_TYPES.map(t =>
    `<button class="chip ${C.type === t ? 'active' : ''}" onclick="setCType('${t}')">${TASK_ICON[t]} ${taskLabel(t)}</button>`).join('');
  const myList = S.myTasks.length ? S.myTasks.map(t => `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <b>${TASK_ICON[t.task_type] || ''} ${taskLabel(t.task_type)}</b>
        <span class="badge ${esc(t.status)}">${esc(tr('status.' + t.status))}</span>
      </div>
      <div class="hint">${t.completions_count}/${t.total_slots} ${tr('grow.done')} · ${t.progress_pct}%</div>
      <div style="display:flex;gap:8px;margin-top:10px">
        ${t.can_pause ? `<button class="btn small secondary" onclick="campaignAction(${t.id},'pause')">${tr('grow.pause')}</button>` : ''}
        ${t.can_resume ? `<button class="btn small secondary" onclick="campaignAction(${t.id},'resume')">${tr('grow.resume')}</button>` : ''}
        ${t.can_cancel ? `<button class="btn small danger-outline" onclick="campaignAction(${t.id},'cancel')">${tr('grow.cancel')}</button>` : ''}
      </div>
    </div>`).join('') : `<div class="empty">${tr('grow.none')}</div>`;
  return vHeader(tr('grow.title')) + `
  <div class="screen">
    <div class="label">${tr('grow.type')}</div>
    <div class="chips">${chips}</div>
    ${needsChannel ? `<div class="label">${tr('grow.channelLabel')}</div>
      ${S.channels.length ? `<select onchange="C.channelId=this.value;render()" style="width:100%">${S.channels.map(c => `<option value="${esc(String(c.id))}" ${String(C.channelId) === String(c.id) ? 'selected' : ''}>${esc(c.channel_name)}${c.subscriber_count != null ? ' · ' + c.subscriber_count + ' subs' : ''}</option>`).join('')}</select>` : `<p class="hint">${tr('grow.noChannelYet')}</p>`}
      <div style="display:flex;gap:8px;margin-top:8px">
        <input type="text" placeholder="youtube.com/@handle" value="${esc(C.newChannelUrl)}" oninput="C.newChannelUrl=this.value" style="flex:1">
        <button class="btn small secondary" style="white-space:nowrap" onclick="addChannelWeb()" ${C.addingChannel ? 'disabled' : ''}>${C.addingChannel ? tr('grow.adding') : '+ ' + tr('grow.addChannel')}</button>
      </div>` : ''}
    ${needsVideo ? `<div class="label">${tr('grow.videoUrl')}</div>
      <input id="c-video" type="url" placeholder="https://youtube.com/watch?v=…" value="${esc(C.videoUrl)}" oninput="C.videoUrl=this.value">` : ''}
    ${C.type === 'watch' ? `<div class="label">${tr('grow.minutes')}</div>
      <input id="c-mins" type="number" min="1" max="60" value="${esc(C.watchMins)}" oninput="C.watchMins=this.value;updatePrice()">` : ''}
    <div class="label">${C.type === 'subscribe' ? tr('grow.howManySubs') : tr('grow.howManyCompletions')}</div>
    <input id="c-slots" type="number" min="1" placeholder="10" value="${esc(C.slots)}" oninput="C.slots=this.value;updatePrice()">
    <div class="pricebox" id="pricebox">${priceHTML()}</div>
    <button class="btn" style="margin-top:14px" onclick="createCampaign()" ${C.creating ? 'disabled' : ''}>${C.creating ? tr('grow.creating') : tr('grow.create')}</button>
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
    <button class="btn" style="margin-bottom:12px" onclick="loadTab('buy')">💰 ${tr('buy.title')}</button>
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
      <button class="btn small" style="white-space:nowrap;min-width:104px" onclick="buyCoins(${usd})" ${B.busy ? 'disabled' : ''}>${busy ? tr('buy.redirecting') : tr('buy.buyNow')}</button>
    </div>`;
  }).join('');
  const cu = parseInt(B.customUsd, 10) || 0;
  const cValid = cu >= 20;
  return vHeader(tr('buy.title')) + `
  <div class="screen">
    <button class="btn small secondary" style="display:inline-block;width:auto" onclick="loadTab('wallet')">← ${tr('buy.back')}</button>
    <p class="hint" style="margin:12px 0 10px">${tr('buy.subtitle')}</p>
    ${cards}
    <div class="label">${tr('buy.custom')}</div>
    <div class="card">
      <input id="custom-usd" type="number" min="20" step="1" inputmode="numeric" placeholder="20" value="${esc(String(B.customUsd || ''))}" oninput="updateCustomBuy()">
      <div id="custom-coins" style="margin-top:10px;font-size:14.5px">${cValid ? customCoinsHTML(cu) : `<span class="hint">${tr('buy.min')}</span>`}</div>
      <button id="custom-buy-btn" class="btn" style="margin-top:12px" onclick="buyCoinsCustom()" ${(!cValid || B.busy) ? 'disabled' : ''}>${(B.busy === cu && cu) ? tr('buy.redirecting') : tr('buy.buyNow')}</button>
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
    `<button onclick="changeLang('${code}')">${flagImg(info.cc)} ${esc(info.native)}</button>`).join('');
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
    <button class="btn" style="margin-top:8px" onclick="loadTab('referral')">🎁 ${tr('referral.invite')}</button>
    ${u.is_admin ? `<button class="btn" style="margin-top:8px" onclick="loadTab('admin')">🛠 ${tr('profile.admin')}</button>` : ''}
    <button class="btn secondary" style="margin-top:8px" onclick="signOut()">${tr('profile.signOut')}</button>
    <button class="btn danger-outline" style="margin-top:26px" onclick="deleteAccount()">${tr('profile.deleteAccount')}</button>
  </div>`;
}

function vReferral() {
  const r = S.referral || {};
  const code = r.code || '…';
  const referrerBonus = r.referrer_bonus ?? 150;
  const refereeBonus = r.referee_bonus ?? 100;
  return vHeader(tr('referral.title')) + `
  <div class="screen">
    <button class="btn small secondary" style="display:inline-block;width:auto" onclick="loadTab('profile')">← ${tr('common.back')}</button>
    <div class="card" style="text-align:center;padding:24px">
      <div style="font-size:42px">🎁</div>
      <p class="hint" style="margin:8px 0 16px">${tr('referral.subtitle', { referrer: referrerBonus, referee: refereeBonus })}</p>
      <div class="hint">${tr('referral.yourCode')}</div>
      <div style="font-size:32px;font-weight:800;color:var(--gold);letter-spacing:6px;margin:6px 0">${esc(code)}</div>
      <button class="btn" style="margin-top:10px" onclick="shareReferral()">${tr('referral.share')}</button>
    </div>
    <div style="display:flex;gap:10px">
      <div class="card" style="flex:1;text-align:center;margin-bottom:0"><div style="font-size:22px;font-weight:800">${r.rewarded ?? 0}</div><div class="hint">${tr('referral.joined')}</div></div>
      <div class="card" style="flex:1;text-align:center;margin-bottom:0"><div style="font-size:22px;font-weight:800">${r.pending ?? 0}</div><div class="hint">${tr('referral.pending')}</div></div>
      <div class="card" style="flex:1;text-align:center;margin-bottom:0"><div style="font-size:22px;font-weight:800">${((r.rewarded ?? 0) * referrerBonus).toLocaleString()}</div><div class="hint">${tr('referral.earned')}</div></div>
    </div>
    <p class="hint" style="margin-top:14px;text-align:center">${tr('referral.note')}</p>
  </div>`;
}

async function shareReferral() {
  const code = S.referral?.code;
  if (!code) return;
  const msg = tr('referral.shareMessage', { code });
  try {
    if (navigator.share) await navigator.share({ text: msg });
    else { await navigator.clipboard.writeText(code); alert(tr('referral.copied')); }
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
      <button class="btn" style="flex:1" onclick="loadTab('earn')">${tr('home.earnCoins')}</button>
      <button class="btn secondary" style="flex:1" onclick="loadTab('grow')">${tr('home.getSubs')}</button>
    </div>
    <div class="label" style="margin-top:22px">${tr('home.recentActivity')}</div>
    <div class="card">${recent.length ? recent.map(tx => `
      <div class="tx"><div><div class="d">${esc(txText(tx.description))}</div><div class="t">${new Date(tx.created_at).toLocaleDateString()}</div></div>
      <div class="amt ${tx.type === 'spent' ? 'minus' : 'plus'}">${tx.type === 'spent' ? '−' : '+'}${tx.amount}</div></div>`).join('') : `<div class="empty">${tr('home.noTransactions')}</div>`}</div>
  </div>`;
}

function vAdmin() {
  const s = A.stats || {};
  const tile = (label, val) => `<div class="card" style="flex:1;min-width:110px;text-align:center;margin-bottom:0"><div style="font-size:20px;font-weight:800">${val ?? 0}</div><div class="hint">${label}</div></div>`;
  const fields = ADMIN_FIELDS.map(([k, label]) => `
    <div class="row"><span class="l">${label}</span>
      <input type="number" min="0" value="${esc(A.settings[k] ?? '')}" oninput="A.settings['${k}']=this.value" style="width:90px;padding:8px;text-align:right"></div>`).join('');
  const users = A.users.map(u => `
    <div class="card">
      <div><b>${esc(u.name || u.email)}</b> <span style="color:var(--gold)">🔔 ${u.subscriber_count ?? 0} subs</span>
        <div class="hint">${esc(u.email)} · ${esc(u.role)} · 🪙${u.coins} · ${u.tasks_completed} done${u.is_banned ? ' · ⛔ banned' : ''}${u.youtube_channel_id ? ` · <a href="https://www.youtube.com/channel/${esc(u.youtube_channel_id)}" target="_blank" rel="noopener">channel ↗</a>` : ''}</div></div>
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
        ${u.is_banned ? `<button class="btn small secondary" onclick="adminBanUser('${esc(u.email)}',true)">Unban</button>`
                      : `<button class="btn small danger-outline" onclick="adminBanUser('${esc(u.email)}',false)">Ban</button>`}
        ${u.role === 'premium' ? `<button class="btn small secondary" onclick="adminPromoteUser('${esc(u.email)}','user')">↓ User</button>`
                               : `<button class="btn small secondary" onclick="adminPromoteUser('${esc(u.email)}','premium')">↑ Premium</button>`}
      </div>
    </div>`).join('');
  return vHeader('🛠 Admin') + `
  <div class="screen">
    <button class="btn small secondary" style="display:inline-block;width:auto" onclick="loadTab('profile')">← Back</button>
    <div class="label" style="margin-top:14px">Stats</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${tile('Users', s.users)}${tile('Active campaigns', s.active_tasks)}${tile('Coins in circ.', s.total_coins_in_circulation)}${tile('Banned', s.banned_users)}
    </div>
    <div class="label" style="margin-top:18px">API mode (currently: ${esc(A.mode)})</div>
    <div style="display:flex;gap:8px">
      <button class="btn ${A.mode === 'live' ? '' : 'secondary'}" style="flex:1" onclick="adminSetMode('live')">Live (API verify)</button>
      <button class="btn ${A.mode === 'degraded' ? '' : 'secondary'}" style="flex:1" onclick="adminSetMode('degraded')">Honor mode</button>
    </div>
    <div class="label" style="margin-top:18px">Economy & limits</div>
    <div class="card">${fields}</div>
    <button class="btn" onclick="adminSave()" ${A.saving ? 'disabled' : ''}>${A.saving ? 'Saving…' : 'Save settings'}</button>
    ${A.err ? `<p class="error">${esc(A.err)}</p>` : ''}${A.msg ? `<p class="success-text">${esc(A.msg)}</p>` : ''}
    <div class="label" style="margin-top:22px">Users</div>
    <div style="display:flex;gap:8px">
      <input type="text" placeholder="Search email…" value="${esc(A.userQuery)}" oninput="A.userQuery=this.value" style="flex:1">
      <button class="btn small secondary" style="white-space:nowrap" onclick="adminSearchUsers()">Search</button>
      <button class="btn small" style="white-space:nowrap" onclick="adminTopCreators()">🔔 Top creators</button>
    </div>
    ${A.userErr ? `<p class="error">${esc(A.userErr)}</p>` : ''}
    <div style="margin-top:10px">${users || `<div class="hint">Search for a user by email.</div>`}</div>
  </div>`;
}

function vTabbar() {
  const tabs = [['home', '🏠'], ['earn', '📋'], ['grow', '📈'], ['wallet', '🪙'], ['profile', '👤']];
  return `<div class="tabbar">${tabs.map(([k, i]) =>
    `<button class="${S.tab === k ? 'active' : ''}" onclick="loadTab('${k}')"><span class="ico">${i}</span>${tr('tabs.' + k)}</button>`).join('')}</div>`;
}

// ── glue ──────────────────────────────────────────────────────────────────────
function setFilter(t) { S.taskFilter = t; loadTab('earn'); }
function setCType(t) { C.type = t; C.error = ''; C.ok = ''; render(); }

function render() {
  const root = document.getElementById('app');
  if (!S.token) { root.innerHTML = vLogin(); return; }
  const view = { home: vHome, earn: vEarn, grow: vGrow, wallet: vWallet, profile: vProfile, admin: vAdmin, buy: vBuy, referral: vReferral }[S.tab] || vEarn;
  root.innerHTML = view() + vTabbar() + vModal();
}

// expose handlers used in inline HTML
Object.assign(window, { signIn, signOut, loadTab, setFilter, setCType, openTask, closeModal, modalOpenYouTube, modalVerify, createCampaign, campaignAction, deleteAccount, changeLang, addChannelWeb, updatePrice, render, C, A, B, S, buyCoins, buyCoinsCustom, updateCustomBuy, shareReferral,
  gotoAdmin, adminSave, adminSetMode, adminSearchUsers, adminTopCreators, adminBanUser, adminPromoteUser });

(async function init() {
  // NowPayments sends the buyer back to ?payment=success|cancelled after checkout.
  const pay = new URLSearchParams(location.search).get('payment');
  if (pay) history.replaceState({}, '', location.pathname); // clean the URL
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
