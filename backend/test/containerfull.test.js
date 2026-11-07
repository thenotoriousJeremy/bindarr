// Filing a card into a container with no room. resolveCompartmentAndPosition
// returned { full: true } for that until d0ee430 turned it into a bare null, and
// every caller then read .compartment_id off null: adding to a full binder, or
// moving a card into one, was a 500, and the scanner's "container full, left
// Unsorted" message could never appear. The contract is back: an add lands in
// Unsorted and says container_full; a move leaves the card where it was.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-containerfull-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* nothing to remove */ }
}
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;   // no starter containers to overflow into

const express = require('express');
const db = require('../src/db');
const scryfallApi = require('../src/scryfallApi');

let server;

async function cleanup() {
  if (server && server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

function startApp(userId) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId, role: 'admin' }; next(); });
  app.use('/api', require('../src/routes/collection'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function call(base, method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const placementOf = (id) => db.get(`SELECT location_id, compartment_id, position, condition FROM collection WHERE id = ?`, [id]);

async function main() {
  // Every card here is cached English Magic, so an add never needs a provider.
  scryfallApi.client.get = async (url) => { throw new Error(`no network in this test (${url})`); };
  await db.initDb();
  const userId = (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('owner', 'x', 'admin', 'tok')`)).lastID;
  for (const id of ['mtg-a', 'mtg-b', 'mtg-c', 'mtg-d']) {
    await db.run(`INSERT INTO card_cache (id, name, game, language, price_trend) VALUES (?, ?, 'mtg', 'English', 1)`, [id, id]);
  }

  // A one-pocket binder that is already taken.
  const full = (await db.run(`INSERT INTO locations (name, type, user_id) VALUES ('Full Binder', 'Binder', ?)`, [userId])).lastID;
  const fullPage = (await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 1)`, [full])).lastID;
  await db.run(`INSERT INTO collection (card_id, user_id, location_id, compartment_id, position, game) VALUES ('mtg-a', ?, ?, ?, 1000, 'mtg')`, [userId, full, fullPage]);
  // A locked box with room. Locked, so filing cannot overflow into it: with no
  // container anywhere taking new cards, the full binder really is the end.
  const locked = (await db.run(`INSERT INTO locations (name, type, user_id, locked) VALUES ('Locked Box', 'Box', ?, 1)`, [userId])).lastID;
  const lockedRow = (await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 50)`, [locked])).lastID;
  const filed = (await db.run(`INSERT INTO collection (card_id, user_id, location_id, compartment_id, position, game) VALUES ('mtg-b', ?, ?, ?, 3000, 'mtg')`, [userId, locked, lockedRow])).lastID;
  const unsorted = (await db.run(`INSERT INTO collection (card_id, user_id, game) VALUES ('mtg-c', ?, 'mtg')`, [userId])).lastID;

  const base = await startApp(userId);

  // --- adding into a full container: added, Unsorted, and told so ----------------
  let res = await call(base, 'POST', '/api/collection', { card_id: 'mtg-d', location_id: full, game: 'mtg' });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.container_full, true);
  assert.strictEqual(res.body.placement, null);
  assert.deepStrictEqual(
    await db.get(`SELECT location_id, compartment_id FROM collection WHERE id = ?`, [res.body.id]),
    { location_id: null, compartment_id: null }, 'the new copy is in Unsorted'
  );

  res = await call(base, 'POST', '/api/collection/bulk-add', { card_ids: ['mtg-c', 'mtg-d'], location_id: full, game: 'mtg' });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.added, 2, 'a bulk add into a full container adds every card');

  // --- moving into a full container: the card stays where it was ------------------
  const before = await placementOf(filed);
  res = await call(base, 'PUT', `/api/collection/${filed}`, { location_id: full, condition: 'Damaged' });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.container_full, true);
  const after = await placementOf(filed);
  assert.deepStrictEqual(
    { location_id: after.location_id, compartment_id: after.compartment_id, position: after.position },
    { location_id: before.location_id, compartment_id: before.compartment_id, position: before.position },
    'it was not pulled out of its slot'
  );
  assert.strictEqual(after.condition, 'Damaged', 'the rest of the edit still saved');

  res = await call(base, 'PUT', `/api/collection/${unsorted}`, { location_id: full });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.container_full, true);
  assert.strictEqual((await placementOf(unsorted)).location_id, null, 'an unsorted card stays unsorted');

  // --- bulk move: what does not fit stays put, and the message says so ------------
  res = await call(base, 'POST', '/api/collection/bulk', { entry_ids: [filed, unsorted], action: 'move', value: full });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.affected, 0);
  assert.strictEqual(res.body.container_full, true);
  assert.match(res.body.message, /2 did not fit/);
  assert.strictEqual((await placementOf(filed)).compartment_id, lockedRow);

  console.log('containerfull ok');
}

main()
  .then(cleanup, async (err) => { await cleanup(); throw err; })
  .catch(err => { console.error(err); process.exitCode = 1; });
