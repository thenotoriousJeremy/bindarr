// Tap-to-place into a box in Custom order (POST /collection/:id/place).
//
// The handler writes the card at slot * 1000 - 500, between the card already in
// that slot and the one before it, then renumbers the box. That renumber used to
// be called with the user id as the sort order and an object as the foil
// setting. It only came out right because sortCards treats a number like "no
// criteria" and keeps position order. This pins the behaviour: the card lands
// in the slot it was dropped on and a later rebalance does not move it. The
// source box is renumbered too, closing the gap the card left.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-placecustom-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');
const { rebalanceCompartmentByScheme } = require('../src/utils/compartmentSort');

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
    ['place-test', db.hashPassword('x'), 'admin', `share-${process.pid}`]
  );
  const userId = user.lastID;
  const base = await startApp(userId);

  // Names chosen so that any real sort (by name) would reorder them: the custom
  // order Zubat, Abra, Mew must survive untouched.
  const names = { zubat: 'Zubat', abra: 'Abra', mew: 'Mew', onix: 'Onix', bulba: 'Bulbasaur', eevee: 'Eevee' };
  for (const [id, name] of Object.entries(names)) {
    await db.run(
      `INSERT OR REPLACE INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend, game)
       VALUES (?, ?, 'Pokémon', '[]', '[]', 'Common', 's1', 'Set One', '1', '', 1, 'pokemon')`,
      [id, name]
    );
  }

  const makeBox = async (name) => {
    const loc = await db.run(
      `INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, game, user_id)
       VALUES (?, 'Box', 'custom', 'foils_first', 'any', 'any', ?)`,
      [name, userId]
    );
    const row = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 40)`, [loc.lastID]);
    return { locId: loc.lastID, compId: row.lastID };
  };
  const target = await makeBox('Target Box');
  const source = await makeBox('Source Box');

  const addCard = async (cardId, box, position) => (await db.run(
    `INSERT INTO collection (card_id, quantity, condition, printing, language, location_id, compartment_id, position, user_id)
     VALUES (?, 1, 'Near Mint', 'Normal', 'English', ?, ?, ?, ?)`,
    [cardId, box.locId, box.compId, position, userId]
  )).lastID;

  const zubat = await addCard('zubat', target, 1000);
  const abra = await addCard('abra', target, 2000);
  const mew = await addCard('mew', target, 3000);

  const bulba = await addCard('bulba', source, 1000);
  const onix = await addCard('onix', source, 2000);
  const eevee = await addCard('eevee', source, 3000);

  const order = async (box) => (await db.all(
    `SELECT id, position FROM collection WHERE compartment_id = ? ORDER BY position, id`, [box.compId]
  )).map(r => [r.id, r.position]);

  // Drop Onix on slot 2 of the target box: between Zubat and Abra.
  const res = await fetch(`${base}/api/collection/${onix}/place`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ compartment_id: target.compId, slot: 2 }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200, `place must succeed, got ${res.status}: ${JSON.stringify(body)}`);
  assert.strictEqual(body.message, 'Card placed');

  const expectedTarget = [[zubat, 1000], [onix, 2000], [abra, 3000], [mew, 4000]];
  assert.deepStrictEqual(await order(target), expectedTarget,
    'the placed card must sit in slot 2, with the box renumbered around it in custom order');

  // The source box closes the gap Onix left, keeping its own custom order.
  const expectedSource = [[bulba, 1000], [eevee, 2000]];
  assert.deepStrictEqual(await order(source), expectedSource, 'the source box must be renumbered without its card');

  // A later rebalance with the location's own scheme must not move anything.
  await rebalanceCompartmentByScheme(db, target.compId, 'custom', 'foils_first');
  assert.deepStrictEqual(await order(target), expectedTarget, 'a later rebalance must leave the placement where it is');

  console.log('placecustom: all assertions passed');
}

main()
  .then(cleanup)
  .catch(async (err) => {
    console.error(err);
    await cleanup();
    process.exit(1);
  });
