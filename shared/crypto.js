// Copyright (c) 2026 Johannes Thorén. All rights reserved.
// Licensed under the LGJT License v1. See LICENSE in the project root.
// Crypto primitives. Everything here runs in both the browser and Node.
// Audited libraries only (@noble/*); nothing hand-rolled below the protocol layer.
import { ed25519, x25519, edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256, sha512 } from '@noble/hashes/sha2';
import { randomBytes, concatBytes } from '@noble/hashes/utils';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { customAlphabet } from 'nanoid';

// ---------- encoding ----------
const te = new TextEncoder();
const td = new TextDecoder();
export const utf8 = (s) => te.encode(s);
export const fromUtf8 = (u) => td.decode(u);
export const concat = (...parts) => concatBytes(...parts);
export const rand = (n) => randomBytes(n);

export function enc(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function dec(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const b = atob(s);
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}
export function eq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// Unambiguous lowercase alphabet (no i, l, o, u) so IDs and codes survive being read aloud or typed.
export const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
export const newAccountId = customAlphabet(ALPHABET, 16); // 80 bits
export const newDeviceId = customAlphabet(ALPHABET, 8);
export const newId = customAlphabet(ALPHABET, 20);

/** Normalise user-typed IDs/codes: lowercase, strip separators, map look-alikes. */
export function normalizeCode(s) {
  return s.toLowerCase().replace(/[il]/g, '1').replace(/o/g, '0').replace(/u/g, 'v').replace(/[^0-9a-z]/g, '');
}
export const isAccountId = (s) => typeof s === 'string' && s.length === 16 && [...s].every((c) => ALPHABET.includes(c));
export const formatId = (id) => id.match(/.{1,4}/g).join('-');

// ---------- KDF / MAC / AEAD ----------
export const kdf = (ikm, salt, info, len = 32) => hkdf(sha256, ikm, salt, utf8(info), len);
export const mac = (key, data) => hmac(sha256, key, data);
export const hash = (data) => sha256(data);

/** XChaCha20-Poly1305 with a random 24-byte nonce prepended. */
export function seal(key, pt, ad = new Uint8Array()) {
  const nonce = rand(24);
  return concat(nonce, xchacha20poly1305(key, nonce, ad).encrypt(pt));
}
export function open(key, data, ad = new Uint8Array()) {
  return xchacha20poly1305(key, data.subarray(0, 24), ad).decrypt(data.subarray(24));
}

// ---------- curves ----------
export const X = {
  gen() {
    const priv = x25519.utils.randomPrivateKey();
    return { priv, pub: x25519.getPublicKey(priv) };
  },
  dh: (priv, pub) => x25519.getSharedSecret(priv, pub),
};
export const Ed = {
  gen() {
    const priv = ed25519.utils.randomPrivateKey();
    return { priv, pub: ed25519.getPublicKey(priv) };
  },
  sign: (priv, msg) => ed25519.sign(msg, priv),
  verify(sig, msg, pub) {
    try { return ed25519.verify(sig, msg, pub); } catch { return false; }
  },
  // The identity key is Ed25519; its birationally-equivalent X25519 form is used for X3DH.
  toXPriv: (priv) => edwardsToMontgomeryPriv(priv),
  toXPub: (pub) => edwardsToMontgomeryPub(pub),
};

// ---------- signed statements (domain-separated) ----------
export const stmt = {
  device: (account, deviceId, signPub) => utf8(`veil/device/v1|${account}|${deviceId}|${signPub}`),
  spk: (account, deviceId, spkId, spkPub) => utf8(`veil/spk/v1|${account}|${deviceId}|${spkId}|${spkPub}`),
  auth: (nonce) => utf8(`veil/auth/v1|${nonce}`),
  removeDevice: (account, deviceId) => utf8(`veil/remove-device/v1|${account}|${deviceId}`),
  register: (account, identity) => utf8(`veil/register/v1|${account}|${identity}`),
};

/**
 * Safety number: 60 digits derived from both parties' IDs and identity keys.
 * Identical on both sides; compare it out-of-band to verify there's no MITM.
 */
export function safetyNumber(idA, keyA, idB, keyB) {
  const part = (id, key) => {
    let h = concat(utf8(id), dec(key));
    for (let i = 0; i < 1024; i++) h = sha512(concat(h, dec(key)));
    let digits = '';
    for (let i = 0; i < 30; i += 5) {
      const n = ((h[i] * 2 ** 32) + (h[i + 1] << 24 >>> 0) + (h[i + 2] << 16) + (h[i + 3] << 8) + h[i + 4]) % 100000;
      digits += String(n).padStart(5, '0');
    }
    return digits;
  };
  const [a, b] = [part(idA, keyA), part(idB, keyB)].sort();
  return (a + b).match(/.{5}/g).join(' ');
}
