// The on-device database for device mode: @capacitor-community/sqlite, shaped as
// the driver backend/src/embedded/shims/sqlite3.js expects —
//   { open(name), run(sql, params) -> { lastID, changes }, all(sql, params) -> rows, close() }
//
// The plugin is passed in rather than imported, so this file stays plain logic
// that node --test can exercise against a fake (deviceSqlite.test.js).
//
// What the adaptation has to get right, all read off the plugin's own Android
// and iOS sources:
//   - Every run() passes transaction:false. The plugin otherwise wraps each
//     statement in a transaction of its own, which turns db.js's
//     withTransaction() BEGIN into "cannot start a transaction within a
//     transaction".
//   - BEGIN / COMMIT / ROLLBACK go through the plugin's transaction calls, not
//     run(). Android executes run() as a compiled update statement, and its
//     transaction bookkeeping only stays straight through those calls.
//   - PRAGMAs go through query(). Android refuses any statement that returns a
//     row from its update path, and most PRAGMAs do (`busy_timeout = 5000`
//     answers 5000).
//   - journal_mode is not ours to set. The plugin opens the file in the mode the
//     platform manages; WAL exists on the server so readers do not block its one
//     writer, and a phone has only the one connection.
//   - iOS prepends a { ios_columns: [...] } row to every non-empty result, and
//     its rows are unordered dictionaries. The plugin's own wrapper strips that
//     row and rebuilds each row in column order; so does rows() below.

const statementKind = (sql) => {
  const head = String(sql).trimStart().slice(0, 16).toUpperCase();
  if (/^BEGIN\b/.test(head)) return 'begin';
  if (/^(COMMIT|END)\b/.test(head)) return 'commit';
  if (/^ROLLBACK\b/.test(head) && !/\bTO\b/i.test(sql)) return 'rollback';
  if (/^PRAGMA\b/.test(head)) return 'pragma';
  return 'statement';
};

const NO_CHANGE = { lastID: 0, changes: 0 };

function rows(values) {
  if (!Array.isArray(values) || !values.length) return [];
  const columns = values[0] && values[0].ios_columns;
  if (!Array.isArray(columns)) return values;
  return values.slice(1).map((row) => {
    const ordered = {};
    for (const name of columns) ordered[name] = row[name];
    return ordered;
  });
}

export function createDeviceDriver(plugin) {
  let database = null;

  return {
    async open(filename) {
      // The plugin stores `<name>SQLite.db` in the app's own data directory, so
      // the name db.js passes ('bindarr.db') becomes the bare 'bindarr'.
      database = String(filename).replace(/^.*[\\/]/, '').replace(/\.db$/i, '') || 'bindarr';
      // A WebView reload keeps the native side's connections while this JS
      // forgets them, and createConnection then refuses a name it already holds.
      // Telling the plugin "this page has none" closes whatever a previous page
      // load left open, so every launch starts from one clean connection.
      await plugin.checkConnectionsConsistency({ dbNames: [], openModes: [] }).catch(() => {});
      await plugin.createConnection({ database, version: 1, encrypted: false, mode: 'no-encryption', readonly: false });
      await plugin.open({ database, readonly: false });
    },

    async run(sql, params = []) {
      switch (statementKind(sql)) {
        case 'begin':
          await plugin.beginTransaction({ database });
          return NO_CHANGE;
        case 'commit':
          await plugin.commitTransaction({ database });
          return NO_CHANGE;
        case 'rollback':
          await plugin.rollbackTransaction({ database });
          return NO_CHANGE;
        case 'pragma':
          if (/^\s*PRAGMA\s+journal_mode\b/i.test(sql)) return NO_CHANGE;
          await plugin.query({ database, statement: sql, values: params, readonly: false });
          return NO_CHANGE;
        default: {
          const { changes } = await plugin.run({ database, statement: sql, values: params, transaction: false, readonly: false });
          return {
            lastID: changes && changes.lastId > 0 ? changes.lastId : 0,
            changes: changes && changes.changes > 0 ? changes.changes : 0,
          };
        }
      }
    },

    async all(sql, params = []) {
      if (/^\s*PRAGMA\s+journal_mode\b/i.test(sql)) return [];
      const { values } = await plugin.query({ database, statement: sql, values: params, readonly: false });
      return rows(values);
    },

    async close() {
      if (!database) return;
      await plugin.close({ database, readonly: false }).catch(() => {});
      await plugin.closeConnection({ database, readonly: false }).catch(() => {});
    },
  };
}

export { statementKind, rows };
