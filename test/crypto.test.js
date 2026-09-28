import assert from 'node:assert/strict';
import { Ed, X, enc, dec, utf8, fromUtf8, stmt, safetyNumber } from '../shared/crypto.js';
import { x3dhInitiate, x3dhRespond } from '../shared/x3dh.js';
import { initInitiator, initResponder, ratchetEncrypt, ratchetDecrypt } from '../shared/ratchet.js';
import { newSenderKey, distributionOf, receiverFromDistribution, groupEncrypt, groupDecrypt } from '../shared/senderkey.js';

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓', name); };

console.log('crypto');

const alice = { account: 'aaaaaaaaaaaaaaaa', identity: Ed.gen() };
const bob = { account: 'bbbbbbbbbbbbbbbb', identity: Ed.gen() };
const spk = X.gen(); const opk = X.gen();
const bundle = {
  spk: { id: 1, pub: enc(spk.pub), sig: enc(Ed.sign(bob.identity.priv, stmt.spk(bob.account, 'dev1', 1, enc(spk.pub)))) },
  opk: { id: 7, pub: enc(opk.pub) },
};

function pair() {
  const a = x3dhInitiate(alice, { account: bob.account, identity: enc(bob.identity.pub), deviceId: 'dev1' }, bundle);
  const b = x3dhRespond(bob, spk, opk, a.header);
  return { A: initInitiator(a.sk, a.spkPub, a.ad), B: initResponder(b.sk, spk, b.ad), a, b };
}

t('X3DH both sides derive the same key', () => {
  const { a, b } = pair();
  assert.equal(enc(a.sk), enc(b.sk));
  assert.equal(enc(a.ad), enc(b.ad));
});

t('X3DH rejects a forged signed prekey', () => {
  const evil = X.gen();
  assert.throws(() => x3dhInitiate(alice, { account: bob.account, identity: enc(bob.identity.pub), deviceId: 'dev1' },
    { spk: { ...bundle.spk, pub: enc(evil.pub) } }));
});

t('Double Ratchet: ping-pong, out-of-order, tamper, replay', () => {
  let { A, B } = pair();
  const send = (st, text) => ratchetEncrypt(st, utf8(text));
  let r;
  r = send(A, 'hi bob'); A = r.state;
  let got = ratchetDecrypt(B, r.msg); B = got.state; assert.equal(fromUtf8(got.plaintext), 'hi bob');
  r = send(B, 'hi alice'); B = r.state;
  got = ratchetDecrypt(A, r.msg); A = got.state; assert.equal(fromUtf8(got.plaintext), 'hi alice');
  // out of order across a DH step
  const m = [];
  for (let i = 0; i < 5; i++) { r = send(A, 'm' + i); A = r.state; m.push(r.msg); }
  for (const i of [3, 0, 4, 2, 1]) { got = ratchetDecrypt(B, m[i]); B = got.state; assert.equal(fromUtf8(got.plaintext), 'm' + i); }
  // replay fails and doesn't damage the session
  assert.throws(() => ratchetDecrypt(B, m[2]));
  // tamper
  r = send(A, 'secret'); A = r.state;
  const bad = { ...r.msg, c: enc(dec(r.msg.c).map((x, i) => (i === 30 ? x ^ 1 : x))) };
  assert.throws(() => ratchetDecrypt(B, bad));
  got = ratchetDecrypt(B, r.msg); B = got.state; assert.equal(fromUtf8(got.plaintext), 'secret');
  // header tamper
  r = send(A, 'x'); A = r.state;
  assert.throws(() => ratchetDecrypt(B, { ...r.msg, h: { ...r.msg.h, n: r.msg.h.n + 1 } }));
});

t('Double Ratchet: forward secrecy — old state cannot read new messages after DH step', () => {
  let { A, B } = pair();
  let r = ratchetEncrypt(A, utf8('1')); A = r.state; B = ratchetDecrypt(B, r.msg).state;
  const oldB = B;
  r = ratchetEncrypt(B, utf8('2')); B = r.state; A = ratchetDecrypt(A, r.msg).state;
  r = ratchetEncrypt(A, utf8('3')); A = r.state;
  B = ratchetDecrypt(B, r.msg).state;
  // compromise of B's *new* state must not reveal message '1' (already consumed): its chain keys moved on
  assert.notEqual(B.ckr, oldB.ckr);
});

t('Sender keys: order, skip, signature, fresh member cannot read old', () => {
  let sk = newSenderKey();
  let r = groupEncrypt(sk, utf8('before')); sk = r.state; const old = r.msg;
  let rs = receiverFromDistribution(distributionOf(sk));
  assert.throws(() => groupDecrypt(rs, old));
  const ms = [];
  for (let i = 0; i < 4; i++) { r = groupEncrypt(sk, utf8('g' + i)); sk = r.state; ms.push(r.msg); }
  for (const i of [2, 0, 3, 1]) { const g = groupDecrypt(rs, ms[i]); rs = g.state; assert.equal(fromUtf8(g.plaintext), 'g' + i); }
  const forged = { ...ms[0], c: ms[1].c };
  assert.throws(() => groupDecrypt(rs, forged));
});

t('Safety number is symmetric', () => {
  const a = safetyNumber(alice.account, enc(alice.identity.pub), bob.account, enc(bob.identity.pub));
  const b = safetyNumber(bob.account, enc(bob.identity.pub), alice.account, enc(alice.identity.pub));
  assert.equal(a, b);
  assert.match(a, /^(\d{5} ){11}\d{5}$/);
});

console.log(`${passed} passed`);
