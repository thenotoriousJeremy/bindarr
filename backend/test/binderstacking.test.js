// Stacking containers: duplicate copies share one slot instead of claiming one
// each (locations.allow_stacking).
//
// Three behaviours, and the first two are the ones that make the feature real
// rather than cosmetic: occupancy has to count slots rather than cards, or a
// nine-pocket page reports itself full at nine copies of one card; and auto-filing
// has to send a duplicate to its twin's slot, or the copies never land together in
// the first place. The third is the manual drop: dropping a copy onto its own twin
// used to trade the two rows, which is a no-op nobody can see.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-binderstacking-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');
const { loadCompartments, recommendSlot } = require('../src/utils/compartmentSort');

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

async function main() {
  await db.initDb();

  const user = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    ['stacking-test', db.hashPassword('x'), 'admin', `share-${process.pid}`]
  );
  const userId = user.lastID;
  const base = await startApp(userId);

  // A three-pocket page, so "full" is reachable inside one test.
  const loc = await db.run(
    `INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, game, allow_stacking, user_id)
     VALUES (?, 'Binder', 'custom', 'normals_first', 'any', 'any', 1, ?)`,
    ['Stacking Binder', userId]
  );
  const locId = loc.lastID;
  const page = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 3)`, [locId]);
  const pageId = page.lastID;

  for (const id of ['pika', 'charm']) {
    await db.run(
      `INSERT OR REPLACE INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend, game)
       VALUES (?, ?, 'Pokémon', '[]', '[]', 'Common', 's1', 'Set One', '1', '', 1, 'pokemon')`,
      [id, id === 'pika' ? 'Pikachu' : 'Charmander']
    );
  }

  const addCopy = async (cardId, compartmentId, position) => (await db.run(
    `INSERT INTO collection (card_id, quantity, condition, printing, language, location_id, compartment_id, position, user_id)
     VALUES (?, 1, 'Near Mint', 'Normal', 'English', ?, ?, ?, ?)`,
    [cardId, locId, compartmentId, position, userId]
  )).lastID;

  // Four Pikachus in one pocket, and the page still has two free pockets.
  await addCopy('pika', pageId, 1000);
  await addCopy('pika', pageId, 1000);
  await addCopy('pika', pageId, 1000);
  await addCopy('pika', pageId, 1000);

  const comps = await loadCompartments(db, locId, userId);
  assert.strictEqual(comps[0].count, 1, `four copies in one pocket must count as one slot, got ${comps[0].count}`);
  assert.strictEqual(comps[0].free, 2, `a three-pocket page with one slot used has two free, got ${comps[0].free}`);
  console.log('PASS: occupancy counts slots used, not cards held');

  // Auto-filing a fifth Pikachu joins the pocket the others are in.
  const location = await db.get(`SELECT * FROM locations WHERE id = ?`, [locId]);
  const stacked = await recommendSlot(db, location, {
    card_id: 'pika', name: 'Pikachu', printing: 'Normal', language: 'English', types: [], supertype: 'Pokémon'
  });
  assert.strictEqual(stacked.compartment_id, pageId, 'a duplicate must be filed on the page its twin is on');
  assert.strictEqual(stacked.position, 1000, `a duplicate must take its twin's slot, got ${stacked.position}`);
  assert.strictEqual(stacked.stacked, true, 'a stacked recommendation must say so, so batch filing does not charge it a slot');

  // A different card is not a duplicate: it gets a slot of its own.
  const fresh = await recommendSlot(db, location, {
    card_id: 'charm', name: 'Charmander', printing: 'Normal', language: 'English', types: [], supertype: 'Pokémon'
  });
  assert.notStrictEqual(fresh.position, 1000, 'a different card must not be stacked onto the Pikachu pocket');
  assert.ok(!fresh.stacked, 'a card with no twin here is not a stacked placement');
  console.log('PASS: auto-filing sends a duplicate to its twin\'s slot and nothing else');

  // Manual drop of a copy onto its own twin: stacks rather than swapping.
  const loose = await addCopy('pika', null, 0);
  const twin = await db.get(`SELECT id FROM collection WHERE compartment_id = ? AND card_id = 'pika' LIMIT 1`, [pageId]);
  const res = await fetch(`${base}/api/collection/${loose}/place`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ compartment_id: pageId, slot: 1, swap_with: twin.id }),
  });
  assert.strictEqual(res.status, 200, `dropping onto a twin must succeed, got ${res.status}`);
  const placed = await db.get(`SELECT compartment_id, position FROM collection WHERE id = ?`, [loose]);
  assert.strictEqual(placed.compartment_id, pageId, 'the dropped copy must land on the page');
  assert.strictEqual(placed.position, 1000, `the dropped copy must share the twin's slot, got ${placed.position}`);
  const twinAfter = await db.get(`SELECT compartment_id, position FROM collection WHERE id = ?`, [twin.id]);
  assert.strictEqual(twinAfter.compartment_id, pageId, 'the twin must not be pushed out of the binder by the drop');
  assert.strictEqual(twinAfter.position, 1000, 'the twin must stay in its own slot');
  console.log('PASS: dropping a copy onto its twin stacks instead of swapping');

  // Same page with stacking off: the four copies are four cards against capacity.
  await db.run(`UPDATE locations SET allow_stacking = 0 WHERE id = ?`, [locId]);
  const plain = await loadCompartments(db, locId, userId);
  assert.strictEqual(plain[0].count, 5, `without stacking every copy counts, got ${plain[0].count}`);
  console.log('PASS: with stacking off, occupancy is the card count again');
}

main()
  .then(() => cleanup())
  .catch(async err => {
    console.error('FAIL:', err.stack || err.message);
    await cleanup();
    process.exitCode = 1;
  });
