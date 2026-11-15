// Claiming a fresh install takes the setup code from the server log (SEC-06).
//
// Until the owner account exists, POST /api/auth/bootstrap creates it for whoever
// asks first, and a first SSO sign-in does the same. A server exposed before its
// owner opens it could be taken by a scanner. Now both need the one-time setup
// code the server prints at boot, except straight from the server's own machine:
// loopback, with no proxy header saying the request is really someone else's.
//
// Also: /api/auth/config reports the server's version, so the phone app can tell
// it is talking to an older server (MOB-14).
//
// The real auth router in this process, over a throwaway database. A request
// "from elsewhere" is a loopback request carrying X-Forwarded-For, which is how a
// reverse proxy on the same machine presents one. Plain node + assert.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-setupcode-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;
const SETUP_CODE = 'abcd-EFGH-2345';
process.env.SETUP_CODE = SETUP_CODE;

const express = require('express');
const db = require('../src/db');

const servers = [];
async function cleanup() {
  for (const s of servers) {
    if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
    if (s.listening) await new Promise(resolve => s.close(resolve));
  }
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

const listen = (handler) => new Promise(resolve => {
  const server = http.createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});

const ELSEWHERE = { 'X-Forwarded-For': '203.0.113.9' };

async function main() {
  await db.initDb();
  const auth = require('../src/routes/auth');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', auth);
  const base = await listen(app);

  const call = async (method, p, { body, headers = {} } = {}) => {
    const res = await fetch(base + p, {
      method,
      redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, headers: res.headers };
  };
  const users = async () => (await db.get(`SELECT COUNT(*) AS n FROM users`)).n;

  // --- isDirectLoopback, on its own --------------------------------------------
  const fakeReq = (remoteAddress, headers = {}, trust = false) => ({
    socket: { remoteAddress }, headers, app: { get: (k) => (k === 'trust proxy' ? trust : undefined) },
  });
  for (const addr of ['127.0.0.1', '127.0.0.5', '::1', '::ffff:127.0.0.1']) {
    assert.strictEqual(auth.isDirectLoopback(fakeReq(addr)), true, `${addr} is this machine`);
  }
  for (const addr of ['10.0.0.5', '192.168.1.20', '172.17.0.1', '::ffff:10.0.0.1', '2001:db8::1', undefined]) {
    assert.strictEqual(auth.isDirectLoopback(fakeReq(addr)), false, `${addr} is not`);
  }
  for (const header of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto']) {
    assert.strictEqual(auth.isDirectLoopback(fakeReq('127.0.0.1', { [header]: 'x' })), false, `a ${header} header means a proxy`);
  }
  assert.strictEqual(auth.isDirectLoopback(fakeReq('127.0.0.1', {}, 1)), false, 'behind TRUST_PROXY, loopback is the proxy');
  assert.strictEqual(auth.isDirectLoopback({ headers: {} }), false, 'no socket (device mode) is never the exemption');
  console.log('PASS: only a direct loopback connection skips the setup code');

  // --- /config says when the code is needed, and the version ---------------------
  const version = require('../package.json').version;
  let cfg = await call('GET', '/api/auth/config');
  assert.strictEqual(cfg.json.setupRequired, true);
  assert.strictEqual(cfg.json.setupCodeRequired, false, 'not from this machine');
  assert.strictEqual(cfg.json.version, version, 'the server says which version it runs');
  cfg = await call('GET', '/api/auth/config', { headers: ELSEWHERE });
  assert.strictEqual(cfg.json.setupCodeRequired, true, 'from elsewhere, the setup screen asks for the code');
  console.log('PASS: /config reports setupCodeRequired and the server version');

  // --- The code is printed at boot, while there is no account ---------------------
  const logged = [];
  const realLog = console.log;
  console.log = (...args) => { logged.push(args.join(' ')); };
  try {
    await auth.announceSetupCode();
  } finally {
    console.log = realLog;
  }
  assert.ok(logged.some(l => /SETUP_CODE/.test(l)), 'a preset code is announced without being printed');
  assert.ok(!logged.join('\n').includes(SETUP_CODE), 'the operator already knows a preset code');

  // --- Bootstrap from elsewhere needs the code -------------------------------------
  const body = { password: 'owner-password-1' };
  let r = await call('POST', '/api/auth/bootstrap', { body, headers: ELSEWHERE });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.code, 'setup_code_required');
  r = await call('POST', '/api/auth/bootstrap', { body: { ...body, setup_code: 'WXYZ-WXYZ-WXYZ' }, headers: ELSEWHERE });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.code, 'setup_code_invalid', 'a wrong code is refused');
  r = await call('POST', '/api/auth/bootstrap', { body: { ...body, setup_code: 12345 }, headers: ELSEWHERE });
  assert.strictEqual(r.status, 403, 'a code of the wrong type is just a wrong code');
  assert.strictEqual(await users(), 0, 'nothing was created by the refused attempts');

  // Case, spaces and dashes do not matter: it is typed off a log line.
  r = await call('POST', '/api/auth/bootstrap', { body: { ...body, setup_code: ' ABCD efgh 2345 ' }, headers: ELSEWHERE });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.ok(r.json.token, 'the owner is signed in');
  const owner = await db.get(`SELECT id, username, role FROM users`);
  assert.deepStrictEqual({ username: owner.username, role: owner.role }, { username: 'admin', role: 'admin' });
  r = await call('POST', '/api/auth/bootstrap', { body: { ...body, setup_code: SETUP_CODE }, headers: ELSEWHERE });
  assert.strictEqual(r.status, 409, 'and once there is an owner, the code opens nothing');
  console.log('PASS: bootstrap from elsewhere takes the setup code, and only the right one');

  // --- Straight from this machine, no code ------------------------------------------
  await db.run(`DELETE FROM sessions`);
  await db.run(`DELETE FROM locations`);
  await db.run(`DELETE FROM users`);
  r = await call('POST', '/api/auth/bootstrap', { body });
  assert.strictEqual(r.status, 201, `loopback is exempt: ${JSON.stringify(r.json)}`);
  console.log('PASS: a browser on the server itself needs no code');

  // Nothing is announced once an account exists.
  logged.length = 0;
  console.log = (...args) => { logged.push(args.join(' ')); };
  try {
    await auth.announceSetupCode();
  } finally {
    console.log = realLog;
  }
  assert.deepStrictEqual(logged, [], 'no setup code is printed for an install that has an owner');

  // A generated code (no SETUP_CODE) is printed, in the shape the setup screen takes.
  await db.run(`DELETE FROM sessions`);
  await db.run(`DELETE FROM locations`);
  await db.run(`DELETE FROM users`);
  delete process.env.SETUP_CODE;
  delete require.cache[require.resolve('../src/routes/auth')];
  const fresh = require('../src/routes/auth');
  logged.length = 0;
  console.log = (...args) => { logged.push(args.join(' ')); };
  try {
    await fresh.announceSetupCode();
  } finally {
    console.log = realLog;
  }
  const printed = (logged.join('\n').match(/Setup code: ([2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4})/) || [])[1];
  assert.ok(printed, `a generated code is printed: ${logged.join(' | ')}`);
  const app2 = express();
  app2.use(express.json());
  app2.use('/api/auth', fresh);
  const base2 = await listen(app2);
  const post2 = (b) => fetch(`${base2}/api/auth/bootstrap`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ELSEWHERE }, body: JSON.stringify(b),
  });
  assert.strictEqual((await post2({ ...body, setup_code: SETUP_CODE })).status, 403, 'the old preset no longer works');
  assert.strictEqual((await post2({ ...body, setup_code: printed.toLowerCase() })).status, 201, 'the printed code does');
  console.log('PASS: a generated setup code is printed at boot and accepted');

  console.log('PASS: setupcode.test.js');
}

main()
  .catch(err => {
    console.error('FAIL:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
