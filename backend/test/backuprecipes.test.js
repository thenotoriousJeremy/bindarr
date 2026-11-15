// Sealed recipes in a full backup (routes/backup.js).
//
// Since #168 a recipe is shared: one per product and game, and every account's
// purchases of that product can follow it. A restore used to delete the
// restorer's recipes and insert the file's again, so other accounts' purchases
// lost theirs, and a file holding a recipe someone else already had here failed
// the whole restore on the unique index (a 500). Now a restore never deletes or
// changes a recipe: each recipe in the file is the server's own recipe for that
// product where there is one, and only a product with none gets the file's,
// with its components, as the restorer's. Members, admins and the phone (an
// admin) restore the same way.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-backuprecipes-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* nothing to remove */ }
}
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

const express = require('express');
const db = require('../src/db');

// No provider is asked for anything: every card the files name is cached here.
const fetched = [];
const stubModule = (rel, exports) => {
  const file = require.resolve(rel);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stubModule('../src/utils/cardApi', {
  ...require('../src/utils/cardApi'),
  getCardById: async (id) => { fetched.push(id); return null; },
});

const PROMO = 'mtg-recipe-promo';
const BOLT = 'mtg-recipe-bolt';

let server;
let base;
const accounts = new Map();

async function cleanup() {
  if (server && server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

function startApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => { req.user = accounts.get(Number(req.headers['x-user'])); next(); });
  app.use('/api', require('../src/routes/backup'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function api(userId, method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-user': String(userId) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function addUser(name, role = 'member') {
  const id = (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES (?, 'x', ?, ?)`,
    [name, role, `share-${name}-${process.pid}`])).lastID;
  accounts.set(id, { id, username: name, role, tcg_api_key: '' });
  return id;
}

async function addRecipe(userId, productId, productName, components, expectedCards = null) {
  const id = (await db.run(
    `INSERT INTO sealed_templates (user_id, product_id, product_name, game, expected_cards) VALUES (?, ?, ?, 'mtg', ?)`,
    [userId, productId, productName, expectedCards])).lastID;
  for (const c of components) {
    await db.run(
      `INSERT INTO sealed_template_components (template_id, component_type, quantity, card_id, product_name, sealed_type, game)
       VALUES (?, ?, ?, ?, ?, ?, 'mtg')`,
      [id, c.card_id ? 'card' : 'product', c.quantity, c.card_id || null, c.product_name || null, c.product_name ? 'Booster Pack' : null]);
  }
  return id;
}

async function addPurchase(userId, productId, productName, templateId) {
  const id = (await db.run(
    `INSERT INTO sealed_purchases (user_id, product_id, product_name, game, quantity, template_id) VALUES (?, ?, ?, 'mtg', 1, ?)`,
    [userId, productId, productName, templateId])).lastID;
  await db.run(`INSERT INTO sealed_units (purchase_id) VALUES (?)`, [id]);
  return id;
}

// Every recipe on the server with its components, to show a restore changed none.
const recipes = async () => {
  const rows = await db.all(`SELECT * FROM sealed_templates ORDER BY id`);
  for (const r of rows) {
    r.components = await db.all(`SELECT * FROM sealed_template_components WHERE template_id = ? ORDER BY id`, [r.id]);
  }
  return rows;
};
const followed = async (userId) => (await db.all(
  `SELECT product_name, template_id FROM sealed_purchases WHERE user_id = ? ORDER BY product_name`, [userId]))
  .map(p => [p.product_name, p.template_id]);

async function main() {
  await db.initDb();
  base = await startApp();
  for (const [id, name] of [[PROMO, 'Promo Dragon'], [BOLT, 'Lightning Bolt']]) {
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES (?, ?, 'mtg')`, [id, name]);
  }
  const alice = await addUser('alice');
  const bob = await addUser('bob');
  const carol = await addUser('carol');
  const dana = await addUser('dana', 'admin');

  // Alice made the Collector Box's recipe and one nobody follows; bob made the
  // Prerelease Kit's, a product with no catalog id. Both follow alice's, and alice
  // follows bob's.
  const collectorBox = await addRecipe(alice, 501, 'Collector Box', [{ card_id: PROMO, quantity: 1 }, { product_name: 'Booster Pack', quantity: 2 }], 30);
  const fatPack = await addRecipe(alice, 777, 'Fat Pack', [{ product_name: 'Booster Pack', quantity: 9 }]);
  const prerelease = await addRecipe(bob, null, 'Prerelease Kit', [{ card_id: BOLT, quantity: 1 }]);
  await addPurchase(alice, 501, 'Collector Box', collectorBox);
  await addPurchase(alice, null, 'Prerelease Kit', prerelease);
  await addPurchase(bob, 501, 'Collector Box', collectorBox);
  const before = await recipes();

  // --- the backup carries every recipe its purchases follow ---------------------
  const exported = await api(alice, 'GET', '/api/backup');
  assert.strictEqual(exported.status, 200, JSON.stringify(exported.body));
  const file = exported.body;
  assert.deepStrictEqual(file.data.sealed_templates.map(t => t.product_name).sort(), ['Collector Box', 'Fat Pack', 'Prerelease Kit'],
    'the recipes alice made, and bob\'s, which her purchase follows');
  assert.strictEqual(file.data.sealed_template_components.length, 4);
  console.log('PASS: a backup carries the recipes the account made and the ones its purchases follow');

  // --- restored on the same install: the recipes are the server's own ---------------
  // The file's copy of the Collector Box recipe differs from the server's now (made
  // before an edit, say): the server's stays as it is.
  const edited = JSON.parse(JSON.stringify(file));
  edited.data.sealed_templates.find(t => t.product_name === 'Collector Box').expected_cards = 99;
  edited.data.sealed_template_components.push({ id: 9999, template_id: collectorBox, component_type: 'card', quantity: 5, card_id: BOLT, game: 'mtg' });
  let r = await api(alice, 'POST', '/api/backup/restore', { backup: edited });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(await recipes(), before, 'no recipe was deleted, added or changed');
  assert.deepStrictEqual(await followed(alice), [['Collector Box', collectorBox], ['Prerelease Kit', prerelease]],
    'her restored purchases follow the same recipes');
  assert.deepStrictEqual(await followed(bob), [['Collector Box', collectorBox]], 'bob\'s purchase still follows alice\'s recipe');
  console.log('PASS: restored on the same install, the restore neither deletes nor changes a recipe others follow');

  // --- restored into an account whose server already has those recipes -------------
  // Carol, a member, restores alice's file: every recipe in it is one this server
  // has (one made by someone else), which used to fail the restore with a 500.
  r = await api(carol, 'POST', '/api/backup/restore', { backup: file });
  assert.strictEqual(r.status, 200, `a recipe the server already has does not fail the restore: ${JSON.stringify(r.body)}`);
  assert.deepStrictEqual(await recipes(), before, 'carol\'s restore made no second recipe for any product');
  assert.deepStrictEqual(await followed(carol), [['Collector Box', collectorBox], ['Prerelease Kit', prerelease]]);
  console.log('PASS: a file\'s recipe the server already has maps onto the server\'s, without a 500');

  // --- recipes new to the server ----------------------------------------------------
  // Dana, an admin (whose restore is the phone's too), restores a file with a
  // recipe for a product this server has none for, and one for the Prerelease Kit
  // under another capitalisation, which is bob's recipe: names match regardless.
  const novel = JSON.parse(JSON.stringify(file));
  novel.data.sealed_templates.push(
    { id: 9001, user_id: 4242, product_id: 999, product_name: 'Starter Deck', game: 'mtg', expected_cards: 60 },
    { id: 9002, user_id: 4242, product_id: null, product_name: 'PRERELEASE KIT', game: 'mtg', expected_cards: 7 },
  );
  novel.data.sealed_template_components.push(
    { id: 9101, template_id: 9001, component_type: 'card', quantity: 2, card_id: PROMO, game: 'mtg' },
    { id: 9102, template_id: 9001, component_type: 'product', quantity: 1, product_name: 'Booster Pack', sealed_type: 'Booster Pack', game: 'mtg' },
    { id: 9103, template_id: 9002, component_type: 'card', quantity: 3, card_id: PROMO, game: 'mtg' },
  );
  novel.data.sealed_purchases.push(
    { id: 9201, user_id: 4242, product_id: 999, product_name: 'Starter Deck', game: 'mtg', quantity: 1, template_id: 9001 },
    { id: 9202, user_id: 4242, product_id: null, product_name: 'Prerelease Kit', game: 'mtg', quantity: 1, template_id: 9002 },
  );
  fetched.length = 0;
  r = await api(dana, 'POST', '/api/backup/restore', { backup: novel });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const after = await recipes();
  assert.deepStrictEqual(after.slice(0, before.length), before, 'the recipes already here are untouched');
  assert.strictEqual(after.length, before.length + 1, 'one recipe is new: the Starter Deck\'s');
  const starter = after[after.length - 1];
  assert.deepStrictEqual([starter.product_id, starter.product_name, starter.game, starter.expected_cards, starter.user_id],
    [999, 'Starter Deck', 'mtg', 60, dana], 'made as the restorer\'s');
  assert.deepStrictEqual(starter.components.map(c => [c.component_type, c.quantity, c.card_id, c.product_name]),
    [['card', 2, PROMO, null], ['product', 1, null, 'Booster Pack']], 'with its components');
  assert.deepStrictEqual(await followed(dana),
    [['Collector Box', collectorBox], ['Prerelease Kit', prerelease], ['Prerelease Kit', prerelease], ['Starter Deck', starter.id]]);
  assert.strictEqual(fetched.length, 0);
  console.log('PASS: a recipe new to the server is made with its components; names match regardless of case');

  // --- a backup without recipes ---------------------------------------------------------
  const old = JSON.parse(JSON.stringify(file));
  delete old.data.sealed_templates;
  delete old.data.sealed_template_components;
  r = await api(alice, 'POST', '/api/backup/restore', { backup: old });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.sealed, 2);
  assert.deepStrictEqual(await followed(alice), [['Collector Box', null], ['Prerelease Kit', null]],
    'purchases whose recipe the file does not hold follow none');
  assert.deepStrictEqual((await recipes()).slice(0, before.length), before, 'and the server\'s recipes stay');
  assert.deepStrictEqual(await followed(bob), [['Collector Box', collectorBox]]);
  console.log('PASS: a backup without recipes restores, and leaves the server\'s recipes alone');
}

main()
  .then(async () => { await cleanup(); console.log('backuprecipes tests passed'); })
  .catch(async (err) => { console.error(err); await cleanup(); process.exit(1); });
