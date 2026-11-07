// Nested sealed recipes: card counts roll up through product components that
// have their own recipes (e.g. a bundle holding an ETB and a booster bundle).
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-sealedcontents-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../src/db');
const { templateCardCount, productCardCount } = require('../src/utils/sealedContents');

async function cleanup() {
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

async function addTemplate(userId, name, components) {
  const t = await db.run(`INSERT INTO sealed_templates (user_id, product_name, game) VALUES (?, ?, 'pokemon')`, [userId, name]);
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
    console.log('PASS: nested sealed recipes roll up card counts');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();
