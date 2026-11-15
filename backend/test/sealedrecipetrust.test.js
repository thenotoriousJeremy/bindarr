// Sealed recipes are shared, one per product (#168), but whose recipe may put
// cards in a member's collection without being asked:
//
//   - saving a recipe attaches it to the saver's own earlier purchases only (it
//     used to attach everyone's, so member B's recipe decided what opening member
//     A's box added to A's collection);
//   - opening a unit applies the recipe its purchase was saved with, or else only
//     one its buyer or an admin created. Another member's recipe is still there to
//     see, and a purchase saved with it (the form shows it) applies it.
//
// Also here: Riftbound sealed product can be recorded; a failed bulk-sharing update
// answers without the database's own words; listing units reads each recipe once
// per request through the new sealed_unit_id index; the recipe migration is one
// transaction whose foreign-key check minds only the recipe tables; and duplicate
// recipes are merged into the oldest before the one-per-product indexes are made.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-sealedrecipetrust-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.BINDARR_SKIP_PRE_MIGRATION_SNAPSHOT = '1';
delete process.env.DEFAULT_ADMIN_PASSWORD;

const express = require('express');
const db = require('../src/db');

let server;
const users = {};

async function cleanup() {
  if (server && server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const id = Number(req.get('x-test-user'));
    req.user = { id, role: id === users.admin ? 'admin' : 'member' };
    next();
  });
  app.use('/api', require('../src/routes/sealed'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/api`));
  });
}

let base;
const api = async (as, method, url, body) => {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', 'x-test-user': String(as) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const buy = async (as, product_name) => {
  const res = await api(as, 'POST', '/sealed/purchases', { product_name, game: 'pokemon', unit_price: 10 });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const unit = await db.get(`SELECT id FROM sealed_units WHERE purchase_id = ?`, [res.body.purchase.id]);
  return { purchase: res.body.purchase.id, unit: unit.id };
};
const saveRecipe = async (as, product_name, quantity = 2) => {
  const res = await api(as, 'POST', '/sealed/templates', {
    product_name, game: 'pokemon', components: [{ component_type: 'card', card_id: 'promo-1', quantity }],
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return res.body.template.id;
};
const openUnit = async (as, unit) => {
  const res = await api(as, 'PUT', `/sealed/units/${unit}/open`, { opened: true });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  return res.body;
};
const pulled = async (userId, unit) => (await db.get(
  `SELECT COUNT(*) AS n FROM collection WHERE user_id = ? AND card_id = 'promo-1' AND sealed_unit_id = ?`, [userId, unit]
)).n;
const recipeOf = async (purchase) => (await db.get(`SELECT template_id FROM sealed_purchases WHERE id = ?`, [purchase])).template_id;

async function recipeTrust() {
  // A bought the box before B wrote a recipe for it.
  const early = await buy(users.a, 'Mystery Box');
  const recipe = await saveRecipe(users.b, 'Mystery Box');
  assert.strictEqual(await recipeOf(early.purchase), null, "B's recipe is not attached to A's purchase");
  await openUnit(users.a, early.unit);
  assert.strictEqual(await pulled(users.a, early.unit), 0, "opening A's box adds none of the cards B's recipe names");
  assert.strictEqual(await recipeOf(early.purchase), null, 'and does not attach it either');

  // The recipe is still shared: A sees it, and a purchase saved with it applies it.
  const match = await api(users.a, 'GET', '/sealed/templates/match?product_name=Mystery%20Box&game=pokemon');
  assert.strictEqual(match.body.template.id, recipe, 'A can still read the shared recipe');
  const later = await buy(users.a, 'Mystery Box');
  assert.strictEqual(await recipeOf(later.purchase), recipe, 'a purchase saved while the recipe exists is saved with it');
  await openUnit(users.a, later.unit);
  assert.strictEqual(await pulled(users.a, later.unit), 2, 'and opening it applies it');

  // The saver's own earlier purchases are attached, and apply on open.
  const own = await buy(users.b, 'Own Box');
  await saveRecipe(users.b, 'Own Box');
  assert.ok(await recipeOf(own.purchase), "saving a recipe attaches it to the saver's own earlier purchase");
  await openUnit(users.b, own.unit);
  assert.strictEqual(await pulled(users.b, own.unit), 2);

  // An admin's recipe is trusted: it applies to a member's earlier purchase on open.
  const adminBox = await buy(users.a, 'Admin Box');
  await saveRecipe(users.admin, 'Admin Box', 1);
  assert.strictEqual(await recipeOf(adminBox.purchase), null, "an admin's save attaches only the admin's purchases");
  await openUnit(users.a, adminBox.unit);
  assert.strictEqual(await pulled(users.a, adminBox.unit), 1, "an admin's recipe applies when the box is opened");

  // A's own recipe for a product A bought before writing it applies too.
  const mine = await buy(users.a, 'Mine Box');
  await saveRecipe(users.a, 'Mine Box', 3);
  await openUnit(users.a, mine.unit);
  assert.strictEqual(await pulled(users.a, mine.unit), 3);
  console.log("PASS: only the buyer's, an admin's or an applied recipe adds cards on open");
}

async function riftboundAndErrors() {
  const res = await api(users.a, 'POST', '/sealed/purchases', { product_name: 'Origins Booster Box', game: 'riftbound' });
  assert.strictEqual(res.status, 201, `Riftbound sealed product can be recorded: ${JSON.stringify(res.body)}`);
  assert.strictEqual((await api(users.a, 'POST', '/sealed/purchases', { product_name: 'X', game: 'chess' })).status, 400);

  await db.run(`CREATE TRIGGER fail_share BEFORE UPDATE OF available_to_all ON sealed_purchases
                BEGIN SELECT RAISE(ABORT, 'secret internal detail'); END`);
  const shared = await api(users.a, 'PUT', '/sealed/purchases/bulk-sharing', { purchase_ids: [res.body.purchase.id], available_to_all: true });
  assert.strictEqual(shared.status, 500);
  assert.ok(!JSON.stringify(shared.body).includes('secret internal detail'), `the database error stays in the log: ${JSON.stringify(shared.body)}`);
  await db.run(`DROP TRIGGER fail_share`);
  console.log('PASS: Riftbound sealed product is accepted, and a failed update keeps its error to itself');
}

async function unitListing() {
  const plan = await db.all(`EXPLAIN QUERY PLAN SELECT id FROM collection WHERE sealed_unit_id = ?`, [1]);
  assert.ok(plan.some(r => /idx_collection_sealed_unit/.test(r.detail)), `a unit's cards are found through the index: ${JSON.stringify(plan)}`);

  // Thirty units of one product with a recipe: each unit's progress asked the same
  // recipe questions again.
  const res = await api(users.b, 'POST', '/sealed/purchases', { product_name: 'Own Box', game: 'pokemon', quantity: 30 });
  assert.strictEqual(res.status, 201);
  const counts = { n: 0 };
  const originals = { get: db.get, all: db.all };
  for (const name of Object.keys(originals)) db[name] = (...args) => { counts.n++; return originals[name](...args); };
  let listed;
  try {
    listed = await api(users.b, 'GET', '/sealed/units');
  } finally {
    Object.assign(db, originals);
  }
  assert.strictEqual(listed.status, 200);
  const units = listed.body.units.length;
  assert.ok(units >= 30);
  assert.ok(counts.n <= units * 2 + 10, `listing ${units} units ran ${counts.n} reads`);
  console.log(`PASS: listing ${units} units runs ${counts.n} reads, the recipe looked up once`);
}

// --- the migrations, on databases of their own --------------------------------

// A database whose sealed_templates still has the pre-#168 shape (user_id NOT
// NULL, one recipe per user), with two users' recipes for the same product.
async function legacyRecipes() {
  await db.run(`PRAGMA foreign_keys = OFF`);
  for (const index of ['idx_sealed_templates_user', 'idx_sealed_templates_global_product', 'idx_sealed_templates_global_name']) {
    await db.run(`DROP INDEX IF EXISTS ${index}`);
  }
  await db.run(`DROP TABLE sealed_templates`);
  await db.run(`
    CREATE TABLE sealed_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      game TEXT NOT NULL DEFAULT 'pokemon',
      expected_cards INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  await db.run(`DELETE FROM sealed_template_components`);
  await db.run(`UPDATE sealed_purchases SET template_id = NULL`);
  await db.run(`INSERT INTO sealed_templates (id, user_id, product_id, product_name, game) VALUES (101, ?, 555, 'Legacy Box', 'pokemon')`, [users.a]);
  await db.run(`INSERT INTO sealed_templates (id, user_id, product_id, product_name, game) VALUES (102, ?, 555, 'Legacy Box', 'pokemon')`, [users.b]);
  await db.run(`INSERT INTO sealed_template_components (template_id, component_type, quantity, card_id) VALUES (101, 'card', 1, 'promo-1'), (102, 'card', 2, 'promo-2')`);
  const purchase = (await db.run(`INSERT INTO sealed_purchases (user_id, product_id, product_name, game, template_id) VALUES (?, 555, 'Legacy Box', 'pokemon', 102)`, [users.b])).lastID;
  // An orphan that has nothing to do with recipes: a copy whose card_cache row is gone.
  await db.run(`INSERT INTO collection (card_id, user_id, game) VALUES ('long-gone-card', ?, 'pokemon')`, [users.a]);
  await db.run(`PRAGMA foreign_keys = ON`);
  return purchase;
}

async function recipeMigration() {
  const purchase = await legacyRecipes();
  // A failure part way through the rebuild leaves the recipes exactly as they were.
  await db.run(`CREATE TRIGGER fail_rebuild BEFORE INSERT ON sealed_template_components
                BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  await assert.rejects(db.initDb(), /disk full/);
  await db.run(`DROP TRIGGER fail_rebuild`);
  assert.strictEqual((await db.all(`SELECT id FROM sealed_templates ORDER BY id`)).map(r => r.id).join(), '101,102', 'both recipes are still there');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM sealed_template_components`)).n, 2, 'with their components');
  assert.ok((await db.all(`PRAGMA table_info(sealed_templates)`)).find(c => c.name === 'user_id').notnull, 'in the old shape, to try again');
  assert.ok(!(await db.get(`SELECT name FROM sqlite_master WHERE name = 'sealed_templates_shared'`)), 'with no half-built side table');

  // The next boot completes it, an unrelated orphan notwithstanding.
  await db.initDb();
  const recipes = await db.all(`SELECT id, product_id FROM sealed_templates WHERE product_id = 555`);
  assert.deepStrictEqual(recipes.map(r => r.id), [101], 'one recipe for the product, the oldest');
  assert.strictEqual(await recipeOf(purchase), 101, 'the purchase follows it');
  assert.deepStrictEqual((await db.all(`SELECT card_id, quantity FROM sealed_template_components WHERE template_id = 101 ORDER BY card_id`)).map(r => [r.card_id, r.quantity]),
    [['promo-1', 1], ['promo-2', 2]], 'with both recipes\' components');
  assert.ok(!(await db.all(`PRAGMA table_info(sealed_templates)`)).find(c => c.name === 'user_id').notnull, 'recipes are shared now');
  assert.strictEqual((await db.get(`PRAGMA foreign_keys`)).foreign_keys, 1, 'foreign keys are back on');
  console.log('PASS: the recipe migration is atomic and minds only its own tables');
}

async function duplicateMerge() {
  // A shared-schema database holding duplicates: two recipes for one product id,
  // two for one name, with purchases following the newer ones.
  for (const index of ['idx_sealed_templates_global_product', 'idx_sealed_templates_global_name']) {
    await db.run(`DROP INDEX IF EXISTS ${index}`);
  }
  const older = (await db.run(`INSERT INTO sealed_templates (user_id, product_id, product_name, game) VALUES (?, 777, 'Dupe Box', 'pokemon')`, [users.a])).lastID;
  const newer = (await db.run(`INSERT INTO sealed_templates (user_id, product_id, product_name, game) VALUES (?, 777, 'Dupe Box', 'pokemon')`, [users.b])).lastID;
  const olderName = (await db.run(`INSERT INTO sealed_templates (user_id, product_name, game) VALUES (?, 'Named Box', 'pokemon')`, [users.a])).lastID;
  const newerName = (await db.run(`INSERT INTO sealed_templates (user_id, product_name, game) VALUES (?, 'named box', 'pokemon')`, [users.b])).lastID;
  const otherGame = (await db.run(`INSERT INTO sealed_templates (user_id, product_id, product_name, game) VALUES (?, 777, 'Dupe Box', 'mtg')`, [users.b])).lastID;
  const p1 = (await db.run(`INSERT INTO sealed_purchases (user_id, product_id, product_name, game, template_id) VALUES (?, 777, 'Dupe Box', 'pokemon', ?)`, [users.b, newer])).lastID;
  const p2 = (await db.run(`INSERT INTO sealed_purchases (user_id, product_name, game, template_id) VALUES (?, 'named box', 'pokemon', ?)`, [users.b, newerName])).lastID;

  await db.initDb();
  const left = (await db.all(`SELECT id FROM sealed_templates WHERE id IN (?, ?, ?, ?, ?) ORDER BY id`, [older, newer, olderName, newerName, otherGame])).map(r => r.id);
  assert.deepStrictEqual(left, [older, olderName, otherGame], 'the oldest recipe of each product is kept; another game\'s is its own');
  assert.strictEqual(await recipeOf(p1), older);
  assert.strictEqual(await recipeOf(p2), olderName);
  const indexes = (await db.all(`PRAGMA index_list(sealed_templates)`)).filter(i => i.unique).map(i => i.name).sort();
  assert.deepStrictEqual(indexes, ['idx_sealed_templates_global_name', 'idx_sealed_templates_global_product'], 'and one recipe per product is enforced again');
  await assert.rejects(db.run(`INSERT INTO sealed_templates (user_id, product_id, product_name, game) VALUES (?, 777, 'Again', 'pokemon')`, [users.a]), /UNIQUE/);
  console.log('PASS: duplicate recipes are merged into the oldest, and the unique indexes hold');
}

async function main() {
  await db.initDb();
  for (const [name, role] of [['a', 'member'], ['b', 'member'], ['admin', 'admin']]) {
    users[name] = (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES (?, 'x', ?, ?)`, [name, role, `tok-${name}`])).lastID;
  }
  for (const id of ['promo-1', 'promo-2']) {
    await db.run(`INSERT INTO card_cache (id, name, game, language, rarity, price_trend) VALUES (?, ?, 'pokemon', 'English', 'Promo', 1)`, [id, id]);
  }
  base = await startApp();
  await recipeTrust();
  await riftboundAndErrors();
  await unitListing();
  await recipeMigration();
  await duplicateMerge();
}

main()
  .then(cleanup, async (err) => { await cleanup(); throw err; })
  .catch(err => { console.error(err); process.exitCode = 1; });
