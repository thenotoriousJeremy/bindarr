// The process's one SQLite connection, and the lock that keeps a transaction's
// statements apart from everyone else's. Every statement reaches the connection
// through run/get/all, withTransaction or runExclusive below: db.js re-exports
// them for the rest of the backend, and initDb (./migrations.js) calls them
// directly.
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');

// The app began life as "PokeKeep", a Pokémon-only tracker, so its database was
// called pokemon_cards.db. It has handled Magic since v1.4.x, and the file name
// is the last thing still carrying the old name.
const DB_FILENAME = 'bindarr.db';
const LEGACY_DB_FILENAME = 'pokemon_cards.db';

// Rename an existing pokemon_cards.db to the new name, WAL sidecars included.
// Getting this wrong loses collections: point SQLite at a name that isn't there
// and it cheerfully creates an empty database, which looks exactly like the app
// wiping everything. So: never overwrite, move the -wal/-shm files with the
// main one (un-checkpointed transactions live in the WAL), and on any failure
// keep using the old file rather than silently starting fresh.
// Returns the path that should actually be opened.
function resolveDbPath(target) {
  // Only ever migrate INTO the canonical name. A custom DB_PATH is the
  // operator's decision and must not attract someone else's old file.
  if (path.basename(target) !== DB_FILENAME) return target;

  const legacy = path.join(path.dirname(target), LEGACY_DB_FILENAME);
  if (fs.existsSync(target) || !fs.existsSync(legacy)) return target;

  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(legacy + suffix)) fs.renameSync(legacy + suffix, target + suffix);
    }
    console.log(`Renamed legacy database ${LEGACY_DB_FILENAME} -> ${DB_FILENAME}.`);
    return target;
  } catch (err) {
    console.error(
      `Could not rename ${LEGACY_DB_FILENAME} to ${DB_FILENAME} (${err.message}). ` +
      `Continuing with ${LEGACY_DB_FILENAME} — your data is safe, but please rename it manually.`
    );
    return legacy;
  }
}

// Ensure database directory exists. The default is backend/database: this file
// sits in backend/src/db.
const requestedDbPath = process.env.DB_PATH || path.join(__dirname, `../../database/${DB_FILENAME}`);
const dbDir = path.dirname(requestedDbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const dbPath = resolveDbPath(requestedDbPath);

console.log(`Connecting to SQLite database at: ${dbPath}`);
// Settles once the connection is open AND configured. initDb awaits it first.
//
// A connection that failed to open does not fail the queries queued on it —
// sqlite3 drops them, so initDb's promise never settled and the server sat
// listening, answering 503 forever. And the PRAGMAs are run one after another,
// each waited for, before initDb's first statement: sqlite3 runs statements in
// parallel, and a read still mid-step when the switch to WAL lands fails it with
// "cannot change into wal mode from within a transaction" — fired without a
// callback, that was an uncaught error event, which ends the process. The busy
// timeout goes first so the switch waits out another connection's lock rather
// than failing on it.
let settleOpen;
const opened = new Promise((resolve, reject) => { settleOpen = (err) => (err ? reject(err) : resolve()); });
opened.catch(() => {});   // initDb reports it; never an unhandled rejection on its own
const dbConnection = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
    return settleOpen(err);
  }
  console.log('Database connection established successfully.');
  const pragmas = ['PRAGMA busy_timeout = 5000', 'PRAGMA foreign_keys = ON', 'PRAGMA journal_mode = WAL'];
  const next = (i) => {
    if (i === pragmas.length) return settleOpen();
    dbConnection.run(pragmas[i], (pragmaErr) => {
      if (!pragmaErr) return next(i + 1);
      console.error(`Error configuring database (${pragmas[i]}):`, pragmaErr.message);
      settleOpen(pragmaErr);
    });
  };
  next(0);
});

// --- Connection lock --------------------------------------------------------
// There is ONE sqlite3 connection, so an open transaction belongs to the
// connection, not to the code that opened it. Before this lock, a write any
// other request made while a transaction was open landed inside it — and its
// ROLLBACK threw that write away — and every reader saw rows nobody had
// committed.
//
// So the connection has an owner. While a transaction is open, statements from
// outside it queue until its COMMIT or ROLLBACK. Statements issued from inside
// it, in the callback itself or in any helper the callback awaits, run at once.
// "Inside" is tracked with AsyncLocalStorage, so helpers keep calling
// db.run/get/all and need no transaction handle passed down to them.
//
// Transactions run one at a time, and each waits for the statements already
// running to finish before its BEGIN: node-sqlite3 can reorder statements that
// are in flight together, so "issued before the BEGIN" does not mean "executed
// before it". The queue is first come, first served. A statement that arrives
// while a transaction is waiting goes behind it, so a steady stream of reads
// cannot starve a write.
//
// The lock is held for the whole callback. A transaction must never await a
// network request: every other request in the process would wait with it.
//
// A statement from a transaction that has already finished (work the callback
// started and did not await) is treated as coming from outside: it waits its
// turn and runs on its own, rather than slipping into whichever transaction
// holds the connection next.
const txScope = new AsyncLocalStorage();
let owner = null;     // the open transaction, if any
let inFlight = 0;     // statements handed to sqlite3 and not yet answered
const waiting = [];   // first come, first served: { tx, start }

function dispatch(method, sql, params) {
  inFlight++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, result) => {
      if (settled) return;
      settled = true;
      inFlight--;
      if (err) reject(err);
      else resolve(result);
      pump();
    };
    try {
      if (method === 'run') {
        dbConnection.run(sql, params, function (err) {
          done(err, err ? undefined : { lastID: this.lastID, changes: this.changes });
        });
      } else {
        dbConnection[method](sql, params, done);
      }
    } catch (err) {
      done(err);
    }
  });
}

// Start whatever the free connection can take: queued statements, until the next
// transaction in line, which then waits for the connection to go quiet.
function pump() {
  while (!owner && waiting.length) {
    if (waiting[0].tx && inFlight > 0) return;
    waiting.shift().start();
  }
}

function schedule(method, sql, params) {
  if (!owner) {
    if (waiting.length === 0) return dispatch(method, sql, params);
  } else {
    const scope = txScope.getStore();
    if (scope && scope.tx === owner) return dispatch(method, sql, params);
  }
  return new Promise((resolve, reject) => {
    waiting.push({ tx: false, start: () => dispatch(method, sql, params).then(resolve, reject) });
  });
}

function acquire(tx) {
  return new Promise(resolve => {
    const start = () => { owner = tx; resolve(); };
    if (!owner && waiting.length === 0 && inFlight === 0) start();
    else waiting.push({ tx: true, start });
  });
}

function release() {
  owner = null;
  pump();
}

// BEGIN/COMMIT/SAVEPOINT and friends, which only make sense while `tx` still
// owns the connection. Run after it has gone, a SAVEPOINT would quietly open a
// brand-new transaction nobody commits.
function control(tx, sql) {
  if (owner !== tx) return Promise.reject(new Error(`${sql}: the transaction it belongs to has already finished`));
  return dispatch('run', sql, []);
}

// Roll back without letting a failed ROLLBACK replace the error that caused it.
async function undo(tx, sql) {
  try {
    await control(tx, sql);
  } catch (err) {
    console.error(`${sql} failed:`, err.message);
  }
}

// Helper wrappers for Promise-based SQL operations
function run(sql, params = []) {
  return schedule('run', sql, params);
}

function get(sql, params = []) {
  return schedule('get', sql, params);
}

function all(sql, params = []) {
  return schedule('all', sql, params);
}

// One statement with the connection to itself, outside any transaction: VACUUM
// INTO. SQLite refuses it with "cannot VACUUM - SQL statements in progress"
// while any other statement on the connection is still running, and an ordinary
// run() only waits for the open transaction, not for reads and writes already in
// flight. So it queues like a transaction (waits for the connection to go quiet,
// then owns it) and issues no BEGIN; everything that arrives meanwhile waits.
async function runExclusive(sql, params = []) {
  const scope = txScope.getStore();
  if (owner && scope && scope.tx === owner) {
    throw new Error(`${sql}: cannot run exclusively from inside a transaction`);
  }
  const tx = { exclusive: true };
  await acquire(tx);
  try {
    return await dispatch('run', sql, params);
  } finally {
    release();
  }
}

// Run fn inside BEGIN IMMEDIATE / COMMIT, rolling back if it throws. fn has the
// connection to itself until it settles (see the connection lock above).
//
// Called from inside another transaction, it becomes a SAVEPOINT in that one
// rather than a second BEGIN (which SQLite refuses): its writes commit or roll
// back with the outer transaction, but if fn throws, only fn's own writes are
// undone. That is what lets a caller catch one failed step and carry on.
// Savepoints under the same parent take turns, because they nest as a stack and
// two open side by side would release or roll back each other.
//
// fn takes no argument on purpose. It used to be handed a `tx` object, but that
// object was `{ run, get, all, withTransaction }` — the module's own exports under
// a different name. Use `db` directly: the lock knows which statements are fn's.
async function withTransaction(fn) {
  const scope = txScope.getStore();
  if (owner && scope && scope.tx === owner) return withSavepoint(scope, fn);

  const tx = { savepoints: 0 };
  await acquire(tx);
  try {
    return await txScope.run({ tx, turn: Promise.resolve() }, async () => {
      await control(tx, 'BEGIN IMMEDIATE TRANSACTION');
      try {
        const result = await fn();
        await control(tx, 'COMMIT');
        return result;
      } catch (error) {
        await undo(tx, 'ROLLBACK');
        throw error;
      }
    });
  } finally {
    release();
  }
}

async function withSavepoint(parent, fn) {
  const previous = parent.turn;
  let finished;
  parent.turn = new Promise(resolve => { finished = resolve; });
  try {
    await previous;
    // The transaction this was meant to join ended while it waited for its turn
    // (its caller did not await it). Run on its own instead.
    if (owner !== parent.tx) return await txScope.exit(() => withTransaction(fn));

    const { tx } = parent;
    const name = `sp_${++tx.savepoints}`;
    return await txScope.run({ tx, turn: Promise.resolve() }, async () => {
      await control(tx, `SAVEPOINT ${name}`);
      try {
        const result = await fn();
        await control(tx, `RELEASE ${name}`);
        return result;
      } catch (error) {
        await undo(tx, `ROLLBACK TO ${name}`);
        await undo(tx, `RELEASE ${name}`);
        throw error;
      }
    });
  } finally {
    finished();
  }
}

module.exports = {
  dbConnection,
  dbPath,
  // Settles once the connection is open and configured; initDb awaits it.
  opened,
  run,
  get,
  all,
  withTransaction,
  runExclusive,
  resolveDbPath,
  DB_FILENAME,
  LEGACY_DB_FILENAME,
};
