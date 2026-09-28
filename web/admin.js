// Copyright (c) 2026 Johannes Thorén. All rights reserved.
// Licensed under the LGJT License v1. See LICENSE in the project root.
// Veil admin: invites and accounts. Talks to /admin/api with an HttpOnly session cookie.
import QRCode from 'qrcode';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const formatId = (id) => id.match(/.{1,4}/g).join('-');
const inviteLink = (code) => `${location.origin}/#invite=${code}`;

const I = {
  logo: '',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM21 14v.01M14 21h.01M17 21h4v-4"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13"/>',
};
const icon = (n, style = '') => `<svg class="i" ${style ? `style="${style}"` : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;
const LOGO = '<svg class="logo" viewBox="0 0 48 48" aria-hidden="true" style="width:30px;height:30px"><rect width="48" height="48" rx="14" fill="var(--accent)"/><path d="M14 15.5l10 18 10-18" fill="none" stroke="var(--accent-ink)" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---------- theme (shared preference with the app) ----------
const darkMq = matchMedia('(prefers-color-scheme: dark)');
const getTheme = () => { try { return localStorage.getItem('veil-theme') || 'system'; } catch { return 'system'; } };
const isDark = () => getTheme() === 'dark' || (getTheme() === 'system' && darkMq.matches);
function toggleTheme() {
  const t = isDark() ? 'light' : 'dark';
  try { localStorage.setItem('veil-theme', t); } catch { /* ignore */ }
  document.documentElement.dataset.theme = t;
  $$('[data-theme-toggle]').forEach((b) => (b.innerHTML = icon(isDark() ? 'sun' : 'moon')));
}

// ---------- helpers ----------
async function api(method, route, body) {
  const res = await fetch(`/admin/api/${route}`, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}
let toastTimer;
function toast(text) {
  $('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3000);
}
async function copy(text, msg = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch { prompt('Copy this:', text); }
}
const qrSvg = (text) => QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#0b1116', light: '#ffffff' } });
function ago(ts) {
  if (!ts) return '—';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}
function until(ts) {
  if (ts == null) return 'Never';
  const s = (ts - Date.now()) / 1000;
  if (s <= 0) return new Date(ts).toLocaleDateString();
  if (s < 3600) return `in ${Math.ceil(s / 60)} min`;
  if (s < 86400) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86400)} d`;
}
const bytes = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
const STATUS = { active: ['ok', 'Active'], used: ['', 'Used up'], expired: ['', 'Expired'], revoked: ['warn', 'Revoked'] };

function modal(title, body, foot = '') {
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div><div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ''}</div>`;
  const close = () => { o.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  o.addEventListener('mousedown', (e) => { if (e.target === o) close(); });
  o.querySelector('[data-close]').onclick = close;
  document.addEventListener('keydown', onKey);
  document.body.append(o);
  return { el: o, close };
}
function confirmBox(title, text, ok) {
  return new Promise((resolve) => {
    const m = modal(title, `<p style="margin:0">${text}</p>`, `<button class="btn" data-no>Cancel</button><button class="btn danger" data-yes>${esc(ok)}</button>`);
    m.el.querySelector('[data-no]').onclick = () => { m.close(); resolve(false); };
    m.el.querySelector('[data-yes]').onclick = () => { m.close(); resolve(true); };
  });
}
async function showInviteQr(inv) {
  const link = inviteLink(inv.code);
  const m = modal(inv.label ? `Invite · ${inv.label}` : 'Invite', `
    <div class="qr">${await qrSvg(link)}</div>
    <div class="code" style="font-size:13px">${esc(link)}</div>
    <p class="muted small center" style="margin:0 0 14px">Scan with a phone camera, or send the link. It opens Veil ready to create an identity.</p>
    <div class="row" style="justify-content:center"><button class="btn" data-copy>${icon('copy')} Copy link</button>${navigator.share ? `<button class="btn" data-share>${icon('share')} Share</button>` : ''}</div>`);
  m.el.querySelector('[data-copy]').onclick = () => copy(link, 'Invite link copied');
  const sh = m.el.querySelector('[data-share]');
  if (sh) sh.onclick = () => navigator.share({ title: 'Join me on Veil', url: link }).catch(() => {});
}

// ---------- login ----------
function renderLogin(error = '') {
  $('#app').innerHTML = `
    <div class="welcome"><div class="welcome-top"><button class="icon-btn" data-theme-toggle aria-label="Toggle theme">${icon(isDark() ? 'sun' : 'moon')}</button></div>
    <div class="welcome-inner" style="max-width:380px">
      <div class="brand">${LOGO.replace('width:30px;height:30px', 'width:40px;height:40px')}<h1>Veil admin</h1></div>
      <form class="card" id="login" style="margin-top:18px">
        <label class="field"><span>Admin token</span><input class="input mono" id="token" type="password" autocomplete="current-password" required autofocus></label>
        ${error ? `<p style="color:var(--danger);margin:-4px 0 12px;font-size:14px">${esc(error)}</p>` : ''}
        <button class="btn primary block" type="submit">Sign in</button>
        <p class="muted small" style="margin:14px 0 0">The token is printed in the server log on first start and stored in <span class="mono">admin-token</span> next to the database (<span class="mono">/data/admin-token</span> in Docker). Set <span class="mono">ADMIN_TOKEN</span> to choose your own.</p>
      </form>
    </div></div>`;
  $('[data-theme-toggle]').onclick = toggleTheme;
  $('#login').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('POST', 'login', { token: $('#token').value.trim() });
      start();
    } catch (err) {
      renderLogin(err.message);
    }
  };
}

// ---------- dashboard ----------
const state = { data: null, showInactive: false, accountFilter: '', lastInvite: null };
let refreshTimer;

async function start() {
  try {
    state.data = await api('GET', 'overview');
  } catch (e) {
    if (e.status === 401) return renderLogin();
    return toast(e.message);
  }
  renderShell();
  renderData();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, 15000);
}
async function refresh() {
  try { state.data = await api('GET', 'overview'); renderData(); } catch (e) { if (e.status === 401) { clearInterval(refreshTimer); renderLogin('Session expired — sign in again'); } }
}

function renderShell() {
  $('#app').innerHTML = `
  <div class="admin">
    <header class="admin-top">
      <div class="title">${LOGO}<span>Veil</span><span class="pill">Admin</span></div>
      <a class="btn sm" href="/" target="_blank" rel="noopener">${icon('ext')} Open app</a>
      <button class="icon-btn" data-theme-toggle aria-label="Toggle theme">${icon(isDark() ? 'sun' : 'moon')}</button>
      <button class="icon-btn" id="logout" title="Sign out" aria-label="Sign out">${icon('logout')}</button>
    </header>
    <main class="admin-main">
      <section class="stats" id="stats"></section>

      <section class="card">
        <h2>Create an invite</h2>
        <p>Nobody can create an identity without an invite. People who already have one can link more devices without one.</p>
        <form id="new-invite" class="form-row">
          <label class="field span"><span>Label (only you see it)</span><input class="input" id="inv-label" maxlength="80" placeholder="e.g. Mom, Book club"></label>
          <label class="field"><span>Can be used</span>
            <select class="input" id="inv-uses"><option value="1">Once</option><option value="5">5 times</option><option value="25">25 times</option><option value="">Unlimited</option></select></label>
          <label class="field"><span>Expires</span>
            <select class="input" id="inv-exp"><option value="24">In 24 hours</option><option value="168" selected>In 7 days</option><option value="720">In 30 days</option><option value="">Never</option></select></label>
          <div class="field"><button class="btn primary" type="submit">${icon('plus')} Create invite</button></div>
        </form>
        <div id="inv-result"></div>
      </section>

      <section class="card">
        <div class="row" style="margin-bottom:6px"><h2 class="grow" style="margin:0">Invites</h2>
          <label class="row small muted" style="cursor:pointer"><input type="checkbox" class="check" id="show-inactive"> Show used, expired and revoked</label></div>
        <div class="table-wrap" id="invites"></div>
      </section>

      <section class="card">
        <div class="row" style="margin-bottom:6px"><h2 class="grow" style="margin:0">Identities</h2>
          <input class="input" id="acc-filter" placeholder="Filter by ID or invite" style="max-width:240px;height:36px"></div>
        <p style="margin:0 0 8px">The server only knows each identity's random ID, when it joined, via which invite, and its devices. Names, contacts and messages stay on people's devices.</p>
        <div class="table-wrap" id="accounts"></div>
      </section>
    </main>
  </div>`;
  $$('[data-theme-toggle]').forEach((b) => (b.onclick = toggleTheme));
  $('#logout').onclick = async () => { await api('POST', 'logout', {}).catch(() => {}); clearInterval(refreshTimer); renderLogin(); };
  $('#show-inactive').onchange = (e) => { state.showInactive = e.target.checked; renderData(); };
  $('#acc-filter').oninput = (e) => { state.accountFilter = e.target.value.toLowerCase().replace(/-/g, ''); renderData(); };
  $('#new-invite').onsubmit = async (e) => {
    e.preventDefault();
    const uses = $('#inv-uses').value, exp = $('#inv-exp').value;
    try {
      const { invite } = await api('POST', 'invites', {
        label: $('#inv-label').value.trim(),
        maxUses: uses ? Number(uses) : null,
        expiresInHours: exp ? Number(exp) : null,
      });
      state.lastInvite = invite;
      $('#inv-label').value = '';
      await renderInviteResult();
      refresh();
    } catch (err) { toast(err.message); }
  };
}

async function renderInviteResult() {
  const inv = state.lastInvite;
  const box = $('#inv-result');
  if (!inv || !box) return;
  const link = inviteLink(inv.code);
  box.innerHTML = `<div class="invite-result">
    <div style="min-width:0">
      <div style="font-weight:650;margin-bottom:6px">Invite ready${inv.label ? ` · ${esc(inv.label)}` : ''}</div>
      <div class="code" style="font-size:13px;margin-bottom:10px;text-align:left">${esc(link)}</div>
      <div class="row" style="flex-wrap:wrap"><button class="btn primary sm" data-copy>${icon('copy')} Copy link</button>${navigator.share ? `<button class="btn sm" data-share>${icon('share')} Share</button>` : ''}
        <span class="muted small">${inv.maxUses == null ? 'Unlimited uses' : inv.maxUses === 1 ? 'Single use' : `${inv.maxUses} uses`} · expires ${until(inv.expires).replace(/^in /, 'in ')}</span></div>
    </div>
    <div class="qr">${await qrSvg(link)}</div>
  </div>`;
  box.querySelector('[data-copy]').onclick = () => copy(link, 'Invite link copied');
  const sh = box.querySelector('[data-share]');
  if (sh) sh.onclick = () => navigator.share({ title: 'Join me on Veil', url: link }).catch(() => {});
}

function renderData() {
  const { stats, invites, accounts } = state.data;
  const tile = (n, l) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  $('#stats').innerHTML = [
    tile(stats.accounts, 'Identities'),
    tile(stats.devices, 'Devices'),
    tile(stats.online, 'Online now'),
    tile(stats.activeInvites, 'Active invites'),
    tile(stats.queued, 'Messages waiting'),
    tile(`${stats.blobs}<span class="muted" style="font-size:14px;font-weight:500"> · ${bytes(stats.blobBytes)}</span>`, 'Images stored'),
  ].join('');

  const shown = invites.filter((i) => state.showInactive || i.status === 'active');
  $('#invites').innerHTML = shown.length ? `<table class="tbl"><thead><tr><th>Label</th><th>Status</th><th>Used</th><th>Expires</th><th>Created</th><th></th></tr></thead><tbody>
    ${shown.map((i) => `<tr>
      <td>${i.label ? esc(i.label) : '<span class="muted">—</span>'}</td>
      <td><span class="pill ${STATUS[i.status][0]}">${STATUS[i.status][1]}</span></td>
      <td>${i.uses} / ${i.maxUses ?? '∞'}</td>
      <td>${until(i.expires)}</td>
      <td class="muted">${ago(i.created)}</td>
      <td class="actions">${i.status === 'active' ? `
        <button class="icon-btn" data-copy="${i.code}" title="Copy link" aria-label="Copy link">${icon('copy')}</button>
        <button class="icon-btn" data-qr="${i.code}" title="Show QR" aria-label="Show QR">${icon('qr')}</button>
        <button class="icon-btn" data-revoke="${i.code}" title="Revoke" aria-label="Revoke">${icon('ban')}</button>`
        : `<button class="icon-btn" data-del="${i.code}" title="Remove from list" aria-label="Remove">${icon('trash')}</button>`}</td>
    </tr>`).join('')}</tbody></table>`
    : `<p class="muted" style="margin:8px 0">${invites.length ? 'No active invites.' : 'No invites yet. Create one above.'}</p>`;
  const byCode = Object.fromEntries(invites.map((i) => [i.code, i]));
  $$('[data-copy]', $('#invites')).forEach((b) => (b.onclick = () => copy(inviteLink(b.dataset.copy), 'Invite link copied')));
  $$('[data-qr]', $('#invites')).forEach((b) => (b.onclick = () => showInviteQr(byCode[b.dataset.qr])));
  $$('[data-revoke]', $('#invites')).forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox('Revoke invite?', 'The link stops working immediately. Identities already created with it are not affected.', 'Revoke'))) return;
    await api('POST', `invites/${b.dataset.revoke}/revoke`, {}).catch((e) => toast(e.message));
    refresh();
  }));
  $$('[data-del]', $('#invites')).forEach((b) => (b.onclick = async () => { await api('DELETE', `invites/${b.dataset.del}`, {}).catch((e) => toast(e.message)); refresh(); }));

  const f = state.accountFilter;
  const acc = accounts.filter((a) => !f || a.id.includes(f) || (a.invite?.label ?? '').toLowerCase().includes(f));
  $('#accounts').innerHTML = acc.length ? `<table class="tbl"><thead><tr><th>ID</th><th>Invite</th><th>Devices</th><th>Last active</th><th>Joined</th><th></th></tr></thead><tbody>
    ${acc.map((a) => `<tr>
      <td class="mono">${formatId(a.id)}</td>
      <td>${a.invite ? (a.invite.label ? esc(a.invite.label) : '<span class="muted">unlabelled</span>') : '<span class="muted">before invites</span>'}</td>
      <td>${a.devices}</td>
      <td>${ago(a.lastSeen)}</td>
      <td class="muted">${ago(a.created)}</td>
      <td class="actions"><button class="icon-btn" data-delacc="${a.id}" title="Delete identity" aria-label="Delete identity">${icon('trash')}</button></td>
    </tr>`).join('')}</tbody></table>`
    : `<p class="muted" style="margin:8px 0">${accounts.length ? 'No matches.' : 'No identities yet.'}</p>`;
  $$('[data-delacc]', $('#accounts')).forEach((b) => (b.onclick = async () => {
    const id = b.dataset.delacc;
    if (!(await confirmBox('Delete identity?', `<span class="mono">${formatId(id)}</span> and all its devices are removed from the server and signed out. Messages waiting for it are deleted. This can't be undone.`, 'Delete'))) return;
    await api('DELETE', `accounts/${id}`, {}).catch((e) => toast(e.message));
    refresh();
  }));
}

start();
