// Copyright (c) 2026 Johannes Thorén. All rights reserved.
// Licensed under the LGJT License v1. See LICENSE in the project root.
// SQLite storage for the relay. The server only ever holds public keys and opaque ciphertext.
import { DatabaseSync } from 'node:sqlite';

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      identity TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      sign_pub TEXT NOT NULL,
      cert TEXT NOT NULL,
      name_box TEXT,            -- device name, encrypted client-side; opaque here
      created INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (account, id)
    );
    CREATE TABLE IF NOT EXISTS spks (
      account TEXT NOT NULL, device TEXT NOT NULL,
      id INTEGER NOT NULL, pub TEXT NOT NULL, sig TEXT NOT NULL,
      PRIMARY KEY (account, device),
      FOREIGN KEY (account, device) REFERENCES devices(account, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS opks (
      account TEXT NOT NULL, device TEXT NOT NULL,
      id INTEGER NOT NULL, pub TEXT NOT NULL,
      PRIMARY KEY (account, device, id),
      FOREIGN KEY (account, device) REFERENCES devices(account, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS mailbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      account TEXT NOT NULL, device TEXT NOT NULL,
      from_account TEXT NOT NULL, from_device TEXT NOT NULL,
      kind TEXT NOT NULL, body TEXT NOT NULL, ts INTEGER NOT NULL,
      FOREIGN KEY (account, device) REFERENCES devices(account, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS mailbox_dest ON mailbox(account, device, seq);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL,
      expires INTEGER,            -- null = never
      max_uses INTEGER,           -- null = unlimited
      uses INTEGER NOT NULL DEFAULT 0,
      revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS invite_uses (
      code TEXT NOT NULL,
      account TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS invite_uses_account ON invite_uses(account);
  `);

  // migrations
  const cols = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
  if (!cols.includes('push_sub')) db.exec('ALTER TABLE devices ADD COLUMN push_sub TEXT');

  const q = {
    getAccount: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    insertAccount: db.prepare('INSERT INTO accounts (id, identity, created) VALUES (?, ?, ?)'),
    getDevice: db.prepare('SELECT * FROM devices WHERE account = ? AND id = ?'),
    listDevices: db.prepare('SELECT id, sign_pub, cert, name_box, created, last_seen FROM devices WHERE account = ? ORDER BY created'),
    insertDevice: db.prepare('INSERT INTO devices (account, id, sign_pub, cert, name_box, created, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    touchDevice: db.prepare('UPDATE devices SET last_seen = ? WHERE account = ? AND id = ?'),
    setPush: db.prepare('UPDATE devices SET push_sub = ? WHERE account = ? AND id = ?'),
    getPush: db.prepare('SELECT push_sub FROM devices WHERE account = ? AND id = ?'),
    getInvite: db.prepare('SELECT * FROM invites WHERE code = ?'),
    insertInvite: db.prepare('INSERT INTO invites (code, label, created, expires, max_uses) VALUES (?, ?, ?, ?, ?)'),
    useInvite: db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ? AND revoked = 0 AND (expires IS NULL OR expires > ?) AND (max_uses IS NULL OR uses < max_uses)'),
    recordInviteUse: db.prepare('INSERT INTO invite_uses (code, account, ts) VALUES (?, ?, ?)'),
    listInvites: db.prepare('SELECT * FROM invites ORDER BY created DESC'),
    revokeInvite: db.prepare('UPDATE invites SET revoked = 1 WHERE code = ?'),
    deleteInvite: db.prepare('DELETE FROM invites WHERE code = ?'),
    listAccounts: db.prepare(`SELECT a.id, a.created, COUNT(d.id) AS devices, MAX(d.last_seen) AS last_seen,
        (SELECT i.label FROM invite_uses u LEFT JOIN invites i ON i.code = u.code WHERE u.account = a.id LIMIT 1) AS invite_label,
        (SELECT u.code FROM invite_uses u WHERE u.account = a.id LIMIT 1) AS invite_code
      FROM accounts a LEFT JOIN devices d ON d.account = a.id GROUP BY a.id ORDER BY a.created DESC LIMIT 1000`),
    deleteAccount: db.prepare('DELETE FROM accounts WHERE id = ?'),
    stats: db.prepare(`SELECT (SELECT COUNT(*) FROM accounts) AS accounts, (SELECT COUNT(*) FROM devices) AS devices,
      (SELECT COUNT(*) FROM mailbox) AS queued, (SELECT COUNT(*) FROM devices WHERE push_sub IS NOT NULL) AS push`),
    deleteDevice: db.prepare('DELETE FROM devices WHERE account = ? AND id = ?'),
    setDeviceName: db.prepare('UPDATE devices SET name_box = ? WHERE account = ? AND id = ?'),
    upsertSpk: db.prepare('INSERT INTO spks (account, device, id, pub, sig) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account, device) DO UPDATE SET id = excluded.id, pub = excluded.pub, sig = excluded.sig'),
    getSpk: db.prepare('SELECT id, pub, sig FROM spks WHERE account = ? AND device = ?'),
    insertOpk: db.prepare('INSERT OR IGNORE INTO opks (account, device, id, pub) VALUES (?, ?, ?, ?)'),
    popOpk: db.prepare('DELETE FROM opks WHERE rowid = (SELECT rowid FROM opks WHERE account = ? AND device = ? ORDER BY id LIMIT 1) RETURNING id, pub'),
    countOpks: db.prepare('SELECT COUNT(*) AS n FROM opks WHERE account = ? AND device = ?'),
    enqueue: db.prepare('INSERT INTO mailbox (account, device, from_account, from_device, kind, body, ts) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq'),
    pending: db.prepare('SELECT seq, from_account, from_device, kind, body, ts FROM mailbox WHERE account = ? AND device = ? ORDER BY seq LIMIT 500'),
    ack: db.prepare('DELETE FROM mailbox WHERE seq = ? AND account = ? AND device = ?'),
    expire: db.prepare('DELETE FROM mailbox WHERE ts < ?'),
    mailboxSize: db.prepare('SELECT COUNT(*) AS n FROM mailbox WHERE account = ? AND device = ?'),
  };

  const tx = (fn) => (...args) => {
    db.exec('BEGIN');
    try { const r = fn(...args); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  return { db, q, tx };
}
