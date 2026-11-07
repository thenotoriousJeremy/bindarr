const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');

// Card art end to end: admin-only writes (authz.test.js covers the 403s too; this
// adds the full upload → public read → delete round trip), and an unreadable
// upload answering with a client-safe { error } rather than the decoder's message.
//
// The DB sits in its own temp directory because uploaded art is stored beside it
// (cardArt.USER_DIR = dirname(DB_PATH)/card-art).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-cardart-'));
const tmpDb = path.join(tmpDir, 'bindarr.db');
const projectRoot = path.join(__dirname, '../../../');
const CARD_ID = 'mtg-cardart-e2e-0001';
// 1x1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function waitForServer(url) {
  for (let i = 0; i < 150; i++) {
    try { const res = await fetch(url); if (res.ok) return; } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not start in time');
}

function insertCard() {
  const sqlite3 = require(path.join(projectRoot, 'backend/node_modules/sqlite3'));
  return new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(tmpDb);
    conn.run(
      `INSERT OR REPLACE INTO card_cache (id, name, game) VALUES (?, ?, 'mtg')`,
      [CARD_ID, 'Card Art Test'],
      (err) => conn.close(() => (err ? reject(err) : resolve())),
    );
  });
}

async function runTests() {
  const port = '3011';
  const base = `http://localhost:${port}`;
  const server = spawn('node', [path.join(projectRoot, 'backend/src/server.js')], {
    env: { ...process.env, PORT: port, DB_PATH: tmpDb, HTTPS_PORT: '', ALLOW_REGISTRATION: 'true' },
  });
  const json = { 'Content-Type': 'application/json' };

  try {
    await waitForServer(`${base}/api/health`);
    await insertCard();

    const login = async (username, password) => {
      const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ username, password }) });
      assert.strictEqual(r.status, 200, `login ${username}`);
      return { ...json, Authorization: `Bearer ${(await r.json()).token}` };
    };
    const admin = await login('admin', process.env.DEFAULT_ADMIN_PASSWORD || 'test-admin-password');
    const reg = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: json, body: JSON.stringify({ username: 'artmember', password: 'password123' }),
    });
    assert.strictEqual(reg.status, 201, 'member registers');
    const member = await login('artmember', 'password123');
    const upload = (headers) => fetch(`${base}/api/card-art/${CARD_ID}`, { method: 'POST', headers, body: JSON.stringify({ image: PNG }) });
    const remove = (headers) => fetch(`${base}/api/card-art/${CARD_ID}`, { method: 'DELETE', headers });

    // F8-TC1: a member cannot upload art
    assert.strictEqual((await upload(member)).status, 403, 'member upload must be refused');
    console.log('PASS: F8-TC1');

    // F8-TC2: an admin can, and anyone (no session) can read it back
    const up = await upload(admin);
    assert.strictEqual(up.status, 200, `admin upload, got ${up.status}`);
    const read = await fetch(`${base}/api/card-art/${CARD_ID}.png`);
    assert.strictEqual(read.status, 200, 'art is publicly readable');
    console.log('PASS: F8-TC2');

    // F8-TC3: a member cannot delete it, and it survives the attempt
    assert.strictEqual((await remove(member)).status, 403, 'member delete must be refused');
    assert.strictEqual((await fetch(`${base}/api/card-art/${CARD_ID}.png`)).status, 200, 'art still there');
    console.log('PASS: F8-TC3');

    // F8-TC4: an admin can delete it
    assert.strictEqual((await remove(admin)).status, 200, 'admin delete');
    console.log('PASS: F8-TC4');

    // F8-TC5: an unreadable image is refused without echoing the decoder's error
    const bad = await fetch(`${base}/api/card-art/${CARD_ID}`, {
      method: 'POST', headers: admin, body: JSON.stringify({ image: 'data:image/png;base64,bm90IGFuIGltYWdl' }),
    });
    assert.strictEqual(bad.status, 400, `bad image, got ${bad.status}`);
    assert.deepStrictEqual(Object.keys(await bad.json()), ['error'], 'only a client-safe { error }');
    console.log('PASS: F8-TC5');
  } finally {
    // SIGKILL immediately to avoid sqlite3 teardown crashes on Windows
    server.kill('SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 300));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* still locked */ }
  }
}

runTests()
  .then(() => setTimeout(() => process.exit(0), 500))
  .catch(err => { console.error('FAIL: cardart.test.js -', err.message); setTimeout(() => process.exit(1), 500); });
