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

Non-goals for the MVP: metadata hiding (sealed sender), non-image attachments, voice/video, account recovery without a device.

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

### Registration is invite-only

`register` must carry an invite code: 24 chars, 120 bits, made on the admin page. The relay consumes it atomically in the same transaction that creates the account (`UPDATE … WHERE uses < max_uses AND not expired AND not revoked`), so a single-use invite can't be raced into two accounts. It records which invite each account used. `addDevice` (linking) needs no invite: it already requires a device certificate signed by the account's identity key, which only an existing identity can produce.

The admin API (`/admin/api/*`) uses a token → HttpOnly, `SameSite=Strict` session cookie (12 h). Writes must be `application/json`, which a cross-site form can't send. Login is rate-limited per IP. The admin sees only what the relay already stores: random IDs, timestamps, device counts, invite labels.

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

## 6. Images (up to 50 MB)

1. The sender's device picks a fresh random 256-bit key and encrypts the image with XChaCha20-Poly1305 (nonce prepended).
2. It asks the relay for a one-time upload token bound to a random 128-bit blob id and the exact ciphertext size (`blobToken`). Then it `PUT`s the ciphertext to `/blob/<id>`. The relay refuses anything above 50 MB + 40 bytes, or not matching the declared size.
3. The message itself (end-to-end encrypted like any text) carries `{id, key, size, mime, name, w, h, thumb}`. `thumb` is a ~24 px JPEG preview so the bubble has the right shape and a blurred placeholder before download.
4. Receivers `GET /blob/<id>` and decrypt. The AEAD tag authenticates the bytes, so a swapped or corrupted blob is rejected. Decrypted images are cached in IndexedDB, so each device downloads once.

The relay sees only an opaque blob and its size. It never sees the key, the file type, the name or who it's for, beyond the sender being authenticated at upload. Blobs expire after 30 days. Linked devices receive the keys with the history, so they can open older images while the blob still exists. Group images are encrypted once and the key is delivered through the sender-key message, so each member doesn't need a separate upload.

## 7. Notifications (Web Push)

The goal: notifications while the app is closed, without handing message content or names to Google/Apple/Mozilla.

- Each device can register a Web Push subscription with the relay (`pushSubscribe`). Endpoints are allow-listed to the real browser push services, so the relay can't be made to call arbitrary URLs.
- The app reports whether it's in front (`presence`). A WebSocket heartbeat (30 s ping) drops sockets from suspended phones.
- When the relay stores a message for a device that **isn't in front**, it sends a push. It only does this for real messages, which the sender marks (key distribution, read-state and contact sync never wake anyone), and never to the sender's own devices. The push payload is `{a: senderAccount, d: senderDevice, k: 'dm'|'g', g?: senderKeyId}`. That's metadata the relay already has, encrypted to the browser under Web Push (RFC 8291). `Topic` = sender, so a burst from one person collapses into one push.
- The service worker looks up the sender's name, and for groups maps the sender-key id → group (`rsk:*`), in local IndexedDB. It shows **"Bob: new message"** or **"Book club — Bob: new message"**, counting repeats ("3 new messages"). Muted chats and blocked senders get a silent notification that's closed immediately, because Safari cancels subscriptions that receive pushes without showing anything.
- When the app is running (a hidden tab), it decrypts the message itself and shows the text. Both paths use the chat id as the notification tag, so they replace each other instead of doubling up.
- Mute state syncs across your own devices. App icon badge = unread count, where supported.

What push reveals beyond the relay: the push service sees that *something* arrived for your browser and when. It never sees who from (the payload is encrypted to the browser) or what.

## 8. What the server stores

| Table | Contents |
|---|---|
| `accounts` | id, identity public key |
| `invites` / `invite_uses` | invite codes, label, limits, which account used which invite |
| `devices` | device id, signing pub key, cert, device name **encrypted with a key derived from IK** (only your own devices can read it), push subscription endpoint |
| `spks` / `opks` | public prekeys |
| `mailbox` | per-device queue of `{from account/device, kind, ciphertext, ts}`. Deleted on ack, expired after 30 days |
| `blobs/` (files) | encrypted image blobs, random ids, deleted after 30 days |

Server-visible metadata: who sends to whom and when, message sizes, number of devices. Not visible: names, contacts, group membership or names, content, which messages are group messages beyond a `g` kind flag (the recipients share one ciphertext).

## 9. Client storage

IndexedDB key-value (`me`, `spk`, `opk:*`, `sess:*`, `id:*`, `contact:*`, `group:*`, `mysk:*`, `rsk:*`, `chat:*`, `msg:*`, `file:*` decrypted images). Keys aren't yet encrypted at rest. See the roadmap.

## 10. Code map

```
shared/crypto.js     primitives (noble: ed25519/x25519, HKDF, HMAC, XChaCha20-Poly1305), IDs, safety numbers
shared/x3dh.js       X3DH
shared/ratchet.js    Double Ratchet
shared/senderkey.js  Sender Keys
client/core.js       protocol client: sessions, fan-out, groups, linking, contacts (UI-agnostic)
client/store.js      IndexedDB + in-memory stores
server/server.js     HTTP static + encrypted blob store + WebSocket RPC relay
server/db.js         SQLite schema (node:sqlite, no native deps)
web/                 PWA (vanilla JS, bundled by esbuild); web/sw.js = offline shell + push handling
test/                crypto unit tests + multi-client end-to-end tests over real sockets
```

## 11. Roadmap / known gaps

1. **Sealed sender**: hide the sender from the server (sender certificate inside the ciphertext, delivery tokens against spam).
2. **Notification content:** optionally decrypt the message inside the service worker to show the text. That needs care: the SW and an open tab must not advance the same ratchet concurrently.
3. **At-rest encryption** of IndexedDB with a passphrase / WebAuthn PRF key.
4. **Other attachments** (files, video, voice notes) reuse the image pipeline. Very large files would need chunked streaming encryption instead of one in-memory buffer. Per-account storage quotas on the relay.
5. **MLS** for large groups. Multi-admin conflict resolution (today concurrent admin edits are last-valid-version-wins).
6. **Abuse controls**: registration is invite-only, and there's a per-connection rate limit. Still missing: per-account send and storage quotas, and letting members issue their own (limited) invites.
7. **Backups / recovery**: optional encrypted backup keyed by a recovery code. Without it, losing all devices loses the account (by design).
8. Read receipts, typing indicators, disappearing messages, message editing and deletion.
9. Native shells (Tauri/Capacitor) wrapping the same core for background delivery.
10. An **independent security review** before real-world use. The primitives come from audited libraries, but the protocol composition here hasn't been reviewed.
