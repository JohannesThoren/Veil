// Copyright (c) 2026 Johannes Thorén. All rights reserved.
// Licensed under the LGJT License v1. See LICENSE in the project root.
// Veil service worker: offline app shell + push notifications.
//
// Push payloads carry no message content — only which account/device sent something
// (the relay knows that anyway). Names, group names and mute settings are looked up
// here in the local IndexedDB, so the push service (Google/Apple/Mozilla) never sees them.
const CACHE = 'veil-shell-v4';
const SHELL = ['/', '/app.js', '/app.css', '/theme.js', '/manifest.webmanifest', '/icon.svg',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/badge-96.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname === '/ws'
    || url.pathname.startsWith('/blob/') || url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) return;
  const key = e.request.mode === 'navigate' ? '/' : e.request;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
        return res;
      })
      .catch(() => caches.match(key)),
  );
});

// ---------- read-only access to the app's IndexedDB ----------
function idbGet(key) {
  return new Promise((resolve) => {
    const req = indexedDB.open('veil');
    req.onupgradeneeded = () => { req.transaction.abort(); }; // no database yet: don't create one
    req.onerror = () => resolve(undefined);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const g = db.transaction('kv', 'readonly').objectStore('kv').get(key);
        g.onsuccess = () => { resolve(g.result); db.close(); };
        g.onerror = () => { resolve(undefined); db.close(); };
      } catch { resolve(undefined); db.close(); }
    };
  });
}

async function describe(p) {
  const me = await idbGet('me');
  if (!me) return { title: 'Veil', body: 'New message', chatId: null };
  const contact = p.a ? await idbGet(`contact:${p.a}`) : null;
  if (contact?.status === 'blocked') return null;
  const name = contact?.nickname || contact?.profileName || (p.a && await idbGet(`profile:${p.a}`)) || 'Someone';
  if (p.k === 'g') {
    const rs = p.g ? await idbGet(`rsk:${p.a}:${p.d}:${p.g}`) : null;
    if (rs?.gid) {
      const g = await idbGet(`group:${rs.gid}`);
      return { title: g?.name || 'Group', body: `${name}: new message`, chatId: `g:${rs.gid}` };
    }
    return { title: name, body: 'New group message', chatId: null };
  }
  if (p.a === me.account) return null; // my own other device — never notified by the relay, but be safe
  return { title: name, body: contact ? 'New message' : 'New message request', chatId: `dm:${p.a}` };
}

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let p = {};
    try { p = e.data ? e.data.json() : {}; } catch { /* malformed: show generic */ }
    const info = await describe(p);
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => w.focused && w.visibilityState === 'visible')) return; // app is in front: it shows its own UI
    const chat = info?.chatId ? await idbGet(`chat:${info.chatId}`) : null;
    if (!info || chat?.muted) {
      // Muted or blocked. Browsers (Safari especially) cancel push subscriptions that receive pushes
      // without showing anything, so show a silent notification and remove it right away.
      await self.registration.showNotification('Veil', { tag: 'veil-quiet', silent: true });
      for (const n of await self.registration.getNotifications({ tag: 'veil-quiet' })) n.close();
      return;
    }
    if (p.n === 'call') {
      // Incoming call: stays until answered or dismissed. Tapping opens the app, which rings if the call is still live.
      await self.registration.showNotification(info.title, {
        body: 'Incoming call', tag: `call:${p.a}`, renotify: true, requireInteraction: true, vibrate: [300, 200, 300, 200, 300],
        icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', data: { chatId: info.chatId, count: 0 },
      });
      return;
    }
    const tag = info.chatId || 'veil';
    const prev = await self.registration.getNotifications({ tag });
    const count = (prev[0]?.data?.count ?? 0) + 1;
    await self.registration.showNotification(info.title, {
      body: count > 1 ? `${count} new messages` : info.body,
      tag,
      renotify: true,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      data: { chatId: info.chatId, count },
    });
    if (self.navigator.setAppBadge) {
      const all = await self.registration.getNotifications();
      self.navigator.setAppBadge(all.reduce((n, x) => n + (x.data?.count ?? 1), 0)).catch(() => {});
    }
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const chatId = e.notification.data?.chatId;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins[0];
    if (win) {
      await win.focus();
      if (chatId) win.postMessage({ open: chatId });
      return;
    }
    await self.clients.openWindow(chatId ? `/#open=${encodeURIComponent(chatId)}` : '/');
  })());
});

self.addEventListener('pushsubscriptionchange', (e) => {
  // The page re-subscribes and re-registers with the relay on its next start.
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((ws) => ws.forEach((w) => w.postMessage({ resubscribe: true }))));
});
