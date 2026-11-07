// A CSV export from another collection app must import what it says: the foil, the
// exact printing, the game, and only the copies it lists.
//
// Settings uploads every .csv as format 'csv', so they all reach the generic
// mapper, which read none of what a Magic export carries. A ManaBox file lost its
// Foil column, its Scryfall ID and its "Collector number" (it looked for "Card
// number"), was filed as Pokémon, and a row of 0 copies became 1. A Dragon Shield
// file's "sep=," line was taken for the header, so no column had a name at all.
// TCGplayer's "Reverse Holofoil" was flattened to Normal, and its set never
// resolved because only the code ("SVI") was read, never the name beside it.
//
// The fixtures in fixtures/csv use each app's export header row as written:
// ManaBox's documented import/export columns, Dragon Shield's (separator line and
// trailing padding row included, as the DragonShield-to-Moxfield converter
// handles them), and TCGplayer's collection export. Offline: Scryfall and TCGdex
// are answered by axios adapters. Run: `node test/csvimport.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-csvimport-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
// The HTTP layer is stubbed, so there is no real API to pace against.
process.env.SCRYFALL_GAP_SCALE = '0';

const axios = require('axios');
const db = require('../src/db');
const tcgdexApi = require('../src/tcgdexApi');
const scryfallApi = require('../src/scryfallApi');
const importRouter = require('../src/routes/importExport');
const { parseThirdPartyCSV, parsePrice, parseQuantity } = require('../src/utils/csvMappers');

axios.defaults.adapter = async (config) => { throw new Error(`Unexpected network request: ${config.url}`); };

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'csv', name), 'utf8');

// Scryfall's /cards/collection over a five-card catalogue, by id or set + number.
const SCRYFALL = [
  ['11111111-2222-3333-4444-555555555555', 'Breaker of Creation', 'mh3', '1', 'en'],
  ['22222222-3333-4444-5555-666666666666', 'Rescue, Pepper Potts', 'msc', '755', 'en'],
  ['33333333-4444-5555-6666-777777777777', 'Master Transmuter', 'plst', 'CON-31', 'en'],
  ['44444444-5555-6666-7777-888888888888', 'Sol Ring', 'c21', '263', 'en'],
  ['66666666-7777-8888-9999-aaaaaaaaaaaa', 'Lightning Bolt', 'sta', '42', 'ja'],
].map(([id, name, set, collector_number, lang]) => ({
  id, name, set, set_name: set.toUpperCase(), collector_number, lang, rarity: 'rare',
  prices: { usd: '1.00', usd_foil: '2.00' }, image_uris: { normal: `https://cards.scryfall.io/normal/${id}.jpg` },
}));
const batches = [];
scryfallApi.client.defaults.adapter = async (config) => {
  if (config.url !== '/cards/collection') throw new Error(`Unexpected Scryfall request: ${config.url}`);
  const { identifiers } = JSON.parse(config.data);
  batches.push(identifiers);
  const find = (i) => SCRYFALL.find(c => (i.id ? c.id === i.id
    : c.set === String(i.set).toLowerCase() && c.collector_number.toLowerCase() === String(i.collector_number).toLowerCase()));
  return {
    data: { object: 'list', data: identifiers.map(find).filter(Boolean), not_found: identifiers.filter(i => !find(i)) },
    status: 200, statusText: 'OK', headers: {}, config,
  };
};

// TCGdex: one set, two cards. TCGplayer names the set "SVI" (its own code) and
// "Scarlet & Violet"; TCGdex calls it sv01, so only the name can join them.
const brief = (localId, name) => ({ id: `sv01-${localId}`, localId, name });
const full = (localId, name) => ({
  ...brief(localId, name), category: 'Pokemon', rarity: 'Common',
  image: `https://assets.tcgdex.net/en/sv/sv01/${localId}`, set: { id: 'sv01', name: 'Scarlet & Violet' },
});
tcgdexApi.client.defaults.adapter = async (config) => {
  const ok = (data) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
  const set = { id: 'sv01', name: 'Scarlet & Violet', cardCount: { official: 198, total: 258 } };
  if (config.url === '/en/sets') return ok([set]);
  if (config.url === '/en/sets/sv01') return ok({ ...set, cards: [brief('001', 'Sprigatito'), brief('002', 'Floragato')] });
  if (config.url === '/en/cards/sv01-001') return ok(full('001', 'Sprigatito'));
  if (config.url === '/en/cards/sv01-002') return ok(full('002', 'Floragato'));
  const err = new Error('Not found');
  err.response = { status: 404 };
  throw err;
};

const handler = importRouter.stack.find(layer => layer.route?.path === '/import').route.stack.at(-1).handle;
async function importCsv(data) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ body: { format: 'csv', data }, user: { id: 1, tcg_api_key: '' } }, res);
  return res;
}
const imported = () => db.all(`
  SELECT card_id, printing, condition, language, game, purchase_price FROM collection ORDER BY card_id, printing, id`);
const mtg = (uuid) => `mtg-${uuid}`;

function testMapper() {
  // Bindarr's own export names no game, but its card ids do.
  const own = parseThirdPartyCSV([
    { 'Card ID': mtg(SCRYFALL[0].id), 'Name': 'Breaker of Creation', 'Set ID': 'mh3', 'Card Number': '1', 'Printing': 'Holofoil' },
    { 'Card ID': 'lorcana-crd_ariel', 'Name': 'Ariel - On Human Legs', 'Set ID': 'lorcana-1', 'Card Number': '1' },
    { 'Card ID': 'sv1-1', 'Name': 'Sprigatito', 'Set ID': 'sv1', 'Card Number': '1' },
  ], 'csv');
  assert.deepStrictEqual(own.map(r => r.game), ['mtg', 'lorcana', 'pokemon']);
  assert.strictEqual(own[0].printing, 'Holofoil', 'the stored vocabulary round-trips');

  // Header spellings are matched case-, space- and punctuation-blind.
  const [spelled] = parseThirdPartyCSV([{ '\uFEFFNAME': 'Sol Ring', 'set_code': 'C21', 'COLLECTOR NUMBER': '263', 'qty': '2' }], 'csv');
  assert.strictEqual(spelled.name, 'Sol Ring', 'a BOM on the first header is ignored');
  assert.strictEqual(spelled.collector_number, '263');
  assert.strictEqual(spelled.quantity, 2);

  // A game column wins, however it is spelled.
  const lines = parseThirdPartyCSV([
    { 'Product Line': 'Magic: The Gathering', 'Product Name': 'Sol Ring', 'Number': '263', 'Condition': 'Near Mint Foil' },
    { 'Product Line': 'Pokémon', 'Product Name': 'Sprigatito', 'Number': '001', 'Condition': 'Lightly Played Reverse Holofoil' },
  ], 'tcgplayer');
  assert.deepStrictEqual(lines.map(r => [r.game, r.condition, r.printing]), [
    ['mtg', 'Near Mint', 'Holofoil'],
    ['pokemon', 'Lightly Played', 'Reverse Holofoil'],
  ], "TCGplayer's seller export puts the finish in the condition cell");

  // Moxfield's and Archidekt's collection exports, by their own header rows.
  const [moxfield] = parseThirdPartyCSV([{ 'Count': '3', 'Tradelist Count': '0', 'Name': 'Sol Ring', 'Edition': 'c21',
    'Condition': 'NM', 'Language': 'English', 'Foil': 'foil', 'Alter': 'False', 'Proxy': 'False', 'Purchase Price': '1.10',
    'Collector Number': '263' }], 'csv');
  assert.deepStrictEqual([moxfield.game, moxfield.set_code, moxfield.collector_number, moxfield.quantity, moxfield.printing],
    ['mtg', 'c21', '263', 3, 'Holofoil']);
  const [archidekt] = parseThirdPartyCSV([{ 'Quantity': '1', 'Name': 'Sol Ring', 'Set Code': 'c21', 'Set Name': 'Commander 2021',
    'Collector Number': '263', 'Condition': 'NM', 'Language': 'English', 'Foil': 'false',
    'Scryfall ID': SCRYFALL[3].id, 'Oracle ID': '6ad8011d-3471-4369-9d68-b264cc027487' }], 'csv');
  assert.deepStrictEqual([archidekt.game, archidekt.card_id, archidekt.printing], ['mtg', mtg(SCRYFALL[3].id), 'Normal']);

  // A printing the collection.printing CHECK constraint refuses never gets through.
  const [odd] = parseThirdPartyCSV([{ 'Name': 'Sol Ring', 'Set': 'C21', 'Number': '263', 'Printing': 'Shiny?' }], 'csv');
  assert.strictEqual(odd.printing, 'Normal');

  assert.strictEqual(parseQuantity(''), 1, 'no quantity means one copy');
  assert.strictEqual(parseQuantity('0'), 0, 'a stated zero stays zero');
  assert.ok(Number.isNaN(parseQuantity('a few')), 'an unreadable quantity is not one');
  assert.strictEqual(parsePrice('$1.50'), 1.5);
  assert.strictEqual(parsePrice('1,50'), 1.5, 'a European decimal comma');
  assert.strictEqual(parsePrice('1,234.50'), 1234.5);
  assert.strictEqual(parsePrice(''), 0);
}

async function testManaBox() {
  const res = await importCsv(fixture('manabox.csv'));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.count, 6, 'two Breakers and four singles; the 0-copy Bolt is not one of them');
  assert.deepStrictEqual(res.body.unresolved, []);
  assert.match(res.body.message, /1 row with a quantity of 0 \(or none readable\) was skipped/);

  // Every row was asked for by its Scryfall id: the exact printing, in one batch.
  assert.strictEqual(batches.length, 1);
  assert.deepStrictEqual(batches[0].map(i => i.id), SCRYFALL.map(c => c.id));

  const rows = await imported();
  assert.deepStrictEqual(rows.map(r => [r.card_id, r.printing]), [
    [mtg(SCRYFALL[0].id), 'Normal'],
    [mtg(SCRYFALL[0].id), 'Normal'],
    [mtg(SCRYFALL[1].id), 'Holofoil'],
    [mtg(SCRYFALL[2].id), 'Normal'],
    [mtg(SCRYFALL[3].id), 'Holofoil'],   // etched is a foil
    [mtg(SCRYFALL[4].id), 'Holofoil'],
  ]);
  assert.ok(rows.every(r => r.game === 'mtg'), 'a ManaBox file is Magic');
  const byCard = (uuid) => rows.find(r => r.card_id === mtg(uuid));
  assert.strictEqual(byCard(SCRYFALL[4].id).language, 'Japanese', "ManaBox's 'ja' is stored as the language's name");
  assert.strictEqual(byCard(SCRYFALL[1].id).condition, 'Moderately Played', "Cardmarket's Light Played");
  assert.strictEqual(byCard(SCRYFALL[2].id).condition, 'Near Mint', "Cardmarket's Excellent");
  assert.strictEqual(byCard(SCRYFALL[0].id).purchase_price, 2.5);
}

async function testDragonShield() {
  batches.length = 0;
  const res = await importCsv(fixture('dragonshield-mtg.csv'));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.count, 4);
  assert.deepStrictEqual(res.body.unresolved, [], 'the padding row is not reported as an unmatched card');
  assert.match(res.body.message, /1 row with a quantity of 0 \(or none readable\) was skipped/);

  // No ids here, so set + number; The List's CON-31 is sent whole.
  assert.deepStrictEqual(batches[0].map(i => `${i.set}:${i.collector_number}`), ['mh3:1', 'c21:263', 'plst:CON-31']);

  const rows = await imported();
  assert.deepStrictEqual(rows.map(r => [r.card_id, r.printing, r.condition]), [
    [mtg(SCRYFALL[0].id), 'Normal', 'Near Mint'],
    [mtg(SCRYFALL[0].id), 'Normal', 'Near Mint'],
    [mtg(SCRYFALL[2].id), 'Holofoil', 'Near Mint'],
    [mtg(SCRYFALL[3].id), 'Holofoil', 'Moderately Played'],
  ]);
  assert.ok(rows.every(r => r.game === 'mtg'), 'a Dragon Shield file is Magic');
  assert.strictEqual(rows[3].purchase_price, 1.1, "'Price Bought' is the purchase price");
}

async function testTcgplayer() {
  const res = await importCsv(fixture('tcgplayer.csv'));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.count, 4);
  assert.deepStrictEqual(res.body.unresolved, []);

  const rows = await imported();
  assert.deepStrictEqual(rows.map(r => [r.card_id, r.printing, r.condition]), [
    ['tcgdex-en-sv01-001', 'Normal', 'Near Mint'],
    ['tcgdex-en-sv01-001', 'Normal', 'Near Mint'],
    ['tcgdex-en-sv01-001', 'Reverse Holofoil', 'Lightly Played'],
    ['tcgdex-en-sv01-002', 'Holofoil', 'Near Mint'],
  ]);
  assert.ok(rows.every(r => r.game === 'pokemon'));
}

async function main() {
  testMapper();
  await db.initDb();
  await db.run(`UPDATE app_settings SET pokemon_provider = 'tcgdex' WHERE id = 1`);
  for (const run of [testManaBox, testDragonShield, testTcgplayer]) {
    await db.run(`DELETE FROM collection`);
    await run();
  }

  // A file with no copies to import (0, or a quantity nobody can read) imports
  // nothing, and says why.
  const none = await importCsv('Name,Set code,Collector number,Quantity,Scryfall ID\nSol Ring,C21,263,0,\nSol Ring,C21,263,a few,');
  assert.strictEqual(none.statusCode, 400);
  assert.match(none.body.error, /no row has a quantity of 1 or more/);
  assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM collection`)).n, 4, 'nothing was added');
}

main()
  .then(() => console.log('CSV import self-check passed'))
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => {
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  });
