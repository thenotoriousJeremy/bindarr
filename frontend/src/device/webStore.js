// Browser dev harness for device mode only: VITE_DEVICE_WEB=1 npm run dev.
//
// On a phone, device mode talks to @capacitor-community/sqlite's native code. A
// desktop browser has none, so this stands in for the plugin: the calls
// src/utils/deviceSqlite.js makes, answered in the shapes the plugin's Android
// implementation returns, over sql.js. The driver under test is therefore the
// one the app ships; only the engine beneath it differs. The database is kept in
// IndexedDB so a reload behaves like relaunching the app.
//
// Not the plugin's own web build: that one goes through jeep-sqlite, which
// bundles an older sql.js than npm installs beside it, and the two refuse to link.
// Nothing ships this file — apiBase.js only reaches it when VITE_DEVICE_WEB was set
// at build time.
import initSqlJs from 'sql.js';

const IDB_NAME = 'bindarr-device-harness';

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('db');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('db', mode);
      const req = fn(tx.objectStore('db'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}

export async function createWebSqlitePlugin() {
  const SQL = await initSqlJs({ locateFile: (file) => `/node_modules/sql.js/dist/${file}` });
  const dbs = new Map();
  let saveTimer = null;

  const get = (database) => {
    const entry = dbs.get(database);
    if (!entry) throw new Error(`No open database ${database}`);
    return entry;
  };

  // sql.js's export() closes and reopens the database, which resets per-connection
  // pragmas; foreign keys are put back on the way the native plugin keeps them.
  const save = (database) => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const entry = dbs.get(database);
      if (!entry || entry.inTransaction) return;
      const bytes = entry.db.export();
      entry.db.run('PRAGMA foreign_keys = ON');
      idb('readwrite', store => store.put(bytes, database)).catch(err => console.error('harness save failed', err));
    }, 300);
  };

  const rows = (db, statement, values) => {
    const stmt = db.prepare(statement);
    try {
      if (values && values.length) stmt.bind(values);
      const out = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally {
      stmt.free();
    }
  };

  return {
    async checkConnectionsConsistency() {
      dbs.clear();
      return { result: false };
    },
    async createConnection({ database }) {
      if (dbs.has(database)) throw new Error(`Connection ${database} already exists`);
      dbs.set(database, { db: null, inTransaction: false });
    },
    async open({ database }) {
      const entry = get(database);
      const bytes = await idb('readonly', store => store.get(database));
      entry.db = new SQL.Database(bytes || undefined);
      entry.db.run('PRAGMA foreign_keys = ON');
    },
    async close({ database }) {
      const entry = dbs.get(database);
      if (entry && entry.db) entry.db.close();
    },
    async closeConnection({ database }) {
      dbs.delete(database);
    },
    async beginTransaction({ database }) {
      const entry = get(database);
      entry.db.run('BEGIN TRANSACTION');
      entry.inTransaction = true;
      return { changes: { changes: 0 } };
    },
    async commitTransaction({ database }) {
      const entry = get(database);
      entry.db.run('COMMIT');
      entry.inTransaction = false;
      save(database);
      return { changes: { changes: 0 } };
    },
    async rollbackTransaction({ database }) {
      const entry = get(database);
      if (entry.inTransaction) entry.db.run('ROLLBACK');
      entry.inTransaction = false;
      return { changes: { changes: 0 } };
    },
    async run({ database, statement, values }) {
      const { db, inTransaction } = get(database);
      db.run(statement, values && values.length ? values : undefined);
      const [[changes, lastId]] = db.exec('SELECT changes(), last_insert_rowid()')[0].values;
      if (!inTransaction) save(database);
      return { changes: { changes, lastId, values: [] } };
    },
    async query({ database, statement, values }) {
      return { values: rows(get(database).db, statement, values) };
    },
  };
}
