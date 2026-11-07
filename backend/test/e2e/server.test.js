const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');

// Boots the real Express app against a throwaway DB and exercises it over HTTP.
// This is the only test that starts server.js end to end, so it catches route
// wiring / middleware / startup breakage the in-process unit tests can't.
const tmpDb = path.join(os.tmpdir(), `bindarr-server-test-${process.pid}.db`);
const projectRoot = path.join(__dirname, '../../../');

async function waitForServer(url) {
  for (let i = 0; i < 150; i++) {
    try { const res = await fetch(url); if (res.ok) return; } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not start in time');
}

async function runTests() {
  const port = '3009';
  const base = `http://localhost:${port}`;
  const server = spawn('node', [path.join(projectRoot, 'backend/src/server.js')], {
    // HTTPS_PORT blanked for the same reason as in scryfall-mock.js, which this
    // one server is not preloaded with: a fixed TLS port cannot be shared.
    env: { ...process.env, PORT: port, DB_PATH: tmpDb, HTTPS_PORT: '', ALLOW_REGISTRATION: 'true' }
  });

  try {
    await waitForServer(`${base}/api/health`);

    // F1-TC1: health endpoint is up and identifies the app
    const res = await fetch(`${base}/api/health`);
    assert.strictEqual(res.status, 200, 'health check should return 200');
    assert.strictEqual(res.headers.get('x-app-name'), 'Bindarr', 'health header x-app-name must be Bindarr');
    console.log('PASS: F1-TC1');

    // F1-TC2: a protected route rejects unauthenticated requests
    const noAuth = await fetch(`${base}/api/collection`);
    assert.ok(noAuth.status === 401 || noAuth.status === 403, `collection must require auth, got ${noAuth.status}`);
    console.log('PASS: F1-TC2');

    const post = (url, body, headers = {}) => fetch(`${base}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

    // F1-TC3: a non-string username is a bad request, not a process crash.
    // `username.trim()` used to throw outside the handler's try, and the
    // rejection took the server down for everyone.
    for (const [url, body] of [
      ['/api/auth/login', { username: 1, password: 'whatever1' }],
      ['/api/auth/login', { username: 'admin', password: { $gt: '' } }],
      ['/api/auth/register', { username: ['a', 'b', 'c'], password: 'password123' }],
      ['/api/auth/bootstrap', { password: 12345678 }],
    ]) {
      const bad = await post(url, body);
      assert.strictEqual(bad.status, 400, `${url} ${JSON.stringify(body)} should be 400, got ${bad.status}`);
      assert.ok((await bad.json()).error, 'a 400 carries an error message');
    }
    const stillUp = await fetch(`${base}/api/health`);
    assert.strictEqual(stillUp.status, 200, 'server must survive malformed credentials');
    assert.strictEqual(server.exitCode, null, 'server process must still be running');
    console.log('PASS: F1-TC3');

    // F1-TC4: public routes keep the small body limit, and the 15 MB import
    // limit is not available before auth — an anonymous 2 MB body is refused
    // without being buffered, on a public route and on the import path alike.
    const twoMb = JSON.stringify({ username: 'x'.repeat(2 * 1024 * 1024), password: 'y' });
    const bigLogin = await post('/api/auth/login', twoMb);
    assert.strictEqual(bigLogin.status, 413, `2 MB login body should be 413, got ${bigLogin.status}`);
    const anonImport = await post('/api/import', { format: 'json', data: 'x'.repeat(2 * 1024 * 1024) });
    assert.strictEqual(anonImport.status, 401, `anonymous import should be 401 before parsing, got ${anonImport.status}`);
    console.log('PASS: F1-TC4');

    // F1-TC5: once signed in, the import path does take a big body, and the row
    // cap answers with a client-safe 413 before any provider lookup.
    const login = await post('/api/auth/login', { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD });
    assert.strictEqual(login.status, 200, `admin login should succeed, got ${login.status}`);
    const auth = { Authorization: `Bearer ${(await login.json()).token}` };
    const rows = Array.from({ length: 5001 }, (_, i) => ({ card_id: `x-${i}`, name: 'Filler card name '.repeat(16), game: 'pokemon' }));
    const capped = await post('/api/import', { format: 'json', data: rows }, auth);
    assert.strictEqual(capped.status, 413, `5001-row import should be 413, got ${capped.status}`);
    assert.match((await capped.json()).error, /at most 5000/, 'cap error names the limit');
    const containerText = Array.from({ length: 5001 }, (_, i) => `1 Card ${i} (abc) ${i + 1}`).join('\n');
    const cappedBox = await post('/api/import-container', { name: 'Box', data: containerText }, auth);
    assert.strictEqual(cappedBox.status, 413, `5001-row container import should be 413, got ${cappedBox.status}`);
    assert.ok(capped.headers.get('ratelimit-limit') || capped.headers.get('ratelimit-policy'), 'import is rate limited');
    console.log('PASS: F1-TC5');
  } finally {
    // SIGKILL immediately to avoid sqlite3 teardown crashes on Windows
    server.kill('SIGKILL');
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
    }
  }
}

runTests()
  .then(() => setTimeout(() => process.exit(0), 500))
  .catch(err => { console.error('FAIL: server.test.js -', err.message); setTimeout(() => process.exit(1), 500); });
