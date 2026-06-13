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
  if (res.status === 401 && S.token) { signOut(); throw new Error(tr('common.sessionExpired')); }
  if (!res.ok) { const e = new Error(data.error || tr('common.requestFailed')); e.code = data.code; e.data = data; throw e; }
  return data;
}
const api = {
  signIn: (code) => req('POST', '/auth/google', { serverAuthCode: code, web: true }),
  // /users/me returns the user object directly (not wrapped in {user}); normalize either shape
  me: () => req('GET', '/users/me').then(d => (d && d.user) ? d.user : d),
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
  if (!window.google?.accounts?.oauth2) { S.loginError = tr('login.loading'); return render(); }
  const codeClient = google.accounts.oauth2.initCodeClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: YT_SCOPE,
    ux_mode: 'popup',
    callback: async (resp) => {
      if (!resp.code) { S.loginError = tr('login.cancelled'); return render(); }
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
  const type = parts.type ? taskLabel(parts.type) : '';
  switch (key) {
    case 'welcome_bonus': return tr('tx.welcome');
    case 'campaign_created': return tr('tx.created', { type, slots: parts.slots }) + (parts.free ? tr('tx.free') : '');
    case 'task_completed': return tr('tx.completed', { type });
    case 'task_completed_comment': return tr('tx.completedComment', { type });
    case 'campaign_refund': return tr('tx.refund');
    case 'coins_reclaimed': return tr('tx.reclaimed', { type });
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
    else if (tab === 'profile') S.user = (await api.me()) || S.user;
    if (tab !== 'profile' && S.token) { api.me().then(d => { S.user = d; render(); }).catch(() => {}); }
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
    api.me().then(d => { S.user = d; render(); }).catch(() => {});
    S.tasks = S.tasks.filter(t => t.id !== m.task.id);
  } catch (e) {
    m.status = 'ready';
    m.error = e.data?.remaining ? tr('modal.waitMore', { s: e.data.remaining }) : e.message;
  }
  render();
}

// ── create campaign ───────────────────────────────────────────────────────────
const C = { type: 'subscribe', slots: '', videoUrl: '', watchMins: '1', creating: false, error: '', ok: '' };

async function createCampaign() {
  C.error = ''; C.ok = '';
  const slots = parseInt(C.slots, 10);
  if (!slots || slots < 1) { C.error = tr('grow.errSlots'); return render(); }
  const needsVideo = C.type !== 'subscribe';
  if (needsVideo && !C.videoUrl.trim()) { C.error = tr('grow.errVideo'); return render(); }
  const needsChannel = ['subscribe', 'subscribe_like'].includes(C.type);
  const channel = S.channels[0];
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

// ── views ─────────────────────────────────────────────────────────────────────
function vLogin() {
  return `
  <div class="center">
    <div class="logo">📺</div>
    <h1 style="font-size:28px">SubsShare</h1>
    <p style="color:var(--text2);margin:10px 0 30px;line-height:1.5">${tr('login.tagline')}</p>
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
    <div class="card task" onclick='openTask(${JSON.stringify(t).replace(/'/g, '&#39;')})'>
      <div class="avatar">${t.owner_avatar ? `<img src="${esc(t.owner_avatar)}" alt="" referrerpolicy="no-referrer">` : (TASK_ICON[t.task_type] || '📺')}</div>
      <div class="info">
        <div class="name">${esc(t.channel_name || t.owner_name)}</div>
        <div class="meta">${taskLabel(t.task_type)}${t.task_type === 'watch' ? ` · ${t.watch_minutes} ${tr('earn.min')}` : ''} · ${t.remaining_slots} ${tr('earn.left')}</div>
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
  const est = estimateCost(C.type, parseInt(C.slots, 10) || 0, parseInt(C.watchMins, 10) || 1);
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
    ${needsVideo ? `<div class="label">${tr('grow.videoUrl')}</div>
      <input id="c-video" type="url" placeholder="https://youtube.com/watch?v=…" value="${esc(C.videoUrl)}" oninput="C.videoUrl=this.value">` : ''}
    ${C.type === 'watch' ? `<div class="label">${tr('grow.minutes')}</div>
      <input id="c-mins" type="number" min="1" max="60" value="${esc(C.watchMins)}" oninput="C.watchMins=this.value">` : ''}
    <div class="label">${C.type === 'subscribe' ? tr('grow.howManySubs') : tr('grow.howManyCompletions')}</div>
    <input id="c-slots" type="number" min="1" placeholder="10" value="${esc(C.slots)}" oninput="C.slots=this.value" onchange="render()">
    <div class="pricebox">${tr('grow.price', { cost: `<b>${est}</b>`, per: (est && C.slots ? Math.round(est / (parseInt(C.slots, 10) || 1)) : SLOT_COSTS[C.type]), reward: REWARDS[C.type], extra: (C.type === 'watch' ? tr('grow.extraMin') : '') })}</div>
    <button class="btn" style="margin-top:14px" onclick="createCampaign()" ${C.creating ? 'disabled' : ''}>${C.creating ? tr('grow.creating') : tr('grow.create')}</button>
    ${C.error ? `<p class="error">${esc(C.error)}</p>` : ''}${C.ok ? `<p class="success-text">${esc(C.ok)}</p>` : ''}
    <div class="label" style="margin-top:26px">${tr('grow.mine')}</div>
    ${myList}
  </div>`;
}

function vWallet() {
  const list = S.txs.length ? S.txs.map(tx => `
    <div class="tx">
      <div><div class="d">${esc(txText(tx.description))}</div><div class="t">${new Date(tx.created_at).toLocaleString()}</div></div>
      <div class="amt ${tx.type === 'spent' ? 'minus' : 'plus'}">${tx.type === 'spent' ? '−' : '+'}${tx.amount}</div>
    </div>`).join('') : `<div class="empty">${tr('wallet.none')}</div>`;
  return vHeader(tr('wallet.title')) + `<div class="screen"><div class="card">${list}</div></div>`;
}

function vProfile() {
  const u = S.user || {};
  const langOpts = Object.entries(window.I18N.LANGS).map(([code, info]) =>
    `<option value="${code}" ${code === window.I18N.getLang() ? 'selected' : ''}>${info.flag} ${esc(info.native)}</option>`).join('');
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
        <select onchange="changeLang(this.value)" style="width:auto;padding:8px 12px;font-weight:600">${langOpts}</select></div>
    </div>
    <div class="card">
      <div class="row"><span class="l">${tr('profile.support')}</span><a class="v" href="mailto:support@viralboostnow.com">support@viralboostnow.com</a></div>
      <div class="row"><span class="l">${tr('common.privacy')}</span><a class="v" href="https://viralboostnow.com/privacy.html" target="_blank" rel="noopener">↗</a></div>
      <div class="row"><span class="l">${tr('common.terms')}</span><a class="v" href="https://viralboostnow.com/terms.html" target="_blank" rel="noopener">↗</a></div>
    </div>
    <button class="btn secondary" style="margin-top:8px" onclick="signOut()">${tr('profile.signOut')}</button>
    <button class="btn danger-outline" style="margin-top:26px" onclick="deleteAccount()">${tr('profile.deleteAccount')}</button>
  </div>`;
}

function vTabbar() {
  const tabs = [['earn', '📋'], ['grow', '📈'], ['wallet', '🪙'], ['profile', '👤']];
  return `<div class="tabbar">${tabs.map(([k, i]) =>
    `<button class="${S.tab === k ? 'active' : ''}" onclick="loadTab('${k}')"><span class="ico">${i}</span>${tr('tabs.' + k)}</button>`).join('')}</div>`;
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
Object.assign(window, { signIn, signOut, loadTab, setFilter, setCType, openTask, closeModal, modalOpenYouTube, modalVerify, createCampaign, campaignAction, deleteAccount, changeLang, render, C });

(async function init() {
  if (S.token) {
    try { S.user = await api.me(); await loadTab('earn'); }
    catch { /* expired token already handled */ render(); }
  } else render();
})();
