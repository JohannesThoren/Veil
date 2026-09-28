// Key-value storage used by the client core. Values must be JSON-serialisable.
// entries(prefix) returns [key, value] pairs sorted by key.

export class MemoryStore {
  constructor() { this.m = new Map(); }
  async get(k) { const v = this.m.get(k); return v === undefined ? undefined : structuredClone(v); }
  async put(k, v) { this.m.set(k, structuredClone(v)); }
  async del(k) { this.m.delete(k); }
  async entries(prefix) {
    return [...this.m.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, structuredClone(v)]);
  }
  async clear() { this.m.clear(); }
}

export class IdbStore {
  constructor(name = 'veil') { this.name = name; this.db = null; }
  async _open() {
    if (this.db) return this.db;
    this.db = await new Promise((res, rej) => {
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this.db;
  }
  async _tx(mode, fn) {
    const db = await this._open();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => res(req?.result);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  }
  get(k) { return this._tx('readonly', (s) => s.get(k)); }
  put(k, v) { return this._tx('readwrite', (s) => s.put(v, k)); }
  del(k) { return this._tx('readwrite', (s) => s.delete(k)); }
  clear() { return this._tx('readwrite', (s) => s.clear()); }
  async entries(prefix) {
    const range = IDBKeyRange.bound(prefix, prefix + '￿');
    const db = await this._open();
    return new Promise((res, rej) => {
      const out = [];
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').openCursor(range);
      req.onsuccess = () => {
        const c = req.result;
        if (c) { out.push([c.key, c.value]); c.continue(); } else res(out);
      };
      req.onerror = () => rej(req.error);
    });
  }
}
