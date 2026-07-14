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
    env: { ...process.env, PORT: port, DB_PATH: tmpDb }
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
