// Nested sealed recipes: card counts roll up through product components that
// have their own recipes (e.g. a bundle holding an ETB and a booster bundle).
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-sealedcontents-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../src/db');
const { templateCardCount, productCardCount, unitCardProgress } = require('../src/utils/sealedContents');

async function cleanup() {
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

async function addTemplate(userId, name, components, expectedCards = null) {
  const t = await db.run(
    `INSERT INTO sealed_templates (user_id, product_name, game, expected_cards) VALUES (?, ?, 'pokemon', ?)`,
    [userId, name, expectedCards]
  );
  for (const c of components) {
    await db.run(
      `INSERT INTO sealed_template_components (template_id, component_type, quantity, card_id, product_name, expected_cards)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [t.lastID, c.type, c.quantity, c.card_id || null, c.name || null, c.expected_cards ?? null]
    );
  }
  return t.lastID;
}

(async () => {
  try {
    await db.initDb();
    const user = (await db.get(`SELECT id FROM users LIMIT 1`))?.id
      || (await db.run(`INSERT INTO users (username, password_hash, share_token) VALUES ('u', 'x', 'tok')`)).lastID;

    await addTemplate(user, 'ETB', [
      { type: 'product', quantity: 9, name: 'Booster Pack', expected_cards: 10 },
      { type: 'card', quantity: 1, card_id: 'promo-a' },
    ]);
    await addTemplate(user, 'Booster Bundle', [{ type: 'product', quantity: 6, name: 'Booster Pack', expected_cards: 10 }]);
    const bundleId = await addTemplate(user, 'Costco Bundle', [
      { type: 'product', quantity: 1, name: 'ETB', expected_cards: 1 },
      { type: 'product', quantity: 1, name: 'Booster Bundle', expected_cards: 1 },
      { type: 'card', quantity: 2, card_id: 'promo-b' },
    ]);

    assert.strictEqual(await templateCardCount(user, bundleId), 91 + 60 + 2,
      'nested recipes must roll up actual card counts');
    assert.strictEqual(await productCardCount(user, null, 'ETB', 1), 91);
    assert.strictEqual(await productCardCount(user, null, 'Unknown', 7), 7, 'no recipe falls back to expected_cards');
    assert.strictEqual(await productCardCount(user, null, 'Unknown', null), 1);

    await addTemplate(user, 'Progress Pack', [
      { type: 'card', quantity: 11, card_id: 'pack-card' },
    ]);
    await addTemplate(user, 'Progress ETB', [
      { type: 'product', quantity: 9, name: 'Progress Pack', expected_cards: 10 },
      { type: 'card', quantity: 1, card_id: 'promo-card' },
    ], 145);
    const purchase = await db.run(
      `INSERT INTO sealed_purchases (user_id, product_name, game, quantity)
       VALUES (?, 'Progress ETB', 'pokemon', 1)`,
      [user]
    );
    const unit = await db.run(`INSERT INTO sealed_units (purchase_id) VALUES (?)`, [purchase.lastID]);
    await db.run(
      `INSERT INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend, game)
       VALUES ('progress-card', 'Progress Card', 'Pok\u00e9mon', '[]', '[]', 'Common', 'test', 'Test', '1', '', 0, 'pokemon')`
    );
    await db.run(
      `INSERT INTO collection (card_id, user_id, quantity, sealed_unit_id) VALUES ('progress-card', ?, 46, ?)`,
      [user, unit.lastID]
    );
    const childPurchase = await db.run(
      `INSERT INTO sealed_purchases (user_id, product_name, game, quantity, expected_cards, source_unit_id)
       VALUES (?, 'Progress Pack', 'pokemon', 9, 11, ?)`,
      [user, unit.lastID]
    );
    for (let i = 0; i < 9; i++) {
      const childUnit = await db.run(`INSERT INTO sealed_units (purchase_id) VALUES (?)`, [childPurchase.lastID]);
      await db.run(
        `INSERT INTO collection (card_id, user_id, quantity, sealed_unit_id) VALUES ('progress-card', ?, 11, ?)`,
        [user, childUnit.lastID]
      );
    }
    const progress = await unitCardProgress(user, unit.lastID);
    assert.deepStrictEqual(progress, { expected_cards: 145, linked_cards: 145 },
      'nested pack cards count only when linked, alongside direct promo/energy card links');
    console.log('PASS: nested sealed recipes and direct links roll up unit card progress');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();
