// One wishlist, end to end (WEB-03), against a real server:
//
//   - the wishlist rows an older release left in the collection move onto the
//     owner's default Wishlist while the server boots, before it answers;
//   - the hearts (/api/lists/default), the list itself and the public wishlist
//     link all read that one list, and the collection holds no wanted card;
//   - an older app's bulk "move to wishlist" wants the card and puts the copy in
//     the trash, and restoring the trash brings the copy back.
//
// Runs offline (harness.js): every card is seeded into card_cache.
const assert = require('assert');
const harness = require('./harness');

const tmp = harness.tempDatabase('wishlist');
const db = require('../../src/db');

let srv;

async function main() {
  await harness.prepare(db);
  const alice = await harness.member(db, 'alice');
  await db.run(`UPDATE users SET share_enabled = 1 WHERE id = ?`, [alice.id]);
  const token = (await db.get(`SELECT share_token FROM users WHERE id = ?`, [alice.id])).share_token;
  for (const [id, name] of [['pk-wanted', 'Wanted Card'], ['pk-owned', 'Owned Card']]) {
    await db.run(`INSERT INTO card_cache (id, name, game, set_id, set_name, number, price_trend, language, last_updated)
                  VALUES (?, ?, 'pokemon', 'base1', 'Base Set', '1', 3, 'English', datetime('now'))`, [id, name]);
  }
  // As an older release left them: two wanted copies of one card in the collection.
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, list_type, notes, game) VALUES ('pk-wanted', ?, 1, 'wishlist', 'any set', 'pokemon')`, [alice.id]);
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, list_type, notes, game) VALUES ('pk-wanted', ?, 1, 'wishlist', 'any set', 'pokemon')`, [alice.id]);
  const owned = (await db.run(`INSERT INTO collection (card_id, user_id, quantity, list_type, game) VALUES ('pk-owned', ?, 1, 'collection', 'pokemon')`, [alice.id])).lastID;

  srv = await harness.startServer(tmp);
  const req = (method, url, opts = {}) => srv.request(method, url, opts);

  // The boot moved them.
  let res = await req('GET', '/api/lists/default', { as: alice });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.json.card_ids, ['pk-wanted'], 'the heart shows the old wishlist card');
  const listId = res.json.list.id;
  res = await req('GET', `/api/lists/${listId}`, { as: alice });
  assert.deepStrictEqual(res.json.items.map(i => [i.card_id, i.quantity_wanted, i.notes]), [['pk-wanted', 2, 'any set']]);
  res = await req('GET', '/api/collection?list_type=wishlist', { as: alice });
  assert.deepStrictEqual(res.json, [], 'no wanted card is a collection row any more');
  res = await req('GET', '/api/collection', { as: alice });
  assert.deepStrictEqual(res.json.map(r => r.entry_id), [owned], 'the owned copy is untouched');
  res = await req('GET', `/api/shared/${token}?list=wishlist`);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.json.collection.map(c => [c.card_id, c.quantity]), [['pk-wanted', 2]], 'the public link shows the Wishlist');
  console.log('PASS: the old wishlist moved onto the Wishlist at boot, and every reader reads it');

  // An older app moves its owned copy to the wishlist.
  res = await req('POST', '/api/collection/bulk', { as: alice, body: { entry_ids: [owned], action: 'list_type', value: 'wishlist' } });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.affected, 1);
  const batch = res.json.trash_batch;
  assert.ok(batch, 'the copy went to the trash');
  res = await req('GET', '/api/lists/default', { as: alice });
  assert.deepStrictEqual(res.json.card_ids.sort(), ['pk-owned', 'pk-wanted']);
  res = await req('GET', '/api/collection', { as: alice });
  assert.deepStrictEqual(res.json, []);
  res = await req('POST', `/api/collection/trash/${batch}/restore`, { as: alice });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.restored, 1);
  res = await req('GET', '/api/collection', { as: alice });
  assert.deepStrictEqual(res.json.map(r => [r.entry_id, r.list_type]), [[owned, 'collection']], 'and comes back from it');
  console.log("PASS: an older app's move to wishlist wants the card and trashes the copy, undoably");
}

main()
  .then(async () => { await srv.stop(); await harness.cleanup(db, tmp); process.exit(0); })
  .catch(async (err) => {
    console.error(err.stack || err.message);
    if (srv) console.error(`--- server log (tail) ---\n${srv.tail()}`);
    try { if (srv) await srv.stop(); } catch { /* already down */ }
    await harness.cleanup(db, tmp);
    process.exit(1);
  });
