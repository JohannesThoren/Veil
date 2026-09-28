# Veil — design

End-to-end encrypted messaging with **no usernames, phone numbers or emails**.
An account is a random ID. You add people by ID or QR. You add devices by code or QR.

## 1. Goals and non-goals

| Goal | How |
|---|---|
| Server learns as little as possible | Server stores public keys and queued ciphertext only. No names, contact lists, group membership or message content. |
| No identifiers to leak | Account ID = 16 random chars (80 bits, nanoid over an unambiguous alphabet). Nothing links it to a person. |
| Strong E2EE | Signal protocol: X3DH + Double Ratchet (1:1), Sender Keys (groups). Forward secrecy and post-compromise security. |
| Multi-device | Every device has its own keys and sessions. Linking copies the identity key over an encrypted, approved channel. |
| Detect MITM | TOFU key pinning, QR codes that carry the key, 60-digit safety numbers. |

Non-goals for the MVP: metadata hiding (sealed sender), push notifications while the app is closed, attachments, voice/video, account recovery without a device.

## 2. Identities and IDs

```
Account
  id            16 chars, e.g. 1v8y-k165-js58-d52g         (random; server enforces uniqueness)
  identity key  Ed25519 (IK), shared by all devices         (X25519 form used for DH)
Device
  id            8 chars
  signing key   Ed25519, per device — authenticates to the server
  cert          Sig_IK("veil/device/v1|acct|dev|signPub")   — server only accepts devices signed by IK
  signed prekey X25519, Sig_IK(...|acct|dev|spkId|pub), rotated weekly
  one-time prekeys  X25519 × 50, replenished below 20
```

The server binds `account id → identity key` at registration (signed by IK). The account ID alone is enough to message someone, but the server could lie about the key for a bare ID, so:

- **QR / contact link** = `https://host/#c=<id>.<identityKey>`. Scanning it pins the real key and marks the contact **verified**. If the server's key differs, the add is refused.
- **Bare ID** = trust on first use. The UI shows "Not verified" until you compare safety numbers or scan their QR.
- A pinned key can never be replaced silently. A mismatch blocks sending with a safety warning. An account ID can't be re-registered, so a change can only mean the server is misbehaving.

## 3. 1:1 messages — X3DH + Double Ratchet

Sessions are per **(remote account, remote device)** pair.

1. Sender fetches the recipient account's device list (certs verified against the pinned IK) and a prekey bundle for any device it has no session with.
2. X3DH: `SK = HKDF(DH(IKa,SPKb) ‖ DH(EKa,IKb) ‖ DH(EKa,SPKb) ‖ DH(EKa,OPKb))`, AD = `IKa ‖ IKb`.
3. Double Ratchet: X25519 DH ratchet, HKDF-SHA256 root chain, HMAC-SHA256 symmetric chains, XChaCha20-Poly1305 per message (header bound as AAD). Up to 1000 skipped keys per chain.
4. The prekey header rides on every message until the peer replies, so a lost first message doesn't break the session.
5. Up to 4 session states are kept per device. The one that decrypts is promoted, so simultaneous initiation self-heals.

Every state change is computed on a copy and committed only after the AEAD verifies. Tampered or replayed messages never corrupt a session.

**Fan-out.** A message goes to every device of the recipient **and to every other device of the sender** (that's how your sent messages show up on your phone). The server refuses a batch that doesn't cover every current device of the listed accounts (`{stale: …}`). The client then refreshes the device list and retries, so a newly linked device can't be silently skipped.

## 4. Groups — Sender Keys

The group itself is client-side state: `{id, name, members[], admins[], v}`, distributed as a `gstate` control message over the pairwise sessions. The server never sees it.

- Each device keeps one **sender key** per group: a hash-ratchet chain key + an Ed25519 signing key.
- The key is sent (pairwise-encrypted) to every member device that doesn't have it yet. Each group message is then encrypted **once**, signed, and fanned out as identical ciphertext.
- The group ID travels inside the ciphertext. The receiver checks it matches the group the sender key was distributed for, and that the sender is a current member.
- **Rotation rule:** a device tracks who holds its current sender key. Before sending, if any holder is no longer a member device (member removed, left, or device unlinked), it generates a fresh key. Removed members can't read anything sent after the change.
- Admins change state (`v` must increase; only admins' updates are accepted). Anyone can leave. An invite from someone who isn't your contact shows up as a request.

Trade-off vs. MLS (RFC 9420): Sender Keys cost O(n) pairwise messages on rotation and have weaker post-compromise security within a group. MLS is the upgrade path for large groups (§9).

## 5. Linking a device (code or QR)

```
Existing device E                     Relay                    New device N
 linkId(8) + secret(16) = code
 linkOpen(linkId) ─────────────────▶ slot (5 min TTL)
 shows QR (https://host/#link=code)                            scans QR / types code
                                      ◀────── linkJoin(linkId, Enc_K{ephN, deviceName})
 K = HKDF(secret, linkId)
 "Approve <deviceName>?"  ── user approves
 K2 = HKDF(K ‖ DH(ephE, ephN))
 linkSend(Enc_K{ephE, Enc_K2{bundle}}) ───────────────────────▶ decrypt bundle
                                                                new device keys, cert signed with IK
                                                                addDevice(cert, prekeys)
```

- The secret never touches the server: it lives only in the code/QR (80 bits). The ephemeral DH adds forward secrecy for the bundle.
- The bundle holds the identity key, profile name, contacts, identity pins, groups, chats and the last 300 messages per chat. Sessions and sender keys are **not** copied. The new device builds its own, and other members distribute their sender keys to it automatically on their next send (holder tracking, §4).
- Explicit approval on the old device stops a leaked code from being used silently.
- Unlinking signs `veil/remove-device/v1|acct|dev` with IK. The server deletes the device, and the device wipes itself when told.

## 6. What the server stores

| Table | Contents |
|---|---|
| `accounts` | id, identity public key |
| `devices` | device id, signing pub key, cert, device name **encrypted with a key derived from IK** (only your own devices can read it) |
| `spks` / `opks` | public prekeys |
| `mailbox` | per-device queue of `{from account/device, kind, ciphertext, ts}`. Deleted on ack, expired after 30 days |

Server-visible metadata: who sends to whom and when, message sizes, number of devices. Not visible: names, contacts, group membership or names, content, which messages are group messages beyond a `g` kind flag (the recipients share one ciphertext).

## 7. Client storage

IndexedDB key-value (`me`, `spk`, `opk:*`, `sess:*`, `id:*`, `contact:*`, `group:*`, `mysk:*`, `rsk:*`, `chat:*`, `msg:*`). Keys aren't yet encrypted at rest. See the roadmap.

## 8. Code map

```
shared/crypto.js     primitives (noble: ed25519/x25519, HKDF, HMAC, XChaCha20-Poly1305), IDs, safety numbers
shared/x3dh.js       X3DH
shared/ratchet.js    Double Ratchet
shared/senderkey.js  Sender Keys
client/core.js       protocol client: sessions, fan-out, groups, linking, contacts (UI-agnostic)
client/store.js      IndexedDB + in-memory stores
server/server.js     HTTP static + WebSocket RPC relay
server/db.js         SQLite schema (node:sqlite, no native deps)
web/                 PWA (vanilla JS, bundled by esbuild)
test/                crypto unit tests + multi-client end-to-end tests over real sockets
```

## 9. Roadmap / known gaps

1. **Sealed sender**: hide the sender from the server (sender certificate inside the ciphertext, delivery tokens against spam).
2. **Web Push** (VAPID) so notifications arrive when the app is closed. The payload would be a content-free wake-up.
3. **At-rest encryption** of IndexedDB with a passphrase / WebAuthn PRF key.
4. **Attachments**: encrypt client-side with a random key, upload the blob, send key + hash in the message.
5. **MLS** for large groups. Multi-admin conflict resolution (today concurrent admin edits are last-valid-version-wins).
6. **Abuse controls**: per-account send quotas, proof-of-work or invite tokens for registration. Today there is only a per-connection rate limit.
7. **Backups / recovery**: optional encrypted backup keyed by a recovery code. Without it, losing all devices loses the account (by design).
8. Read receipts, typing indicators, disappearing messages, message editing and deletion.
9. Native shells (Tauri/Capacitor) wrapping the same core for background delivery.
10. An **independent security review** before real-world use. The primitives come from audited libraries, but the protocol composition here hasn't been reviewed.
