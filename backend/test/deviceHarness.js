// Loads the device-mode backend (src/embedded) the way the phone app's bundle
// does, for the tests that drive it: every bare module in src/embedded/aliases.js
// is swapped for its device stand-in, and the database underneath is node-sqlite3
// handed to the sqlite3 shim as a driver, where the app hands it the Capacitor
// plugin (frontend/src/utils/deviceSqlite.js).
//
// Not a test itself (no .test.js), so test/run.js does not run it on its own.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const sqlite3 = require('sqlite3');

// observe(sql) sees every statement the moment the driver receives it, before it
// runs; a test uses it to act at an exact point between two statements.
function nodeDriver(observe) {
  let conn;
  const seen = (sql) => { if (observe) observe(sql); };
  return {
    open: (name) => new Promise((ok, fail) => { conn = new sqlite3.Database(name, err => (err ? fail(err) : ok())); }),
    run: (sql, params) => {
      seen(sql);
      return new Promise((ok, fail) => conn.run(sql, params, function (err) {
        if (err) fail(err); else ok({ lastID: this.lastID, changes: this.changes });
      }));
    },
    all: (sql, params) => {
      seen(sql);
      return new Promise((ok, fail) => conn.all(sql, params, (err, rows) => (err ? fail(err) : ok(rows))));
    },
    close: () => new Promise((ok, fail) => conn.close(err => (err ? fail(err) : ok()))),
  };
}

// name: [a-z-]+, so test/run.js recognises a database a killed run left behind.
// ownTcgcsvSwitch: leave BINDARR_DISABLE_TCGCSV_SYNC unset, so device mode
// manages it the way it does on a phone (the axios block below still applies).
function loadEmbedded(name, { observe, ownTcgcsvSwitch = false } = {}) {
  const tmpDb = path.join(os.tmpdir(), `bindarr-${name}-${process.pid}.db`);
  process.env.DB_PATH = tmpDb;
  delete process.env.DEFAULT_ADMIN_PASSWORD;
  // The device's own background jobs reach for TCGCSV and the ECB; a test never
  // does. And nothing else may either: any request through axios fails loudly.
  if (ownTcgcsvSwitch) delete process.env.BINDARR_DISABLE_TCGCSV_SYNC;
  else process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';
  process.env.BINDARR_DISABLE_FX_SYNC = '1';
  const axios = require('axios');
  axios.defaults.adapter = async (config) => {
    throw new Error(`a device-mode test tried to reach the network: ${config.method} ${config.url}`);
  };

  // Swap modules only for code under src/, which is what the bundler does: the
  // tests themselves keep the real sqlite3 to build the driver from.
  const SRC = path.join(__dirname, '..', 'src') + path.sep;
  const aliases = require('../src/embedded/aliases');
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    const fromSrc = parent && parent.filename && parent.filename.startsWith(SRC);
    if (fromSrc && Object.prototype.hasOwnProperty.call(aliases, request)) {
      return resolve.call(this, aliases[request], parent, ...rest);
    }
    return resolve.call(this, request, parent, ...rest);
  };

  const embedded = require('../src/embedded');
  const db = require('../src/db');
  embedded.setDriver(nodeDriver(observe));

  async function cleanup() {
    try { embedded.stop(); } catch { /* never started */ }
    try { await new Promise(ok => db.dbConnection.close(ok)); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }

  return { embedded, db, tmpDb, cleanup };
}

// A promise and the function that settles it, for holding a job or a request at
// a point the test chooses.
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = { loadEmbedded, gate, sleep };
