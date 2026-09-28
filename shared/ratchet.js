// Double Ratchet (Signal spec) over X25519 / HKDF-SHA256 / HMAC-SHA256 / XChaCha20-Poly1305.
// State is a plain JSON object (binary as base64url) so it can be stored anywhere.
// Every operation works on a copy and returns the new state: a failed decrypt never corrupts a session.
import { X, kdf, mac, seal, open, concat, utf8, enc, dec } from './crypto.js';

const MAX_SKIP = 1000;       // max gap inside one chain
const MAX_STORED_SKIPPED = 2000;

const clone = (s) => JSON.parse(JSON.stringify(s));

function kdfRK(rk, dhOut) {
  const o = kdf(dhOut, rk, 'veil/ratchet/rk/v1', 64);
  return [o.slice(0, 32), o.slice(32)];
}
function kdfCK(ck) {
  return [mac(ck, Uint8Array.of(2)), mac(ck, Uint8Array.of(1))]; // [next chain key, message key]
}
const headerBytes = (h) => utf8(`${h.dh}.${h.pn}.${h.n}`);

export function initInitiator(sk, peerSpkPub, ad) {
  const dhs = X.gen();
  const [rk, cks] = kdfRK(sk, X.dh(dhs.priv, peerSpkPub));
  return {
    dhsPriv: enc(dhs.priv), dhsPub: enc(dhs.pub), dhr: enc(peerSpkPub),
    rk: enc(rk), cks: enc(cks), ckr: null, ns: 0, nr: 0, pn: 0, skipped: {}, ad: enc(ad),
  };
}

export function initResponder(sk, spk, ad) {
  return {
    dhsPriv: enc(spk.priv), dhsPub: enc(spk.pub), dhr: null,
    rk: enc(sk), cks: null, ckr: null, ns: 0, nr: 0, pn: 0, skipped: {}, ad: enc(ad),
  };
}

export function ratchetEncrypt(state, plaintext) {
  if (!state.cks) throw new Error('Session cannot send yet');
  const s = clone(state);
  const [ck, mk] = kdfCK(dec(s.cks));
  s.cks = enc(ck);
  const h = { dh: s.dhsPub, pn: s.pn, n: s.ns };
  s.ns += 1;
  const c = seal(mk, plaintext, concat(dec(s.ad), headerBytes(h)));
  return { state: s, msg: { h, c: enc(c) } };
}

export function ratchetDecrypt(state, msg) {
  const s = clone(state);
  const { h } = msg;
  if (typeof h?.dh !== 'string' || !Number.isInteger(h.n) || !Number.isInteger(h.pn)) throw new Error('Bad header');
  const ad = concat(dec(s.ad), headerBytes(h));
  const skipKey = `${h.dh}:${h.n}`;
  if (s.skipped[skipKey]) {
    const pt = open(dec(s.skipped[skipKey]), dec(msg.c), ad);
    delete s.skipped[skipKey];
    return { state: s, plaintext: pt };
  }
  if (h.dh !== s.dhr) {
    skipUntil(s, h.pn);
    dhRatchet(s, h.dh);
  }
  skipUntil(s, h.n);
  const [ck, mk] = kdfCK(dec(s.ckr));
  s.ckr = enc(ck);
  s.nr += 1;
  const pt = open(mk, dec(msg.c), ad); // throws on tamper → caller discards s
  return { state: s, plaintext: pt };
}

function skipUntil(s, until) {
  if (!s.ckr) return;
  if (until - s.nr > MAX_SKIP) throw new Error('Too many skipped messages');
  let ck = dec(s.ckr);
  while (s.nr < until) {
    const [next, mk] = kdfCK(ck);
    s.skipped[`${s.dhr}:${s.nr}`] = enc(mk);
    ck = next;
    s.nr += 1;
  }
  s.ckr = enc(ck);
  const keys = Object.keys(s.skipped);
  for (let i = 0; i < keys.length - MAX_STORED_SKIPPED; i++) delete s.skipped[keys[i]];
}

function dhRatchet(s, theirPub) {
  s.pn = s.ns;
  s.ns = 0;
  s.nr = 0;
  s.dhr = theirPub;
  const [rk1, ckr] = kdfRK(dec(s.rk), X.dh(dec(s.dhsPriv), dec(theirPub)));
  const dhs = X.gen();
  const [rk2, cks] = kdfRK(rk1, X.dh(dhs.priv, dec(theirPub)));
  s.dhsPriv = enc(dhs.priv);
  s.dhsPub = enc(dhs.pub);
  s.rk = enc(rk2);
  s.ckr = enc(ckr);
  s.cks = enc(cks);
}
