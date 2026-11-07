const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');
const { spawn } = require('child_process');

// Own temp directory rather than a bare file in os.tmpdir(): uploaded card art is
// written to a `card-art` folder beside the database, and that must not land in
// (or read from) the shared temp root.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `bindarr-authz-test-${process.pid}-`));
const tmpDb = path.join(tmpDir, 'bindarr.db');
process.env.DB_PATH = tmpDb;
const port = '3013';
const base = `http://localhost:${port}`;

const projectRoot = path.join(__dirname, '../../../');
const db = require('../../src/db');

async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch (e) {
      // retry
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server on port ${port} did not start in time`);
}

async function waitForAdmin() {
  for (let i = 0; i < 150; i++) {
    try {
      const admin = await db.get(`SELECT id FROM users WHERE username = ?`, ['admin']);
      if (admin) return admin.id;
    } catch (e) {
      // retry
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Database did not initialize in time');
}

async function createMember(username) {
  const { lastID } = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, 'member', ?)`,
    [username, 'unused', crypto.randomBytes(16).toString('hex')]
  );
  return lastID;
}

async function sessionHeaders(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`, [token, userId, expiresAt.toISOString()]);
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

async function createBinder(userId, name) {
  const locId = (await db.run(`INSERT INTO locations (name, type, user_id) VALUES (?, 'Binder', ?)`, [name, userId])).lastID;
  const compId = (await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 9)`, [locId])).lastID;
  return { locId, compId };
}

const filtersOf = async (compId) =>
  (await db.all(`SELECT filter_value FROM compartment_assignments WHERE compartment_id = ? ORDER BY filter_value`, [compId]))
    .map(r => r.filter_value);

async function runTests() {
  const serverScript = path.join(projectRoot, 'backend/src/server.js');
  const server = spawn('node', [serverScript], {
    env: { ...process.env, PORT: port, DB_PATH: tmpDb }
  });

  try {
    await waitForServer();
    const adminId = await waitForAdmin();
    const aliceId = await createMember('alice');
    const bobId = await createMember('bob');
    const adminHeaders = await sessionHeaders(adminId);
    const aliceHeaders = await sessionHeaders(aliceId);
    const bobHeaders = await sessionHeaders(bobId);

    const alice = await createBinder(aliceId, 'Alice Binder');
    const bob = await createBinder(bobId, 'Bob Binder');
    await db.run(`INSERT INTO compartment_assignments (compartment_id, filter_value) VALUES (?, ?)`, [alice.compId, 'alice-filter']);

    // F8-TC1: pairing your own location with another user's compartment id must
    // not rewrite that compartment's assignments (nor touch its row).
    try {
      const res = await fetch(`${base}/api/locations/${bob.locId}/compartments/${alice.compId}`, {
        method: 'PUT',
        headers: bobHeaders,
        body: JSON.stringify({ label: 'pwned', assignedFilters: ['bob-filter'] })
      });
      assert.strictEqual(res.status, 404);
      assert.deepStrictEqual(await filtersOf(alice.compId), ['alice-filter']);
      const row = await db.get(`SELECT label FROM compartments WHERE id = ?`, [alice.compId]);
      assert.strictEqual(row.label, null);
      console.log('PASS: F8-TC1');
    } catch (err) {
      console.error('FAIL: F8-TC1 -', err.message);
      throw err;
    }

    // F8-TC2: another user's location (and an unknown compartment id) both 404
    // and write nothing.
    try {
      const foreignLoc = await fetch(`${base}/api/locations/${alice.locId}/compartments/${alice.compId}`, {
        method: 'PUT',
        headers: bobHeaders,
        body: JSON.stringify({ assignedFilters: ['bob-filter'] })
      });
      assert.strictEqual(foreignLoc.status, 404);

      const unknownComp = await fetch(`${base}/api/locations/${bob.locId}/compartments/999999`, {
        method: 'PUT',
        headers: bobHeaders,
        body: JSON.stringify({ assignedFilters: ['bob-filter'] })
      });
      assert.strictEqual(unknownComp.status, 404);
      assert.deepStrictEqual(await filtersOf(999999), []);

      const flat = await fetch(`${base}/api/compartments/${alice.compId}/filters`, {
        method: 'PUT',
        headers: bobHeaders,
        body: JSON.stringify({ filters: ['bob-filter'] })
      });
      assert.strictEqual(flat.status, 404);
      assert.deepStrictEqual(await filtersOf(alice.compId), ['alice-filter']);
      console.log('PASS: F8-TC2');
    } catch (err) {
      console.error('FAIL: F8-TC2 -', err.message);
      throw err;
    }

    // F8-TC3: the owner can still rewrite their own compartment.
    try {
      const res = await fetch(`${base}/api/locations/${alice.locId}/compartments/${alice.compId}`, {
        method: 'PUT',
        headers: aliceHeaders,
        body: JSON.stringify({ label: 'Page 1', assignedFilters: ['set-a', 'set-b'] })
      });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(await filtersOf(alice.compId), ['set-a', 'set-b']);
      const row = await db.get(`SELECT label FROM compartments WHERE id = ?`, [alice.compId]);
      assert.strictEqual(row.label, 'Page 1');
      console.log('PASS: F8-TC3');
    } catch (err) {
      console.error('FAIL: F8-TC3 -', err.message);
      throw err;
    }

    const cardId = 'authz-test-card';
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES (?, ?, ?)`, [cardId, 'Authz Test Card', 'pokemon']);
    const sharp = require('sharp');
    const png = await sharp({ create: { width: 4, height: 6, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
    const image = `data:image/png;base64,${png.toString('base64')}`;
    const artFile = path.join(tmpDir, 'card-art', `${cardId}.png`);

    // F8-TC4: a member cannot upload or delete card art.
    try {
      const post = await fetch(`${base}/api/card-art/${cardId}`, {
        method: 'POST', headers: aliceHeaders, body: JSON.stringify({ image })
      });
      assert.strictEqual(post.status, 403);
      assert.ok(!fs.existsSync(artFile), 'member upload must not write a file');
      console.log('PASS: F8-TC4');
    } catch (err) {
      console.error('FAIL: F8-TC4 -', err.message);
      throw err;
    }

    // F8-TC5: an admin can upload; the art stays publicly readable with no session.
    try {
      const post = await fetch(`${base}/api/card-art/${cardId}`, {
        method: 'POST', headers: adminHeaders, body: JSON.stringify({ image })
      });
      assert.strictEqual(post.status, 200);
      assert.ok(fs.existsSync(artFile));

      const pub = await fetch(`${base}/api/card-art/${cardId}.png`);
      assert.strictEqual(pub.status, 200);
      const index = await (await fetch(`${base}/api/card-art/index`)).json();
      assert.ok(index.ids.includes(cardId));
      console.log('PASS: F8-TC5');
    } catch (err) {
      console.error('FAIL: F8-TC5 -', err.message);
      throw err;
    }

    // F8-TC6: a member cannot delete art; an admin can.
    try {
      const memberDel = await fetch(`${base}/api/card-art/${cardId}`, { method: 'DELETE', headers: bobHeaders });
      assert.strictEqual(memberDel.status, 403);
      assert.ok(fs.existsSync(artFile), 'member delete must not remove the file');

      const adminDel = await fetch(`${base}/api/card-art/${cardId}`, { method: 'DELETE', headers: adminHeaders });
      assert.strictEqual(adminDel.status, 200);
      assert.ok(!fs.existsSync(artFile));
      console.log('PASS: F8-TC6');
    } catch (err) {
      console.error('FAIL: F8-TC6 -', err.message);
      throw err;
    }
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    try {
      await new Promise(resolve => {
        db.dbConnection.close(() => resolve());
      });
    } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

runTests()
  .then(() => {
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
