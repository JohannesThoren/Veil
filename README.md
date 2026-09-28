# Veil

End-to-end encrypted messenger with **no username, phone number or email**.

- **Invite-only:** creating an identity needs an invite link from the admin page (`/admin`). Linking more devices to an existing identity doesn't.
- Your account is a random ID like `1v8y-k165-js58-d52g`.
- Add people by typing their ID or scanning their QR code. The QR also carries their key, so scanning it verifies them.
- Add devices with a 24-character code or a QR from a device you're already signed in on, approved on that device.
- Signal protocol (X3DH + Double Ratchet) for 1:1, Sender Keys for groups. The relay only ever sees ciphertext.
- Send images up to 50 MB (button, paste or drag-and-drop). They're encrypted on your device before upload.
- Light and dark themes: follows your system, or pick one in Settings or with the moon/sun button.
- Installable as an app on phone and desktop (Install button in the sidebar, or *Add to Home Screen* on iPhone).
- **Voice and video calls**, 1:1 and group (up to ~6), end-to-end encrypted. Your own TURN server (coturn) is included for calls across networks.
- Notifications, even when the app is closed. They show who wrote, never the message text. Mute per chat.

See [DESIGN.md](DESIGN.md) for the protocol, threat model and roadmap.

## Run

```bash
docker compose up -d --build        # → http://localhost:8080
```

or without Docker (Node ≥ 22.13):

```bash
npm install
npm run build
npm start                           # PORT=8080 DB_PATH=veil.db by default; images go to ./blobs (BLOB_DIR)
npm test                            # crypto unit tests + multi-client end-to-end tests
```

## HTTPS is required for real use

Browsers only allow the **camera** (QR scanning), **service worker** (install/offline) and **clipboard** on `https://` (or `localhost`). Put Veil behind your reverse proxy with TLS and forward WebSockets on `/ws`:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 1h;
    client_max_body_size 51m;       # images up to 50 MB
}
```

In Nginx Proxy Manager / Nginx UI, enable "WebSockets support" on the proxy host and raise the upload limit (`client_max_body_size 51m`). Nginx's default of 1 MB would block larger images.

## Updating

`docker compose up -d --build`. JS/CSS files get a content hash in their name at build time (`app-3f9a1c2b.css`) and HTML is always revalidated, so browsers pick up a new version on the next load, never a mix of old and new files.

## Admin and invites

Open **`/admin`** (e.g. `https://veil.example.com/admin`) and sign in with the admin token.

- The token is generated on first start, printed in the log, and saved as `admin-token` next to the database: `docker exec veil cat /data/admin-token`, or `docker logs veil`. Set `ADMIN_TOKEN` to choose your own.
- **Create invites** with a label (only you see it), a use limit (once, 5, 25, unlimited) and an expiry (24 h, 7 d, 30 d, never). You get a link and a QR code. Opening the link shows "You're invited" and lets the person create an identity.
- Set **`PUBLIC_URL`** (e.g. `https://veil.example.com`) so invite links and QR codes always use your public address, even when you open `/admin` via a LAN IP. Without it, the page warns when links would point to an internal or non-HTTPS address.
- On iPhone, the invite page tells people to add Veil to the Home Screen first. Safari and Home Screen apps keep separate data.
- Revoke an invite at any time. Identities already created with it are not affected.
- The identity list shows each random ID, which invite it came from, device count and last activity. **Delete** removes the identity and signs all its devices out.
- Sign-in is rate-limited (10 attempts / 15 min per IP). Behind a reverse proxy, set `TRUST_PROXY=1` so the real client IP is used.

## Calls (WebRTC + TURN)

Calls work out of the box on the same network. To call between networks (mobile data ↔ home Wi-Fi), run the bundled TURN server:

1. `cp .env.example .env` and fill in:
   - `TURN_DOMAIN`: a hostname pointing at your public IP, e.g. `turn.lgjt.xyz` (DNS only, no Cloudflare proxy)
   - `TURN_EXTERNAL_IP`: `PUBLIC_IP/LAN_IP` of the server, e.g. `203.0.113.7/192.168.1.10`
   - `TURN_SECRET`: `openssl rand -hex 32`
2. Forward/open on your router and firewall, to the server: **3478/udp, 3478/tcp, 49160–49200/udp**.
3. `docker compose up -d --build`

The relay gives each device short-lived TURN credentials (12 h, HMAC with `TURN_SECRET`), so there are no static passwords. coturn refuses to relay into private networks, so it can't be used to reach your LAN. It only ever carries encrypted media.

**Check it:** in the app, **Settings → Calls → Test connection** shows whether local, STUN and TURN (relay) work from that device. Run it on a phone on mobile data. The server log (`docker logs veil | grep calls:`) shows the ICE config it hands out and warns about a missing `TURN_DOMAIN` or `TURN_SECRET`.

To force every call through TURN: open DevTools on two devices, run `localStorage.setItem('veil-relay','1')`, reload, then call. That forces every call through TURN. Undo with `localStorage.removeItem('veil-relay')`.

## Notifications and installing

- **Install:** Chrome/Edge/Android show an **Install app** button in the sidebar. On iPhone/iPad: Safari → Share → *Add to Home Screen*.
- **Notifications:** turn them on from the prompt in the sidebar or in **Settings → Notifications**. On iPhone/iPad they only work in the installed app (iOS 16.4+).
- The relay creates its push (VAPID) key on first start and stores it next to the database (`vapid.json`). Keep it: if it changes, every device silently re-subscribes on its next start. Set `VAPID_SUBJECT` to your email or site; Apple rejects pushes without a real contact. You can also supply `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` yourself.
- Background notifications need HTTPS, same as the camera.

## Using it

1. Open your **invite link**, then **Create identity** and optionally set a name. The name is only sent, encrypted, to people you message.
2. Share your ID: it's shown under **+ → Add contact** and in **Settings**, with a QR code.
3. **+ → Add contact**: paste an ID or contact link, or scan a QR. Messages from people who haven't been added show up as **requests** (accept or block).
4. **+ → New group**: pick contacts. Admins can rename, add and remove. Removing someone rotates everyone's group keys.
5. **Settings → Link a new device**: on the new device choose *Link to an existing device*, then scan or type the code, then approve on the old device. History, contacts and groups come along.
6. **Calls:** the phone and camera buttons in a chat. Group calls ring every member. Anyone who missed the ring can **Join** from the group while the call is on.
7. **Contact → Safety number**: compare in person or scan their QR to verify.

## Status

MVP. Not independently audited, so don't rely on it for high-risk use yet. Main gaps: images only (no other file types), no at-rest encryption of local storage, sender is visible to the server (no sealed sender). All are in DESIGN.md §12.

## License

Copyright (c) 2026 Johannes Thorén. All rights reserved.

Licensed under the [LGJT License v1](LICENSE). Personal, non-commercial use
only. Anything else requires written permission: johannes@lgjt.xyz
