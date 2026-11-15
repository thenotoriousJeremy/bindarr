// Shared plumbing for the e2e suites, which drive a real server.js over HTTP.
//
//   const harness = require('./harness');
//   const tmp = harness.tempDatabase('isolation');   // sets DB_PATH: do this first
//   const db = require('../../src/db');              // ...so this opens the temp file
//   await harness.prepare(db);                       // schema and the admin, no server yet
//   const alice = await harness.member(db, 'alice'); // { id, username, headers }
//   ...every other fixture, written while no server has the file open...
//   const srv = await harness.startServer(tmp);      // free port, offline, no models
//   const res = await srv.request('GET', '/api/locations', { as: alice });
//   await srv.stop();                                // returns once the process has exited
//   await harness.cleanup(db, tmp);
//
// Fixtures go in before the server starts, or through its API once it has. A
// suite writing the file while the server writes it too can outlast SQLite's 5 s
// busy timeout (cross_feature F5-TC3 did, against a boot-time set sync), and
// fails in a way that says nothing about the code under test.
//
// The server runs offline (offline.js, and netguard.js under it) with an empty
// model directory, which is a fresh install's state: no scan catalog, so
// /api/scan-match answers 503. The suite's own process is guarded too.
//
// Not a *.test.js file, so test/e2e/run.js does not run it as a suite.
require('./netguard');

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { freePort } = require('../freePort');

const SERVER = path.join(__dirname, '..', '..', 'src', 'server.js');
const OFFLINE = path.join(__dirname, 'offline.js');

// The password the seeded `admin` account gets, unless DEFAULT_ADMIN_PASSWORD is
// already set (run.js sets this same value).
const ADMIN_PASSWORD = 'test-admin-password';

// A throwaway directory holding the database (and the card-art, backups, ssl and
// models directories the server creates beside it). Points DB_PATH at it, so call
// this before anything requires src/db. The name carries this process's id, which
// is how run.js tells a dead run's leftovers from a live run's files.
function tempDatabase(name) {
  if (!process.env.DEFAULT_ADMIN_PASSWORD) process.env.DEFAULT_ADMIN_PASSWORD = ADMIN_PASSWORD;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bindarr-${name}-${process.pid}-`));
  const file = path.join(dir, 'bindarr.db');
  process.env.DB_PATH = file;
  return { dir, file };
}

// Brings the schema up to date and seeds the `admin` account in THIS process,
// before any server opens the file, so the suite can write its fixtures while
// nothing else writes. A server started afterwards finds the database current and
// migrates nothing.
//
// Automatic price refresh is switched off (price_refresh_days = 0, as an admin
// can set it): a server's first scheduler tick would otherwise re-price the
// fixtures from the Scryfall fixtures while a suite asserts on their prices.
async function prepare(db) {
  await db.initDb();
  await db.run(`UPDATE app_settings SET price_refresh_days = 0 WHERE id = 1`);
}

// Starts server.js on a free port, preloaded with offline.js, with no models.
// `env` is laid over the defaults below; a key set to undefined is removed. `tmp`
// is what tempDatabase returned, or { dir, file } for a database somewhere else.
// Resolves once /api/health answers, unless `wait: false` (for a server that is
// expected to exit instead: await `exited`).
async function startServer(tmp, { env = {}, wait = true } = {}) {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const childEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: tmp.file,
    HTTPS_PORT: '',
    CV_MODEL_DIR: path.join(tmp.dir, 'models'),
    BINDARR_DISABLE_TCGCSV_SYNC: '1',
    BINDARR_DISABLE_FX_SYNC: '1',
    // Notification channels may then point at 127.0.0.1, which nothing here sends to.
    NOTIFY_ALLOW_PRIVATE: 'true',
    BACKUP_INTERVAL_HOURS: '0',
    DEFAULT_ADMIN_PASSWORD: process.env.DEFAULT_ADMIN_PASSWORD || ADMIN_PASSWORD,
    ...env,
  };
  for (const [key, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[key];

  // The IPC channel is how the server notices this process is gone (offline.js).
  const child = spawn(process.execPath, ['-r', OFFLINE, SERVER], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));

  // Kept, not echoed: the suites print their own verdicts, and a server log is
  // only interesting when something failed (see `tail`). Both pipes are always
  // read, so a chatty server can never fill one and stall.
  // `logs` is both streams interleaved (the last 400 chunks, for `tail`); each
  // stream is also kept on its own, its last 256 KB, for stdout()/stderr().
  const logs = [];
  const streams = { stdout: { chunks: [], size: 0 }, stderr: { chunks: [], size: 0 } };
  const keep = (name) => (chunk) => {
    const text = chunk.toString();
    logs.push(text);
    if (logs.length > 400) logs.shift();
    const s = streams[name];
    s.chunks.push(text);
    s.size += text.length;
    while (s.size > 256 * 1024 && s.chunks.length > 1) s.size -= s.chunks.shift().length;
  };
  child.stdout.on('data', keep('stdout'));
  child.stderr.on('data', keep('stderr'));

  if (wait) {
    let healthy = false;
    for (let i = 0; i < 600; i++) {
      try {
        healthy = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })).ok;
      } catch { /* not listening yet */ }
      if (healthy) break;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`server exited during startup:\n${logs.join('')}`);
      }
      await new Promise(r => setTimeout(r, 100));
    }
    if (!healthy) {
      child.kill('SIGKILL');
      await exited;
      throw new Error(`server on ${port} never became healthy:\n${logs.join('')}`);
    }
  }

  // One request. `as` is a member from member()/admin(); `body` is sent as JSON
  // unless it is already a string. Never throws for an HTTP status: a hung or
  // reset request comes back as { status: 0, error } so a suite can report it.
  async function request(method, url, { as, body, headers = {}, timeoutMs = 15000 } = {}) {
    const init = {
      method,
      headers: { ...(as ? as.headers : {}), ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    try {
      const res = await fetch(`${base}${url}`, init);
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, json, text, headers: res.headers };
    } catch (error) {
      return { status: 0, json: null, text: '', error: error.name === 'TimeoutError' ? `no response in ${timeoutMs} ms` : error.message };
    }
  }

  async function alive() {
    const health = await request('GET', '/api/health', { timeoutMs: 5000 });
    return child.exitCode === null && health.status === 200;
  }

  // SIGKILL, as the suites always have: sqlite3's teardown can crash on Windows.
  // Waits for the exit, so the temp files are free to delete afterwards.
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    await exited;
  }

  const tail = (n = 40) => logs.join('').split('\n').slice(-n).join('\n');
  return {
    base, port, child, exited, request, alive, stop, tail,
    stdout: () => streams.stdout.chunks.join(''),
    stderr: () => streams.stderr.chunks.join(''),
  };
}

// A member account plus a live session, written straight into the database: the
// auth routes are not what these suites are about, and the login limiter allows
// only 20 attempts per window. Call it before startServer.
async function member(db, username, role = 'member') {
  const { lastID: id } = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    [username, 'unused', role, crypto.randomBytes(16).toString('hex')]
  );
  return { id, username, headers: await sessionHeaders(db, id) };
}

// The `admin` account initDb seeds from DEFAULT_ADMIN_PASSWORD, with a fresh
// session. After prepare() it is already there; otherwise this waits for the
// server to create it.
async function admin(db) {
  for (let i = 0; i < 100; i++) {
    const row = await db.get(`SELECT id FROM users WHERE username = 'admin'`).catch(() => null);
    if (row) return { id: row.id, username: 'admin', headers: await sessionHeaders(db, row.id) };
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('the admin account was never created');
}

async function sessionHeaders(db, userId) {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  // Stored hashed, as authHelpers.generateSession does; the bearer is the raw token.
  // Required here, not at the top: authHelpers loads src/db, which must not open
  // before tempDatabase() has pointed DB_PATH at the throwaway file.
  const { hashSessionToken } = require('../../src/utils/authHelpers');
  await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`, [hashSessionToken(token), userId, expiresAt]);
  return { Authorization: `Bearer ${token}` };
}

// Closes this process's connection and removes the directory. Call after every
// server is stopped: Windows will not delete a file a live process holds, and the
// retries cover the moment after an exit before the handles are gone.
async function cleanup(db, tmp) {
  if (db) {
    try { await new Promise(r => db.dbConnection.close(() => r())); } catch { /* already closed */ }
  }
  try {
    fs.rmSync(tmp.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    console.warn(`could not remove ${tmp.dir}: ${err.message}`);
  }
}

module.exports = { ADMIN_PASSWORD, tempDatabase, prepare, startServer, member, admin, sessionHeaders, cleanup };
