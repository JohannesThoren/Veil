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

  const q = {
    getAccount: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    insertAccount: db.prepare('INSERT INTO accounts (id, identity, created) VALUES (?, ?, ?)'),
    getDevice: db.prepare('SELECT * FROM devices WHERE account = ? AND id = ?'),
    listDevices: db.prepare('SELECT id, sign_pub, cert, name_box, created, last_seen FROM devices WHERE account = ? ORDER BY created'),
    insertDevice: db.prepare('INSERT INTO devices (account, id, sign_pub, cert, name_box, created, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    touchDevice: db.prepare('UPDATE devices SET last_seen = ? WHERE account = ? AND id = ?'),
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
