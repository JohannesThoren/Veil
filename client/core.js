// Copyright (c) 2026 Johannes Thorén. All rights reserved.
// Licensed under the LGJT License v1. See LICENSE in the project root.
// Veil client core: account, sessions, fan-out, groups, device linking.
// UI-agnostic; runs in the browser (IdbStore + WebSocket) and in Node (MemoryStore + ws) for tests.
import {
  Ed, X, enc, dec, utf8, fromUtf8, concat, kdf, seal, open, stmt, rand,
  newAccountId, newDeviceId, newId, normalizeCode, isAccountId, safetyNumber, ALPHABET,
} from '../shared/crypto.js';
import { customAlphabet } from 'nanoid';
import { x3dhInitiate, x3dhRespond } from '../shared/x3dh.js';
import { initInitiator, initResponder, ratchetEncrypt, ratchetDecrypt } from '../shared/ratchet.js';
import { newSenderKey, distributionOf, receiverFromDistribution, groupEncrypt, groupDecrypt } from '../shared/senderkey.js';

const OPK_BATCH = 50;
const OPK_LOW = 20;
const SPK_MAX_AGE = 7 * 24 * 3600 * 1000;
const MAX_SESSIONS_PER_DEVICE = 4;
const LINK_HISTORY_PER_CHAT = 300;
const newLinkPart = customAlphabet(ALPHABET, 8);
const newLinkSecret = customAlphabet(ALPHABET, 16);
export const MAX_ATTACHMENT = 50 * 1024 * 1024;
const PHOTO_LABEL = '📷 Photo';

function validAttachment(a) {
  return a && typeof a === 'object'
    && /^[A-Za-z0-9_-]{22}$/.test(a.id) && /^[A-Za-z0-9_-]{43}$/.test(a.key)
    && Number.isInteger(a.size) && a.size > 0 && a.size <= MAX_ATTACHMENT
    && typeof a.mime === 'string' && /^image\/[a-z0-9.+-]+$/.test(a.mime)
    && (a.thumb == null || (typeof a.thumb === 'string' && a.thumb.length < 30000 && a.thumb.startsWith('data:image/')))
    && (a.w == null || (Number.isInteger(a.w) && a.w > 0)) && (a.h == null || (Number.isInteger(a.h) && a.h > 0));
}
const cleanAttachment = (a) => ({ id: a.id, key: a.key, size: a.size, mime: a.mime, name: String(a.name ?? '').slice(0, 200), w: a.w ?? null, h: a.h ?? null, thumb: a.thumb ?? null });

export class IdentityChangedError extends Error {
  constructor(account) { super(`Identity key for ${account} changed — possible interception`); this.account = account; }
}

const uniq = (a) => [...new Set(a)];
const previewText = (text, att) => (att ? (text ? `📷 ${text}` : PHOTO_LABEL) : text);
const pad = (n) => String(n).padStart(15, '0');

export class VeilClient {
  constructor({ store, url, WebSocket }) {
    this.store = store;
    this.url = url;
    this.WS = WebSocket;
    this.me = null;
    this.status = 'offline';
    this._listeners = {};
    this._rpcId = 0;
    this._pending = new Map();
    this._chain = Promise.resolve();
    this._linkHandlers = new Map();
    this._closed = false;
    this._backoff = 500;
    this.httpBase = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
    this._downloads = new Map();
    this._visible = true;
  }

  // ---------------- events ----------------
  on(ev, fn) { (this._listeners[ev] ??= new Set()).add(fn); return () => this._listeners[ev].delete(fn); }
  emit(ev, data) { for (const fn of this._listeners[ev] ?? []) try { fn(data); } catch (e) { console.error(e); } }

  /** Run fn exclusively: all session/ratchet state changes are serialised through this. */
  _serial(fn) {
    const run = this._chain.then(() => fn());
    this._chain = run.catch(() => {});
    return run;
  }

  async load() {
    this.me = (await this.store.get('me')) ?? null;
    if (this.me && !this.me.registered) { await this.store.clear(); this.me = null; }
    return this.me;
  }
  get identityPriv() { return dec(this.me.identity.priv); }

  // ---------------- transport ----------------
  connect() {
    this._closed = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new this.WS(this.url);
      this.ws = ws;
      this._setStatus('connecting');
      ws.onmessage = async (ev) => {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
        if (msg.re != null) {
          const p = this._pending.get(msg.re);
          if (!p) return;
          this._pending.delete(msg.re);
          clearTimeout(p.timer);
          msg.err ? p.reject(new Error(msg.err)) : p.resolve(msg);
          return;
        }
        if (msg.t === 'hello') {
          this._nonce = msg.nonce;
          try {
            if (this.me?.registered) await this._auth();
            else this._setStatus('online');
            this._backoff = 500;
            if (!settled) { settled = true; resolve(); }
          } catch (e) {
            if (!settled) { settled = true; reject(e); }
            this.emit('error', e);
          }
          return;
        }
        this._onPush(msg);
      };
      ws.onclose = () => {
        for (const p of this._pending.values()) { clearTimeout(p.timer); p.reject(new Error('disconnected')); }
        this._pending.clear();
        this._setStatus('offline');
        if (!settled) { settled = true; reject(new Error('Could not connect to server')); }
        if (!this._closed && this.me?.registered) {
          setTimeout(() => this.connect().catch(() => {}), this._backoff);
          this._backoff = Math.min(this._backoff * 2, 30000);
        }
      };
      ws.onerror = () => {};
    });
  }
  close() { this._closed = true; this.ws?.close(); }
  _setStatus(s) { this.status = s; this.emit('status', s); }

  rpc(t, payload = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('Not connected'));
      const id = ++this._rpcId;
      const timer = setTimeout(() => { this._pending.delete(id); reject(new Error(`${t} timed out`)); }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, id, t }));
    });
  }

  async _auth() {
    const sig = enc(Ed.sign(dec(this.me.sign.priv), stmt.auth(this._nonce)));
    const res = await this.rpc('auth', { account: this.me.account, device: this.me.deviceId, sig });
    this._setStatus('online');
    this.rpc('presence', { visible: this._visible }).catch(() => {});
    this._maintainPrekeys(res.opks).catch((e) => this.emit('error', e));
  }

  // ---------------- presence & push ----------------
  /** Tell the relay whether the app is in front. When it isn't, new messages also trigger a push. */
  setVisible(visible) {
    this._visible = !!visible;
    if (this.status === 'online') this.rpc('presence', { visible: this._visible }).catch(() => {});
  }
  async pushKey() { return (await this.rpc('pushKey')).key; }
  /** sub: PushSubscription.toJSON(), or null to stop pushes to this device. */
  setPushSubscription(sub) { return this.rpc('pushSubscribe', { sub }); }
  async setMuted(chatId, muted) {
    const chat = await this.store.get(`chat:${chatId}`);
    if (!chat) return;
    chat.muted = !!muted;
    await this.store.put(`chat:${chatId}`, chat);
    this.emit('change', { type: 'chat', chatId });
    this._fanout([], { t: 'chatState', chatId, patch: { muted: !!muted } }).catch(() => {});
  }

  _onPush(msg) {
    switch (msg.t) {
      case 'env':
        this._serial(() => this._handleEnvelope(msg.env))
          .catch((e) => console.warn('drop envelope', msg.env.seq, e.message))
          .finally(() => this.rpc('ack', { seqs: [msg.env.seq] }).catch(() => {}));
        break;
      case 'prekeysLow': this._maintainPrekeys(0).catch(() => {}); break;
      case 'devicesChanged': this.emit('change', { type: 'devices' }); break;
      case 'removed': this._closed = true; this.store.clear().then(() => this.emit('removed')); break;
      case 'link': this._linkHandlers.get(msg.link)?.(msg.p); break;
      case 'linkClosed': this._linkHandlers.get(msg.link)?.(null); break;
    }
  }

  // ---------------- keys ----------------
  async _newSpk() {
    const id = ((await this.store.get('spkNext')) ?? 1);
    const kp = X.gen();
    const pub = enc(kp.pub);
    const sig = enc(Ed.sign(this.identityPriv, stmt.spk(this.me.account, this.me.deviceId, id, pub)));
    const old = await this.store.get('spk');
    if (old) await this.store.put('spk-old', old);
    await this.store.put('spk', { id, priv: enc(kp.priv), pub, sig, created: Date.now() });
    await this.store.put('spkNext', id + 1);
    return { id, pub, sig };
  }
  async _newOpks(n) {
    let next = (await this.store.get('opkNext')) ?? 1;
    const out = [];
    for (let i = 0; i < n; i++, next++) {
      const kp = X.gen();
      await this.store.put(`opk:${next}`, { priv: enc(kp.priv), pub: enc(kp.pub) });
      out.push({ id: next, pub: enc(kp.pub) });
    }
    await this.store.put('opkNext', next);
    return out;
  }
  async _maintainPrekeys(count) {
    const spk = await this.store.get('spk');
    const payload = {};
    if (!spk || Date.now() - spk.created > SPK_MAX_AGE) payload.spk = await this._newSpk();
    if (count < OPK_LOW) payload.opks = await this._newOpks(OPK_BATCH);
    if (payload.spk || payload.opks) await this.rpc('prekeys', payload);
  }
  _deviceBlock(deviceId, sign, deviceName) {
    const nameKey = kdf(this.identityPriv, utf8('names'), 'veil/device-name/v1');
    return {
      id: deviceId,
      signPub: sign.pub,
      cert: enc(Ed.sign(this.identityPriv, stmt.device(this.me.account, deviceId, sign.pub))),
      nameBox: deviceName ? enc(seal(nameKey, utf8(deviceName))) : null,
    };
  }
  _openName(box) {
    if (!box) return null;
    try { return fromUtf8(open(kdf(this.identityPriv, utf8('names'), 'veil/device-name/v1'), dec(box))); } catch { return null; }
  }

  // ---------------- account ----------------
  /** Accepts an invite URL (…#invite=<code>) or a bare 24-char code. */
  static parseInvite(input) {
    const m = String(input ?? '').match(/[#?&]invite=([0-9a-z]{24})/);
    const c = m ? m[1] : normalizeCode(String(input ?? ''));
    return c.length === 24 ? c : null;
  }
  /** { ok: true } or { ok: false, reason } — without creating anything. */
  async checkInvite(code) {
    const res = await fetch(`${this.httpBase}/api/invite?code=${encodeURIComponent(code)}`);
    return res.json();
  }

  async createAccount({ deviceName = 'Device', profileName = '', invite } = {}) {
    const inviteCode = VeilClient.parseInvite(invite);
    if (!inviteCode) throw new Error('An invite is required to create an identity');
    if (!this.ws || this.ws.readyState !== 1) await this.connect();
    const identity = Ed.gen();
    const sign = Ed.gen();
    for (let attempt = 0; attempt < 5; attempt++) {
      const account = newAccountId();
      this.me = {
        account, deviceId: newDeviceId(),
        identity: { priv: enc(identity.priv), pub: enc(identity.pub) },
        sign: { priv: enc(sign.priv), pub: enc(sign.pub) },
        deviceName, profileName, registered: false, created: Date.now(),
      };
      await this.store.put('me', this.me);
      const spk = await this._newSpk();
      const opks = await this._newOpks(OPK_BATCH);
      try {
        await this.rpc('register', {
          account, identity: this.me.identity.pub,
          sig: enc(Ed.sign(identity.priv, stmt.register(account, this.me.identity.pub))),
          device: this._deviceBlock(this.me.deviceId, this.me.sign, deviceName), spk, opks, invite: inviteCode,
        });
      } catch (e) {
        if (e.message === 'account id taken') continue;
        await this.store.clear();
        this.me = null;
        throw e;
      }
      this.me.registered = true;
      await this.store.put('me', this.me);
      await this.store.put(`id:${account}`, { identity: this.me.identity.pub, verified: true });
      this._setStatus('online');
      this.emit('change', { type: 'me' });
      return this.me;
    }
    throw new Error('Could not allocate an account ID');
  }

  /** Contact card: a URL (works as a QR code and as a clickable link) carrying ID + identity key. */
  myCard(origin = '') {
    return `${origin}/#c=${this.me.account}.${this.me.identity.pub}`;
  }

  async setProfileName(name) {
    this.me.profileName = name.slice(0, 64);
    await this.store.put('me', this.me);
    this.emit('change', { type: 'me' });
    await this._fanout([], { t: 'me', profileName: this.me.profileName }).catch(() => {});
  }

  async wipe() { this.close(); await this.store.clear(); this.me = null; }

  // ---------------- devices ----------------
  async listDevices() {
    const res = await this.rpc('devices', { accounts: [this.me.account] });
    return (res.accounts[this.me.account]?.devices ?? []).map((d) => ({
      id: d.id, name: this._openName(d.nameBox) ?? 'Unnamed device', created: d.created, lastSeen: d.lastSeen,
      current: d.id === this.me.deviceId,
    }));
  }
  async removeDevice(deviceId) {
    const sig = enc(Ed.sign(this.identityPriv, stmt.removeDevice(this.me.account, deviceId)));
    await this.rpc('removeDevice', { device: deviceId, sig });
    await this.store.del(`sess:${this.me.account}:${deviceId}`);
  }

  // ---------------- identity pinning ----------------
  async _pin(account, identity) {
    const cur = await this.store.get(`id:${account}`);
    if (!cur) { await this.store.put(`id:${account}`, { identity, verified: false }); return; }
    if (cur.identity !== identity) throw new IdentityChangedError(account);
  }
  async getIdentity(account) { return this.store.get(`id:${account}`); }
  async setVerified(account, verified) {
    const cur = await this.store.get(`id:${account}`);
    if (cur) { cur.verified = verified; await this.store.put(`id:${account}`, cur); this.emit('change', { type: 'contact', account }); }
  }
  async safetyNumber(account) {
    const id = await this.store.get(`id:${account}`);
    return id ? safetyNumber(this.me.account, this.me.identity.pub, account, id.identity) : null;
  }

  /** Fetch device lists, verify identity pins and device certificates. */
  async _deviceLists(accounts) {
    const res = await this.rpc('devices', { accounts });
    const out = {};
    for (const a of accounts) {
      const info = res.accounts[a];
      if (!info) throw new Error(`Account ${a} does not exist`);
      await this._pin(a, info.identity);
      const ik = dec(info.identity);
      const devs = info.devices.filter((d) => Ed.verify(dec(d.cert), stmt.device(a, d.id, d.signPub), ik)).map((d) => d.id);
      out[a] = { identity: info.identity, devices: devs };
      // forget sessions with devices that no longer exist
      for (const [k] of await this.store.entries(`sess:${a}:`)) if (!devs.includes(k.split(':')[2])) await this.store.del(k);
    }
    return out;
  }

  // ---------------- pairwise sessions ----------------
  async _encryptFor(a, d, identity, content) {
    const key = `sess:${a}:${d}`;
    const recs = (await this.store.get(key)) ?? [];
    let rec = recs[0];
    if (!rec) {
      const bundle = await this.rpc('bundle', { account: a, device: d });
      const x = x3dhInitiate({ account: this.me.account, identity: { priv: this.identityPriv, pub: dec(this.me.identity.pub) } },
        { account: a, identity, deviceId: d }, bundle);
      rec = { state: initInitiator(x.sk, x.spkPub, x.ad), pending: x.header, ek: x.header.ek };
      recs.unshift(rec);
    }
    const { state, msg } = ratchetEncrypt(rec.state, utf8(JSON.stringify(content)));
    rec.state = state;
    await this.store.put(key, recs.slice(0, MAX_SESSIONS_PER_DEVICE));
    return JSON.stringify(rec.pending ? { pk: rec.pending, m: msg } : { m: msg });
  }

  async _decryptFrom(a, d, body) {
    const key = `sess:${a}:${d}`;
    let recs = (await this.store.get(key)) ?? [];
    let candidates = recs;
    let usedOpk = null;
    if (body.pk) {
      const existing = recs.find((r) => r.ek === body.pk.ek);
      if (existing) candidates = [existing];
      else {
        await this._verifyRemoteIdentity(a, body.pk.ik);
        const spkRec = [await this.store.get('spk'), await this.store.get('spk-old')].find((s) => s?.id === body.pk.spk);
        if (!spkRec) throw new Error('Unknown signed prekey');
        let opk = null;
        if (body.pk.opk != null) {
          const o = await this.store.get(`opk:${body.pk.opk}`);
          if (!o) throw new Error('One-time prekey already used');
          opk = { priv: dec(o.priv), pub: dec(o.pub) };
          usedOpk = body.pk.opk;
        }
        const spk = { priv: dec(spkRec.priv), pub: dec(spkRec.pub) };
        const x = x3dhRespond({ identity: { priv: this.identityPriv, pub: dec(this.me.identity.pub) } }, spk, opk, body.pk);
        candidates = [{ state: initResponder(x.sk, spk, x.ad), ek: body.pk.ek }];
      }
    }
    for (const r of candidates) {
      let out;
      try { out = ratchetDecrypt(r.state, body.m); } catch { continue; }
      r.state = out.state;
      r.pending = null; // peer has our session now
      recs = [r, ...recs.filter((x) => x !== r)].slice(0, MAX_SESSIONS_PER_DEVICE);
      await this.store.put(key, recs);
      if (usedOpk != null) await this.store.del(`opk:${usedOpk}`);
      return JSON.parse(fromUtf8(out.plaintext));
    }
    throw new Error('Could not decrypt message');
  }

  async _verifyRemoteIdentity(a, identity) {
    const pinned = await this.store.get(`id:${a}`);
    if (pinned) { if (pinned.identity !== identity) throw new IdentityChangedError(a); return; }
    const res = await this.rpc('devices', { accounts: [a] });
    if (res.accounts[a]?.identity !== identity) throw new Error('Sender identity does not match directory');
    await this._pin(a, identity);
  }

  /**
   * Encrypt `content` for every device of `accounts` plus all my other devices, and send.
   * The server rejects the batch if any device is missing, so new devices can't be silently skipped.
   */
  _fanout(accounts, content) {
    return this._serial(async () => {
      const accts = uniq([...accounts, this.me.account]);
      let lists = await this._deviceLists(accts);
      for (let attempt = 0; attempt < 3; attempt++) {
        const msgs = [];
        for (const a of accts) for (const d of lists[a].devices) {
          if (a === this.me.account && d === this.me.deviceId) continue;
          msgs.push({ a, d, b: await this._encryptFor(a, d, lists[a].identity, content) });
        }
        if (!msgs.length) return Date.now();
        const res = await this.rpc('send', { k: 'dm', msgs, accounts: accts, push: content.t === 'msg' });
        if (!res.stale) return res.ts;
        lists = await this._deviceLists(accts);
      }
      throw new Error('Device list kept changing, try again');
    });
  }

  /** Pairwise send to an explicit set of devices (no completeness check). Must be called inside _serial. */
  async _sendToDevices(targets, lists, content) {
    const msgs = [];
    for (const { a, d } of targets) msgs.push({ a, d, b: await this._encryptFor(a, d, lists[a].identity, content) });
    if (msgs.length) await this.rpc('send', { k: 'dm', msgs });
  }

  // ---------------- incoming ----------------
  async _handleEnvelope(env) {
    const from = env.from;
    let content;
    if (env.k === 'dm') {
      content = await this._decryptFrom(from.a, from.d, JSON.parse(env.b));
    } else if (env.k === 'g') {
      const body = JSON.parse(env.b);
      const rk = `rsk:${from.a}:${from.d}:${body.k}`;
      const rs = await this.store.get(rk);
      if (!rs) throw new Error('No sender key for group message');
      const out = groupDecrypt(rs, body);
      await this.store.put(rk, { ...out.state, gid: rs.gid });
      content = JSON.parse(fromUtf8(out.plaintext));
      if (content.t !== 'msg' || content.to?.group !== rs.gid) throw new Error('Group message bound to another group');
    } else return;
    await this._onContent(from, content, env);
  }

  async _onContent(from, c, env) {
    const mine = from.a === this.me.account;
    switch (c.t) {
      case 'msg': return this._onMessage(from, c, env);
      case 'skd': {
        await this.store.put(`rsk:${from.a}:${from.d}:${c.dist.keyId}`, { ...receiverFromDistribution(c.dist), gid: c.gid });
        return;
      }
      case 'gstate': return this._onGroupState(from, c.group);
      case 'gleave': {
        const g = await this.store.get(`group:${c.gid}`);
        if (!g || !g.members.includes(from.a)) return;
        if (mine) {
          // I left from another of my devices
          g.members = g.members.filter((m) => m !== this.me.account);
          g.admins = g.admins.filter((m) => m !== this.me.account);
          g.left = true;
          await this.store.put(`group:${g.id}`, g);
          await this.store.del(`mysk:${g.id}`);
          this.emit('change', { type: 'group', gid: g.id });
          return;
        }
        g.members = g.members.filter((m) => m !== from.a);
        g.admins = g.admins.filter((m) => m !== from.a);
        await this.store.put(`group:${g.id}`, g);
        await this._systemMessage(`g:${g.id}`, { kind: 'left', who: from.a }, env.ts);
        return;
      }
      case 'contact': {
        if (!mine) return;
        const cur = await this.store.get(`contact:${c.contact.id}`);
        await this.store.put(`contact:${c.contact.id}`, { ...cur, ...c.contact });
        if (c.identity) await this._pin(c.contact.id, c.identity).catch(() => {});
        if (c.contact.status !== 'blocked') await this._ensureChat(`dm:${c.contact.id}`, { kind: 'dm', peer: c.contact.id });
        this.emit('change', { type: 'contact', account: c.contact.id });
        return;
      }
      case 'chatState': {
        if (!mine) return;
        const chat = await this.store.get(`chat:${c.chatId}`);
        const patch = {};
        if (c.patch && 'unread' in c.patch) patch.unread = Number(c.patch.unread) || 0;
        if (c.patch && 'muted' in c.patch) patch.muted = !!c.patch.muted;
        if (chat) { Object.assign(chat, patch); await this.store.put(`chat:${c.chatId}`, chat); this.emit('change', { type: 'chat', chatId: c.chatId }); }
        return;
      }
      case 'call': {
        // Call signaling (ring/join/sdp/leave/…) travels over the same E2E channel; the call engine handles it.
        if (typeof c.id !== 'string' || c.id.length > 40 || typeof c.op !== 'string') return;
        if (!mine && c.profile?.name != null) {
          const name = String(c.profile.name).slice(0, 64);
          if ((await this.store.get(`profile:${from.a}`)) !== name) { await this.store.put(`profile:${from.a}`, name); this.emit('change', { type: 'contact', account: from.a }); }
        }
        this.emit('call', { from, c, ts: env.ts });
        return;
      }
      case 'me': {
        if (!mine) return;
        this.me.profileName = c.profileName;
        await this.store.put('me', this.me);
        this.emit('change', { type: 'me' });
        return;
      }
    }
  }

  async _onMessage(from, c, env) {
    const mine = from.a === this.me.account;
    if (typeof c.text !== 'string' || typeof c.id !== 'string') return;
    const att = c.att != null ? (validAttachment(c.att) ? cleanAttachment(c.att) : undefined) : null;
    if (att === undefined || (!c.text && !att)) return;
    let chatId;
    if (c.to?.group) {
      const g = await this.store.get(`group:${c.to.group}`);
      if (!g || !g.members.includes(from.a)) return;
      chatId = `g:${g.id}`;
    } else if (mine) {
      if (!isAccountId(c.to?.dm)) return;
      chatId = `dm:${c.to.dm}`;
      await this._ensureChat(chatId, { kind: 'dm', peer: c.to.dm });
    } else {
      let contact = await this.store.get(`contact:${from.a}`);
      if (!contact) {
        contact = { id: from.a, nickname: '', profileName: '', status: 'request', added: Date.now() };
        await this.store.put(`contact:${from.a}`, contact);
      }
      if (contact.status === 'blocked') return;
      chatId = `dm:${from.a}`;
      await this._ensureChat(chatId, { kind: 'dm', peer: from.a, request: contact.status === 'request' });
    }
    if (!mine && c.profile?.name != null) {
      const k = `profile:${from.a}`;
      const name = String(c.profile.name).slice(0, 64);
      if ((await this.store.get(k)) !== name) { await this.store.put(k, name); this.emit('change', { type: 'contact', account: from.a }); }
    }
    if (await this.store.get(`mid:${c.id}`)) return;
    const msg = { id: c.id, chatId, from: from.a, fromDevice: from.d, text: c.text.slice(0, 20000), att, ts: env.ts, mine, status: mine ? 'sent' : 'received' };
    const key = `msg:${chatId}:${pad(env.ts)}:${c.id}`;
    await this.store.put(key, msg);
    await this.store.put(`mid:${c.id}`, key);
    const chat = await this.store.get(`chat:${chatId}`);
    chat.last = { text: previewText(msg.text, att), ts: msg.ts, from: from.a };
    chat.updated = msg.ts;
    if (mine) chat.unread = 0; else chat.unread = (chat.unread ?? 0) + 1;
    await this.store.put(`chat:${chatId}`, chat);
    this.emit('message', msg);
    this.emit('change', { type: 'chat', chatId });
  }

  async _systemMessage(chatId, sys, ts = Date.now()) {
    const id = newId();
    const msg = { id, chatId, sys, ts, mine: false, status: 'system' };
    await this.store.put(`msg:${chatId}:${pad(ts)}:${id}`, msg);
    const chat = await this.store.get(`chat:${chatId}`);
    if (chat) { chat.updated = ts; await this.store.put(`chat:${chatId}`, chat); }
    this.emit('change', { type: 'chat', chatId });
  }

  async _ensureChat(chatId, init) {
    let chat = await this.store.get(`chat:${chatId}`);
    if (!chat) {
      chat = { id: chatId, unread: 0, updated: Date.now(), last: null, ...init };
      await this.store.put(`chat:${chatId}`, chat);
      this.emit('change', { type: 'chat', chatId });
    }
    return chat;
  }

  // ---------------- contacts ----------------
  /** Accepts a contact URL/QR payload (…#c=<id>.<key>) or a bare 16-char ID. */
  static parseContact(input) {
    const s = input.trim();
    const m = s.match(/[#?&]c=([0-9a-z]{16})\.([A-Za-z0-9_-]{43})/);
    if (m) return { account: m[1], identity: m[2] };
    const id = normalizeCode(s);
    if (isAccountId(id)) return { account: id, identity: null };
    return null;
  }

  async addContact(input, nickname = '') {
    const parsed = VeilClient.parseContact(input);
    if (!parsed) throw new Error('That is not a valid ID or contact code');
    const { account, identity } = parsed;
    if (account === this.me.account) throw new Error("That's your own ID");
    const res = await this.rpc('devices', { accounts: [account] });
    const info = res.accounts[account];
    if (!info) throw new Error('No account with that ID');
    if (identity && identity !== info.identity) throw new Error('Key in the QR code does not match the server — possible interception');
    await this._pin(account, info.identity);
    if (identity) await this.setVerified(account, true);
    const cur = await this.store.get(`contact:${account}`);
    const contact = { id: account, profileName: '', added: Date.now(), ...cur, nickname: nickname || cur?.nickname || '', status: 'accepted' };
    await this.store.put(`contact:${account}`, contact);
    const chat = await this._ensureChat(`dm:${account}`, { kind: 'dm', peer: account });
    if (chat.request) { chat.request = false; await this.store.put(`chat:${chat.id}`, chat); }
    this.emit('change', { type: 'contact', account });
    this._syncContact(contact).catch(() => {});
    return contact;
  }
  async _syncContact(contact) {
    const id = await this.store.get(`id:${contact.id}`);
    await this._fanout([], { t: 'contact', contact, identity: id?.identity });
  }
  async updateContact(account, patch) {
    const cur = await this.store.get(`contact:${account}`);
    if (!cur) return;
    const contact = { ...cur, ...patch };
    await this.store.put(`contact:${account}`, contact);
    if (patch.status === 'accepted') {
      const chat = await this.store.get(`chat:dm:${account}`);
      if (chat?.request) { chat.request = false; await this.store.put(`chat:${chat.id}`, chat); }
    }
    if (patch.status === 'blocked') await this.store.del(`chat:dm:${account}`);
    this.emit('change', { type: 'contact', account });
    this._syncContact(contact).catch(() => {});
  }
  async contacts() { return (await this.store.entries('contact:')).map(([, v]) => v); }
  async contact(account) { return this.store.get(`contact:${account}`); }
  async displayName(account) {
    if (account === this.me.account) return this.me.profileName || 'You';
    const c = await this.store.get(`contact:${account}`);
    return c?.nickname || c?.profileName || (await this.store.get(`profile:${account}`)) || account.slice(0, 4) + '…' + account.slice(-4);
  }

  // ---------------- calls (signaling transport) ----------------
  /** ICE servers (STUN + short-lived TURN credentials), cached until shortly before they expire. */
  async iceServers() {
    if (this._ice && this._ice.expires - Date.now() > 10 * 60 * 1000) return this._ice.servers;
    const r = await this.rpc('iceServers');
    this._ice = { servers: r.iceServers, expires: r.expires };
    return r.iceServers;
  }
  /** Every device of these accounts plus my own other devices (identity-checked). */
  callDevices(accounts) {
    return this._serial(async () => {
      const accts = uniq([...accounts, this.me.account]);
      const lists = await this._deviceLists(accts);
      const out = [];
      for (const a of accts) for (const d of lists[a].devices) if (!(a === this.me.account && d === this.me.deviceId)) out.push({ a, d });
      return out;
    });
  }
  /** Send a call signal pairwise-encrypted to specific devices. push: wake devices with an "incoming call" notification. */
  sendCall(targets, content, { push = false } = {}) {
    return this._serial(async () => {
      const msgs = [];
      for (const { a, d } of targets) {
        let id = await this.store.get(`id:${a}`);
        if (!id) { await this._deviceLists([a]); id = await this.store.get(`id:${a}`); }
        try { msgs.push({ a, d, b: await this._encryptFor(a, d, id.identity, { ...content, t: 'call' }) }); } catch (e) { console.warn('call signal to', a, d, e.message); }
      }
      if (msgs.length) await this.rpc('send', { k: 'dm', msgs, ...(push ? { push: 'call' } : {}) });
    });
  }
  /** My display name, attached to call setup so people who haven't chatted yet still see who's calling. */
  get _profileTag() { return this.me.profileName ? { name: this.me.profileName } : undefined; }
  /** Add a call entry to a chat's history (each device records its own view of the call). */
  async logCall(chatId, info) {
    const chat = await this.store.get(`chat:${chatId}`);
    if (!chat) return;
    const ts = Date.now();
    await this._systemMessage(chatId, { kind: 'call', ...info }, ts);
    const icon = info.video ? '📹' : '📞';
    const label = info.status === 'missed' ? 'Missed call' : info.status === 'declined' ? 'Declined call' : info.status === 'no-answer' ? 'No answer'
      : info.status === 'busy' ? 'Busy' : info.dir === 'out' ? 'Outgoing call' : 'Incoming call';
    const fresh = await this.store.get(`chat:${chatId}`);
    fresh.last = { text: `${icon} ${label}`, ts, from: info.dir === 'out' ? this.me.account : info.from ?? null };
    fresh.updated = ts;
    if (info.status === 'missed') fresh.unread = (fresh.unread ?? 0) + 1;
    await this.store.put(`chat:${chatId}`, fresh);
    this.emit('change', { type: 'chat', chatId });
  }

  // ---------------- chats & messages ----------------
  async chats() {
    const list = (await this.store.entries('chat:')).map(([, v]) => v);
    return list.sort((a, b) => b.updated - a.updated);
  }
  async chat(chatId) { return this.store.get(`chat:${chatId}`); }
  async messages(chatId) { return (await this.store.entries(`msg:${chatId}:`)).map(([, v]) => v); }
  async markRead(chatId) {
    const chat = await this.store.get(`chat:${chatId}`);
    if (chat && chat.unread) {
      chat.unread = 0;
      await this.store.put(`chat:${chatId}`, chat);
      this.emit('change', { type: 'chat', chatId });
      this._fanout([], { t: 'chatState', chatId, patch: { unread: 0 } }).catch(() => {});
    }
  }
  async deleteChat(chatId) {
    for (const [k, v] of await this.store.entries(`msg:${chatId}:`)) {
      await this.store.del(k);
      await this.store.del(`mid:${v.id}`);
      if (v.att) await this.store.del(`file:${v.att.id}`);
    }
    await this.store.del(`chat:${chatId}`);
    this.emit('change', { type: 'chat', chatId });
  }

  /**
   * Send a text and/or an image. attachment = { bytes: Uint8Array, mime, name, w, h, thumb }.
   * Images are encrypted here with a fresh key, uploaded as opaque bytes, and the key travels
   * inside the end-to-end encrypted message.
   */
  async sendText(chatId, text, { attachment } = {}) {
    text = (text ?? '').trim();
    if (!text && !attachment) return;
    if (attachment) {
      if (!(attachment.bytes instanceof Uint8Array)) throw new Error('attachment.bytes must be a Uint8Array');
      if (attachment.bytes.length > MAX_ATTACHMENT) throw new Error('Images can be at most 50 MB');
      if (!/^image\//.test(attachment.mime ?? '')) throw new Error('Only images can be sent');
    }
    const chat = await this.store.get(`chat:${chatId}`);
    if (!chat) throw new Error('No such chat');
    const id = newId();
    const ts = Date.now();
    const key = `msg:${chatId}:${pad(ts)}:${id}`;
    const att = attachment ? cleanAttachment({ ...attachment, id: enc(rand(16)), key: enc(rand(32)), size: attachment.bytes.length }) : null;
    if (att) await this.store.put(`file:${att.id}`, attachment.bytes);
    const msg = { id, chatId, from: this.me.account, fromDevice: this.me.deviceId, text, att, ts, mine: true, status: 'sending' };
    await this.store.put(key, msg);
    await this.store.put(`mid:${id}`, key);
    chat.last = { text: previewText(text, att), ts, from: this.me.account };
    chat.updated = ts;
    if (chat.request) chat.request = false;
    await this.store.put(`chat:${chatId}`, chat);
    this.emit('change', { type: 'chat', chatId });
    try {
      if (att) await this._uploadBlob(att.id, seal(dec(att.key), attachment.bytes));
      const content = { t: 'msg', id, text, att: att ?? undefined, profile: this.me.profileName ? { name: this.me.profileName } : undefined };
      if (chat.kind === 'dm') {
        const contact = await this.store.get(`contact:${chat.peer}`);
        if (contact?.status === 'request') await this.updateContact(chat.peer, { status: 'accepted' });
        await this._fanout([chat.peer], { ...content, to: { dm: chat.peer } });
      } else {
        await this._groupSend(chat.gid, { ...content, to: { group: chat.gid } });
      }
      msg.status = 'sent';
    } catch (e) {
      msg.status = 'failed';
      msg.error = e.message;
      this.emit('error', e);
    }
    await this.store.put(key, msg);
    this.emit('change', { type: 'chat', chatId });
    return msg;
  }

  async _uploadBlob(blobId, ciphertext) {
    const { token } = await this.rpc('blobToken', { blob: blobId, size: ciphertext.length });
    const res = await fetch(`${this.httpBase}/blob/${blobId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Token': token },
      body: ciphertext,
    });
    if (!res.ok) throw new Error(res.status === 413 ? 'Image is too large' : `Upload failed (${res.status})`);
  }

  /** Decrypted bytes of an attachment; downloaded once, then kept locally. */
  async getAttachment(att) {
    const cached = await this.store.get(`file:${att.id}`);
    if (cached) return cached;
    if (this._downloads.has(att.id)) return this._downloads.get(att.id);
    const p = (async () => {
      const res = await fetch(`${this.httpBase}/blob/${att.id}`);
      if (res.status === 404) throw new Error('This image has expired on the server');
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const ct = new Uint8Array(await res.arrayBuffer());
      if (ct.length > MAX_ATTACHMENT + 40) throw new Error('Attachment too large');
      const bytes = open(dec(att.key), ct); // authenticates: a swapped or corrupted blob fails here
      await this.store.put(`file:${att.id}`, bytes);
      return bytes;
    })();
    this._downloads.set(att.id, p);
    try { return await p; } finally { this._downloads.delete(att.id); }
  }

  async retry(chatId, msgId) {
    const key = await this.store.get(`mid:${msgId}`);
    const msg = key && await this.store.get(key);
    if (!msg || msg.status !== 'failed') return;
    let attachment;
    if (msg.att) {
      const bytes = await this.store.get(`file:${msg.att.id}`);
      if (!bytes) throw new Error('The image is no longer on this device');
      attachment = { ...msg.att, bytes };
      await this.store.del(`file:${msg.att.id}`);
    }
    await this.store.del(key);
    await this.store.del(`mid:${msgId}`);
    return this.sendText(chatId, msg.text, { attachment });
  }

  // ---------------- groups ----------------
  async group(gid) { return this.store.get(`group:${gid}`); }

  async createGroup(name, members) {
    members = uniq(members).filter((m) => m !== this.me.account);
    const gid = newId();
    const group = { id: gid, name: name.slice(0, 80), members: [this.me.account, ...members], admins: [this.me.account], v: 1, createdBy: this.me.account };
    await this.store.put(`group:${gid}`, group);
    await this._ensureChat(`g:${gid}`, { kind: 'group', gid });
    await this._systemMessage(`g:${gid}`, { kind: 'created', who: this.me.account });
    await this._fanout(members, { t: 'gstate', group });
    return group;
  }

  async _updateGroup(gid, mutate, notifyExtra = []) {
    const g = await this.store.get(`group:${gid}`);
    if (!g) throw new Error('No such group');
    if (!g.admins.includes(this.me.account)) throw new Error('Only admins can change the group');
    const before = [...g.members];
    const next = mutate(structuredClone(g));
    next.v = g.v + 1;
    await this._fanout(uniq([...before, ...next.members, ...notifyExtra]).filter((m) => m !== this.me.account), { t: 'gstate', group: next });
    await this.store.put(`group:${gid}`, next);
    await this._describeGroupChange(g, next, this.me.account);
    this.emit('change', { type: 'group', gid });
    return next;
  }
  addMembers(gid, accounts) { return this._updateGroup(gid, (g) => ({ ...g, members: uniq([...g.members, ...accounts]) })); }
  removeMember(gid, account) { return this._updateGroup(gid, (g) => ({ ...g, members: g.members.filter((m) => m !== account), admins: g.admins.filter((m) => m !== account) })); }
  renameGroup(gid, name) { return this._updateGroup(gid, (g) => ({ ...g, name: name.slice(0, 80) })); }
  setAdmin(gid, account, admin) {
    return this._updateGroup(gid, (g) => ({ ...g, admins: admin ? uniq([...g.admins, account]) : g.admins.filter((a) => a !== account) }));
  }
  async leaveGroup(gid) {
    const g = await this.store.get(`group:${gid}`);
    if (!g) return;
    await this._fanout(g.members.filter((m) => m !== this.me.account), { t: 'gleave', gid });
    g.members = g.members.filter((m) => m !== this.me.account);
    g.admins = g.admins.filter((m) => m !== this.me.account);
    g.left = true;
    await this.store.put(`group:${gid}`, g);
    await this.store.del(`mysk:${gid}`);
    this.emit('change', { type: 'group', gid });
  }
  async acceptGroup(gid) {
    const chat = await this.store.get(`chat:g:${gid}`);
    if (chat) { chat.request = false; await this.store.put(`chat:${chat.id}`, chat); this.emit('change', { type: 'chat', chatId: chat.id }); }
  }

  async _onGroupState(from, next) {
    if (!next || typeof next.id !== 'string' || !Array.isArray(next.members) || !Array.isArray(next.admins)) return;
    const cur = await this.store.get(`group:${next.id}`);
    const mine = from.a === this.me.account;
    let ok;
    if (mine) ok = !cur || next.v > cur.v;
    else if (!cur) ok = next.members.includes(this.me.account) && next.admins.includes(from.a) && next.members.includes(from.a);
    else ok = cur.admins.includes(from.a) && next.v > cur.v;
    if (!ok) return;
    const removed = !next.members.includes(this.me.account);
    const g = { ...next, left: removed || undefined };
    await this.store.put(`group:${g.id}`, g);
    if (!cur) {
      if (removed) return;
      const contact = await this.store.get(`contact:${from.a}`);
      await this._ensureChat(`g:${g.id}`, { kind: 'group', gid: g.id, request: !mine && contact?.status !== 'accepted' });
      await this._systemMessage(`g:${g.id}`, mine ? { kind: 'created', who: from.a } : { kind: 'added-you', who: from.a });
    } else {
      await this._describeGroupChange(cur, g, from.a);
    }
    if (removed) await this.store.del(`mysk:${g.id}`);
    this.emit('change', { type: 'group', gid: g.id });
  }

  async _describeGroupChange(prev, next, by) {
    const chatId = `g:${next.id}`;
    const added = next.members.filter((m) => !prev.members.includes(m));
    const removed = prev.members.filter((m) => !next.members.includes(m));
    if (added.length) await this._systemMessage(chatId, { kind: 'added', who: by, targets: added });
    if (removed.length) await this._systemMessage(chatId, { kind: 'removed', who: by, targets: removed });
    if (prev.name !== next.name) await this._systemMessage(chatId, { kind: 'renamed', who: by, name: next.name });
  }

  _groupSend(gid, content) {
    return this._serial(async () => {
      const g = await this.store.get(`group:${gid}`);
      if (!g || !g.members.includes(this.me.account)) throw new Error('You are not in this group');
      const accts = uniq([...g.members, this.me.account]);
      for (let attempt = 0; attempt < 3; attempt++) {
        const lists = await this._deviceLists(accts);
        const targets = [];
        for (const a of accts) for (const d of lists[a].devices) if (!(a === this.me.account && d === this.me.deviceId)) targets.push({ a, d });
        const targetKeys = new Set(targets.map((t) => `${t.a}:${t.d}`));
        let mysk = await this.store.get(`mysk:${gid}`);
        // Rotate whenever anyone who holds the current key is no longer a member (or device was removed).
        if (!mysk || mysk.holders.some((h) => !targetKeys.has(h))) mysk = { sk: newSenderKey(), holders: [] };
        const missing = targets.filter((t) => !mysk.holders.includes(`${t.a}:${t.d}`));
        if (missing.length) {
          await this._sendToDevices(missing, lists, { t: 'skd', gid, dist: distributionOf(mysk.sk) });
          mysk.holders.push(...missing.map((t) => `${t.a}:${t.d}`));
        }
        const { state, msg } = groupEncrypt(mysk.sk, utf8(JSON.stringify(content)));
        mysk.sk = state;
        await this.store.put(`mysk:${gid}`, mysk);
        if (!targets.length) return Date.now();
        const b = JSON.stringify(msg);
        const res = await this.rpc('send', { k: 'g', msgs: targets.map((t) => ({ ...t, b })), accounts: accts, push: content.t === 'msg' });
        if (!res.stale) return res.ts;
      }
      throw new Error('Group device list kept changing, try again');
    });
  }

  // ---------------- device linking ----------------
  /**
   * On an existing device: open a link slot. Returns a code (and URL for the QR).
   * onRequest({ deviceName }) is called when a new device joins; resolve true to approve.
   */
  async startLink({ origin = '', onRequest, onDone }) {
    const linkId = newLinkPart();
    const secret = newLinkSecret();
    await this.rpc('linkOpen', { link: linkId });
    const K = kdf(utf8(secret), utf8(linkId), 'veil/link/v1');
    const cancel = () => { this._linkHandlers.delete(linkId); this.rpc('linkClose', { link: linkId }).catch(() => {}); };
    this._linkHandlers.set(linkId, async (p) => {
      if (!p) return;
      try {
        const req = JSON.parse(fromUtf8(open(K, dec(p), utf8('join'))));
        const approved = await onRequest({ deviceName: String(req.name ?? '').slice(0, 64) });
        if (!approved) { cancel(); onDone?.(false); return; }
        const eph = X.gen();
        const K2 = kdf(concat(K, X.dh(eph.priv, dec(req.eph))), utf8(linkId), 'veil/link/v1/bundle');
        const bundle = await this._exportBundle();
        const box = seal(K2, utf8(JSON.stringify(bundle)), utf8('bundle'));
        const outer = seal(K, utf8(JSON.stringify({ eph: enc(eph.pub), box: enc(box) })), utf8('reply'));
        await this.rpc('linkSend', { link: linkId, p: enc(outer) }, 60000);
        this._linkHandlers.delete(linkId);
        onDone?.(true);
      } catch (e) {
        cancel();
        onDone?.(false, e);
      }
    });
    const code = (linkId + secret).match(/.{4}/g).join('-');
    return { code, url: `${origin}/#link=${linkId}${secret}`, cancel };
  }

  static parseLinkCode(input) {
    const m = input.match(/[#?&]link=([0-9a-z]{24})/);
    const c = m ? m[1] : normalizeCode(input);
    return c.length === 24 ? { linkId: c.slice(0, 8), secret: c.slice(8) } : null;
  }

  /** On a new device: join via code; returns a ready, registered client. */
  static async joinLink({ store, url, WebSocket, code, deviceName = 'Device', timeoutMs = 180000 }) {
    const parsed = VeilClient.parseLinkCode(code);
    if (!parsed) throw new Error('That is not a valid link code');
    const { linkId, secret } = parsed;
    const client = new VeilClient({ store, url, WebSocket });
    await client.connect();
    const K = kdf(utf8(secret), utf8(linkId), 'veil/link/v1');
    const eph = X.gen();
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for approval')), timeoutMs);
      client._linkHandlers.set(linkId, (p) => { clearTimeout(timer); p ? resolve(p) : reject(new Error('Link was declined or cancelled')); });
    });
    const p = seal(K, utf8(JSON.stringify({ eph: enc(eph.pub), name: deviceName })), utf8('join'));
    try {
      await client.rpc('linkJoin', { link: linkId, p: enc(p) });
      const p2 = await reply;
      const outer = JSON.parse(fromUtf8(open(K, dec(p2), utf8('reply'))));
      const K2 = kdf(concat(K, X.dh(eph.priv, dec(outer.eph))), utf8(linkId), 'veil/link/v1/bundle');
      const bundle = JSON.parse(fromUtf8(open(K2, dec(outer.box), utf8('bundle'))));
      await client._importBundle(bundle, deviceName);
      return client;
    } catch (e) {
      client.close();
      throw e;
    }
  }

  async _exportBundle() {
    const chats = (await this.store.entries('chat:')).map(([, v]) => v);
    const messages = [];
    for (const chat of chats) {
      const ms = await this.store.entries(`msg:${chat.id}:`);
      for (const [, m] of ms.slice(-LINK_HISTORY_PER_CHAT)) messages.push(m.status === 'sending' ? { ...m, status: 'failed' } : m);
    }
    const all = async (p) => (await this.store.entries(p)).map(([k, v]) => [k, v]);
    return {
      v: 1,
      account: this.me.account,
      identity: this.me.identity,
      profileName: this.me.profileName,
      kv: [...await all('contact:'), ...await all('id:'), ...await all('profile:'), ...await all('group:'), ...chats.map((c) => [`chat:${c.id}`, c])],
      messages,
    };
  }

  async _importBundle(b, deviceName) {
    await this.store.clear();
    this.me = {
      account: b.account, deviceId: newDeviceId(), identity: b.identity,
      sign: (() => { const s = Ed.gen(); return { priv: enc(s.priv), pub: enc(s.pub) }; })(),
      deviceName, profileName: b.profileName ?? '', registered: false, created: Date.now(),
    };
    await this.store.put('me', this.me);
    for (const [k, v] of b.kv) await this.store.put(k, v);
    for (const m of b.messages) {
      const key = `msg:${m.chatId}:${pad(m.ts)}:${m.id}`;
      await this.store.put(key, m);
      await this.store.put(`mid:${m.id}`, key);
    }
    const spk = await this._newSpk();
    const opks = await this._newOpks(OPK_BATCH);
    await this.rpc('addDevice', { account: this.me.account, device: this._deviceBlock(this.me.deviceId, this.me.sign, deviceName), spk, opks });
    this.me.registered = true;
    await this.store.put('me', this.me);
    this._setStatus('online');
    this.emit('change', { type: 'me' });
  }
}
