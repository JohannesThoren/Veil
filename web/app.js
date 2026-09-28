// Copyright (c) 2026 Johannes Thorén. All rights reserved.
// Licensed under the LGJT License v1. See LICENSE in the project root.

import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { VeilClient, IdentityChangedError, MAX_ATTACHMENT } from '../client/core.js';
import { IdbStore } from '../client/store.js';
import { formatId } from '../shared/crypto.js';

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const store = new IdbStore('veil');
let client = null;
const ui = { chatId: null, search: '', drafts: {}, renderQueued: false, urls: new Map() };
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const I = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM21 14v.01M14 21h.01M17 21h4v-4"/>',
  send: '<path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4Z"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  shieldCheck: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M12 18h.01"/>',
  laptop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13"/>',
  eyeOff: '<path d="M9.9 4.2A10 10 0 0 1 12 4c7 0 10 8 10 8a17 17 0 0 1-2.2 3.3M6.6 6.6A17 17 0 0 0 2 12s3 8 10 8a10 10 0 0 0 5.4-1.6M2 2l20 20M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  bellOff: '<path d="M8.7 3A6 6 0 0 1 18 8a21 21 0 0 0 .6 5M17 17H3s3-2 3-9a4.7 4.7 0 0 1 .3-1.7M10.3 21a1.9 1.9 0 0 0 3.4 0M2 2l20 20"/>',
  install: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 7v7M9 11l3 3 3-3M10 18h4"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
};
const icon = (n, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;
const LOGO = '<svg class="logo" viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="14" fill="var(--accent)"/><path d="M14 15.5l10 18 10-18" fill="none" stroke="var(--accent-ink)" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const hue = (id) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const initial = (name) => (name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();
const avatar = (id, name, cls = '') => `<div class="avatar ${cls}" style="--h:${hue(id)}">${esc(initial(name))}</div>`;

function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (now - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function dayLabel(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === new Date(now - 864e5).toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const linkify = (s) => esc(s).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)"'\]]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);

function deviceLabel() {
  const ua = navigator.userAgent;
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} on ${os}` : b;
}

let toastTimer;
function toast(text) {
  $('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3200);
}
function errText(e) {
  if (e instanceof IdentityChangedError) return 'Safety warning: this contact’s key changed on the server. Messages were not sent.';
  return e?.message ?? String(e);
}
async function copy(text, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(what); } catch { toast('Copy failed — select and copy manually'); }
}
const qrSvg = (text) => QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#0b1116', light: '#ffffff' } });

// ------------------------------------------------------------------ theme
const darkMq = matchMedia('(prefers-color-scheme: dark)');
function getTheme() { try { return localStorage.getItem('veil-theme') || 'system'; } catch { return 'system'; } }
const isDark = () => getTheme() === 'dark' || (getTheme() === 'system' && darkMq.matches);
function setTheme(t) {
  try { t === 'system' ? localStorage.removeItem('veil-theme') : localStorage.setItem('veil-theme', t); } catch { /* not persisted */ }
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  syncTheme();
}
function syncTheme() {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--panel').trim();
  $$('meta[name="theme-color"]').forEach((m) => { m.removeAttribute('media'); m.content = color; });
  $$('[data-theme-toggle]').forEach((b) => { b.innerHTML = icon(isDark() ? 'sun' : 'moon'); b.title = isDark() ? 'Light theme' : 'Dark theme'; });
  $$('[data-theme-set]').forEach((b) => b.classList.toggle('on', b.dataset.themeSet === getTheme()));
}
darkMq.addEventListener('change', syncTheme);
const themeToggle = () => `<button class="icon-btn" data-theme-toggle aria-label="Toggle dark theme">${icon(isDark() ? 'sun' : 'moon')}</button>`;
function wireThemeToggles(root = document) {
  $$('[data-theme-toggle]', root).forEach((b) => (b.onclick = () => setTheme(isDark() ? 'light' : 'dark')));
  $$('[data-theme-set]', root).forEach((b) => (b.onclick = () => setTheme(b.dataset.themeSet)));
}

// ------------------------------------------------------------------ install as app
let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const canInstall = () => !isStandalone() && (!!installPrompt || isIOS());
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; refreshInstallUI(); });
window.addEventListener('appinstalled', () => { installPrompt = null; refreshInstallUI(); toast('Veil is installed'); });
function refreshInstallUI() {
  $$('[data-install]').forEach((b) => b.classList.toggle('hidden', !canInstall()));
  $('.side-foot')?.classList.toggle('hidden', !canInstall());
}
const installButton = (cls = 'btn') => `<button class="${cls} ${canInstall() ? '' : 'hidden'}" data-install>${icon('install')} Install app</button>`;
function wireInstall(root = document) { $$('[data-install]', root).forEach((b) => (b.onclick = installApp)); }
async function installApp() {
  if (installPrompt) {
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') installPrompt = null;
    refreshInstallUI();
    return;
  }
  openModal({
    title: 'Install Veil',
    body: `<ol style="margin:0;padding-left:20px;display:grid;gap:10px">
      <li>Tap the <b>Share</b> button ${icon('share', 'i" style="width:16px;height:16px;vertical-align:-3px')} in Safari’s toolbar.</li>
      <li>Choose <b>Add to Home Screen</b>.</li>
      <li>Open Veil from your home screen, then turn on notifications in Settings.</li></ol>
      <p class="muted small" style="margin:14px 0 0">On iPhone and iPad, notifications only work once Veil is added to the home screen.</p>`,
  });
}

// ------------------------------------------------------------------ notifications
// Two paths, both ending in the same notification (same tag = chat id, so they replace each other):
//  • the app is running: it decrypts the message and shows the text;
//  • the app is closed/suspended: the relay sends a Web Push with no content; the service worker
//    looks up the sender's name locally and shows “Name: new message”.
const notifSupported = () => 'Notification' in window && 'serviceWorker' in navigator;
const pushSupported = () => notifSupported() && 'PushManager' in window && window.isSecureContext;
const notifOff = () => { try { return localStorage.getItem('veil-notify') === 'off'; } catch { return false; } };
const setNotifOff = (off) => { try { off ? localStorage.setItem('veil-notify', 'off') : localStorage.removeItem('veil-notify'); } catch { /* ignore */ } };
function b64uToBytes(s) { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); }

async function subscribePush() {
  if (!pushSupported() || Notification.permission !== 'granted' || notifOff()) return false;
  const reg = await navigator.serviceWorker.ready;
  const key = await client.pushKey();
  let sub = await reg.pushManager.getSubscription();
  const current = sub?.options?.applicationServerKey;
  if (sub && current && btoa(String.fromCharCode(...new Uint8Array(current))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== key) {
    await sub.unsubscribe(); sub = null; // relay's key changed
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
  await client.setPushSubscription(sub.toJSON());
  return true;
}

async function enableNotifications() {
  if (!notifSupported()) { toast('This browser doesn’t support notifications'); return 'unsupported'; }
  if (isIOS() && !isStandalone()) { installApp(); return 'install-first'; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Notifications are blocked in your browser settings'); return perm; }
  setNotifOff(false);
  try {
    const ok = await subscribePush();
    toast(ok ? 'Notifications on — even when Veil is closed' : 'Notifications on while Veil is open');
  } catch (e) {
    toast('Notifications on while Veil is open (push unavailable: ' + (e.message || e) + ')');
  }
  scheduleRender();
  return perm;
}
async function disableNotifications() {
  setNotifOff(true);
  try {
    const reg = await navigator.serviceWorker?.ready;
    await (await reg?.pushManager?.getSubscription())?.unsubscribe();
  } catch { /* ignore */ }
  await client.setPushSubscription(null).catch(() => {});
  toast('Notifications off on this device');
  scheduleRender();
}
function notifState() {
  if (!notifSupported()) return 'unsupported';
  if (notifOff()) return 'off';
  if (Notification.permission === 'granted') return 'on';
  if (Notification.permission === 'denied') return 'blocked';
  return 'ask';
}

async function clearChatNotifications(chatId) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    for (const n of (await reg?.getNotifications({ tag: chatId })) ?? []) n.close();
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------ images
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

async function prepareImage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let w = null, h = null, thumb = null;
  try {
    const bmp = await createImageBitmap(file);
    w = bmp.width; h = bmp.height;
    const scale = 24 / Math.max(w, h);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    thumb = c.toDataURL('image/jpeg', 0.6);
    bmp.close();
  } catch { /* format the browser can't decode (e.g. HEIC): send without preview */ }
  return { bytes, mime: file.type, name: file.name || 'image', w, h, thumb };
}

function pickImages(fileList) {
  const chatId = ui.chatId;
  if (!chatId || !$('#composer')) return;
  let files = [...fileList].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return toast('Only images can be sent');
  const big = files.filter((f) => f.size > MAX_ATTACHMENT);
  if (big.length) toast(`${big.length === 1 ? `“${big[0].name}” is` : `${big.length} images are`} over 50 MB and can’t be sent`);
  files = files.filter((f) => f.size <= MAX_ATTACHMENT);
  if (files.length > 10) { files = files.slice(0, 10); toast('Up to 10 images at a time'); }
  if (!files.length) return;
  const urls = files.map((f) => URL.createObjectURL(f));
  const m = openModal({
    title: files.length > 1 ? `Send ${files.length} images` : 'Send image',
    body: `<div class="pick-grid" style="${files.length === 1 ? 'grid-template-columns:1fr' : ''}">${files.map((f, i) => `
        <figure style="${files.length === 1 ? 'aspect-ratio:4/3' : ''}"><img src="${urls[i]}" alt=""><figcaption>${esc(f.name || 'image')} · ${fmtSize(f.size)}</figcaption></figure>`).join('')}</div>
      <input class="input" id="pk-cap" placeholder="Add a caption (optional)" maxlength="2000" autocomplete="off">
      <p class="muted small" style="margin:10px 0 0">${icon('lock', 'i" style="width:13px;height:13px;vertical-align:-2px')} Encrypted on this device before upload. Max 50 MB per image.</p>`,
    foot: '<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>' + icon('send') + ' Send</button>',
    onClose: () => setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 1000),
  });
  const cap = $('#pk-cap', m.el);
  cap.value = $('#composer')?.value.trim() ?? '';
  setTimeout(() => cap.focus(), 50);
  const send = async () => {
    const caption = cap.value;
    m.close();
    if ($('#composer') && caption && caption === $('#composer').value.trim()) { $('#composer').value = ''; ui.drafts[chatId] = ''; $('#composer').dispatchEvent(new Event('input')); }
    for (let i = 0; i < files.length; i++) {
      try {
        const attachment = await prepareImage(files[i]);
        await client.sendText(chatId, i === 0 ? caption : '', { attachment });
      } catch (e) { toast(errText(e)); }
    }
  };
  m.el.querySelector('[data-no]').onclick = m.close;
  m.el.querySelector('[data-yes]').onclick = send;
  cap.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); send(); } };
}

function imageBox(m) {
  const { w, h } = m.att;
  const maxW = 300, maxH = 360;
  let dw = 240, dh = 180;
  if (w && h) {
    const scale = Math.min(maxW / w, maxH / h, 1);
    dw = Math.max(140, Math.round(w * scale));
    dh = Math.max(90, Math.round(h * scale));
  }
  const url = ui.urls.get(m.att.id);
  const src = url ?? m.att.thumb;
  return `<button class="img-wrap" data-img="${esc(m.id)}" style="width:${dw}px;aspect-ratio:${dw}/${dh}" aria-label="Open image">
    <img alt="${esc(m.att.name || 'Image')}" ${src ? `src="${esc(src)}"` : ''} class="${url ? '' : 'blur'}">
    ${url ? '' : '<div class="img-state"><span class="spinner"></span></div>'}</button>`;
}

function loadImages(box, atts) {
  for (const el of $$('[data-img]', box)) {
    const msgId = el.dataset.img;
    const att = atts.get(msgId);
    el.onclick = () => openLightbox(att);
    if (ui.urls.has(att.id)) continue;
    client.getAttachment(att).then((bytes) => {
      if (!ui.urls.has(att.id)) ui.urls.set(att.id, URL.createObjectURL(new Blob([bytes], { type: att.mime })));
      const cur = $(`[data-img="${CSS.escape(msgId)}"]`);
      if (!cur) return;
      const img = cur.querySelector('img');
      img.src = ui.urls.get(att.id);
      img.classList.remove('blur');
      cur.querySelector('.img-state')?.remove();
    }).catch((e) => {
      const st = $(`[data-img="${CSS.escape(msgId)}"] .img-state`);
      if (st) st.textContent = /expired/.test(e.message) ? 'Expired' : 'Couldn’t load';
    });
  }
}

function openLightbox(att) {
  const url = ui.urls.get(att.id);
  if (!url) return;
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `<div class="bar"><a class="icon-btn" href="${url}" download="${esc(att.name || 'image')}" title="Save" aria-label="Save image">${icon('download')}</a>
    <button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="stage"><img src="${url}" alt="${esc(att.name || 'Image')}"></div>`;
  const close = () => { lb.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  lb.querySelector('[data-close]').onclick = close;
  lb.querySelector('.stage').onclick = (e) => { if (e.target.tagName !== 'IMG') close(); };
  document.addEventListener('keydown', onKey);
  document.body.append(lb);
}

// ------------------------------------------------------------------ modal
function openModal({ title, body = '', foot = '', wide = false, onClose }) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ''}</div>`;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('[data-close]').onclick = close;
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  const m = overlay.querySelector('.modal');
  return { el: m, body: m.querySelector('.modal-body'), close, set: (html) => { m.querySelector('.modal-body').innerHTML = html; } };
}
function confirmDialog({ title, text, ok = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const m = openModal({
      title, body: `<p style="margin:0">${text}</p>`,
      foot: `<button class="btn" data-no>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(ok)}</button>`,
      onClose: () => resolve(result),
    });
    m.el.querySelector('[data-no]').onclick = m.close;
    m.el.querySelector('[data-yes]').onclick = () => { result = true; m.close(); };
  });
}

// ------------------------------------------------------------------ QR scanner
function scanQR(hint = 'Point the camera at a Veil QR code') {
  return new Promise((resolve) => {
    let stream, raf, done = false;
    const m = openModal({
      title: 'Scan QR code',
      body: `<div class="scanner"><video playsinline muted></video><div class="frame"></div></div><p class="muted small center" data-msg>${esc(hint)}</p>`,
      onClose: () => { done = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); resolve(null); },
    });
    const video = m.el.querySelector('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
    const finish = (text) => {
      if (done) return;
      done = true;
      stream?.getTracks().forEach((t) => t.stop());
      m.close();
      resolve(text);
    };
    const tick = async () => {
      if (done) return;
      if (video.readyState >= 2) {
        try {
          if (detector) {
            const codes = await detector.detect(video);
            if (codes[0]) return finish(codes[0].rawValue);
          } else {
            const w = (canvas.width = Math.min(video.videoWidth, 640));
            const h = (canvas.height = Math.round(video.videoHeight * (w / video.videoWidth)));
            ctx.drawImage(video, 0, 0, w, h);
            const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
            if (code) return finish(code.data);
          }
        } catch { /* keep scanning */ }
      }
      raf = requestAnimationFrame(tick);
    };
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => { stream = s; if (done) return s.getTracks().forEach((t) => t.stop()); video.srcObject = s; video.play(); tick(); })
      .catch(() => {
        m.el.querySelector('[data-msg]').textContent = window.isSecureContext
          ? 'Camera unavailable or permission denied. Type the code instead.'
          : 'The camera needs HTTPS. Open Veil over https:// or type the code instead.';
      });
    if (!navigator.mediaDevices) m.el.querySelector('[data-msg]').textContent = 'The camera needs HTTPS. Type the code instead.';
  });
}

// ------------------------------------------------------------------ welcome
function renderWelcome({ code = '', invite = '' } = {}) {
  document.title = 'Veil';
  $('#app').innerHTML = `
  <div class="welcome"><div class="welcome-top">${themeToggle()}</div><div class="welcome-inner">
    <div class="brand">${LOGO}<h1>Veil</h1></div>
    <p class="tagline">Private messaging with no phone number, email or username.</p>
    <div class="card" id="w-create-card"></div>
    <div class="card">
      <h2>Link to an existing device</h2>
      <p>On a device already using Veil, open Settings → Link a new device. Then scan its QR or type its code here.</p>
      <div class="row" style="margin-bottom:12px">
        <input class="input grow mono" id="w-code" placeholder="xxxx-xxxx-xxxx-xxxx-xxxx-xxxx" value="${esc(code)}" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button class="btn" id="w-scan" aria-label="Scan QR">${icon('camera')}</button>
      </div>
      <button class="btn block" id="w-link">Link this device</button>
    </div>
    <div class="center" style="margin-top:4px">${installButton('btn')}</div>
    <ul class="points">
      <li>${icon('lock')}<span>End-to-end encrypted with the Signal protocol (X3DH + Double Ratchet). The server only relays ciphertext.</span></li>
      <li>${icon('eyeOff')}<span>No identifiers to leak: the server never learns your name, contacts or groups.</span></li>
      <li>${icon('phone')}<span>Use it on every device. Each one gets its own keys.</span></li>
    </ul>
  </div></div>`;

  wireThemeToggles();
  wireInstall();
  paintCreateCard(invite ? { code: invite, checking: true } : {});
  if (invite) checkWelcomeInvite(invite);
  $('#w-scan').onclick = async () => {
    const text = await scanQR('Scan the QR shown under “Link a new device”');
    if (text) { $('#w-code').value = text; $('#w-link').click(); }
  };
  $('#w-link').onclick = () => joinFlow($('#w-code').value);
  $('#w-code').onkeydown = (e) => { if (e.key === 'Enter') $('#w-link').click(); };
}

// The “create identity” card: invite-only. Without a valid invite you can only link an existing identity.
function paintCreateCard({ code = '', checking = false, valid = false, error = '' } = {}) {
  const card = $('#w-create-card');
  if (!card) return;
  if (valid) {
    card.innerHTML = `
      <h2>You’re invited</h2>
      <p>Create your identity. You get a random ID, with no phone number or email, and share it or its QR code with people you want to talk to.</p>
      <label class="field"><span>Your name (optional)</span>
        <input class="input" id="w-name" maxlength="64" placeholder="Only shown to people you message" autocomplete="off"></label>
      <button class="btn primary block" id="w-create">Create identity</button>`;
    $('#w-create').onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>';
      try {
        client = new VeilClient({ store, url: WS_URL, WebSocket });
        await client.createAccount({ deviceName: deviceLabel(), profileName: $('#w-name').value.trim(), invite: code });
        history.replaceState(null, '', location.pathname + (location.hash.startsWith('#c=') ? location.hash : ''));
        startMain({ fresh: true });
      } catch (err) {
        client?.close();
        if (/invite/i.test(err.message)) return paintCreateCard({ error: err.message });
        toast(errText(err));
        btn.disabled = false;
        btn.textContent = 'Create identity';
      }
    };
    setTimeout(() => $('#w-name')?.focus(), 50);
    return;
  }
  card.innerHTML = `
    <h2>New to Veil?</h2>
    <p>Veil is invite-only. Open the invite link you were sent, or paste it here.</p>
    <div class="row" style="margin-bottom:${error ? 8 : 12}px">
      <input class="input grow mono" id="w-invite" placeholder="Invite link or code" value="${esc(code)}" autocomplete="off" autocapitalize="off" spellcheck="false">
      <button class="btn" id="w-inv-scan" aria-label="Scan invite QR">${icon('camera')}</button>
    </div>
    ${error ? `<p style="color:var(--danger);font-size:14px;margin:0 0 12px">${esc(error)}</p>` : ''}
    <button class="btn primary block" id="w-inv-go" ${checking ? 'disabled' : ''}>${checking ? '<span class="spinner"></span>' : 'Continue'}</button>`;
  const go = () => {
    const c = VeilClient.parseInvite($('#w-invite').value);
    if (!c) return paintCreateCard({ code: $('#w-invite').value, error: 'That doesn’t look like an invite link.' });
    paintCreateCard({ code: c, checking: true });
    checkWelcomeInvite(c);
  };
  $('#w-inv-go').onclick = go;
  $('#w-invite').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  $('#w-inv-scan').onclick = async () => {
    const t = await scanQR('Scan the invite QR code');
    if (t) { $('#w-invite').value = t; go(); }
  };
}
async function checkWelcomeInvite(code) {
  try {
    const r = await new VeilClient({ store, url: WS_URL, WebSocket }).checkInvite(code);
    paintCreateCard(r.ok ? { code, valid: true } : { code, error: r.reason || 'This invite isn’t valid.' });
  } catch {
    paintCreateCard({ code, error: 'Couldn’t reach the server. Check your connection and try again.' });
  }
}

async function joinFlow(code) {
  if (!VeilClient.parseLinkCode(code)) return toast('That doesn’t look like a link code (24 characters).');
  const name = deviceLabel();
  const m = openModal({
    title: 'Waiting for approval',
    body: `<div class="center"><span class="spinner"></span><p>Approve <b>${esc(name)}</b> on your other device.</p><p class="muted small">This device will receive your identity key, contacts, groups and recent history over an encrypted channel.</p></div>`,
  });
  try {
    client = await VeilClient.joinLink({ store, url: WS_URL, WebSocket, code, deviceName: name });
    m.close();
    history.replaceState(null, '', location.pathname);
    startMain({ linked: true });
  } catch (err) {
    m.close();
    toast(errText(err));
  }
}

// ------------------------------------------------------------------ main shell
function startMain({ fresh = false, linked = false } = {}) {
  client.on('change', scheduleRender);
  client.on('status', (s) => { const d = $('.status-dot'); if (d) { d.className = `status-dot ${s}`; d.title = s; } });
  client.on('message', notify);
  client.on('error', (e) => toast(errText(e)));
  client.on('removed', () => {
    alert('This device was unlinked from your account. Its data has been erased.');
    location.reload();
  });
  $('#app').innerHTML = `
  <div class="shell">
    <aside class="side">
      <div class="side-head">
        <div class="title">${LOGO.replace('class="logo"', 'class="logo" style="width:28px;height:28px"')}Veil<span class="status-dot ${client.status}" title="${client.status}"></span></div>
        ${themeToggle()}
        <button class="icon-btn" id="b-new" title="New chat" aria-label="New chat">${icon('plus')}</button>
        <button class="icon-btn" id="b-settings" title="Settings" aria-label="Settings">${icon('settings')}</button>
      </div>
      <div class="search"><input class="input" id="search" placeholder="Search" autocomplete="off"></div>
      <div class="chat-list" id="chat-list"></div>
      <div id="nudge"></div>
      <div class="side-foot ${canInstall() ? '' : 'hidden'}">
        ${installButton('btn block')}
      </div>
    </aside>
    <main class="main" id="main"></main>
  </div>`;
  wireThemeToggles();
  $('#b-new').onclick = () => newChatModal();
  $('#b-settings').onclick = () => settingsModal();
  $('#search').oninput = (e) => { ui.search = e.target.value.toLowerCase(); renderSide(); };
  window.onpopstate = () => { if (ui.chatId) closeChat(false); };
  const main = $('#main');
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  main.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || !$('#composer')) return;
    e.preventDefault();
    if (dragDepth++ === 0) main.insertAdjacentHTML('beforeend', `<div class="drop-hint">${icon('image')}&nbsp; Drop images to send</div>`);
  });
  main.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  main.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('.drop-hint')?.remove(); } });
  main.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('.drop-hint')?.remove();
    pickImages(e.dataTransfer.files);
  });
  const onVisibility = () => {
    client.setVisible(!document.hidden);
    if (!document.hidden) {
      if (ui.chatId) { client.markRead(ui.chatId); clearChatNotifications(ui.chatId); }
      if (client.status === 'offline') client.connect().catch(() => {});
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', () => client.setVisible(false));
  window.addEventListener('pageshow', onVisibility);
  client.setVisible(!document.hidden);
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.open) client.chat(e.data.open).then((c) => c && openChat(e.data.open));
    if (e.data?.resubscribe) subscribePush().catch(() => {});
  });
  let pushSynced = false;
  client.on('status', (st) => { if (st === 'online' && !pushSynced) { pushSynced = true; subscribePush().catch(() => {}); } });
  if (client.status === 'online') { pushSynced = true; subscribePush().catch(() => {}); }
  wireInstall();
  if (client.status !== 'online') client.connect().catch(() => {});
  renderSide();
  renderMain();
  handleHash();
  if (fresh) myIdModal(true);
  if (linked) toast('Device linked');
}

function scheduleRender() {
  if (ui.renderQueued) return;
  ui.renderQueued = true;
  requestAnimationFrame(async () => {
    ui.renderQueued = false;
    await renderSide();
    if (ui.chatId) await renderConversation(false);
  });
}

function renderNudge(chatCount) {
  const el = $('#nudge');
  if (!el) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem('veil-nudge') === 'no'; } catch { /* ignore */ }
  const st = notifState();
  if (dismissed || !chatCount || st !== 'ask') { el.innerHTML = ''; return; }
  const iosNeedsInstall = isIOS() && !isStandalone();
  el.innerHTML = `<div class="nudge">${icon('bell')}<div class="grow"><b>Get notified</b><div class="muted small">${iosNeedsInstall ? 'Add Veil to your home screen to get notifications.' : 'Know when a message arrives, even when Veil is closed.'}</div></div>
    <button class="btn primary" id="nudge-yes">${iosNeedsInstall ? 'How' : 'Turn on'}</button><button class="icon-btn" id="nudge-no" aria-label="Dismiss">${icon('x')}</button></div>`;
  $('#nudge-yes').onclick = () => enableNotifications();
  $('#nudge-no').onclick = () => { try { localStorage.setItem('veil-nudge', 'no'); } catch { /* ignore */ } el.innerHTML = ''; };
}

async function chatTitle(chat) {
  if (chat.kind === 'group') return (await client.group(chat.gid))?.name ?? 'Group';
  return client.displayName(chat.peer);
}

async function renderSide() {
  const list = $('#chat-list');
  if (!list) return;
  const chats = await client.chats();
  let total = 0;
  const rows = [];
  for (const c of chats) {
    const title = await chatTitle(c);
    total += c.unread || 0;
    if (ui.search && !title.toLowerCase().includes(ui.search) && !(c.peer ?? '').includes(ui.search.replace(/-/g, ''))) continue;
    let preview = c.last?.text ?? (c.kind === 'group' ? 'Group created' : 'No messages yet');
    if (c.last && c.kind === 'group' && c.last.from) preview = `${c.last.from === client.me.account ? 'You' : await client.displayName(c.last.from)}: ${preview}`;
    else if (c.last?.from === client.me.account) preview = `You: ${preview}`;
    rows.push({ c, html: `
      <button class="chat-item ${c.id === ui.chatId ? 'active' : ''}" data-chat="${esc(c.id)}">
        ${avatar(c.gid ?? c.peer, title, c.kind === 'group' ? 'group' : '')}
        <div class="meta">
          <div class="top"><span class="name">${esc(title)}</span><span class="time">${c.last ? fmtTime(c.last.ts) : ''}</span></div>
          <div class="bottom"><span class="preview">${c.muted ? `${icon('bellOff', 'i muted-ico')} ` : ''}${esc(preview)}</span>${c.request ? '<span class="pill warn">Request</span>' : c.unread ? `<span class="badge">${c.unread}</span>` : ''}</div>
        </div>
      </button>` });
  }
  const requests = rows.filter((r) => r.c.request);
  const normal = rows.filter((r) => !r.c.request);
  list.innerHTML = rows.length
    ? (requests.length ? `<div class="section-label">Requests</div>${requests.map((r) => r.html).join('')}${normal.length ? '<div class="section-label">Chats</div>' : ''}` : '') + normal.map((r) => r.html).join('')
    : `<div class="empty-list">${ui.search ? 'No matches' : `No chats yet.<br><br><button class="btn primary" id="b-first">${icon('userPlus')} Add a contact</button>`}</div>`;
  $$('[data-chat]', list).forEach((b) => (b.onclick = () => openChat(b.dataset.chat)));
  const first = $('#b-first');
  if (first) first.onclick = () => newChatModal();
  document.title = total ? `(${total}) Veil` : 'Veil';
  try { total ? navigator.setAppBadge?.(total) : navigator.clearAppBadge?.(); } catch { /* unsupported */ }
  renderNudge(chats.length);
}

function renderMain() {
  const main = $('#main');
  $('.shell').classList.toggle('in-chat', !!ui.chatId);
  if (!ui.chatId) {
    main.innerHTML = `<div class="main-empty"><div>${LOGO}<h2 style="margin:6px 0">Veil</h2><p>Pick a chat, or start one with <b>+</b>.<br>Messages are end-to-end encrypted.</p></div></div>`;
    return;
  }
  main.innerHTML = `
    <header class="conv-head" id="conv-head"></header>
    <div id="conv-banner"></div>
    <div class="messages" id="messages" aria-live="polite"></div>
    <div id="composer-wrap"></div>`;
  renderConversation(true);
}

function openChat(chatId) {
  if (ui.chatId === chatId) return;
  saveDraft();
  if (!ui.chatId && matchMedia('(max-width: 760px)').matches) history.pushState({ chat: chatId }, '');
  ui.chatId = chatId;
  clearChatNotifications(chatId);
  renderMain();
  renderSide();
}
function closeChat(pop = true) {
  saveDraft();
  ui.chatId = null;
  if (pop && history.state?.chat) history.back();
  renderMain();
  renderSide();
}
function saveDraft() {
  const ta = $('#composer');
  if (ta && ui.chatId) ui.drafts[ui.chatId] = ta.value;
}

async function renderConversation(fresh) {
  const chatId = ui.chatId;
  const chat = await client.chat(chatId);
  if (!chat) { ui.chatId = null; renderMain(); return; }
  const title = await chatTitle(chat);
  const group = chat.kind === 'group' ? await client.group(chat.gid) : null;
  const idInfo = chat.kind === 'dm' ? await client.getIdentity(chat.peer) : null;

  // header
  const sub = group
    ? `${group.members.length} member${group.members.length === 1 ? '' : 's'}`
    : idInfo?.verified ? `<span class="pill ok">${icon('shieldCheck', 'i" style="width:12px;height:12px')} Verified</span>` : `<span class="pill">Not verified</span>`;
  $('#conv-head').innerHTML = `
    <button class="icon-btn back" id="b-back" aria-label="Back">${icon('back')}</button>
    <button class="who" id="b-info">${avatar(chat.gid ?? chat.peer, title, `sm ${group ? 'group' : ''}`)}
      <div style="min-width:0"><div class="name">${esc(title)}</div><div class="sub">${sub}</div></div></button>
    <button class="icon-btn" id="b-info2" aria-label="Details">${icon('info')}</button>`;
  $('#b-back').onclick = () => closeChat();
  $('#b-info').onclick = $('#b-info2').onclick = () => (group ? groupInfoModal(chat.gid) : contactInfoModal(chat.peer));

  // request banner
  const banner = $('#conv-banner');
  if (chat.request) {
    const who = group ? await client.displayName(group.createdBy) : title;
    banner.innerHTML = `<div class="banner"><div class="grow">${group ? `<b>${esc(who)}</b> added you to this group.` : `<b>Message request.</b> This ID isn’t in your contacts yet.`}</div>
      <button class="btn danger" id="b-reject">${group ? 'Leave' : 'Block'}</button><button class="btn primary" id="b-accept">Accept</button></div>`;
    $('#b-accept').onclick = async () => { group ? await client.acceptGroup(chat.gid) : await client.addContact(chat.peer); };
    $('#b-reject').onclick = async () => {
      if (group) { await client.leaveGroup(chat.gid); await client.deleteChat(chatId); }
      else await client.updateContact(chat.peer, { status: 'blocked' });
      closeChat();
    };
  } else banner.innerHTML = '';

  // messages
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const msgs = await client.messages(chatId);
  const names = {};
  const atts = new Map();
  const nameOf = async (a) => (names[a] ??= a === client.me.account ? 'You' : await client.displayName(a));
  let html = '';
  let lastDay = null, prev = null;
  for (const m of msgs) {
    const day = dayLabel(m.ts);
    if (day !== lastDay) { html += `<div class="day">${day}</div>`; lastDay = day; prev = null; }
    if (m.sys) { html += `<div class="sys">${esc(await sysText(m.sys, nameOf))}</div>`; prev = null; continue; }
    const cont = prev && prev.from === m.from && m.ts - prev.ts < 5 * 60e3;
    const status = m.mine ? (m.status === 'sending' ? icon('clock') : m.status === 'failed' ? '' : icon('check')) : '';
    if (m.att) atts.set(m.id, m.att);
    const stamp = `<span class="stamp">${clock(m.ts)}${status}</span>`;
    const bubble = m.att
      ? `<div class="bubble media ${m.text ? '' : 'only'}">${imageBox(m)}${m.text ? `<div class="caption">${linkify(m.text)}${stamp}</div>` : stamp}</div>`
      : `<div class="bubble">${linkify(m.text)}${stamp}</div>`;
    html += `<div class="msg ${m.mine ? 'out' : 'in'} ${cont ? 'cont' : ''}" style="--h:${hue(m.from)}">
      ${group && !m.mine && !cont ? `<div class="sender">${esc(await nameOf(m.from))}</div>` : ''}
      ${bubble}
      ${m.status === 'failed' ? `<button class="failed" data-retry="${esc(m.id)}">${icon('alert', 'i" style="width:13px;height:13px;vertical-align:-2px')} Not sent — tap to retry</button>` : ''}
    </div>`;
    prev = m;
  }
  if (!msgs.length) html = `<div class="sys" style="margin:auto">${icon('lock')}<br>Messages here are end-to-end encrypted.${chat.kind === 'dm' && !idInfo?.verified ? '<br>Compare safety numbers to verify this contact.' : ''}</div>`;
  box.innerHTML = html;
  $$('[data-retry]', box).forEach((b) => (b.onclick = () => client.retry(chatId, b.dataset.retry).catch((e) => toast(errText(e)))));
  loadImages(box, atts);
  if (fresh || nearBottom || msgs.at(-1)?.mine) box.scrollTop = box.scrollHeight;

  // composer
  const wrap = $('#composer-wrap');
  const canSend = group ? group.members.includes(client.me.account) : true;
  if (!canSend) {
    wrap.innerHTML = `<div class="composer-note">You’re no longer a member of this group.</div>`;
  } else if (fresh || !$('#composer')) {
    wrap.innerHTML = `<form class="composer" id="composer-form">
      <button type="button" class="attach" id="b-attach" title="Send image (max 50 MB)" aria-label="Send image">${icon('image')}</button>
      <input type="file" id="file-in" accept="image/*" multiple hidden>
      <textarea id="composer" rows="1" placeholder="Message" aria-label="Message"></textarea>
      <button class="send" id="b-send" aria-label="Send" disabled>${icon('send')}</button></form>`;
    const ta = $('#composer');
    ta.value = ui.drafts[chatId] ?? '';
    const resize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 180) + 'px'; $('#b-send').disabled = !ta.value.trim(); };
    resize();
    ta.oninput = resize;
    $('#b-attach').onclick = () => $('#file-in').click();
    $('#file-in').onchange = (e) => { pickImages(e.target.files); e.target.value = ''; };
    ta.onpaste = (e) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); pickImages(files); }
    };
    const touch = matchMedia('(pointer: coarse)').matches;
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !touch && !e.isComposing) { e.preventDefault(); $('#composer-form').requestSubmit(); } };
    $('#composer-form').onsubmit = (e) => {
      e.preventDefault();
      const text = ta.value;
      if (!text.trim()) return;
      ta.value = '';
      ui.drafts[chatId] = '';
      resize();
      client.sendText(chatId, text);
      ta.focus();
    };
    if (!touch) ta.focus();
  }
  if (!document.hidden) client.markRead(chatId);
}

async function sysText(s, nameOf) {
  const who = await nameOf(s.who);
  const list = async (xs) => (await Promise.all(xs.map(nameOf))).join(', ');
  switch (s.kind) {
    case 'created': return `${who} created the group`;
    case 'added-you': return `${who} added you`;
    case 'added': return `${who} added ${await list(s.targets)}`;
    case 'removed': return `${who} removed ${await list(s.targets)}`;
    case 'renamed': return `${who} renamed the group to “${s.name}”`;
    case 'left': return `${who} left`;
    default: return '';
  }
}

async function notify(m) {
  if (m.mine || (!document.hidden && ui.chatId === m.chatId)) return;
  if (notifState() !== 'on') return;
  const chat = await client.chat(m.chatId);
  if (!chat || chat.muted) return;
  const title = await chatTitle(chat);
  const text = m.att ? (m.text ? `📷 ${m.text}` : '📷 Photo') : m.text;
  const body = (chat.kind === 'group' ? `${await client.displayName(m.from)}: ${text}` : text).slice(0, 200);
  const opts = { body, tag: m.chatId, renotify: true, icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', data: { chatId: m.chatId, count: 1 } };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) { await reg.showNotification(title, opts); return; } // replaces a content-free push notification for the same chat
  } catch { /* fall through */ }
  const n = new Notification(title, opts);
  n.onclick = () => { window.focus(); openChat(m.chatId); n.close(); };
}

function handleHash() {
  const h = location.hash;
  if (!h) return;
  history.replaceState(history.state, '', location.pathname);
  if (h.startsWith('#c=')) newChatModal({ contact: h });
  else if (h.startsWith('#open=')) { const id = decodeURIComponent(h.slice(6)); client.chat(id).then((c) => c && openChat(id)); }
  else if (h === '#new') newChatModal();
  else if (h.startsWith('#invite=')) toast('You already have an identity on this device. Invites are for new people.');
  else if (h.startsWith('#link=')) toast('This device is already set up. Open the link on the new device.');
}

// ------------------------------------------------------------------ modals
async function myIdModal(welcome = false) {
  const card = client.myCard(location.origin);
  const m = openModal({
    title: welcome ? 'You’re all set' : 'Your ID',
    body: `
      ${welcome ? `<div class="notice">${icon('info')}<div>This is your identity. Share the ID or QR with people you want to talk to. No one can find you any other way.</div></div>` : ''}
      <div class="qr">${await qrSvg(card)}</div>
      <div class="big-id">${formatId(client.me.account)}</div>
      <p class="muted small center" style="margin:6px 0 16px">The QR also carries your public key, so scanning it verifies you automatically.</p>
      <div class="row" style="justify-content:center;flex-wrap:wrap">
        <button class="btn" data-copy-id>${icon('copy')} Copy ID</button>
        <button class="btn" data-copy-link>${icon('link')} Copy link</button>
        ${navigator.share ? `<button class="btn" data-share>${icon('share')} Share</button>` : ''}
      </div>`,
  });
  m.el.querySelector('[data-copy-id]').onclick = () => copy(formatId(client.me.account), 'ID copied');
  m.el.querySelector('[data-copy-link]').onclick = () => copy(card, 'Link copied');
  const sh = m.el.querySelector('[data-share]');
  if (sh) sh.onclick = () => navigator.share({ title: 'Message me on Veil', url: card }).catch(() => {});
}

async function newChatModal({ contact = '', tab = 'contact' } = {}) {
  const contacts = (await client.contacts()).filter((c) => c.status === 'accepted');
  const rows = await Promise.all(contacts.map(async (c) => ({ id: c.id, name: await client.displayName(c.id) })));
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const m = openModal({
    title: 'New chat',
    body: `
      <div class="tabs"><button data-tab="contact">${icon('userPlus', 'i" style="width:16px;height:16px;vertical-align:-3px')} Add contact</button><button data-tab="group">${icon('users', 'i" style="width:16px;height:16px;vertical-align:-3px')} New group</button></div>
      <div data-pane="contact">
        <div class="my-id-row">${icon('qr')}<div class="grow"><div class="muted small">Your ID — share it so people can add you</div><div class="mono">${formatId(client.me.account)}</div></div>
          <button class="btn sm" id="nc-myid">Show QR</button></div>
        <label class="field"><span>Their ID or contact link</span>
          <div class="row"><input class="input grow mono" id="nc-id" placeholder="xxxx-xxxx-xxxx-xxxx" value="${esc(contact)}" autocomplete="off" autocapitalize="off" spellcheck="false">
          <button class="btn" id="nc-scan" aria-label="Scan QR">${icon('camera')}</button></div></label>
        <label class="field"><span>Nickname (optional, only you see it)</span><input class="input" id="nc-nick" maxlength="64" autocomplete="off"></label>
        <button class="btn primary block" id="nc-add">Add and start chat</button>
        ${rows.length ? `<div class="divider"></div><div class="section-label" style="padding-left:0">Contacts</div><div class="list">${rows.map((r) => `
          <button class="list-item" style="border:0;background:none;text-align:left;width:100%" data-open="${r.id}">${avatar(r.id, r.name, 'sm')}<div class="grow"><div class="t">${esc(r.name)}</div><div class="muted small mono">${formatId(r.id)}</div></div></button>`).join('')}</div>` : ''}
      </div>
      <div data-pane="group" class="hidden">
        <label class="field"><span>Group name</span><input class="input" id="ng-name" maxlength="80" autocomplete="off"></label>
        <div class="field"><span>Members</span>
        ${rows.length ? `<div class="list">${rows.map((r) => `<label class="list-item"><input type="checkbox" class="check" value="${r.id}">${avatar(r.id, r.name, 'sm')}<div class="grow"><div class="t">${esc(r.name)}</div></div></label>`).join('')}</div>`
          : '<p class="muted small">Add contacts first — you can only add people whose ID you have.</p>'}</div>
        <button class="btn primary block" id="ng-create" ${rows.length ? '' : 'disabled'}>Create group</button>
      </div>`,
  });
  const setTab = (t) => {
    $$('[data-tab]', m.el).forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    $$('[data-pane]', m.el).forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== t));
  };
  $$('[data-tab]', m.el).forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  setTab(tab);
  $('#nc-myid', m.el).onclick = () => myIdModal();
  $$('[data-open]', m.el).forEach((b) => (b.onclick = () => { m.close(); openChat(`dm:${b.dataset.open}`); }));
  const add = async () => {
    const btn = $('#nc-add', m.el);
    btn.disabled = true;
    try {
      const c = await client.addContact($('#nc-id', m.el).value, $('#nc-nick', m.el).value.trim());
      m.close();
      openChat(`dm:${c.id}`);
      if ((await client.getIdentity(c.id))?.verified) toast('Contact added and verified via QR');
    } catch (e) { toast(errText(e)); btn.disabled = false; }
  };
  $('#nc-add', m.el).onclick = add;
  $('#nc-id', m.el).onkeydown = (e) => { if (e.key === 'Enter') add(); };
  $('#nc-scan', m.el).onclick = async () => {
    const t = await scanQR('Scan the QR under their “Your ID”');
    if (t) { $('#nc-id', m.el).value = t; add(); }
  };
  $('#ng-create', m.el).onclick = async () => {
    const name = $('#ng-name', m.el).value.trim();
    const members = $$('input.check:checked', m.el).map((i) => i.value);
    if (!name) return toast('Give the group a name');
    if (!members.length) return toast('Pick at least one member');
    try {
      const g = await client.createGroup(name, members);
      m.close();
      openChat(`g:${g.id}`);
    } catch (e) { toast(errText(e)); }
  };
  if (contact) setTimeout(() => $('#nc-nick', m.el).focus(), 50);
}

async function contactInfoModal(account) {
  const c = await client.contact(account);
  const name = await client.displayName(account);
  const idInfo = await client.getIdentity(account);
  const sn = await client.safetyNumber(account);
  const m = openModal({
    title: 'Contact',
    body: `
      <div class="center">${avatar(account, name, 'lg').replace('class="avatar', 'style="margin:0 auto 10px;--h:' + hue(account) + '" class="avatar')}
        <div style="font-weight:700;font-size:19px">${esc(name)}</div>
        <div class="muted mono small">${formatId(account)}</div>
        <div style="margin-top:8px">${idInfo?.verified ? `<span class="pill ok">Verified</span>` : `<span class="pill">Not verified</span>`}</div>
      </div>
      <div class="divider"></div>
      <label class="field"><span>Nickname</span><div class="row"><input class="input grow" id="ci-nick" value="${esc(c?.nickname ?? '')}" maxlength="64" placeholder="${esc(c?.profileName || 'Only you see this')}"><button class="btn" id="ci-save">Save</button></div></label>
      <div class="field"><span>Safety number</span>
        ${sn ? `<div class="safety">${sn.split(' ').map((g) => `<span>${g}</span>`).join('')}</div>` : '<p class="muted small">Not available yet.</p>'}
        <p class="muted small" style="margin:0 0 10px">Compare these numbers with ${esc(name)} in person or on a call, or scan their QR. If they match, nobody is intercepting your messages.</p>
        <div class="row"><button class="btn" id="ci-scan">${icon('camera')} Scan their QR</button>
        <button class="btn" id="ci-verify">${idInfo?.verified ? 'Clear verification' : 'Mark as verified'}</button></div>
      </div>
      <div class="divider"></div>
      <div class="row" style="flex-wrap:wrap">
        <button class="btn" id="ci-mute">${icon((await client.chat(`dm:${account}`))?.muted ? 'bell' : 'bellOff')} ${(await client.chat(`dm:${account}`))?.muted ? 'Unmute' : 'Mute'}</button>
        <button class="btn danger" id="ci-block">${c?.status === 'blocked' ? 'Unblock' : 'Block'}</button>
        <button class="btn danger" id="ci-del">${icon('trash')} Delete chat</button>
      </div>`,
  });
  $('#ci-mute', m.el).onclick = async () => {
    const chat = await client.chat(`dm:${account}`);
    if (!chat) return;
    await client.setMuted(chat.id, !chat.muted);
    m.close();
    contactInfoModal(account);
  };
  $('#ci-save', m.el).onclick = async () => { await client.updateContact(account, { nickname: $('#ci-nick', m.el).value.trim() }); toast('Saved'); };
  $('#ci-verify', m.el).onclick = async () => { await client.setVerified(account, !idInfo?.verified); m.close(); contactInfoModal(account); };
  $('#ci-scan', m.el).onclick = async () => {
    const t = await scanQR(`Scan ${name}’s QR code`);
    if (!t) return;
    const p = VeilClient.parseContact(t);
    if (!p?.identity || p.account !== account) return toast('That QR code belongs to someone else');
    if (p.identity !== idInfo?.identity) return toast('Key mismatch! Do not trust this chat until you find out why.');
    await client.setVerified(account, true);
    toast('Verified');
    contactInfoModal(account);
  };
  $('#ci-block', m.el).onclick = async () => {
    if (c?.status === 'blocked') { await client.updateContact(account, { status: 'accepted' }); m.close(); return; }
    if (await confirmDialog({ title: `Block ${name}?`, text: 'Their messages will be dropped on all your devices. They are not told.', ok: 'Block', danger: true })) {
      await client.updateContact(account, { status: 'blocked' });
      m.close();
      closeChat();
    }
  };
  $('#ci-del', m.el).onclick = async () => {
    if (await confirmDialog({ title: 'Delete chat?', text: 'Deletes the message history on this device.', ok: 'Delete', danger: true })) {
      await client.deleteChat(`dm:${account}`);
      m.close();
      closeChat();
    }
  };
}

async function groupInfoModal(gid) {
  const g = await client.group(gid);
  const me = client.me.account;
  const admin = g.admins.includes(me);
  const members = await Promise.all(g.members.map(async (a) => ({ a, name: await client.displayName(a) })));
  const contacts = (await client.contacts()).filter((c) => c.status === 'accepted' && !g.members.includes(c.id));
  const addable = await Promise.all(contacts.map(async (c) => ({ a: c.id, name: await client.displayName(c.id) })));
  const m = openModal({
    title: 'Group',
    body: `
      <div class="center">${avatar(gid, g.name, 'lg group').replace('class="avatar', 'style="margin:0 auto 10px;--h:' + hue(gid) + '" class="avatar')}
        <div style="font-weight:700;font-size:19px">${esc(g.name)}</div>
        <div class="muted small">${g.members.length} members · encrypted with sender keys</div></div>
      ${admin ? `<div class="divider"></div><label class="field"><span>Name</span><div class="row"><input class="input grow" id="gi-name" value="${esc(g.name)}" maxlength="80"><button class="btn" id="gi-rename">Rename</button></div></label>` : ''}
      <div class="divider"></div>
      <div class="section-label" style="padding-left:0">Members</div>
      <div class="list">${members.map(({ a, name }) => `
        <div class="list-item">${avatar(a, name, 'sm')}<div class="grow"><div class="t">${esc(a === me ? 'You' : name)}</div><div class="muted small mono">${formatId(a)}</div></div>
          ${g.admins.includes(a) ? '<span class="pill">Admin</span>' : ''}
          ${admin && a !== me ? `<button class="icon-btn" data-remove="${a}" title="Remove" aria-label="Remove ${esc(name)}">${icon('x')}</button>` : ''}
        </div>`).join('')}</div>
      ${admin && addable.length ? `<div class="divider"></div><div class="section-label" style="padding-left:0">Add members</div>
        <div class="list">${addable.map(({ a, name }) => `<label class="list-item"><input type="checkbox" class="check" value="${a}">${avatar(a, name, 'sm')}<div class="grow"><div class="t">${esc(name)}</div></div></label>`).join('')}</div>
        <button class="btn block" id="gi-add" style="margin-top:10px">${icon('userPlus')} Add selected</button>` : ''}
      <div class="divider"></div>
      <button class="btn block" id="gi-mute" style="margin-bottom:8px">${icon((await client.chat(`g:${gid}`))?.muted ? 'bell' : 'bellOff')} ${(await client.chat(`g:${gid}`))?.muted ? 'Unmute notifications' : 'Mute notifications'}</button>
      ${g.members.includes(me) ? `<button class="btn danger block" id="gi-leave">Leave group</button>` : `<button class="btn danger block" id="gi-del">${icon('trash')} Delete chat</button>`}`,
  });
  const run = async (fn) => { try { await fn(); m.close(); groupInfoModal(gid); } catch (e) { toast(errText(e)); } };
  $('#gi-mute', m.el).onclick = async () => { const c = await client.chat(`g:${gid}`); if (c) run(() => client.setMuted(c.id, !c.muted)); };
  $('#gi-rename', m.el)?.addEventListener('click', () => run(() => client.renameGroup(gid, $('#gi-name', m.el).value.trim() || g.name)));
  $$('[data-remove]', m.el).forEach((b) => (b.onclick = async () => {
    const name = members.find((x) => x.a === b.dataset.remove).name;
    if (await confirmDialog({ title: `Remove ${name}?`, text: 'Everyone rotates their group keys, so they can’t read anything sent after this.', ok: 'Remove', danger: true })) run(() => client.removeMember(gid, b.dataset.remove));
  }));
  $('#gi-add', m.el)?.addEventListener('click', () => {
    const picked = $$('input.check:checked', m.el).map((i) => i.value);
    if (picked.length) run(() => client.addMembers(gid, picked));
  });
  $('#gi-leave', m.el)?.addEventListener('click', async () => {
    if (await confirmDialog({ title: 'Leave group?', text: 'You’ll stop receiving messages from this group.', ok: 'Leave', danger: true })) {
      await client.leaveGroup(gid).catch((e) => toast(errText(e)));
      m.close();
      scheduleRender();
    }
  });
  $('#gi-del', m.el)?.addEventListener('click', async () => { await client.deleteChat(`g:${gid}`); m.close(); closeChat(); });
}

async function settingsModal() {
  const m = openModal({
    title: 'Settings', wide: true,
    body: `
      <label class="field"><span>Your name</span><div class="row"><input class="input grow" id="st-name" value="${esc(client.me.profileName)}" maxlength="64" placeholder="Optional"><button class="btn" id="st-save">Save</button></div>
        <span class="muted small" style="font-weight:400">Sent, encrypted, to people you message. The server never sees it.</span></label>
      <div class="kv"><span class="muted">Your ID</span><button class="btn" id="st-id" style="height:32px">${icon('qr')} <span class="mono">${formatId(client.me.account)}</span></button></div>
      <div class="divider"></div>
      <div class="row"><div class="section-label grow" style="padding-left:0">Linked devices</div><button class="btn primary" id="st-link">${icon('plus')} Link a new device</button></div>
      <div class="list" id="st-devices" style="margin-top:8px"><div class="center" style="padding:12px"><span class="spinner"></span></div></div>
      <div class="divider"></div>
      <div class="kv" style="align-items:center"><span>Appearance</span><div class="seg" role="radiogroup" aria-label="Theme">
        <button data-theme-set="system">${icon('monitor')} System</button><button data-theme-set="light">${icon('sun')} Light</button><button data-theme-set="dark">${icon('moon')} Dark</button></div></div>
      <div class="kv" style="align-items:center"><span>Notifications</span><div id="st-notif"></div></div>
      <p class="muted small" style="margin:4px 0 0" id="st-notif-note"></p>
      <div class="kv" style="align-items:center" id="st-install-row"><span>App</span>${canInstall() ? installButton('btn') : `<span class="muted small">${isStandalone() ? 'Installed' : 'Use your browser’s “Install” or “Add to Home Screen”'}</span>`}</div>
      <div class="divider"></div>
      <button class="btn danger" id="st-remove">${icon('trash')} Remove this device</button>`,
  });
  wireThemeToggles(m.el);
  syncTheme();
  $('#st-save', m.el).onclick = async () => { await client.setProfileName($('#st-name', m.el).value.trim()); toast('Saved'); };
  $('#st-id', m.el).onclick = () => myIdModal();
  $('#st-link', m.el).onclick = () => { m.close(); linkDeviceModal(); };
  wireInstall(m.el);
  const paintNotif = () => {
    const st = notifState();
    const box = $('#st-notif', m.el), note = $('#st-notif-note', m.el);
    if (!box) return;
    const on = st === 'on';
    box.innerHTML = st === 'unsupported' || st === 'blocked'
      ? `<span class="pill">${st === 'blocked' ? 'Blocked by browser' : 'Not supported'}</span>`
      : `<div class="seg"><button data-n="on" class="${on ? 'on' : ''}">${icon('bell')} On</button><button data-n="off" class="${on ? '' : 'on'}">${icon('bellOff')} Off</button></div>`;
    note.textContent = st === 'blocked' ? 'Allow notifications for this site in your browser settings, then come back.'
      : isIOS() && !isStandalone() ? 'On iPhone/iPad, add Veil to your home screen first.'
      : !pushSupported() ? 'Shown while Veil is open. Background notifications need HTTPS.'
      : 'Arrive even when Veil is closed. They show who wrote, never what — the text stays encrypted until you open Veil.';
    $$('[data-n]', box).forEach((b) => (b.onclick = async () => { b.dataset.n === 'on' ? await enableNotifications() : await disableNotifications(); paintNotif(); }));
  };
  paintNotif();
  const devices = await client.listDevices().catch(() => null);
  const list = $('#st-devices', m.el);
  if (!list) return;
  list.innerHTML = devices ? devices.map((d) => `
    <div class="list-item"><div class="avatar sm" style="--h:200;background:var(--hover);color:var(--muted)">${icon(/iOS|Android/.test(d.name) ? 'phone' : 'laptop')}</div>
      <div class="grow"><div class="t">${esc(d.name)}</div><div class="muted small">${d.current ? 'This device' : `Last active ${fmtTime(d.lastSeen)}`} · linked ${new Date(d.created).toLocaleDateString()}</div></div>
      ${d.current ? '<span class="pill ok">This device</span>' : `<button class="icon-btn" data-unlink="${d.id}" title="Unlink" aria-label="Unlink ${esc(d.name)}">${icon('trash')}</button>`}
    </div>`).join('') : '<p class="muted small">Offline — can’t load devices.</p>';
  $$('[data-unlink]', list).forEach((b) => (b.onclick = async () => {
    if (await confirmDialog({ title: 'Unlink device?', text: 'It will be signed out and its local data erased the next time it connects.', ok: 'Unlink', danger: true })) {
      try { await client.removeDevice(b.dataset.unlink); m.close(); settingsModal(); } catch (e) { toast(errText(e)); }
    }
  }));
  $('#st-remove', m.el).onclick = async () => {
    const only = devices && devices.length === 1;
    const ok = await confirmDialog({
      title: 'Remove this device?',
      text: only
        ? '<b>This is your only device.</b> Your identity, contacts and messages will be gone for good, and no one can reach this ID again.'
        : 'This device will be unlinked and its local data erased. Your other devices keep working.',
      ok: only ? 'Delete everything' : 'Remove', danger: true,
    });
    if (!ok) return;
    try { await client.removeDevice(client.me.deviceId); } catch { /* offline: still wipe locally */ }
    await client.wipe();
    location.reload();
  };
}

async function linkDeviceModal() {
  let done = false;
  let link = null;
  const m = openModal({
    title: 'Link a new device',
    body: '<div class="center" style="padding:24px"><span class="spinner"></span></div>',
    onClose: () => { if (!done) link?.cancel(); },
  });
  try {
    link = await client.startLink({
      origin: location.origin,
      onRequest: ({ deviceName }) => new Promise((resolve) => {
        m.set(`<div class="notice warn">${icon('alert')}<div><b>${esc(deviceName || 'A device')}</b> wants to link to your account.<br>Only approve if you just started this on your own device.</div></div>
          <p class="muted small">It will receive your identity key, contacts, groups and recent history.</p>
          <div class="row" style="justify-content:flex-end"><button class="btn" data-no>Decline</button><button class="btn primary" data-yes>Approve</button></div>`);
        m.el.querySelector('[data-yes]').onclick = () => { m.set('<div class="center" style="padding:24px"><span class="spinner"></span><p>Sending encrypted data…</p></div>'); resolve(true); };
        m.el.querySelector('[data-no]').onclick = () => { resolve(false); };
      }),
      onDone: (ok, err) => {
        done = true;
        if (ok) m.set(`<div class="center" style="padding:12px">${icon('check', 'i" style="width:40px;height:40px;color:var(--accent)')}<p><b>Device linked.</b></p></div>`);
        else m.set(`<p class="center muted">${err ? esc(errText(err)) : 'Link declined.'}</p>`);
      },
    });
  } catch (e) {
    m.set(`<p class="center muted">${esc(errText(e))}</p>`);
    return;
  }
  m.set(`
    <p class="muted small" style="margin-top:0">On the new device, open Veil and choose <b>Link to an existing device</b>. Scan this code, or type the code below.</p>
    <div class="qr">${await qrSvg(link.url)}</div>
    <div class="code">${link.code}</div>
    <p class="muted small center" style="margin:0"><span class="spinner" style="width:12px;height:12px;border-width:2px;vertical-align:-1px"></span> Waiting for the new device · expires in 5 minutes</p>`);
}

// ------------------------------------------------------------------ boot
function registerSW() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

async function boot() {
  registerSW();
  syncTheme();
  client = new VeilClient({ store, url: WS_URL, WebSocket });
  let me = null;
  try { me = await client.load(); } catch (e) { $('#app').innerHTML = `<p style="padding:24px">Storage unavailable: ${esc(e.message)}. Private browsing may block IndexedDB.</p>`; return; }
  if (!me) {
    const m = location.hash.match(/^#link=([0-9a-z]{24})/);
    const inv = location.hash.match(/^#invite=([0-9a-z]{24})/);
    renderWelcome({ code: m ? m[1].match(/.{4}/g).join('-') : '', invite: inv ? inv[1] : '' });
    if (location.hash.startsWith('#c=')) toast('You need an invite to create an identity. Then open the contact link again.');
    return;
  }
  startMain();
}
boot();
