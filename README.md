# Veil

End-to-end encrypted messenger with **no username, phone number or email**.

- Your account is a random ID like `1v8y-k165-js58-d52g`.
- Add people by typing their ID or scanning their QR code. The QR also carries their key, so scanning it verifies them.
- Add devices with a 24-character code or a QR from a device you're already signed in on, approved on that device.
- Signal protocol (X3DH + Double Ratchet) for 1:1, Sender Keys for groups. The relay only ever sees ciphertext.
- Send images up to 50 MB (button, paste or drag-and-drop). They're encrypted on your device before upload.
- Light and dark themes: follows your system, or pick one in Settings or with the moon/sun button.
- A PWA: works in any modern browser, installable on phone and desktop.

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

## Using it

1. **Create identity** and optionally set a name. The name is only sent, encrypted, to people you message.
2. Share **Your ID** (bottom left), or show its QR.
3. **+ → Add contact**: paste an ID or contact link, or scan a QR. Messages from people who haven't been added show up as **requests** (accept or block).
4. **+ → New group**: pick contacts. Admins can rename, add and remove. Removing someone rotates everyone's group keys.
5. **Settings → Link a new device**: on the new device choose *Link to an existing device*, then scan or type the code, then approve on the old device. History, contacts and groups come along.
6. **Contact → Safety number**: compare in person or scan their QR to verify.

## Status

MVP. Not independently audited, so don't rely on it for high-risk use yet. Main gaps: no push notifications while closed, images only (no other file types), no at-rest encryption of local storage, sender is visible to the server (no sealed sender). All are in DESIGN.md §10.
