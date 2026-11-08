// The `sqlite3` package's API, over whatever SQLite the device has.
//
// db.js is written against node-sqlite3's callbacks. On a phone the database is
// the native SQLite that @capacitor-community/sqlite exposes over the Capacitor
// bridge, which speaks promises and JSON. This adapts one to the other so db.js
// — schema, migrations, run/get/all, withTransaction — runs unchanged.
//
// The app supplies the database with setDriver() before the first statement;
// statements issued before that simply wait for it. A driver is
//   { open(name), run(sql, params) -> { lastID, changes }, all(sql, params) -> rows, close() }
// (frontend/src/utils/deviceSqlite.js is the Capacitor one).
//
// Statements run strictly one at a time, in the order issued. That is what
// node-sqlite3's single connection gives db.js on a server, and withTransaction
// depends on it: everything issued between its BEGIN and COMMIT lands inside the
// transaction, and nothing else is in flight on the connection meanwhile.
'use strict';

let provide;
const driverReady = new Promise((resolve) => { provide = resolve; });
let installed = null;

function setDriver(driver) {
  if (installed && installed !== driver) throw new Error('A SQLite driver is already installed');
  installed = driver;
  provide(driver);
}

// node-sqlite3 binds booleans as 1/0 and a Date as its epoch milliseconds. The
// bridge would carry a boolean as-is and a Date as an ISO string, so make both
// what the server would have stored.
function bindable(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  return value;
}

const isNamedParams = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !ArrayBuffer.isView(v);

// run(sql), run(sql, cb), run(sql, [params], cb), run(sql, a, b, cb). db.js only
// ever uses the array form; named ({ $id: 1 }) parameters are refused rather
// than bound in some order the server would not have used.
function splitArgs(rest) {
  const callback = typeof rest[rest.length - 1] === 'function' ? rest.pop() : null;
  if (rest.length === 1 && isNamedParams(rest[0])) {
    throw new TypeError('Named parameters are not supported on the device');
  }
  const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
  return { params: params.map(bindable), callback };
}

class Database {
  constructor(filename, mode, callback) {
    const cb = typeof mode === 'function' ? mode : callback;
    this._opened = driverReady.then(driver => driver.open(filename));
    this._opened.then(() => cb && cb.call(this, null), err => cb && cb.call(this, err));
    this._tail = Promise.resolve();
  }

  // Queue one statement behind every earlier one. A failed statement does not
  // stall the queue; a failed open fails everything after it.
  _enqueue(op) {
    const result = this._tail.then(() => this._opened).then(() => op(installed));
    this._tail = result.then(() => undefined, () => undefined);
    return result;
  }

  run(sql, ...rest) {
    const { params, callback } = splitArgs(rest);
    this._enqueue(driver => driver.run(sql, params)).then(
      r => callback && callback.call({ lastID: r.lastID, changes: r.changes }, null),
      err => callback && callback.call({}, err)
    );
    return this;
  }

  get(sql, ...rest) {
    const { params, callback } = splitArgs(rest);
    this._enqueue(driver => driver.all(sql, params)).then(
      rows => callback && callback(null, rows && rows.length ? rows[0] : undefined),
      err => callback && callback(err)
    );
    return this;
  }

  all(sql, ...rest) {
    const { params, callback } = splitArgs(rest);
    this._enqueue(driver => driver.all(sql, params)).then(
      rows => callback && callback(null, rows || []),
      err => callback && callback(err)
    );
    return this;
  }

  close(callback) {
    this._enqueue(driver => driver.close && driver.close()).then(
      () => callback && callback(null),
      err => callback && callback(err)
    );
  }
}

const sqlite3 = { Database, setDriver };
sqlite3.verbose = () => sqlite3;

module.exports = sqlite3;
