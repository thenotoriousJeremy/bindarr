// Set here as well as in run.js: a suite run on its own boots a server on a fresh
// database, which would otherwise run a full TCGCSV sync (~800 requests) at boot.
process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';
process.env.BINDARR_DISABLE_FX_SYNC = '1';

const assert = require('assert');
const harness = require('./harness');

// Card art end to end: admin-only writes (authz.test.js covers the 403s too; this
// adds the full upload → public read → delete round trip), and an unreadable
// upload answering with a client-safe { error } rather than the decoder's message.
//
// The DB sits in its own temp directory because uploaded art is stored beside it
// (cardArt.USER_DIR = dirname(DB_PATH)/card-art).
const tmp = harness.tempDatabase('cardart');
const db = require('../../src/db');
const CARD_ID = 'mtg-cardart-e2e-0001';
// 1x1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function insertCard() {
  return db.run(`INSERT OR REPLACE INTO card_cache (id, name, game) VALUES (?, ?, 'mtg')`, [CARD_ID, 'Card Art Test']);
}

async function runTests() {
  // The card goes into the file before the server opens it.
  await harness.prepare(db);
  await insertCard();
  const server = await harness.startServer(tmp, { env: { ALLOW_REGISTRATION: 'true' } });
  const base = server.base;
  const json = { 'Content-Type': 'application/json' };

  try {
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
    await server.stop();
    await harness.cleanup(db, tmp);
  }
}

runTests()
  .then(() => process.exit(0))
  .catch(err => { console.error('FAIL: cardart.test.js -', err.message); process.exit(1); });
