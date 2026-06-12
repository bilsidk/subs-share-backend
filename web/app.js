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

const TASK_LABEL = {
  subscribe: 'Subscribe', like: 'Like', like_comment: 'Like + Comment',
  subscribe_like: 'Sub + Like', watch: 'Watch',
};
const TASK_ICON = { subscribe: '🔔', like: '👍', like_comment: '💬', subscribe_like: '⭐', watch: '▶️' };

// ── state ─────────────────────────────────────────────────────────────────────
const S = {
  token: localStorage.getItem('token') || null,
  user: null,
  tab: 'earn',
  tasks: [], taskFilter: null,
  myTasks: [], channels: [], txs: [],
  modal: null, // {task, status:'idle'|'countdown'|'ready'|'verifying'|'done', countdown, startedAt, error, message}
  busy: false, loginError: '',
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
  if (res.status === 401 && S.token) { signOut(); throw new Error('Session expired — sign in again.'); }
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.code = data.code; e.data = data; throw e; }
  return data;
}
const api = {
  signIn: (code) => req('POST', '/auth/google', { serverAuthCode: code, web: true }),
  me: () => req('GET', '/users/me'),
  deleteAccount: () => req('DELETE', '/users/me'),
  channels: () => req('GET', '/channels'),
  tasks: (type) => req('GET', '/tasks' + (type ? '?type=' + encodeURIComponent(type) : '')),
  myTasks: () => req('GET', '/tasks/my'),
  createTask: (d) => req('POST', '/tasks', d),
  verify: (id, startedAt) => req('POST', `/tasks/${id}/verify`, { started_at: startedAt, device_id: deviceId() }),
  pause: (id) => req('PATCH', `/tasks/${id}/pause`),
  resume: (id) => req('PATCH', `/tasks/${id}/resume`),
  cancel: (id) => req('DELETE', `/tasks/${id}`),
  txs: (page = 1) => req('GET', '/transactions?page=' + page),
};

// ── auth ──────────────────────────────────────────────────────────────────────
function signIn() {
  S.loginError = '';
  if (!window.google?.accounts?.oauth2) { S.loginError = 'Google sign-in is still loading — try again in a second.'; return render(); }
  const codeClient = google.accounts.oauth2.initCodeClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: YT_SCOPE,
    ux_mode: 'popup',
    callback: async (resp) => {
      if (!resp.code) { S.loginError = 'Sign-in cancelled.'; return render(); }
      S.busy = true; render();
      try {
        const data = await api.signIn(resp.code);
        S.token = data.token; localStorage.setItem('token', data.token);
        S.user = data.user;
        S.busy = false;
        await loadTab('earn');
      } catch (e) {
        S.busy = false; S.loginError = e.message; render();
      }
    },
    error_callback: () => { S.busy = false; S.loginError = 'Sign-in was closed.'; render(); },
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

function taskUrl(t) {
  if (t.target_video_id) return 'https://www.youtube.com/watch?v=' + encodeURIComponent(t.target_video_id);
  if (t.channel_url) return t.channel_url;
  if (t.youtube_channel_id) return 'https://www.youtube.com/channel/' + encodeURIComponent(t.youtube_channel_id);
  return null;
}

function txText(desc) {
  if (!desc?.startsWith('tx:')) return desc || '';
  const parts = Object.fromEntries(desc.slice(3).split('|').map(p => p.includes(':') ? p.split(':') : ['key', p]));
  const key = desc.slice(3).split('|')[0];
  const type = TASK_LABEL[parts.type] || parts.type || '';
  switch (key) {
    case 'welcome_bonus': return '🎁 Welcome bonus';
    case 'campaign_created': return `📣 Campaign created — ${type}, ${parts.slots} slots` + (parts.free ? ' (free)' : '');
    case 'task_completed': return `✅ Task completed — ${type}`;
    case 'task_completed_comment': return `✅ Task + comment bonus — ${type}`;
    case 'campaign_refund': return `↩️ Campaign refund`;
    case 'coins_reclaimed': return `⚠️ Coins reclaimed — ${type}`;
    default: return desc.slice(3).replace(/\|/g, ' · ');
  }
}

function estimateCost(type, slots, watchMins) {
  let perSlot = SLOT_COSTS[type] ?? 0;
  if (type === 'watch') perSlot += Math.max(0, (watchMins || 1) - 1);
  return perSlot * (slots || 0);
}

// ── data loading ──────────────────────────────────────────────────────────────
async function loadTab(tab) {
  S.tab = tab; render();
  try {
    if (tab === 'earn') S.tasks = await api.tasks(S.taskFilter);
    else if (tab === 'grow') { [S.myTasks, S.channels] = await Promise.all([api.myTasks(), api.channels()]); }
    else if (tab === 'wallet') S.txs = (await api.txs(1)).transactions || [];
    else if (tab === 'profile') S.user = (await api.me()).user || S.user;
    if (tab !== 'profile' && S.token) { api.me().then(d => { S.user = d.user; render(); }).catch(() => {}); }
  } catch (e) { console.warn('load error', e.message); }
  render();
}

// ── verify flow ───────────────────────────────────────────────────────────────
function openTask(task) {
  S.modal = { task, status: 'idle', countdown: 0, startedAt: null, error: '', message: '' };
  render();
}
function closeModal() { S.modal = null; if (countdownTimer) clearInterval(countdownTimer); render(); }

function modalOpenYouTube() {
  const m = S.modal; if (!m) return;
  const url = taskUrl(m.task);
  if (url) window.open(url, '_blank', 'noopener');
  if (m.status === 'idle') {
    m.startedAt = Date.now();
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
    api.me().then(d => { S.user = d.user; render(); }).catch(() => {});
    S.tasks = S.tasks.filter(t => t.id !== m.task.id);
  } catch (e) {
    m.status = 'ready';
    m.error = e.data?.remaining ? `Wait ${e.data.remaining}s more, then verify.` : e.message;
  }
  render();
}

// ── create campaign ───────────────────────────────────────────────────────────
const C = { type: 'subscribe', slots: '', videoUrl: '', watchMins: '1', creating: false, error: '', ok: '' };

async function createCampaign() {
  C.error = ''; C.ok = '';
  const slots = parseInt(C.slots, 10);
  if (!slots || slots < 1) { C.error = 'Enter how many slots you want.'; return render(); }
  const needsVideo = C.type !== 'subscribe';
  if (needsVideo && !C.videoUrl.trim()) { C.error = 'Paste your YouTube video URL.'; return render(); }
  const needsChannel = ['subscribe', 'subscribe_like'].includes(C.type);
  const channel = S.channels[0];
  if (needsChannel && !channel) { C.error = 'No YouTube channel linked to your account. Sign out and back in to register it.'; return render(); }

  C.creating = true; render();
  try {
    const res = await api.createTask({
      channel_id: needsChannel ? channel.id : undefined,
      task_type: C.type,
      subscribers_wanted: slots,
      target_video_url: needsVideo ? C.videoUrl.trim() : undefined,
      watch_minutes: C.type === 'watch' ? parseInt(C.watchMins, 10) || 1 : undefined,
    });
    C.ok = res.owner ? 'Campaign created (free — owner).' : `Campaign created! Spent ${res.coins_spent} coins.`;
    C.slots = ''; C.videoUrl = '';
    [S.myTasks, S.user] = [await api.myTasks(), (await api.me()).user];
  } catch (e) { C.error = e.message; }
  C.creating = false; render();
}

async function campaignAction(id, action) {
  if (action === 'cancel' && !confirm('Cancel this campaign? Remaining slots are refunded.')) return;
  try {
    if (action === 'pause') await api.pause(id);
    else if (action === 'resume') await api.resume(id);
    else await api.cancel(id);
    S.myTasks = await api.myTasks();
    api.me().then(d => { S.user = d.user; render(); }).catch(() => {});
  } catch (e) { alert(e.message); }
  render();
}

async function deleteAccount() {
  if (!confirm('Permanently delete your account and all data? This cannot be undone.')) return;
  try { await api.deleteAccount(); signOut(); } catch (e) { alert(e.message); }
}

// ── views ─────────────────────────────────────────────────────────────────────
function vLogin() {
  return `
  <div class="center">
    <div class="logo">📺</div>
    <h1 style="font-size:28px">SubsShare</h1>
    <p style="color:var(--text2);margin:10px 0 30px;line-height:1.5">Earn coins by supporting other creators.<br>Spend them to grow your channel.</p>
    <button class="gbtn" onclick="signIn()" ${S.busy ? 'disabled' : ''}>
      <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>
      ${S.busy ? 'Signing in…' : 'Continue with Google'}
    </button>
    <p class="hint" style="margin-top:14px">We use your Google account to verify YouTube actions.<br>
      <a href="https://viralboostnow.com/privacy.html" target="_blank" rel="noopener">Privacy</a> ·
      <a href="https://viralboostnow.com/terms.html" target="_blank" rel="noopener">Terms</a></p>
    ${S.loginError ? `<p class="error">${esc(S.loginError)}</p>` : ''}
  </div>`;
}

function vHeader(title) {
  return `<div class="header"><h1>${title}</h1><span class="coins">🪙 ${S.user?.coins ?? '…'}</span></div>`;
}

function vEarn() {
  const chips = [null, 'subscribe', 'like', 'like_comment', 'subscribe_like', 'watch'].map(t =>
    `<button class="chip ${S.taskFilter === t ? 'active' : ''}" onclick="setFilter(${t ? `'${t}'` : 'null'})">${t ? TASK_LABEL[t] : 'All'}</button>`
  ).join('');
  const list = S.tasks.length ? S.tasks.map(t => `
    <div class="card task" onclick='openTask(${JSON.stringify(t).replace(/'/g, '&#39;')})'>
      <div class="avatar">${t.owner_avatar ? `<img src="${esc(t.owner_avatar)}" alt="" referrerpolicy="no-referrer">` : (TASK_ICON[t.task_type] || '📺')}</div>
      <div class="info">
        <div class="name">${esc(t.channel_name || t.owner_name)}</div>
        <div class="meta">${TASK_LABEL[t.task_type] || t.task_type}${t.task_type === 'watch' ? ` · ${t.watch_minutes} min` : ''} · ${t.remaining_slots} left</div>
      </div>
      <div class="reward">+${t.reward} 🪙</div>
    </div>`).join('')
    : `<div class="empty">No tasks right now.<br>Pull down or check back soon!</div>`;
  return vHeader('Earn Coins') + `<div class="screen"><div class="chips">${chips}</div>${list}</div>`;
}

function vModal() {
  const m = S.modal; if (!m) return '';
  const t = m.task;
  const steps = {
    subscribe: '1. Open the channel on YouTube<br>2. Tap <b>Subscribe</b><br>3. Come back and verify',
    like: '1. Open the video on YouTube<br>2. Tap <b>👍 Like</b><br>3. Come back and verify',
    like_comment: '1. Open the video<br>2. Tap <b>👍 Like</b> and leave a <b>comment</b> (bonus coins!)<br>3. Come back and verify',
    subscribe_like: '1. Open the video<br>2. <b>Subscribe</b> to the channel and <b>Like</b> the video<br>3. Come back and verify',
    watch: `1. Open the video<br>2. Watch at least <b>${t.watch_minutes} minute(s)</b><br>3. Come back and verify`,
  };
  let action;
  if (m.status === 'done') {
    action = `<p class="success-text">${esc(m.message)}</p><button class="btn" style="margin-top:12px" onclick="closeModal()">Done</button>`;
  } else {
    const label = m.status === 'verifying' ? 'Verifying…'
      : m.status === 'countdown' ? `Verify (${m.countdown}s)`
      : 'Verify & Claim';
    action = `
      <button class="btn secondary" onclick="modalOpenYouTube()">▶ Open YouTube</button>
      ${m.status === 'countdown' ? `<div class="countdown">${m.countdown}s</div>` : ''}
      <button class="btn" style="margin-top:10px" onclick="modalVerify()" ${m.status === 'ready' ? '' : 'disabled'}>${label}</button>
      ${m.status === 'idle' ? '<p class="hint" style="text-align:center">Open YouTube first — the timer starts when you do.</p>' : ''}
      ${m.error ? `<p class="error">${esc(m.error)}</p>` : ''}`;
  }
  return `
  <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
    <div class="modal">
      <h2>${TASK_ICON[t.task_type] || ''} ${TASK_LABEL[t.task_type] || t.task_type} — +${t.reward} 🪙</h2>
      <div class="meta" style="color:var(--text2);font-size:13px">${esc(t.channel_name || t.owner_name)}</div>
      <div class="steps">${steps[t.task_type] || ''}</div>
      ${action}
    </div>
  </div>`;
}

function vGrow() {
  const needsVideo = C.type !== 'subscribe';
  const est = estimateCost(C.type, parseInt(C.slots, 10) || 0, parseInt(C.watchMins, 10) || 1);
  const chips = Object.keys(TASK_LABEL).map(t =>
    `<button class="chip ${C.type === t ? 'active' : ''}" onclick="setCType('${t}')">${TASK_ICON[t]} ${TASK_LABEL[t]}</button>`).join('');
  const myList = S.myTasks.length ? S.myTasks.map(t => `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <b>${TASK_ICON[t.task_type] || ''} ${TASK_LABEL[t.task_type] || t.task_type}</b>
        <span class="badge ${esc(t.status)}">${esc(t.status)}</span>
      </div>
      <div class="hint">${t.completions_count}/${t.total_slots} done · ${t.progress_pct}%</div>
      <div style="display:flex;gap:8px;margin-top:10px">
        ${t.can_pause ? `<button class="btn small secondary" onclick="campaignAction(${t.id},'pause')">Pause</button>` : ''}
        ${t.can_resume ? `<button class="btn small secondary" onclick="campaignAction(${t.id},'resume')">Resume</button>` : ''}
        ${t.can_cancel ? `<button class="btn small danger-outline" onclick="campaignAction(${t.id},'cancel')">Cancel</button>` : ''}
      </div>
    </div>`).join('') : `<div class="empty">No campaigns yet — create one above!</div>`;
  return vHeader('Grow') + `
  <div class="screen">
    <div class="label">Campaign type</div>
    <div class="chips">${chips}</div>
    ${needsVideo ? `<div class="label">Your video URL</div>
      <input id="c-video" type="url" placeholder="https://youtube.com/watch?v=…" value="${esc(C.videoUrl)}" oninput="C.videoUrl=this.value">` : ''}
    ${C.type === 'watch' ? `<div class="label">Minutes to watch (1–60)</div>
      <input id="c-mins" type="number" min="1" max="60" value="${esc(C.watchMins)}" oninput="C.watchMins=this.value">` : ''}
    <div class="label">How many ${C.type === 'subscribe' ? 'subscribers' : 'completions'}?</div>
    <input id="c-slots" type="number" min="1" placeholder="10" value="${esc(C.slots)}" oninput="C.slots=this.value" onchange="render()">
    <div class="pricebox">≈ <b>${est}</b> coins total (${est && C.slots ? Math.round(est / (parseInt(C.slots, 10) || 1)) : SLOT_COSTS[C.type]}/slot — earner gets ${REWARDS[C.type]}${C.type === 'watch' ? ' + 1/extra min' : ''}). Final price confirmed by server.</div>
    <button class="btn" style="margin-top:14px" onclick="createCampaign()" ${C.creating ? 'disabled' : ''}>${C.creating ? 'Creating…' : 'Create Campaign'}</button>
    ${C.error ? `<p class="error">${esc(C.error)}</p>` : ''}${C.ok ? `<p class="success-text">${esc(C.ok)}</p>` : ''}
    <div class="label" style="margin-top:26px">My campaigns</div>
    ${myList}
  </div>`;
}

function vWallet() {
  const list = S.txs.length ? S.txs.map(tx => `
    <div class="tx">
      <div><div class="d">${esc(txText(tx.description))}</div><div class="t">${new Date(tx.created_at).toLocaleString()}</div></div>
      <div class="amt ${tx.type === 'spent' ? 'minus' : 'plus'}">${tx.type === 'spent' ? '−' : '+'}${tx.amount}</div>
    </div>`).join('') : `<div class="empty">No transactions yet.</div>`;
  return vHeader('Wallet') + `<div class="screen"><div class="card">${list}</div></div>`;
}

function vProfile() {
  const u = S.user || {};
  return vHeader('Profile') + `
  <div class="screen">
    <div class="profile-head">
      ${u.avatar ? `<img src="${esc(u.avatar)}" alt="" referrerpolicy="no-referrer">` : `<div class="ph">${esc((u.name || 'U')[0].toUpperCase())}</div>`}
      <h2>${esc(u.name || '')}</h2>
      <div class="email">${esc(u.email || '')}</div>
    </div>
    <div class="card">
      <div class="row"><span class="l">Coins</span><span class="v" style="color:var(--gold)">🪙 ${u.coins ?? 0}</span></div>
      <div class="row"><span class="l">Role</span><span class="v">${esc(u.role || 'user')}</span></div>
      ${u.youtube_channel_id ? `<div class="row"><span class="l">Channel</span><span class="v">✅ Linked</span></div>` : ''}
    </div>
    <div class="card">
      <div class="row"><span class="l">Support</span><a class="v" href="mailto:support@viralboostnow.com">support@viralboostnow.com</a></div>
      <div class="row"><span class="l">Privacy</span><a class="v" href="https://viralboostnow.com/privacy.html" target="_blank" rel="noopener">View</a></div>
      <div class="row"><span class="l">Terms</span><a class="v" href="https://viralboostnow.com/terms.html" target="_blank" rel="noopener">View</a></div>
    </div>
    <button class="btn secondary" style="margin-top:8px" onclick="signOut()">Sign Out</button>
    <button class="btn danger-outline" style="margin-top:26px" onclick="deleteAccount()">Delete Account</button>
  </div>`;
}

function vTabbar() {
  const tabs = [['earn', '📋', 'Earn'], ['grow', '📈', 'Grow'], ['wallet', '🪙', 'Wallet'], ['profile', '👤', 'Profile']];
  return `<div class="tabbar">${tabs.map(([k, i, l]) =>
    `<button class="${S.tab === k ? 'active' : ''}" onclick="loadTab('${k}')"><span class="ico">${i}</span>${l}</button>`).join('')}</div>`;
}

// ── glue ──────────────────────────────────────────────────────────────────────
function setFilter(t) { S.taskFilter = t; loadTab('earn'); }
function setCType(t) { C.type = t; C.error = ''; C.ok = ''; render(); }

function render() {
  const root = document.getElementById('app');
  if (!S.token) { root.innerHTML = vLogin(); return; }
  const view = { earn: vEarn, grow: vGrow, wallet: vWallet, profile: vProfile }[S.tab] || vEarn;
  root.innerHTML = view() + vTabbar() + vModal();
}

// expose handlers used in inline HTML
Object.assign(window, { signIn, signOut, loadTab, setFilter, setCType, openTask, closeModal, modalOpenYouTube, modalVerify, createCampaign, campaignAction, deleteAccount, render, C });

(async function init() {
  if (S.token) {
    try { S.user = (await api.me()).user; await loadTab('earn'); }
    catch { /* expired token already handled */ render(); }
  } else render();
})();
