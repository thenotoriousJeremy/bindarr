// A card on a list is demand for its TCGCSV category (tcgcsvApi.demandedCategories).
//
// The automatic sync skips Pokémon (3/85) and Riftbound (89) until something on
// the install needs them. A user who only browses sets and hearts cards owns
// nothing yet, but their wishlist is priced -- so a card on any card list,
// the default Wishlist the hearts fill included, has to count.
//
// Offline: demandedCategories only reads the database.
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-tcgcsvdemand-${process.pid}.db`);
process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';
const tcgcsv = require('../src/tcgcsvApi');
const db = require('../src/db');

(async () => {
  try {
    await db.initDb();
    assert.deepStrictEqual(await tcgcsv.demandedCategories(), [], 'a fresh database demands nothing');

    const user = (await db.run(`INSERT INTO users (username, password_hash, share_token) VALUES ('w', 'x', 'w')`)).lastID;
    const wishlist = (await db.run(
      `INSERT INTO card_lists (user_id, name, kind, is_default) VALUES (?, 'Wishlist', 'wishlist', 1)`, [user]
    )).lastID;

    // A Magic card on the list is no reason to fetch Pokémon prices.
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('mtg-x', 'X', 'mtg')`);
    await db.run(`INSERT INTO card_list_items (list_id, card_id) VALUES (?, 'mtg-x')`, [wishlist]);
    assert.deepStrictEqual(await tcgcsv.demandedCategories(), [], 'a Magic card on a list does not demand 3/85');

    await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('sv3pt5-6', 'Charizard', 'pokemon')`);
    await db.run(`INSERT INTO card_list_items (list_id, card_id) VALUES (?, 'sv3pt5-6')`, [wishlist]);
    assert.deepStrictEqual(await tcgcsv.demandedCategories(), [3, 85], 'a wishlisted Pokémon card demands 3/85');
    console.log('PASS: a Pokémon card on the default Wishlist, with nothing owned, demands 3/85');

    // Any list kind counts, not just the default: a buylist is priced too.
    await db.run(`DELETE FROM card_list_items WHERE card_id = 'sv3pt5-6'`);
    assert.deepStrictEqual(await tcgcsv.demandedCategories(), []);
    const buylist = (await db.run(`INSERT INTO card_lists (user_id, name, kind) VALUES (?, 'Buy', 'buylist')`, [user])).lastID;
    await db.run(`INSERT INTO card_list_items (list_id, card_id) VALUES (?, 'sv3pt5-6')`, [buylist]);
    assert.deepStrictEqual(await tcgcsv.demandedCategories(), [3, 85], 'a Pokémon card on any list demands 3/85');
    console.log('PASS: a Pokémon card on any card list demands 3/85');

    // Riftbound the same way: listed, not owned.
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('riftbound-ogn-1', 'R', 'riftbound')`);
    assert.ok(!(await tcgcsv.demandedCategories()).includes(89), 'cached but on no list: no demand');
    await db.run(`INSERT INTO card_list_items (list_id, card_id) VALUES (?, 'riftbound-ogn-1')`, [wishlist]);
    assert.ok((await tcgcsv.demandedCategories()).includes(89), 'a wishlisted Riftbound card demands 89');
    console.log('PASS: a Riftbound card on a list demands 89');
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch { /* gone */ } }
  }
})();
