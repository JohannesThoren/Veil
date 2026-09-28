// Veil relay: stores public prekeys, queues opaque ciphertext per device, relays device-link handshakes.
// It never sees plaintext, contact lists, group membership or names.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { openDb } from './db.js';
import { Ed, dec, enc, rand, stmt, isAccountId, ALPHABET } from '../shared/crypto.js';

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
const isBlobId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{22}$/.test(s);

const isB64 = (s, max = 200) => typeof s === 'string' && s.length > 0 && s.length <= max && /^[A-Za-z0-9_-]+$/.test(s);
const isDeviceId = (s) => typeof s === 'string' && s.length === 8 && [...s].every((c) => ALPHABET.includes(c));
const isLinkId = (s) => typeof s === 'string' && s.length === 8 && [...s].every((c) => ALPHABET.includes(c));
class ClientError extends Error {}
const must = (cond, msg) => { if (!cond) throw new ClientError(msg); };

export function startServer({ port = 8080, dbPath = 'veil.db', staticDir = path.join(__dirname, '../web/dist'), log = console.log } = {}) {
  const { q, tx } = openDb(dbPath);
  const blobDir = process.env.BLOB_DIR ?? path.join(path.dirname(path.resolve(dbPath)), 'blobs');
  fs.mkdirSync(blobDir, { recursive: true });
  const uploads = new Map();   // blobId -> { token, size, expires }
  const blobPath = (id) => path.join(blobDir, id);
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

  const registerTx = tx((a, identity, device, spk, opks) => {
    const now = Date.now();
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
    register(conn, { account, identity, sig, device, spk, opks }) {
      must(!conn.account, 'already authenticated');
      must(isAccountId(account), 'bad account id');
      must(isB64(identity), 'bad identity');
      must(Ed.verify(dec(sig ?? ''), stmt.register(account, identity), dec(identity)), 'registration signature invalid');
      checkDeviceBlock(account, identity, device);
      must(!q.getAccount.get(account), 'account id taken');
      registerTx(account, identity, device, spk, opks);
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
    send(conn, { k, msgs, accounts }) {
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
      for (const m of stored) {
        push(m.a, m.d, { t: 'env', env: { seq: m.seq, from: { a: conn.account, d: conn.device }, k, b: m.b, ts } });
      }
      return { ts };
    },
    ack(conn, { seqs }) {
      must(conn.account, 'not authenticated');
      must(Array.isArray(seqs), 'bad seqs');
      for (const s of seqs) q.ack.run(s, conn.account, conn.device);
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
    let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = path.join(staticDir, p);
    if (!file.startsWith(staticDir)) { res.writeHead(403).end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(staticDir, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404).end('Build the web client first: npm run build'); return; }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    });
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

  // ---------- WebSocket RPC ----------
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: LIMITS.frame });
  wss.on('connection', (ws) => {
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

  const janitor = setInterval(() => {
    q.expire.run(Date.now() - LIMITS.mailboxTtlMs);
    for (const [id, l] of links) if (l.expires < Date.now()) links.delete(id);
    for (const [id, u] of uploads) if (u.expires < Date.now()) uploads.delete(id);
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
        close: () => { clearInterval(janitor); wss.close(); server.close(); for (const c of wss.clients) c.terminate(); },
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer({ port: Number(process.env.PORT ?? 8080), dbPath: process.env.DB_PATH ?? 'veil.db' });
}
