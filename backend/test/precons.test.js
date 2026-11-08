// Precon and Secret Lair import from MTGJSON (routes/precons.js + mtgjsonApi.js).
//
// Offline: MTGJSON answers from trimmed real files in fixtures/precons (the deck
// index and Death Toll, a Duskmourn Commander deck), Scryfall's bulk lookup is
// stubbed, and one card is made to fail on Scryfall so the report of it can be
// checked. Run: `node test/precons.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-precons-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
process.env.SCRYFALL_GAP_SCALE = '0';

const db = require('../src/db');
const mtgjsonApi = require('../src/mtgjsonApi');
const scryfallApi = require('../src/scryfallApi');
const { importLimiter } = require('../src/middleware/auth');
const router = require('../src/routes/precons');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'precons', name), 'utf8'));
const route = (p, method) => router.stack.find(l => l.route?.path === p && l.route.methods[method]).route;
const list = route('/', 'get').stack.at(-1).handle;
const preview = route('/deck', 'get').stack.at(-1).handle;
const importRoute = route('/import', 'post');
const doImport = importRoute.stack.at(-1).handle;

async function call(fn, { query = {}, body = {}, user = 1 } = {}) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(b) { this.body = b; return this; } };
  await fn({ query, body, user: { id: user } }, res);
  return res;
}

const INDEX = fixture('DeckList.json');
const DECK = fixture('DeathToll_DSC.json');
const mtgjsonRequests = [];
mtgjsonApi.client.defaults.adapter = async (config) => {
  mtgjsonRequests.push(config.url);
  assert.match(config.headers['User-Agent'], /^Bindarr\/\S+ \(self-hosted TCG collection manager; https:\/\/github\.com\//,
    'MTGJSON gets a descriptive User-Agent');
  const ok = (data) => ({ status: 200, statusText: 'OK', headers: {}, config, data });
  if (config.url === '/DeckList.json') return ok(INDEX);
  if (config.url === '/decks/DeathToll_DSC.json') return ok(DECK);
  const err = new Error('Request failed with status code 404');
  err.response = { status: 404, headers: {}, data: 'Not Found' };
  throw err;
};

// Scryfall's /cards/collection, answering every id in the deck except one.
const FAILS = '90e9b488-37fd-42db-b0f2-b6c5a15a6e36'; // Demonic Covenant
const deckCards = [...DECK.data.commander, ...DECK.data.mainBoard];
const raw = (c) => ({
  id: c.identifiers.scryfallId, lang: 'en', name: c.name, set: c.setCode.toLowerCase(), set_name: 'Duskmourn Commander',
  collector_number: c.number, rarity: 'rare', type_line: 'Card', colors: [], color_identity: [], cmc: 0,
  prices: { usd: '1.00', usd_foil: '2.00' }, image_uris: { normal: `https://cards.scryfall.io/normal/${c.number}.jpg` },
});
let scryfallAsked = [];
let scryfallDown = false;
scryfallApi.client.defaults.adapter = async (config) => {
  assert.strictEqual(config.url, '/cards/collection');
  if (scryfallDown) throw new Error('connect ECONNREFUSED');
  const { identifiers } = JSON.parse(config.data);
  scryfallAsked.push(...identifiers.map(i => i.id));
  const data = [];
  const notFound = [];
  for (const ident of identifiers) {
    const card = deckCards.find(c => c.identifiers.scryfallId === ident.id);
    if (card && ident.id !== FAILS) data.push(raw(card)); else notFound.push(ident);
  }
  return { status: 200, statusText: 'OK', headers: {}, config, data: { object: 'list', not_found: notFound, data } };
};

async function testListing() {
  let res = await call(list, {});
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.total, 8);
  assert.strictEqual(res.body.version, INDEX.meta.version);
  assert.deepStrictEqual(res.body.decks.slice(0, 2).map(d => d.fileName), ['DandânDeck_SLD', '20WaysToWin_SLD'], 'newest first');
  const lair = res.body.types.find(t => t.type === 'secret-lair');
  assert.strictEqual(lair.count, 5, 'drops plus the Secret Lair Commander and Dandân decks');

  res = await call(list, { query: { type: 'secret-lair' } });
  assert.deepStrictEqual(res.body.decks.map(d => d.code).sort(), ['SLD', 'SLD', 'SLD', 'SLD', 'SLU']);
  res = await call(list, { query: { type: 'Commander Deck' } });
  assert.deepStrictEqual(res.body.decks.map(d => d.name).sort(), ['20 Ways to Win', 'Death Toll', 'Virtue and Valor']);
  res = await call(list, { query: { set: 'dsc' } });
  assert.deepStrictEqual(res.body.decks.map(d => d.fileName), ['DeathToll_DSC']);
  res = await call(list, { query: { q: 'rocks', limit: '1' } });
  assert.strictEqual(res.body.total, 2);
  assert.strictEqual(res.body.decks.length, 1);
  assert.strictEqual(mtgjsonRequests.filter(u => u === '/DeckList.json').length, 1, 'the index is cached, not re-fetched per request');
  console.log('PASS: precon listing and filters');
}

async function testPreview() {
  let res = await call(preview, { query: { file: 'DeathToll_DSC' } });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.name, 'Death Toll');
  assert.strictEqual(res.body.boards.commander[0].name, 'Winter, Cynical Opportunist');
  assert.strictEqual(res.body.copies, 8, 'commander + main board; tokens are not imported');
  assert.ok(!('tokens' in res.body.boards));
  assert.strictEqual(res.body.boards.mainBoard[0].scryfallId, '4dc2d415-fdf7-4f2d-95d0-a793ffc26491');

  const before = mtgjsonRequests.length;
  res = await call(preview, { query: { file: 'NotADeck_XYZ' } });
  assert.strictEqual(res.statusCode, 404);
  res = await call(preview, { query: { file: '../DeckList' } });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(mtgjsonRequests.length, before, 'only file names in the index ever reach MTGJSON');
  console.log('PASS: precon preview');
}

async function testImports() {
  assert.strictEqual(importRoute.stack[0].handle, importLimiter, 'imports share the import rate limit');

  // The commander is already cached, so only the other cards are asked of Scryfall.
  const commander = DECK.data.commander[0];
  await scryfallApi.cacheCards([scryfallApi.normalizeCard(raw(commander))]);
  const box = await db.get(`SELECT id FROM locations WHERE name = 'Bulk Storage Box 1' AND user_id = 1`);

  // --- into the collection, filed into a box
  let res = await call(doImport, { body: { file: 'DeathToll_DSC', mode: 'collection', location_id: box.id } });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(!scryfallAsked.includes(commander.identifiers.scryfallId), 'a cached card is not looked up again');
  assert.strictEqual(res.body.added, 7);
  assert.strictEqual(res.body.unplaced, 0);
  assert.strictEqual(res.body.deck, null);
  assert.deepStrictEqual(res.body.unresolved, [{ name: 'Demonic Covenant', set: 'DSC', number: '19', count: 1, board: 'mainBoard' }],
    'the card Scryfall could not find is reported, not dropped');
  const rows = await db.all(`SELECT c.card_id, c.quantity, c.printing, c.language, c.location_id, c.compartment_id, cc.name
    FROM collection c JOIN card_cache cc ON cc.id = c.card_id WHERE c.user_id = 1 ORDER BY cc.name`);
  assert.strictEqual(rows.length, 7, 'one row per copy');
  assert.ok(rows.every(r => r.quantity === 1 && r.location_id === box.id && r.compartment_id), 'every copy filed into the box');
  assert.strictEqual(rows.filter(r => r.name === 'Swamp').length, 4);
  assert.strictEqual(rows.find(r => r.name === 'Rendmaw, Creaking Nest').printing, 'Holofoil', 'a foil in the box is a foil copy');
  assert.strictEqual(rows.find(r => r.name === 'Deluge of Doom').printing, 'Normal');
  assert.strictEqual(rows[0].language, 'English');

  // --- as a deck: nothing added to the collection
  res = await call(doImport, { body: { file: 'DeathToll_DSC', mode: 'deck', deck_name: '  My Death Toll  ' } });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.added, 0);
  assert.strictEqual(res.body.deck.name, 'My Death Toll');
  const deck = await db.get(`SELECT * FROM decks WHERE id = ?`, [res.body.deck.id]);
  assert.strictEqual(deck.user_id, 1);
  assert.strictEqual(deck.game, 'mtg');
  assert.strictEqual(deck.format, 'Commander / EDH');
  assert.strictEqual(deck.target_size, 8);
  const deckCardsRows = await db.all(`SELECT dc.quantity, cc.name FROM deck_cards dc JOIN card_cache cc ON cc.id = dc.card_id
    WHERE dc.deck_id = ? ORDER BY cc.name`, [deck.id]);
  assert.deepStrictEqual(deckCardsRows.map(r => [r.name, r.quantity]),
    [['Deluge of Doom', 1], ['Rendmaw, Creaking Nest', 1], ['Swamp', 4], ['Winter, Cynical Opportunist', 1]]);
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection WHERE user_id = 1`)).n, 7, 'deck mode adds no copies');

  // --- both, for another user, unfiled
  await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('other', 'x', 'member', 'other-token')`);
  const other = (await db.get(`SELECT id FROM users WHERE username = 'other'`)).id;
  res = await call(doImport, { body: { file: 'DeathToll_DSC', mode: 'both' }, user: other });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.added, 7);
  assert.strictEqual(res.body.deck.name, 'Death Toll');
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection WHERE user_id = ? AND location_id IS NULL`, [other])).n, 7);
  assert.strictEqual((await db.get(`SELECT user_id FROM decks WHERE id = ?`, [res.body.deck.id])).user_id, other);

  // --- refusals
  res = await call(doImport, { body: { file: 'DeathToll_DSC', mode: 'collection', location_id: box.id }, user: other });
  assert.strictEqual(res.statusCode, 400, "another user's box is not a valid location");
  res = await call(doImport, { body: { file: 'DeathToll_DSC', mode: 'binder' } });
  assert.strictEqual(res.statusCode, 400);
  res = await call(doImport, { body: { file: 'Missing_XYZ' } });
  assert.strictEqual(res.statusCode, 404);

  // --- nothing resolves: refused, with the list of what failed
  await db.run(`DELETE FROM deck_cards`);
  await db.run(`DELETE FROM collection`);
  await db.run(`DELETE FROM card_cache`);
  scryfallDown = true;
  res = await call(doImport, { body: { file: 'DeathToll_DSC', mode: 'collection' } });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.unresolved.length, 5);
  assert.strictEqual((await db.get(`SELECT COUNT(*) AS n FROM collection`)).n, 0);
  console.log('PASS: precon import into the collection, a deck, or both');
}

async function main() {
  try {
    await db.initDb();
    await testListing();
    await testPreview();
    await testImports();
  } finally {
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

main()
  .then(() => console.log('Precon import self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
