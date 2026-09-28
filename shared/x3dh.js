// Copyright (c) 2026 Johannes Thorén. All rights reserved.
// Licensed under the LGJT License v1. See LICENSE in the project root.
// X3DH key agreement (Signal spec), using the account's Ed25519 identity key
// converted to X25519 for the DH steps.
import { X, Ed, kdf, concat, enc, dec, stmt } from './crypto.js';

const F = new Uint8Array(32).fill(0xff);
const SALT = new Uint8Array(32);

/**
 * Initiator side.
 * @param me      { account, identity: { priv, pub } }   (Uint8Arrays)
 * @param peer    { account, identity: b64, deviceId }
 * @param bundle  { spk: { id, pub, sig }, opk?: { id, pub } }  (b64 strings)
 */
export function x3dhInitiate(me, peer, bundle) {
  const spkPub = dec(bundle.spk.pub);
  const peerIk = dec(peer.identity);
  if (!Ed.verify(dec(bundle.spk.sig), stmt.spk(peer.account, peer.deviceId, bundle.spk.id, bundle.spk.pub), peerIk)) {
    throw new Error('Signed prekey signature invalid');
  }
  const ek = X.gen();
  const ikA = Ed.toXPriv(me.identity.priv);
  const parts = [
    F,
    X.dh(ikA, spkPub),
    X.dh(ek.priv, Ed.toXPub(peerIk)),
    X.dh(ek.priv, spkPub),
  ];
  if (bundle.opk) parts.push(X.dh(ek.priv, dec(bundle.opk.pub)));
  const sk = kdf(concat(...parts), SALT, 'veil/x3dh/v1');
  return {
    sk,
    ad: concat(me.identity.pub, peerIk),
    spkPub,
    header: { ik: enc(me.identity.pub), ek: enc(ek.pub), spk: bundle.spk.id, opk: bundle.opk?.id ?? null },
  };
}

/**
 * Responder side.
 * @param me     { identity: { priv, pub } }
 * @param spk    { priv, pub } Uint8Arrays
 * @param opk    { priv, pub } | null
 * @param header as produced by x3dhInitiate
 */
export function x3dhRespond(me, spk, opk, header) {
  const ikA = Ed.toXPub(dec(header.ik));
  const ek = dec(header.ek);
  const parts = [
    F,
    X.dh(spk.priv, ikA),
    X.dh(Ed.toXPriv(me.identity.priv), ek),
    X.dh(spk.priv, ek),
  ];
  if (header.opk != null) {
    if (!opk) throw new Error('One-time prekey missing');
    parts.push(X.dh(opk.priv, ek));
  }
  const sk = kdf(concat(...parts), SALT, 'veil/x3dh/v1');
  return { sk, ad: concat(dec(header.ik), me.identity.pub) };
}
