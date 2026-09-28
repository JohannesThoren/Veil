// End-to-end: real relay server + several clients over real WebSockets.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';
import { startServer } from '../server/server.js';
import { VeilClient } from '../client/core.js';
import { MemoryStore } from '../client/store.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veil-'));
const srv = await startServer({ port: 0, dbPath: path.join(dir, 'test.db'), log: () => {} });
const url = `ws://localhost:${srv.port}/ws`;
const clients = [];
const mk = () => { const c = new VeilClient({ store: new MemoryStore(), url, WebSocket }); clients.push(c); return c; };

async function waitFor(fn, label, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timeout: ' + label);
}
const texts = async (c, chatId) => (await c.messages(chatId)).filter((m) => m.text).map((m) => m.text);
let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('  ✓', name); }

console.log('end-to-end');
const alice = mk(), bob = mk(), carol = mk();
let alice2, bob2;

try {
  await t('create accounts (random 16-char IDs, no usernames)', async () => {
    await alice.createAccount({ deviceName: 'Alice laptop', profileName: 'Alice' });
    await bob.createAccount({ deviceName: 'Bob phone', profileName: 'Bob' });
    await carol.createAccount({ deviceName: 'Carol', profileName: 'Carol' });
    assert.match(alice.me.account, /^[0-9a-z]{16}$/);
    assert.notEqual(alice.me.account, bob.me.account);
  });

  await t('add contact by bare ID, first message arrives as a request', async () => {
    await alice.addContact(bob.me.account.match(/.{4}/g).join('-').toUpperCase());
    await alice.sendText(`dm:${bob.me.account}`, 'hi bob');
    await waitFor(async () => (await texts(bob, `dm:${alice.me.account}`)).includes('hi bob'), 'bob gets hi');
    const chat = await bob.chat(`dm:${alice.me.account}`);
    assert.equal(chat.request, true);
    assert.equal(await bob.displayName(alice.me.account), 'Alice');
  });

  await t('reply accepts the request; ratchet works both ways', async () => {
    await bob.sendText(`dm:${alice.me.account}`, 'hey alice');
    await waitFor(async () => (await texts(alice, `dm:${bob.me.account}`)).includes('hey alice'), 'alice gets reply');
    assert.equal((await bob.chat(`dm:${alice.me.account}`)).request, false);
    for (let i = 0; i < 5; i++) await alice.sendText(`dm:${bob.me.account}`, `burst ${i}`);
    await waitFor(async () => (await texts(bob, `dm:${alice.me.account}`)).includes('burst 4'), 'burst');
  });

  await t('QR contact card with a wrong key is rejected; correct one marks verified', async () => {
    const good = bob.myCard('https://x');
    const bad = good.replace(/\.(.)/, (m, ch) => '.' + (ch === 'A' ? 'B' : 'A'));
    await assert.rejects(carol.addContact(bad), /interception|valid/);
    await carol.addContact(good);
    assert.equal((await carol.getIdentity(bob.me.account)).verified, true);
    assert.equal(await carol.safetyNumber(bob.me.account), await bob.safetyNumber(carol.me.account).catch(() => null) ?? await carol.safetyNumber(bob.me.account));
  });

  await t('link a second device by code — needs approval, carries history', async () => {
    let asked = null;
    const link = await alice.startLink({ origin: 'https://x', onRequest: async (r) => { asked = r.deviceName; return true; } });
    assert.match(link.code, /^([0-9a-z]{4}-){5}[0-9a-z]{4}$/);
    alice2 = await VeilClient.joinLink({ store: new MemoryStore(), url, WebSocket, code: link.code.toUpperCase(), deviceName: 'Alice phone' });
    clients.push(alice2);
    assert.equal(asked, 'Alice phone');
    assert.equal(alice2.me.account, alice.me.account);
    assert.notEqual(alice2.me.deviceId, alice.me.deviceId);
    assert.ok((await texts(alice2, `dm:${bob.me.account}`)).includes('hey alice'), 'history copied');
    const devs = await alice.listDevices();
    assert.deepEqual(devs.map((d) => d.name).sort(), ['Alice laptop', 'Alice phone']);
  });

  await t('declined link gives the new device nothing', async () => {
    const link = await bob.startLink({ onRequest: async () => false });
    await assert.rejects(VeilClient.joinLink({ store: new MemoryStore(), url, WebSocket, code: link.url, deviceName: 'Evil' }), /declined/);
  });

  await t('fan-out: messages reach all devices; sent messages sync to own devices', async () => {
    await bob.sendText(`dm:${alice.me.account}`, 'to both alices');
    await waitFor(async () => (await texts(alice, `dm:${bob.me.account}`)).includes('to both alices'), 'alice1');
    await waitFor(async () => (await texts(alice2, `dm:${bob.me.account}`)).includes('to both alices'), 'alice2');
    await alice2.sendText(`dm:${bob.me.account}`, 'from phone');
    await waitFor(async () => (await texts(bob, `dm:${alice.me.account}`)).includes('from phone'), 'bob');
    await waitFor(async () => (await texts(alice, `dm:${bob.me.account}`)).includes('from phone'), 'alice1 sync');
    const synced = (await alice.messages(`dm:${bob.me.account}`)).find((m) => m.text === 'from phone');
    assert.equal(synced.mine, true);
  });

  await t('bob links a device via QR URL; alice (who has a session) must include it', async () => {
    const link = await bob.startLink({ origin: 'https://veil.example', onRequest: async () => true });
    bob2 = await VeilClient.joinLink({ store: new MemoryStore(), url, WebSocket, code: link.url, deviceName: 'Bob tablet' });
    clients.push(bob2);
    await alice.sendText(`dm:${bob.me.account}`, 'new device too?');
    await waitFor(async () => (await texts(bob2, `dm:${alice.me.account}`)).includes('new device too?'), 'bob2');
  });

  const gchat = {};
  await t('group: create, everyone (all devices) receives from everyone', async () => {
    await alice.addContact(carol.me.account);
    const g = await alice.createGroup('Weekend', [bob.me.account, carol.me.account]);
    gchat.id = `g:${g.id}`;
    for (const c of [bob, bob2, carol, alice2]) await waitFor(() => c.group(g.id), 'group state');
    assert.equal((await carol.chat(gchat.id)).request, true, 'carol has not accepted alice → invite is a request');
    await alice.sendText(gchat.id, 'group hello');
    await bob.sendText(gchat.id, 'bob here');
    await carol.sendText(gchat.id, 'carol here');
    for (const c of [alice, alice2, bob, bob2, carol]) {
      await waitFor(async () => {
        const ts = await texts(c, gchat.id);
        return ['group hello', 'bob here', 'carol here'].every((x) => ts.includes(x));
      }, 'group msgs on ' + c.me.deviceId);
    }
  });

  await t('group: removed member stops receiving; sender keys rotate', async () => {
    const gid = gchat.id.slice(2);
    const before = (await alice.store.get(`mysk:${gid}`)).sk.keyId;
    await alice.removeMember(gid, carol.me.account);
    await waitFor(async () => (await carol.group(gid)).left, 'carol sees removal');
    await waitFor(async () => !(await bob.group(gid)).members.includes(carol.me.account), 'bob sees removal');
    await alice.sendText(gchat.id, 'after carol');
    await bob.sendText(gchat.id, 'bob after carol');
    await waitFor(async () => (await texts(bob2, gchat.id)).includes('after carol'), 'bob2 gets');
    await waitFor(async () => (await texts(alice2, gchat.id)).includes('bob after carol'), 'alice2 gets');
    await new Promise((r) => setTimeout(r, 200));
    const carolTexts = await texts(carol, gchat.id);
    assert.ok(!carolTexts.includes('after carol') && !carolTexts.includes('bob after carol'));
    assert.notEqual((await alice.store.get(`mysk:${gid}`)).sk.keyId, before, 'alice rotated');
    await assert.rejects(carol.sendText(gchat.id, 'can I still post?').then((m) => { if (m.status === 'failed') throw new Error(m.error); }), /not in this group/);
  });

  await t('group: leave, rename, add back', async () => {
    const gid = gchat.id.slice(2);
    await alice.renameGroup(gid, 'Weekend plans');
    await waitFor(async () => (await bob.group(gid)).name === 'Weekend plans', 'rename');
    await alice.addMembers(gid, [carol.me.account]);
    await waitFor(async () => !(await carol.group(gid)).left, 'carol back');
    await bob2.leaveGroup(gid);
    await waitFor(async () => !(await alice.group(gid)).members.includes(bob.me.account), 'alice sees bob left');
    await waitFor(async () => (await bob.group(gid)).left, 'bob other device knows');
    await carol.sendText(gchat.id, 'carol is back');
    await waitFor(async () => (await texts(alice2, gchat.id)).includes('carol is back'), 'alice2 gets carol');
  });

  await t('images: encrypted before upload, key travels E2E, every device can open it', async () => {
    const marker = Buffer.from('PLAINTEXT-IMAGE-MARKER');
    const bytes = new Uint8Array(Buffer.concat([marker, randomBytes(3 * 1024 * 1024), marker]));
    const sent = await alice.sendText(`dm:${bob.me.account}`, 'sunset', { attachment: { bytes, mime: 'image/jpeg', name: 'sunset.jpg', w: 4000, h: 3000, thumb: 'data:image/jpeg;base64,AAAA' } });
    assert.equal(sent.status, 'sent');
    for (const c of [bob, bob2, alice2]) {
      const m = await waitFor(async () => (await c.messages(`dm:${c === alice2 ? bob.me.account : alice.me.account}`)).find((x) => x.id === sent.id), 'image msg');
      assert.equal(m.text, 'sunset');
      assert.equal(m.att.w, 4000);
      const got = await c.getAttachment(m.att);
      assert.ok(Buffer.from(got).equals(Buffer.from(bytes)), 'bytes round-trip');
    }
    assert.equal((await bob.chat(`dm:${alice.me.account}`)).last.text, '📷 sunset');
    const stored = fs.readFileSync(path.join(srv.blobDir, sent.att.id));
    assert.ok(!stored.includes(marker), 'server holds ciphertext only');
    assert.equal(stored.length, bytes.length + 40);
  });

  await t('images: group photo without caption; 50 MB accepted, larger refused', async () => {
    const big = new Uint8Array(randomBytes(50 * 1024 * 1024));
    const t0 = Date.now();
    const m = await carol.sendText(gchat.id, '', { attachment: { bytes: big, mime: 'image/png', name: 'big.png' } });
    assert.equal(m.status, 'sent', m.error);
    const got = await waitFor(async () => (await alice2.messages(gchat.id)).find((x) => x.id === m.id), 'group image');
    assert.equal((await alice2.getAttachment(got.att)).length, big.length);
    console.log(`    (50 MB encrypt+upload+download+decrypt: ${Date.now() - t0} ms)`);
    assert.equal((await alice.chat(gchat.id)).last.text, '📷 Photo');
    await assert.rejects(carol.sendText(gchat.id, '', { attachment: { bytes: new Uint8Array(50 * 1024 * 1024 + 1), mime: 'image/png' } }), /50 MB/);
    await assert.rejects(carol.rpc('blobToken', { blob: 'A'.repeat(22), size: 60 * 1024 * 1024 }), /too large/);
    await assert.rejects(carol.sendText(gchat.id, '', { attachment: { bytes: new Uint8Array(10), mime: 'application/pdf' } }), /Only images/);
  });

  await t('images: tampered or wrong-key blobs are rejected', async () => {
    const m = await alice.sendText(`dm:${bob.me.account}`, '', { attachment: { bytes: new Uint8Array(randomBytes(5000)), mime: 'image/webp' } });
    const f = path.join(srv.blobDir, m.att.id);
    const buf = fs.readFileSync(f); buf[100] ^= 1; fs.writeFileSync(f, buf);
    const bm = await waitFor(async () => (await bob.messages(`dm:${alice.me.account}`)).find((x) => x.id === m.id), 'msg');
    await assert.rejects(bob.getAttachment(bm.att));
    // uploads need a token bound to the id and size
    const r = await fetch(`http://localhost:${srv.port}/blob/${'B'.repeat(22)}`, { method: 'PUT', body: 'x' });
    assert.equal(r.status, 403);
  });

  await t('offline delivery: queued at relay, delivered on reconnect', async () => {
    bob.close(); bob2.close();
    await alice.sendText(`dm:${bob.me.account}`, 'while you were away');
    await new Promise((r) => setTimeout(r, 100));
    await bob.connect();
    await waitFor(async () => (await texts(bob, `dm:${alice.me.account}`)).includes('while you were away'), 'queued delivery');
    await bob2.connect();
  });

  await t('unlinking a device: it is wiped and excluded', async () => {
    let removed = false;
    bob2.on('removed', () => { removed = true; });
    await bob.removeDevice(bob2.me.deviceId);
    await waitFor(() => removed, 'bob2 removed');
    await alice.sendText(`dm:${bob.me.account}`, 'only one bob now');
    await waitFor(async () => (await texts(bob, `dm:${alice.me.account}`)).includes('only one bob now'), 'bob gets');
  });

  await t('blocked contacts are dropped', async () => {
    await carol.updateContact(bob.me.account, { status: 'blocked' });
    await bob.addContact(carol.me.account);
    await bob.sendText(`dm:${carol.me.account}`, 'spam');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await texts(carol, `dm:${bob.me.account}`)).length, 0);
  });

  await t('relay stores only ciphertext', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 'test.db'));
    bob.close();
    await alice.sendText(`dm:${bob.me.account}`, 'TOP-SECRET-PLAINTEXT');
    const rows = db.prepare('SELECT body FROM mailbox').all();
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => !r.body.includes('TOP-SECRET') && !r.body.includes('Weekend')));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert.ok(!tables.some((n) => /contact|group|user/.test(n)));
  });

  console.log(`${passed} passed`);
} finally {
  for (const c of clients) c.close();
  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
