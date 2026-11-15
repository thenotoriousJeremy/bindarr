// Wanted cards keep their prices moving (WEB-03).
//
// Price alerts watch the cards on a wishlist (notify.js), and read their price
// history. Wanted cards used to be collection rows, which every price sweep
// selects; now they are list items, so each sweep selects the cards on a
// wishlist too (priceHelpers.WISHLIST_CARDS_SQL). A buylist is not a wishlist.
//
// Offline: Scryfall's client is stubbed, TCGCSV's set choice is a database read.
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-wishlistprices-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.SCRYFALL_GAP_SCALE = '0';
process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';
delete process.env.DEFAULT_ADMIN_PASSWORD;

const db = require('../src/db');
const scryfallApi = require('../src/scryfallApi');
const tcgcsv = require('../src/tcgcsvApi');

async function cleanup() {
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

const WISHED = '11111111-1111-1111-1111-111111111111';
const OWNED = '22222222-2222-2222-2222-222222222222';
const BOUGHT = '33333333-3333-3333-3333-333333333333';

async function main() {
  await db.initDb();
  const user = (await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('wisher', 'x', 'member', 'wish-tok')`)).lastID;
  const card = (id, game, setId) => db.run(
    `INSERT INTO card_cache (id, name, game, set_id, set_name, number, language) VALUES (?, ?, ?, ?, ?, '1', 'English')`,
    [id, id, game, setId, setId]
  );
  const list = async (kind, cardIds) => {
    const id = (await db.run(`INSERT INTO card_lists (user_id, name, kind) VALUES (?, ?, ?)`, [user, kind, kind])).lastID;
    for (const cardId of cardIds) await db.run(`INSERT INTO card_list_items (list_id, card_id) VALUES (?, ?)`, [id, cardId]);
  };
  await card(`mtg-${WISHED}`, 'mtg', 'wsh');
  await card(`mtg-${OWNED}`, 'mtg', 'own');
  await card(`mtg-${BOUGHT}`, 'mtg', 'buy');
  await card('pk-wished', 'pokemon', 'sv-wished');
  await card('pk-owned', 'pokemon', 'sv-owned');
  await card('pk-bought', 'pokemon', 'sv-bought');
  for (const id of [`mtg-${OWNED}`, 'pk-owned']) {
    await db.run(`INSERT INTO collection (card_id, user_id, game) VALUES (?, ?, (SELECT game FROM card_cache WHERE id = ?))`, [id, user, id]);
  }
  await list('wishlist', [`mtg-${WISHED}`, 'pk-wished']);
  await list('buylist', [`mtg-${BOUGHT}`, 'pk-bought']);

  // TCGCSV (Pokémon): the sets worth a request.
  const sets = (await tcgcsv.setsToPrice('owned')).map(s => s.set_id).sort();
  assert.deepStrictEqual(sets, ['sv-owned', 'sv-wished'], 'a set with a wanted card is priced; a buylist alone is not');
  console.log('PASS: the TCGCSV sweep prices the sets of wanted cards');

  // Scryfall (Magic): the cards asked for.
  const asked = [];
  scryfallApi.client.defaults.adapter = async (config) => {
    if (!/\/cards\/collection$/.test(config.url)) throw new Error(`Unexpected Scryfall request: ${config.url}`);
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    asked.push(...body.identifiers.map(i => i.id));
    return { status: 200, statusText: 'OK', headers: {}, config, data: { data: [], not_found: [] } };
  };
  await scryfallApi.updateCollectionPrices(true);
  assert.deepStrictEqual(asked.sort(), [WISHED, OWNED].sort(), 'the wanted card is priced with the owned one; a buylist card is not');
  console.log('PASS: the Scryfall sweep prices wanted cards');
}

main()
  .then(cleanup)
  .catch(async (err) => {
    console.error('FAIL:', err);
    await cleanup();
    process.exit(1);
  });
