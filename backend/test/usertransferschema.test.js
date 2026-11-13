const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-user-transfers-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../src/db');

async function cleanup() {
  await new Promise(resolve => {
    try { db.dbConnection.close(() => resolve()); } catch { resolve(); }
  });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

async function main() {
  await db.initDb();
  await db.initDb();

  const alice = (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    ['transfer-alice', 'hash', 'member', `transfer-a-${process.pid}`]
  )).lastID;
  const bob = (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    ['transfer-bob', 'hash', 'member', `transfer-b-${process.pid}`]
  )).lastID;

  const cardId = `transfer-card-${process.pid}`;
  await db.run(`INSERT INTO card_cache (id, name) VALUES (?, ?)`, [cardId, 'Transfer Test Card']);
  const cardEntry = await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, purchase_price) VALUES (?, ?, 1, ?)`,
    [cardId, alice, 0.3]
  );
  const purchase = await db.run(
    `INSERT INTO sealed_purchases (user_id, product_name, quantity) VALUES (?, ?, 1)`,
    [alice, 'Booster Bundle']
  );
  const sealedUnit = await db.run(`INSERT INTO sealed_units (purchase_id) VALUES (?)`, [purchase.lastID]);
  const transfer = await db.run(
    `INSERT INTO user_transfers (proposer_id, recipient_id, transfer_type) VALUES (?, ?, ?)`,
    [alice, bob, 'trade']
  );
  await db.run(
    `INSERT INTO user_transfer_items
       (transfer_id, from_user_id, to_user_id, item_type, source_collection_id, purchase_cost, item_snapshot)
     VALUES (?, ?, ?, 'card', ?, ?, ?)`,
    [transfer.lastID, alice, bob, cardEntry.lastID, 0.3, JSON.stringify({ name: 'Transfer Test Card', condition: 'Near Mint' })]
  );
  await db.run(
    `INSERT INTO user_transfer_items
       (transfer_id, from_user_id, to_user_id, item_type, source_sealed_unit_id, item_snapshot)
     VALUES (?, ?, ?, 'sealed', ?, ?)`,
    [transfer.lastID, bob, alice, sealedUnit.lastID, JSON.stringify({ product_name: 'Booster Pack', origin_product_name: 'Booster Bundle' })]
  );

  const items = await db.all(
    `SELECT item_type, purchase_cost, item_snapshot FROM user_transfer_items WHERE transfer_id = ? ORDER BY id`,
    [transfer.lastID]
  );
  assert.deepStrictEqual(items.map(item => item.item_type), ['card', 'sealed']);
  assert.strictEqual(items[0].purchase_cost, 0.3);
  assert.strictEqual(JSON.parse(items[1].item_snapshot).origin_product_name, 'Booster Bundle');

  await db.run(`DELETE FROM collection WHERE id = ?`, [cardEntry.lastID]);
  await db.run(`DELETE FROM sealed_units WHERE id = ?`, [sealedUnit.lastID]);
  const historicalItems = await db.all(
    `SELECT source_collection_id, source_sealed_unit_id, item_snapshot
       FROM user_transfer_items WHERE transfer_id = ? ORDER BY id`,
    [transfer.lastID]
  );
  assert.strictEqual(historicalItems[0].source_collection_id, null);
  assert.strictEqual(historicalItems[1].source_sealed_unit_id, null);
  assert.strictEqual(JSON.parse(historicalItems[0].item_snapshot).name, 'Transfer Test Card');
  assert.strictEqual(JSON.parse(historicalItems[1].item_snapshot).origin_product_name, 'Booster Bundle');

  await assert.rejects(
    db.run(`INSERT INTO user_transfers (proposer_id, recipient_id, transfer_type) VALUES (?, ?, 'gift')`, [alice, alice]),
    /constraint/i,
    'a user cannot propose a transfer to themself'
  );
  await assert.rejects(
    db.run(
      `INSERT INTO user_transfer_items
         (transfer_id, from_user_id, to_user_id, item_type, quantity, item_snapshot)
       VALUES (?, ?, ?, 'card', 0, '{}')`,
      [transfer.lastID, alice, bob]
    ),
    /constraint/i,
    'transfer item quantities must be positive'
  );

  console.log('PASS: transfer proposals support card and sealed item snapshots');
  console.log('PASS: historical item snapshots survive source collection and unit deletion');
  console.log('PASS: transfer participant and quantity constraints are enforced');
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(cleanup);
