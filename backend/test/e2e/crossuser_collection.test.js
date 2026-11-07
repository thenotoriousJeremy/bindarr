const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');
const { spawn } = require('child_process');

// F9: one user's collection requests cannot reach another user's containers or
// copies. Compartment, location, deck and entry ids are global, so an id that
// exists is not an id that is yours. PUT /api/collection/:id used to take
// compartment_id on trust: any user could file their cards into another user's
// binder. Two real users, a real server, real HTTP.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `bindarr-crossuser-test-${process.pid}-`));
const tmpDb = path.join(tmpDir, 'bindarr.db');
process.env.DB_PATH = tmpDb;
const port = '3016';
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

async function addCopy(userId, cardId, binder, position) {
  return (await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, location_id, compartment_id, position, game) VALUES (?, ?, 1, ?, ?, ?, 'mtg')`,
    [cardId, userId, binder ? binder.locId : null, binder ? binder.compId : null, position || 0]
  )).lastID;
}

const rowOf = (id) => db.get(`SELECT id, user_id, location_id, compartment_id, position, condition FROM collection WHERE id = ?`, [id]);

async function step(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name} -`, err.message);
    throw err;
  }
}

async function runTests() {
  const serverScript = path.join(projectRoot, 'backend/src/server.js');
  const server = spawn('node', [serverScript], {
    env: { ...process.env, PORT: port, DB_PATH: tmpDb }
  });

  try {
    await waitForServer();
    const aliceId = await createMember('alice');
    const bobId = await createMember('bob');
    const bob = await sessionHeaders(bobId);
    await db.run(`INSERT INTO card_cache (id, name, game, language, price_trend) VALUES ('mtg-xu-1', 'Shared Card', 'mtg', 'English', 1)`);

    const aliceBinder = await createBinder(aliceId, 'Alice Binder');
    const aliceCopy = await addCopy(aliceId, 'mtg-xu-1', aliceBinder, 1000);
    const aliceDeck = (await db.run(`INSERT INTO decks (user_id, name, game) VALUES (?, 'Alice Deck', 'mtg')`, [aliceId])).lastID;
    const bobBinder = await createBinder(bobId, 'Bob Binder');
    const bobBox = await createBinder(bobId, 'Bob Second Binder');
    const bobCopy = await addCopy(bobId, 'mtg-xu-1', bobBinder, 1000);
    const bobLoose = await addCopy(bobId, 'mtg-xu-1', null);
    const aliceBefore = await rowOf(aliceCopy);
    const put = (id, body) => fetch(`${base}/api/collection/${id}`, { method: 'PUT', headers: bob, body: JSON.stringify(body) });
    const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: bob, body: JSON.stringify(body) });

    // F9-TC1: filing your own card into someone else's compartment is refused,
    // and neither card moves.
    await step('F9-TC1', async () => {
      const before = await rowOf(bobCopy);
      const res = await put(bobCopy, { compartment_id: aliceBinder.compId });
      assert.strictEqual(res.status, 404);
      assert.deepStrictEqual(await rowOf(bobCopy), before);
      const inAlices = await db.all(`SELECT id FROM collection WHERE compartment_id = ?`, [aliceBinder.compId]);
      assert.deepStrictEqual(inAlices.map(r => r.id), [aliceCopy], "nothing of Bob's landed in Alice's binder");
    });

    // F9-TC2: so is moving your own card to someone else's container, which used
    // to answer 200 and drop the card into Unsorted.
    await step('F9-TC2', async () => {
      const filedBefore = await rowOf(bobCopy);
      let res = await put(bobCopy, { location_id: aliceBinder.locId, condition: 'Damaged' });
      assert.strictEqual(res.status, 404);
      assert.deepStrictEqual(await rowOf(bobCopy), filedBefore, 'not unsorted, not edited');
      res = await put(bobLoose, { location_id: aliceBinder.locId });
      assert.strictEqual(res.status, 404);
      assert.strictEqual((await rowOf(bobLoose)).location_id, null);
    });

    // F9-TC3: another user's copy cannot be edited, placed or deleted at all.
    await step('F9-TC3', async () => {
      let res = await put(aliceCopy, { condition: 'Damaged', compartment_id: bobBinder.compId });
      assert.strictEqual(res.status, 404);
      res = await post(`/api/collection/${aliceCopy}/place`, { compartment_id: bobBinder.compId, slot: 2 });
      assert.strictEqual(res.status, 404);
      res = await fetch(`${base}/api/collection/${aliceCopy}`, { method: 'DELETE', headers: bob });
      assert.strictEqual(res.status, 404);
      assert.deepStrictEqual(await rowOf(aliceCopy), aliceBefore);
    });

    // F9-TC4: the other routes that take a container, deck or entry id from the
    // body check it against the caller too.
    await step('F9-TC4', async () => {
      let res = await post('/api/collection', { card_id: 'mtg-xu-1', location_id: aliceBinder.locId, game: 'mtg' });
      assert.strictEqual(res.status, 400, 'add into a foreign container');
      res = await post(`/api/collection/${bobLoose}/place`, { compartment_id: aliceBinder.compId, slot: 3 });
      assert.strictEqual(res.status, 400, 'place into a foreign compartment');
      res = await post('/api/collection/bulk', { entry_ids: [bobLoose], action: 'move', value: aliceBinder.locId });
      assert.strictEqual(res.status, 400, 'bulk move into a foreign container');
      res = await post('/api/collection/bulk', { entry_ids: [bobLoose], action: 'add_to_deck', value: aliceDeck });
      assert.strictEqual(res.status, 404, "add to someone else's deck");
      res = await post('/api/collection/bulk', { entry_ids: [aliceCopy], action: 'delete' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual((await res.json()).affected, 0, "a bulk delete of someone else's copy touches nothing");
      res = await post(`/api/locations/${aliceBinder.locId}/apply-all`, { entry_ids: [bobLoose] });
      assert.strictEqual(res.status, 404, 'file into a foreign container');
      assert.deepStrictEqual(await rowOf(aliceCopy), aliceBefore);
      assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection WHERE compartment_id = ?`, [aliceBinder.compId])).n, 1);
    });

    // F9-TC5: your own compartment still works, and the copy's container follows
    // the compartment instead of staying on the binder it left.
    await step('F9-TC5', async () => {
      const res = await put(bobCopy, { compartment_id: bobBox.compId });
      assert.strictEqual(res.status, 200, await res.text());
      const row = await rowOf(bobCopy);
      assert.strictEqual(row.compartment_id, bobBox.compId);
      assert.strictEqual(row.location_id, bobBox.locId);
    });

    // F9-TC6: a quantity edit on a stacked tile works on the rows the tile names,
    // and naming someone else's copies there reaches none of them.
    await step('F9-TC6', async () => {
      let res = await put(bobCopy, { quantity: 1, stack_entry_ids: [bobCopy, bobLoose, aliceCopy] });
      assert.strictEqual(res.status, 200, await res.text());
      assert.deepStrictEqual(await rowOf(aliceCopy), aliceBefore, "Alice's copy was not trimmed from Bob's tile");
      assert.strictEqual(await rowOf(bobLoose), undefined, "Bob's own tile shrank to the one copy");
      res = await put(bobCopy, { quantity: 3, stack_entry_ids: [bobCopy, aliceCopy] });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.stack_entry_ids.length, 3);
      assert.ok(!body.stack_entry_ids.includes(aliceCopy));
      assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection WHERE user_id = ?`, [aliceId])).n, 1);
    });
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
