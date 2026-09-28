// Copyright (c) 2026 Johannes Thorén. All rights reserved.
// Licensed under the LGJT License v1. See LICENSE in the project root.
// Veil relay: stores public prekeys, queues opaque ciphertext per device, relays device-link handshakes.
// It never sees plaintext, contact lists, group membership or names.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import webpush from 'web-push';
import { openDb } from './db.js';
import crypto from 'node:crypto';
import { customAlphabet } from 'nanoid';
import { Ed, dec, enc, rand, stmt, isAccountId, ALPHABET } from '../shared/crypto.js';

const newInviteCode = customAlphabet(ALPHABET, 24); // 120 bits
const isInviteCode = (s) => typeof s === 'string' && s.length === 24 && [...s].every((c) => ALPHABET.includes(c));
function inviteStatus(inv, now = Date.now()) {
  if (!inv) return 'invalid';
  if (inv.revoked) return 'revoked';
  if (inv.expires != null && inv.expires <= now) return 'expired';
  if (inv.max_uses != null && inv.uses >= inv.max_uses) return 'used';
  return 'active';
}
const INVITE_ERRORS = { invalid: 'Invite not found', revoked: 'This invite was revoked', expired: 'This invite has expired', used: 'This invite has already been used' };

function loadAdminToken(dataDir, log) {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  const file = path.join(dataDir, 'admin-token');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* generate */ }
  const token = enc(rand(24));
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  log(`admin token created — sign in at /admin with: ${token}  (stored in ${file})`);
  return token;
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LIMITS = {
  body: 256 * 1024,          // max ciphertext per envelope
  frame: 8 * 1024 * 1024,    // max websocket frame
  opksPerUpload: 200,
  mailboxPerDevice: 10000,
  devicesPerAccount: 10,
  linkTtlMs: 5 * 60 * 1000,
  mailboxTtlMs: 30 * 24 * 3600 * 1000,
  ratePerSec: 30,            // requests per connection, token bucket
  burst: 120,
  // Attachments: 50 MiB plaintext + 24-byte nonce + 16-byte tag
  blobBytes: 50 * 1024 * 1024 + 40,
  blobTtlMs: 30 * 24 * 3600 * 1000,
  uploadTtlMs: 10 * 60 * 1000,
};
// Only real browser push services, so a subscription can't make the relay call arbitrary URLs.
const PUSH_HOSTS = /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)$/;
function validSubscription(sub) {
  if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1024) return false;
  let u;
  try { u = new URL(sub.endpoint); } catch { return false; }
  return u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname) && !u.port
    && typeof sub.keys?.p256dh === 'string' && sub.keys.p256dh.length < 200
    && typeof sub.keys?.auth === 'string' && sub.keys.auth.length < 100;
}

function loadVapid(dataDir) {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  const file = path.join(dataDir, 'vapid.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* generate below */ }
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

const isBlobId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{22}$/.test(s);

const isB64 = (s, max = 200) => typeof s === 'string' && s.length > 0 && s.length <= max && /^[A-Za-z0-9_-]+$/.test(s);
const isDeviceId = (s) => typeof s === 'string' && s.length === 8 && [...s].every((c) => ALPHABET.includes(c));
const isLinkId = (s) => typeof s === 'string' && s.length === 8 && [...s].every((c) => ALPHABET.includes(c));
class ClientError extends Error {}
const must = (cond, msg) => { if (!cond) throw new ClientError(msg); };

export function startServer({ port = 8080, dbPath = 'veil.db', staticDir = path.join(__dirname, '../web/dist'), log = console.log, pushSender, adminToken } = {}) {
  const { q, tx } = openDb(dbPath);
  const blobDir = process.env.BLOB_DIR ?? path.join(path.dirname(path.resolve(dbPath)), 'blobs');
  fs.mkdirSync(blobDir, { recursive: true });
  const uploads = new Map();   // blobId -> { token, size, expires }
  const blobPath = (id) => path.join(blobDir, id);

  const ADMIN_TOKEN = adminToken ?? loadAdminToken(path.dirname(path.resolve(dbPath)), log);

  // ---------- push ----------
  const vapid = loadVapid(path.dirname(path.resolve(dbPath)));
  const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  const sendPush = pushSender ?? ((sub, payload, opts) => webpush.sendNotification(sub, payload, {
    ...opts, vapidDetails: { subject: vapidSubject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
  }));
  const lastPush = new Map(); // "dest|sender" -> ts, light throttle (the push service also collapses by topic)
  function isVisible(a, d) {
    for (const c of online.get(key(a, d)) ?? []) if (c.visible !== false) return true;
    return false;
  }
  function maybePush(a, d, payload) {
    if (isVisible(a, d)) return; // the app is open and in front: it gets the message over the socket
    const row = q.getPush.get(a, d);
    if (!row?.push_sub) return;
    const k = `${a}:${d}|${payload.a}`;
    const now = Date.now();
    if (now - (lastPush.get(k) ?? 0) < 1500) return;
    lastPush.set(k, now);
    const sub = JSON.parse(row.push_sub);
    Promise.resolve(sendPush(sub, JSON.stringify(payload), { TTL: 24 * 3600, urgency: 'high', topic: payload.a }))
      .catch((err) => {
        if (err?.statusCode === 404 || err?.statusCode === 410) q.setPush.run(null, a, d); // subscription gone
        else log('push failed', err?.statusCode ?? err?.message);
      });
  }
  const online = new Map();    // "account:device" -> Set<conn>
  const links = new Map();     // linkId -> { host, joiner, expires }

  const key = (a, d) => `${a}:${d}`;
  const push = (a, d, msg) => {
    const conns = online.get(key(a, d));
    if (conns) for (const c of conns) c.send(msg);
  };

  function checkDeviceBlock(account, identity, device) {
    must(isDeviceId(device?.id), 'bad device id');
    must(isB64(device.signPub), 'bad signPub');
    must(isB64(device.cert), 'bad cert');
    must(Ed.verify(dec(device.cert), stmt.device(account, device.id, device.signPub), dec(identity)), 'device certificate invalid');
    must(device.nameBox == null || isB64(device.nameBox, 400), 'bad nameBox');
  }
  function storePrekeys(account, deviceId, identity, spk, opks) {
    if (spk) {
      must(Number.isInteger(spk.id) && isB64(spk.pub) && isB64(spk.sig), 'bad spk');
      must(Ed.verify(dec(spk.sig), stmt.spk(account, deviceId, spk.id, spk.pub), dec(identity)), 'spk signature invalid');
      q.upsertSpk.run(account, deviceId, spk.id, spk.pub, spk.sig);
    }
    if (opks) {
      must(Array.isArray(opks) && opks.length <= LIMITS.opksPerUpload, 'bad opks');
      for (const o of opks) {
        must(Number.isInteger(o.id) && isB64(o.pub), 'bad opk');
        q.insertOpk.run(account, deviceId, o.id, o.pub);
      }
    }
  }

  const registerTx = tx((a, identity, device, spk, opks, invite) => {
    const now = Date.now();
    if (q.useInvite.run(invite, now).changes !== 1) throw new ClientError(INVITE_ERRORS[inviteStatus(q.getInvite.get(invite))] ?? 'Invite not valid');
    q.recordInviteUse.run(invite, a, now);
    q.insertAccount.run(a, identity, now);
    q.insertDevice.run(a, device.id, device.signPub, device.cert, device.nameBox ?? null, now, now);
    storePrekeys(a, device.id, identity, spk, opks);
  });
  const addDeviceTx = tx((a, identity, device, spk, opks) => {
    const now = Date.now();
    q.insertDevice.run(a, device.id, device.signPub, device.cert, device.nameBox ?? null, now, now);
    storePrekeys(a, device.id, identity, spk, opks);
  });
  const sendTx = tx((from, kind, msgs, ts) => {
    const out = [];
    for (const m of msgs) {
      const { seq } = q.enqueue.get(m.a, m.d, from.account, from.device, kind, m.b, ts);
      out.push({ ...m, seq });
    }
    return out;
  });

  function flush(conn) {
    const rows = q.pending.all(conn.account, conn.device);
    for (const r of rows) {
      conn.send({ t: 'env', env: { seq: r.seq, from: { a: r.from_account, d: r.from_device }, k: r.kind, b: r.body, ts: r.ts } });
    }
  }

  function authenticated(conn, account, device) {
    conn.account = account;
    conn.device = device;
    const k = key(account, device);
    if (!online.has(k)) online.set(k, new Set());
    online.get(k).add(conn);
    q.touchDevice.run(Date.now(), account, device);
    return { opks: q.countOpks.get(account, device).n };
  }

  const handlers = {
    // --- account & device lifecycle ---
    register(conn, { account, identity, sig, device, spk, opks, invite }) {
      must(!conn.account, 'already authenticated');
      must(isInviteCode(invite), 'An invite is required to create an identity');
      const st = inviteStatus(q.getInvite.get(invite));
      must(st === 'active', INVITE_ERRORS[st]);
      must(isAccountId(account), 'bad account id');
      must(isB64(identity), 'bad identity');
      must(Ed.verify(dec(sig ?? ''), stmt.register(account, identity), dec(identity)), 'registration signature invalid');
      checkDeviceBlock(account, identity, device);
      must(!q.getAccount.get(account), 'account id taken');
      registerTx(account, identity, device, spk, opks, invite);
      log(`register ${account.slice(0, 4)}…`);
      return authenticated(conn, account, device.id);
    },
    addDevice(conn, { account, device, spk, opks }) {
      must(!conn.account, 'already authenticated');
      const acc = q.getAccount.get(account);
      must(acc, 'unknown account');
      checkDeviceBlock(account, acc.identity, device);
      must(!q.getDevice.get(account, device.id), 'device id taken');
      must(q.listDevices.all(account).length < LIMITS.devicesPerAccount, 'too many devices');
      addDeviceTx(account, acc.identity, device, spk, opks);
      const res = authenticated(conn, account, device.id);
      notifyDevicesChanged(account);
      return res;
    },
    auth(conn, { account, device, sig }) {
      must(!conn.account, 'already authenticated');
      const d = q.getDevice.get(account ?? '', device ?? '');
      must(d, 'unknown device');
      must(Ed.verify(dec(sig ?? ''), stmt.auth(conn.nonce), dec(d.sign_pub)), 'bad auth signature');
      return authenticated(conn, account, device);
    },
    removeDevice(conn, { device, sig }) {
      must(conn.account, 'not authenticated');
      const acc = q.getAccount.get(conn.account);
      must(Ed.verify(dec(sig ?? ''), stmt.removeDevice(conn.account, device), dec(acc.identity)), 'bad signature');
      q.deleteDevice.run(conn.account, device);
      for (const c of online.get(key(conn.account, device)) ?? []) c.send({ t: 'removed' }), c.close();
      notifyDevicesChanged(conn.account);
      return {};
    },
    setDeviceName(conn, { nameBox }) {
      must(conn.account, 'not authenticated');
      must(isB64(nameBox, 400), 'bad nameBox');
      q.setDeviceName.run(nameBox, conn.account, conn.device);
      return {};
    },
    prekeys(conn, { spk, opks }) {
      must(conn.account, 'not authenticated');
      const acc = q.getAccount.get(conn.account);
      storePrekeys(conn.account, conn.device, acc.identity, spk, opks);
      return { opks: q.countOpks.get(conn.account, conn.device).n };
    },

    // --- directory ---
    devices(conn, { accounts }) {
      must(conn.account, 'not authenticated');
      must(Array.isArray(accounts) && accounts.length <= 1000, 'bad accounts');
      const out = {};
      for (const a of accounts) {
        const acc = isAccountId(a) && q.getAccount.get(a);
        out[a] = acc ? {
          identity: acc.identity,
          devices: q.listDevices.all(a).map((d) => ({
            id: d.id, signPub: d.sign_pub, cert: d.cert,
            // name + activity are only revealed to the account itself
            ...(a === conn.account ? { nameBox: d.name_box, created: d.created, lastSeen: d.last_seen } : {}),
          })),
        } : null;
      }
      return { accounts: out };
    },
    bundle(conn, { account, device }) {
      must(conn.account, 'not authenticated');
      const spk = q.getSpk.get(account ?? '', device ?? '');
      must(spk, 'no such device');
      const opk = q.popOpk.get(account, device);
      if (opk && q.countOpks.get(account, device).n < 10) push(account, device, { t: 'prekeysLow' });
      return { spk: { id: spk.id, pub: spk.pub, sig: spk.sig }, opk: opk ? { id: opk.id, pub: opk.pub } : null };
    },

    // --- messaging ---
    send(conn, { k, msgs, accounts, push: wantPush }) {
      must(conn.account, 'not authenticated');
      must(k === 'dm' || k === 'g', 'bad kind');
      must(Array.isArray(msgs) && msgs.length > 0 && msgs.length <= 2000, 'bad msgs');
      for (const m of msgs) {
        must(isAccountId(m.a) && isDeviceId(m.d), 'bad recipient');
        must(typeof m.b === 'string' && m.b.length <= LIMITS.body, 'body too large');
      }
      // Fan-out completeness: the sender must address every current device of each listed account
      // (minus itself). If not, tell it which devices exist so it can set up sessions and retry.
      if (accounts) {
        must(Array.isArray(accounts) && accounts.length <= 1000, 'bad accounts');
        const stale = {};
        for (const a of accounts) {
          const actual = q.listDevices.all(a).map((d) => d.id).filter((d) => !(a === conn.account && d === conn.device)).sort();
          const given = [...new Set(msgs.filter((m) => m.a === a).map((m) => m.d))].sort();
          if (actual.join() !== given.join()) stale[a] = actual;
        }
        if (Object.keys(stale).length) return { stale };
      }
      for (const m of msgs) must(q.getDevice.get(m.a, m.d), 'unknown recipient device');
      const ts = Date.now();
      const stored = sendTx({ account: conn.account, device: conn.device }, k, msgs, ts);
      let groupKey = null;
      if (wantPush && k === 'g') { try { groupKey = JSON.parse(msgs[0].b).k; } catch { /* ignore */ } }
      for (const m of stored) {
        push(m.a, m.d, { t: 'env', env: { seq: m.seq, from: { a: conn.account, d: conn.device }, k, b: m.b, ts } });
        // Only real messages wake devices (not key distribution / sync), and never my own devices.
        if (wantPush && m.a !== conn.account) {
          maybePush(m.a, m.d, { v: 1, a: conn.account, d: conn.device, k, ...(wantPush === 'call' ? { n: 'call' } : {}), ...(typeof groupKey === 'string' && groupKey.length < 40 ? { g: groupKey } : {}) });
        }
      }
      return { ts };
    },
    ack(conn, { seqs }) {
      must(conn.account, 'not authenticated');
      must(Array.isArray(seqs), 'bad seqs');
      for (const s of seqs) q.ack.run(s, conn.account, conn.device);
      return {};
    },

    // --- calls: ICE servers with short-lived TURN credentials (coturn "use-auth-secret" / TURN REST API) ---
    iceServers(conn) {
      must(conn.account, 'not authenticated');
      const ttlMs = 12 * 3600 * 1000;
      const expires = Date.now() + ttlMs;
      const turnUrls = (process.env.TURN_URLS ?? '').split(',').map((u) => u.trim()).filter(Boolean);
      const secret = process.env.TURN_SECRET ?? '';
      let stunUrls = (process.env.STUN_URLS ?? '').split(',').map((u) => u.trim()).filter(Boolean);
      if (!stunUrls.length && turnUrls.length) stunUrls = [...new Set(turnUrls.map((u) => u.replace(/^turns?:/, 'stun:').replace(/\?.*$/, '')))];
      if (!stunUrls.length) stunUrls = ['stun:stun.cloudflare.com:3478'];
      const servers = [{ urls: stunUrls }];
      if (turnUrls.length && secret) {
        const username = `${Math.floor(expires / 1000)}:${conn.account.slice(0, 8)}`;
        const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
        servers.push({ urls: turnUrls, username, credential });
      }
      return { iceServers: servers, expires };
    },

    // --- presence & push ---
    presence(conn, { visible }) {
      conn.visible = visible !== false;
      return {};
    },
    pushKey() {
      return { key: vapid.publicKey };
    },
    pushSubscribe(conn, { sub }) {
      must(conn.account, 'not authenticated');
      if (sub == null) { q.setPush.run(null, conn.account, conn.device); return {}; }
      must(validSubscription(sub), 'unsupported push endpoint');
      q.setPush.run(JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }), conn.account, conn.device);
      return {};
    },

    // --- attachments: encrypted client-side; the server stores opaque bytes under a random id ---
    blobToken(conn, { blob, size }) {
      must(conn.account, 'not authenticated');
      must(isBlobId(blob), 'bad blob id');
      must(Number.isInteger(size) && size > 0 && size <= LIMITS.blobBytes, 'file too large (max 50 MB)');
      must(!uploads.has(blob) && !fs.existsSync(blobPath(blob)), 'blob id taken');
      const token = enc(rand(24));
      uploads.set(blob, { token, size, expires: Date.now() + LIMITS.uploadTtlMs });
      return { token };
    },

    // --- device linking rendezvous (ciphertext only; the secret stays in the code/QR) ---
    linkOpen(conn, { link: id }) {
      must(conn.account, 'not authenticated');
      must(isLinkId(id) && !links.has(id), 'bad link id');
      links.set(id, { host: conn, joiner: null, expires: Date.now() + LIMITS.linkTtlMs });
      return {};
    },
    linkJoin(conn, { link: id, p }) {
      const l = links.get(id);
      must(l && !l.joiner && l.expires > Date.now(), 'link code not found or expired');
      must(isB64(p, 8192), 'bad payload');
      l.joiner = conn;
      l.host.send({ t: 'link', link: id, p });
      return {};
    },
    linkSend(conn, { link: id, p }) {
      const l = links.get(id);
      must(l && l.host === conn && l.joiner, 'no joiner');
      must(isB64(p, LIMITS.frame), 'bad payload');
      l.joiner.send({ t: 'link', link: id, p });
      links.delete(id);
      return {};
    },
    linkClose(conn, { link: id }) {
      const l = links.get(id);
      if (l && l.host === conn) {
        l.joiner?.send({ t: 'linkClosed', link: id });
        links.delete(id);
      }
      return {};
    },
  };

  function notifyDevicesChanged(account) {
    for (const [k, conns] of online) if (k.startsWith(account + ':')) for (const c of conns) c.send({ t: 'devicesChanged' });
  }

  // ---------- HTTP (static PWA) ----------
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') { res.end('ok'); return; }
    const bm = url.pathname.match(/^\/blob\/([A-Za-z0-9_-]{22})$/);
    if (bm) { handleBlob(req, res, bm[1]); return; }
    if (url.pathname === '/api/invite') { inviteCheck(req, res, url); return; }
    if (url.pathname.startsWith('/admin/api/')) { adminApi(req, res, url).catch((e) => { log('admin error', e); json(res, 500, { error: 'server error' }); }); return; }
    if (url.pathname === '/admin' || url.pathname === '/admin/') url.pathname = '/admin.html';
    let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = path.join(staticDir, p);
    if (!file.startsWith(staticDir)) { res.writeHead(403).end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // Unknown asset (e.g. an old hashed file name): 404 instead of serving HTML as CSS/JS.
      if (path.extname(p)) { res.writeHead(404, { 'Cache-Control': 'no-store' }).end(); return; }
      file = path.join(staticDir, 'index.html'); // client-side route
    }
    if (!fs.existsSync(file)) { res.writeHead(404).end('Build the web client first: npm run build'); return; }
    const ext = path.extname(file);
    const st = fs.statSync(file);
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const base = path.basename(file);
    const cache = /-[0-9a-f]{10}\.(js|css)$|-[A-Z0-9]{8}\.js(\.map)?$/.test(base)
      ? 'public, max-age=31536000, immutable'   // content-hashed: never changes
      : ext === '.html' || base === 'sw.js' || base === 'manifest.webmanifest'
        ? 'no-cache'                              // always revalidate (cheap: ETag → 304)
        : 'public, max-age=86400';
    const headers = {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': cache,
      ETag: etag,
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(), display-capture=()',
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers).end(); return; }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });

  function handleBlob(req, res, id) {
    const file = blobPath(id);
    if (req.method === 'GET' || req.method === 'HEAD') {
      fs.stat(file, (err, st) => {
        if (err) { res.writeHead(404).end(); return; }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': st.size,
          'Cache-Control': 'private, max-age=2592000, immutable',
          'X-Content-Type-Options': 'nosniff',
        });
        if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
      });
      return;
    }
    if (req.method !== 'PUT') { res.writeHead(405).end(); return; }
    const u = uploads.get(id);
    if (!u || u.expires < Date.now() || req.headers['x-upload-token'] !== u.token) { res.writeHead(403).end(); return; }
    uploads.delete(id);
    const tmp = file + '.part';
    const out = fs.createWriteStream(tmp);
    let n = 0, failed = false;
    const fail = (code) => {
      if (failed) return;
      failed = true;
      req.destroy();
      out.destroy();
      fs.rm(tmp, { force: true }, () => {});
      if (!res.headersSent) res.writeHead(code).end();
    };
    req.on('data', (chunk) => {
      if (failed) return;
      n += chunk.length;
      if (n > u.size) return fail(413);
      if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
    });
    req.on('aborted', () => fail(400));
    req.on('error', () => fail(400));
    out.on('error', () => fail(500));
    req.on('end', () => {
      if (failed) return;
      out.end(() => {
        if (n !== u.size) return fail(400);
        fs.rename(tmp, file, (err) => (err ? fail(500) : res.writeHead(201).end()));
      });
    });
  }

  // ---------- invites & admin ----------
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(JSON.stringify(body));
  };
  const clientIp = (req) => (process.env.TRUST_PROXY ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') || req.socket.remoteAddress;
  const buckets = new Map(); // "kind|ip" -> { n, reset }
  function limited(kind, req, max, windowMs) {
    const k = `${kind}|${clientIp(req)}`;
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(k, b); }
    return ++b.n > max;
  }
  function readJson(req, max = 16 * 1024) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > max) { reject(new ClientError('too large')); req.destroy(); } });
      req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new ClientError('bad json')); } });
      req.on('error', reject);
    });
  }

  function inviteCheck(req, res, url) {
    if (limited('invite', req, 60, 60_000)) return json(res, 429, { ok: false, reason: 'Too many attempts, try again in a minute' });
    const code = url.searchParams.get('code') ?? '';
    const st = isInviteCode(code) ? inviteStatus(q.getInvite.get(code)) : 'invalid';
    json(res, 200, st === 'active' ? { ok: true } : { ok: false, reason: INVITE_ERRORS[st] });
  }

  const sessions = new Map(); // session id -> expires
  const SESSION_MS = 12 * 3600 * 1000;
  const cookieOf = (req) => (String(req.headers.cookie ?? '').match(/(?:^|;\s*)veil_admin=([A-Za-z0-9_-]+)/) ?? [])[1];
  const isAdmin = (req) => { const s = cookieOf(req); const exp = s && sessions.get(s); return !!exp && exp > Date.now(); };
  const inviteView = (i) => ({
    code: i.code, label: i.label, created: i.created, expires: i.expires, maxUses: i.max_uses, uses: i.uses, status: inviteStatus(i),
  });

  async function adminApi(req, res, url) {
    const route = url.pathname.slice('/admin/api/'.length);
    const mutating = req.method !== 'GET';
    // CSRF: cookies are SameSite=Strict, and every write must be a JSON request (not sendable by a plain form).
    if (mutating && !String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'JSON required' });

    if (route === 'login' && req.method === 'POST') {
      if (limited('login', req, 10, 15 * 60_000)) return json(res, 429, { error: 'Too many attempts. Wait 15 minutes.' });
      const { token } = await readJson(req).catch(() => ({}));
      if (typeof token !== 'string' || !crypto.timingSafeEqual(sha(token), sha(ADMIN_TOKEN))) return json(res, 401, { error: 'Wrong admin token' });
      const sid = enc(rand(32));
      sessions.set(sid, Date.now() + SESSION_MS);
      const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
      return json(res, 200, { ok: true }, { 'Set-Cookie': `veil_admin=${sid}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${SESSION_MS / 1000}${secure}` });
    }
    if (route === 'logout' && req.method === 'POST') {
      sessions.delete(cookieOf(req));
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'veil_admin=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0' });
    }
    if (!isAdmin(req)) return json(res, 401, { error: 'Not signed in' });

    if (route === 'overview' && req.method === 'GET') {
      let blobs = 0, blobBytes = 0;
      for (const n of fs.readdirSync(blobDir)) {
        if (n.endsWith('.part')) continue;
        try { blobBytes += fs.statSync(path.join(blobDir, n)).size; blobs++; } catch { /* raced with janitor */ }
      }
      const invites = q.listInvites.all().map(inviteView);
      return json(res, 200, {
        publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, '') || null,
        stats: { ...q.stats.get(), blobs, blobBytes, online: online.size, activeInvites: invites.filter((i) => i.status === 'active').length },
        invites,
        accounts: q.listAccounts.all().map((a) => ({ id: a.id, created: a.created, devices: a.devices, lastSeen: a.last_seen, invite: a.invite_code ? { code: a.invite_code, label: a.invite_label ?? '' } : null })),
      });
    }
    if (route === 'invites' && req.method === 'POST') {
      const { label = '', maxUses = 1, expiresInHours = 168 } = await readJson(req);
      if (typeof label !== 'string' || label.length > 80) return json(res, 400, { error: 'Label too long' });
      if (maxUses !== null && !(Number.isInteger(maxUses) && maxUses >= 1 && maxUses <= 10000)) return json(res, 400, { error: 'Bad max uses' });
      if (expiresInHours !== null && !(typeof expiresInHours === 'number' && expiresInHours > 0 && expiresInHours <= 24 * 365)) return json(res, 400, { error: 'Bad expiry' });
      const code = newInviteCode();
      const now = Date.now();
      q.insertInvite.run(code, label.trim(), now, expiresInHours === null ? null : Math.round(now + expiresInHours * 3600_000), maxUses);
      log(`admin: invite created${label ? ` (${label})` : ''}`);
      return json(res, 201, { invite: inviteView(q.getInvite.get(code)) });
    }
    let m = route.match(/^invites\/([0-9a-z]{24})(\/revoke)?$/);
    if (m && req.method === 'POST' && m[2]) { q.revokeInvite.run(m[1]); return json(res, 200, { ok: true }); }
    if (m && req.method === 'DELETE' && !m[2]) { q.deleteInvite.run(m[1]); return json(res, 200, { ok: true }); }
    m = route.match(/^accounts\/([0-9a-z]{16})$/);
    if (m && req.method === 'DELETE') {
      const a = m[1];
      for (const [k, conns] of online) if (k.startsWith(a + ':')) for (const c of conns) { c.send({ t: 'removed' }); c.close(); }
      q.deleteAccount.run(a);
      log(`admin: account ${a.slice(0, 4)}… deleted`);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  }

  // ---------- WebSocket RPC ----------
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: LIMITS.frame });
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const conn = {
      ws, account: null, device: null, nonce: enc(rand(32)),
      tokens: LIMITS.burst, last: Date.now(),
      send: (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); },
      close: () => ws.close(),
    };
    conn.send({ t: 'hello', nonce: conn.nonce });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return ws.close(1003, 'bad json'); }
      const now = Date.now();
      conn.tokens = Math.min(LIMITS.burst, conn.tokens + ((now - conn.last) / 1000) * LIMITS.ratePerSec);
      conn.last = now;
      if (conn.tokens < 1) return conn.send({ re: msg.id, err: 'rate limited' });
      conn.tokens -= 1;
      const h = Object.hasOwn(handlers, msg.t) ? handlers[msg.t] : null;
      if (!h) return conn.send({ re: msg.id, err: 'unknown request' });
      try {
        const res = h(conn, msg);
        conn.send({ re: msg.id, ok: true, ...res });
        if ((msg.t === 'auth' || msg.t === 'register' || msg.t === 'addDevice') && conn.account) flush(conn);
      } catch (e) {
        if (!(e instanceof ClientError)) log('error', msg.t, e);
        conn.send({ re: msg.id, err: e instanceof ClientError ? e.message : 'server error' });
      }
    });
    ws.on('close', () => {
      if (conn.account) {
        const k = key(conn.account, conn.device);
        online.get(k)?.delete(conn);
        if (online.get(k)?.size === 0) online.delete(k);
      }
      for (const [id, l] of links) if (l.host === conn) links.delete(id);
    });
  });

  // Detect dead sockets (e.g. a phone that suspended the app) so they stop counting as "visible".
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, Number(process.env.HEARTBEAT_MS ?? 30000));

  const janitor = setInterval(() => {
    q.expire.run(Date.now() - LIMITS.mailboxTtlMs);
    for (const [id, l] of links) if (l.expires < Date.now()) links.delete(id);
    for (const [id, u] of uploads) if (u.expires < Date.now()) uploads.delete(id);
    for (const [k, t] of lastPush) if (Date.now() - t > 60_000) lastPush.delete(k);
    for (const [k, b] of buckets) if (b.reset < Date.now()) buckets.delete(k);
    for (const [k, exp] of sessions) if (exp < Date.now()) sessions.delete(k);
    fs.readdir(blobDir, (err, names) => {
      if (err) return;
      for (const name of names) {
        const f = path.join(blobDir, name);
        fs.stat(f, (e, st) => {
          if (e) return;
          const age = Date.now() - st.mtimeMs;
          if (age > LIMITS.blobTtlMs || (name.endsWith('.part') && age > LIMITS.uploadTtlMs)) fs.rm(f, { force: true }, () => {});
        });
      }
    });
  }, 60_000);

  return new Promise((resolve) => {
    server.listen(port, () => {
      log(`veil relay listening on :${server.address().port}`);
      resolve({
        port: server.address().port,
        blobDir,
        close: () => { clearInterval(janitor); clearInterval(heartbeat); wss.close(); server.close(); for (const c of wss.clients) c.terminate(); },
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer({ port: Number(process.env.PORT ?? 8080), dbPath: process.env.DB_PATH ?? 'veil.db' });
}
