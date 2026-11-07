// Editing the quantity of a stacked tile. A tile shows several collection rows
// under one number — the collection view stacks by card alone unless told to
// split by condition or printing, and a stacking binder stacks a pocket — and
// the card popup's quantity is that number. The server used to reconcile it
// against a group of its own (same card, condition, printing, language and list,
// anywhere in the collection), which is not the tile: a x5 tile of 3 Near Mint
// + 2 Lightly Played copies, set to 4, was treated as a stack of three NM, grew
// by one, and came out at six. The popup now sends the rows the tile stands
// for, and the server reconciles exactly those.
//
// Which copies go when the number drops: unfiled ones first, then the most
// recently added, and never the copy the popup was opened on. Conditions are
// not ranked; a copy in a binder pocket is the last thing to disappear.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-stacktile-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* nothing to remove */ }
}
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

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

async function put(base, id, body) {
  const res = await fetch(`${base}/api/collection/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  scryfallApi.client.get = async (url) => { throw new Error(`no network in this test (${url})`); };
  await db.initDb();
  const userId = (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('owner', 'x', 'admin', 'tok')`)).lastID;
  const otherId = (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('other', 'x', 'member', 'tok2')`)).lastID;
  await db.run(`INSERT INTO card_cache (id, name, game, language, price_trend) VALUES ('mtg-t', 'Tile Card', 'mtg', 'English', 1)`);
  await db.run(`INSERT INTO card_cache (id, name, game, language, price_trend) VALUES ('mtg-u', 'Other Card', 'mtg', 'English', 1)`);
  const binder = (await db.run(`INSERT INTO locations (name, type, user_id) VALUES ('Binder', 'Binder', ?)`, [userId])).lastID;
  const page = (await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 9)`, [binder])).lastID;

  const copy = async (condition, filed, cardId = 'mtg-t', owner = userId) => (await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, condition, location_id, compartment_id, position, game)
     VALUES (?, ?, 1, ?, ?, ?, ?, 'mtg')`,
    [cardId, owner, condition, filed ? binder : null, filed ? page : null, filed ? 1000 : 0]
  )).lastID;
  const rows = () => db.all(`SELECT id, condition FROM collection WHERE card_id = 'mtg-t' AND user_id = ? ORDER BY id`, [userId]);
  const ids = async () => (await rows()).map(r => r.id);

  // The reported tile: x5 made of 3 NM + 2 LP, one of each filed in the binder.
  const nmFiled = await copy('Near Mint', true);
  const nmShown = await copy('Near Mint', false);   // the copy the popup opens on
  const nmLoose = await copy('Near Mint', false);
  const lpFiled = await copy('Lightly Played', true);
  const lpLoose = await copy('Lightly Played', false);
  const tile = [nmShown, nmFiled, nmLoose, lpFiled, lpLoose];

  const base = await startApp(userId);

  // --- 5 -> 4: one copy goes, and it is the newest unfiled one -----------------------
  let res = await put(base, nmShown, { quantity: 4, stack_entry_ids: tile });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(await ids(), [nmFiled, nmShown, nmLoose, lpFiled], 'x5 set to 4 is four copies, not six');
  assert.deepStrictEqual([...res.body.stack_entry_ids].sort((a, b) => a - b), [nmFiled, nmShown, nmLoose, lpFiled],
    'the response names the rows the tile now holds');

  // --- 4 -> 2: the last unfiled copy, then the newest filed one ---------------------
  res = await put(base, nmShown, { quantity: 2, stack_entry_ids: res.body.stack_entry_ids });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(await ids(), [nmFiled, nmShown], 'the copy the popup is on is never the one removed');

  // --- 2 -> 5: new copies are made from the one being edited -------------------------
  res = await put(base, nmShown, { quantity: 5, stack_entry_ids: res.body.stack_entry_ids });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const grown = await rows();
  assert.strictEqual(grown.length, 5);
  assert.ok(grown.every(r => r.condition === 'Near Mint'));
  assert.strictEqual(res.body.stack_entry_ids.length, 5);

  // --- the same number again changes nothing ----------------------------------------
  res = await put(base, nmShown, { quantity: 5, stack_entry_ids: res.body.stack_entry_ids });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await rows()).length, 5);

  // --- a stacking binder pocket is its own tile ----------------------------------------
  // Three copies share the pocket; two more identical copies sit unfiled. Setting
  // the pocket to 2 removes one of the pocket's own, not the unfiled ones — which
  // is what the old identical-row reconcile went for first.
  await db.run(`DELETE FROM collection WHERE card_id = 'mtg-t'`);
  const pocket = [await copy('Near Mint', true), await copy('Near Mint', true), await copy('Near Mint', true)];
  const elsewhere = [await copy('Near Mint', false), await copy('Near Mint', false)];
  res = await put(base, pocket[0], { quantity: 2, stack_entry_ids: pocket });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(await ids(), [pocket[0], pocket[1], ...elsewhere], 'only the pocket shrank');

  // --- a tile can only name the caller's own copies of this card -----------------------
  const theirs = await copy('Near Mint', false, 'mtg-t', otherId);
  const otherCard = await copy('Near Mint', false, 'mtg-u');
  res = await put(base, pocket[0], { quantity: 1, stack_entry_ids: [pocket[0], pocket[1], theirs, otherCard] });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.ok(await db.get(`SELECT id FROM collection WHERE id = ?`, [theirs]), "another user's copy is never trimmed");
  assert.ok(await db.get(`SELECT id FROM collection WHERE id = ?`, [otherCard]), 'nor a copy of a different card');
  assert.deepStrictEqual(await ids(), [pocket[0], ...elsewhere]);

  // --- malformed lists are refused before anything is written --------------------------
  for (const bad of ['1,2', [1.5], ['x'], [-3], {}]) {
    res = await put(base, pocket[0], { quantity: 3, condition: 'Damaged', stack_entry_ids: bad });
    assert.strictEqual(res.status, 400, `stack_entry_ids ${JSON.stringify(bad)}: ${JSON.stringify(res.body)}`);
  }
  assert.strictEqual((await db.get(`SELECT condition FROM collection WHERE id = ?`, [pocket[0]])).condition, 'Near Mint');

  // --- without a list, the old identical-row reconcile still applies ---------------------
  res = await put(base, pocket[0], { quantity: 2 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await rows()).length, 2, 'API callers that send no list keep the previous behaviour');

  console.log('stacktile ok');
}

main()
  .then(cleanup, async (err) => { await cleanup(); throw err; })
  .catch(err => { console.error(err); process.exitCode = 1; });
