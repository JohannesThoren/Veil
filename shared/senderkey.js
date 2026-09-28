// Sender Keys for groups (as in Signal's pre-MLS groups):
// each device keeps one symmetric hash-ratchet chain + an Ed25519 signing key per group epoch,
// distributes it to every member device over the pairwise Double Ratchet sessions,
// then encrypts each group message once. Membership changes bump the epoch, which forces rotation.
import { Ed, mac, seal, open, utf8, enc, dec, rand } from './crypto.js';

const MAX_FORWARD = 2000;
const clone = (s) => JSON.parse(JSON.stringify(s));
const step = (ck) => [mac(ck, Uint8Array.of(2)), mac(ck, Uint8Array.of(1))];
const signed = (k, i, c) => utf8(`veil/group/v1|${k}|${i}|${c}`);

export function newSenderKey() {
  const sig = Ed.gen();
  return { keyId: enc(rand(12)), ck: enc(rand(32)), iter: 0, sigPriv: enc(sig.priv), sigPub: enc(sig.pub) };
}

/** What gets sent (pairwise-encrypted) to other members. Gives access to messages from `iter` onward only. */
export const distributionOf = (sk) => ({ keyId: sk.keyId, ck: sk.ck, iter: sk.iter, sigPub: sk.sigPub });

export function receiverFromDistribution(d) {
  return { keyId: d.keyId, ck: d.ck, iter: d.iter, sigPub: d.sigPub, skipped: {} };
}

export function groupEncrypt(sk, plaintext) {
  const s = clone(sk);
  const [next, mk] = step(dec(s.ck));
  const i = s.iter;
  const c = enc(seal(mk, plaintext, utf8(`${s.keyId}:${i}`)));
  s.ck = enc(next);
  s.iter += 1;
  const sig = enc(Ed.sign(dec(s.sigPriv), signed(s.keyId, i, c)));
  return { state: s, msg: { k: s.keyId, i, c, s: sig } };
}

export function groupDecrypt(rs, msg) {
  if (!Ed.verify(dec(msg.s), signed(msg.k, msg.i, msg.c), dec(rs.sigPub))) throw new Error('Bad group signature');
  const s = clone(rs);
  const ad = utf8(`${msg.k}:${msg.i}`);
  if (msg.i < s.iter) {
    const mk = s.skipped[msg.i];
    if (!mk) throw new Error('Group message key already used or too old');
    delete s.skipped[msg.i];
    return { state: s, plaintext: open(dec(mk), dec(msg.c), ad) };
  }
  if (msg.i - s.iter > MAX_FORWARD) throw new Error('Group message too far ahead');
  let ck = dec(s.ck);
  while (s.iter < msg.i) {
    const [next, mk] = step(ck);
    s.skipped[s.iter] = enc(mk);
    ck = next;
    s.iter += 1;
  }
  const [next, mk] = step(ck);
  const pt = open(mk, dec(msg.c), ad);
  s.ck = enc(next);
  s.iter += 1;
  const keys = Object.keys(s.skipped);
  for (let j = 0; j < keys.length - MAX_FORWARD; j++) delete s.skipped[keys[j]];
  return { state: s, plaintext: pt };
}
