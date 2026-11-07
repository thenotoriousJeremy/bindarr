// Shared plumbing for e2e suites that drive a real server.js as several users.
//
//   const harness = require('./harness');
//   const tmp = harness.tempDatabase('isolation'); // sets DB_PATH: do this first
//   const db = require('../../src/db');            // ...so this opens the temp file
//   const srv = await harness.startServer(tmp);    // free port, offline, no models
//   const alice = await harness.member(db, 'alice'); // { id, headers }
//   const res = await srv.request('GET', '/api/locations', { as: alice });
//   await srv.stop();
//
// The server runs offline (see offline.js) with an empty model directory, which is
// a fresh install's state: no scan catalog, so /api/scan-match answers 503.
// Not a *.test.js file, so test/e2e/run.js does not run it as a suite.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { freePort } = require('../freePort');

const SERVER = path.join(__dirname, '..', '..', 'src', 'server.js');
const OFFLINE = path.join(__dirname, 'offline.js');

// A throwaway directory holding the database (and the card-art, backups, ssl and
// models directories the server creates beside it). Points DB_PATH at it, so call
// this before anything requires src/db.
function tempDatabase(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bindarr-${name}-${process.pid}-`));
  const file = path.join(dir, 'bindarr.db');
  process.env.DB_PATH = file;
  return { dir, file };
}

async function startServer(tmp, { env = {} } = {}) {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const logs = [];
  const child = spawn(process.execPath, ['-r', OFFLINE, SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: tmp.file,
      HTTPS_PORT: '',
      CV_MODEL_DIR: path.join(tmp.dir, 'models'),
      BINDARR_DISABLE_TCGCSV_SYNC: '1',
      BACKUP_INTERVAL_HOURS: '0',
      DEFAULT_ADMIN_PASSWORD: process.env.DEFAULT_ADMIN_PASSWORD || 'test-admin-password',
      ...env,
    },
  });
  // Kept, not echoed: the suites print their own verdicts, and a server log is
  // only interesting when something failed (see `tail`).
  const keep = (chunk) => { logs.push(chunk.toString()); if (logs.length > 400) logs.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);

  for (let i = 0; i < 200; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch { /* not listening yet */ }
    if (child.exitCode !== null) throw new Error(`server exited during startup:\n${logs.join('')}`);
    await new Promise(r => setTimeout(r, 100));
    if (i === 199) throw new Error(`server on ${port} never became healthy:\n${logs.join('')}`);
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
      return { status: res.status, json, text };
    } catch (error) {
      return { status: 0, json: null, text: '', error: error.name === 'TimeoutError' ? `no response in ${timeoutMs} ms` : error.message };
    }
  }

  async function alive() {
    const health = await request('GET', '/api/health', { timeoutMs: 5000 });
    return child.exitCode === null && health.status === 200;
  }

  async function stop() {
    // SIGKILL, as the other suites do: sqlite3's teardown can crash on Windows.
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    await new Promise(r => (child.exitCode !== null ? r() : child.once('exit', r)));
  }

  const tail = (n = 40) => logs.join('').split('\n').slice(-n).join('\n');
  return { base, port, child, request, alive, stop, tail };
}

// A member account plus a live session, written straight into the database the
// way the other suites do: the auth routes are not what these suites are about,
// and the login limiter allows only 20 attempts per window.
async function member(db, username, role = 'member') {
  const { lastID: id } = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    [username, 'unused', role, crypto.randomBytes(16).toString('hex')]
  );
  return { id, username, headers: await sessionHeaders(db, id) };
}

// The admin initDb seeds (DEFAULT_ADMIN_PASSWORD), once the server has created it.
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
  await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`, [token, userId, expiresAt]);
  return { Authorization: `Bearer ${token}` };
}

async function cleanup(db, tmp) {
  try { await new Promise(r => db.dbConnection.close(() => r())); } catch { /* already closed */ }
  try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* Windows can hold it a moment */ }
}

module.exports = { tempDatabase, startServer, member, admin, sessionHeaders, cleanup };
