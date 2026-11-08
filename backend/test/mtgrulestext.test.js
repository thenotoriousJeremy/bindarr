// Magic's rules text in card_cache: the type line, oracle text, mana cost,
// power/toughness/loyalty and keywords that Scryfall-syntax filtering of a
// collection reads (shared/scryfallQuery.mjs).
//
// Against a temp SQLite: the migration adds the columns once and schedules their
// backfill on an upgrade; normalizeCard takes them from Scryfall's card (both faces
// of a double-faced one); cacheCards stores them; other games store NULL; and GET
// /api/collection hands them to the collection screen, keywords as a list.
// No network. No framework — plain node + assert. Run: `node test/mtgrulestext.test.js`
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

process.env.SCRYFALL_GAP_SCALE = '0';
const tmpDb = path.join(os.tmpdir(), `bindarr-mtgrulestext-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');
const scryfall = require('../src/scryfallApi');
const { cacheNormalizedCards } = require('../src/utils/cardCache');
const { parseCardRow } = require('../src/utils/priceHelpers');

let server;
async function cleanup() {
  if (server && server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

const ANGEL = {
  id: '00000000-0000-4000-8000-00000000a001', lang: 'en', name: 'Serra Angel', set: 'dom', set_name: 'Dominaria',
  collector_number: '33', rarity: 'uncommon', type_line: 'Creature — Angel', oracle_text: 'Flying, vigilance',
  mana_cost: '{3}{W}{W}', cmc: 5, power: '4', toughness: '4', colors: ['W'], color_identity: ['W'],
  keywords: ['Flying', 'Vigilance'], image_uris: { normal: 'https://img.test/angel.jpg' }, prices: { usd: '0.40', usd_foil: '2.00' },
};
const BEARS = {
  id: '00000000-0000-4000-8000-00000000a002', lang: 'en', name: 'Grizzly Bears', set: 'lea', set_name: 'Limited Edition Alpha',
  collector_number: '189', rarity: 'common', type_line: 'Creature — Bear', oracle_text: '', mana_cost: '{1}{G}',
  cmc: 2, power: '2', toughness: '2', colors: ['G'], color_identity: ['G'], keywords: [], image_uris: { normal: 'https://img.test/bears.jpg' }, prices: { usd: '0.30' },
};
// Double-faced: text, costs and stats live on the faces, not the top level.
const DELVER = {
  id: '00000000-0000-4000-8000-00000000a003', lang: 'en', name: 'Delver of Secrets // Insectile Aberration', set: 'isd',
  set_name: 'Innistrad', collector_number: '51', rarity: 'common', cmc: 1, color_identity: ['U'], keywords: ['Flying', 'Transform'],
  type_line: 'Creature — Human Wizard // Creature — Human Insect', prices: { usd: '0.50' },
  card_faces: [
    { name: 'Delver of Secrets', mana_cost: '{U}', type_line: 'Creature — Human Wizard', oracle_text: 'At the beginning of your upkeep, look at the top card of your library.', power: '1', toughness: '1', colors: ['U'], image_uris: { normal: 'https://img.test/delver.jpg' } },
    { name: 'Insectile Aberration', mana_cost: '', type_line: 'Creature — Human Insect', oracle_text: 'Flying', power: '3', toughness: '2', colors: ['U'], image_uris: { normal: 'https://img.test/aberration.jpg' } },
  ],
};
// A planeswalker's loyalty, and a split card whose cost is already joined at the top.
const JACE = { id: '00000000-0000-4000-8000-00000000a004', lang: 'en', name: 'Jace, the Mind Sculptor', set: 'wwk', collector_number: '31', rarity: 'mythic', type_line: 'Legendary Planeswalker — Jace', oracle_text: '+2: Look at the top card of target player\'s library.', mana_cost: '{2}{U}{U}', loyalty: '3', cmc: 4, colors: ['U'], color_identity: ['U'], keywords: [], image_uris: { normal: 'https://img.test/jace.jpg' }, prices: {} };
const FIRE_ICE = { id: '00000000-0000-4000-8000-00000000a005', lang: 'en', name: 'Fire // Ice', set: 'apc', collector_number: '128', rarity: 'uncommon', type_line: 'Instant // Instant', mana_cost: '{1}{R} // {1}{U}', cmc: 4, colors: ['R', 'U'], color_identity: ['R', 'U'], keywords: [], image_uris: { normal: 'https://img.test/fireice.jpg' }, prices: {},
  card_faces: [
    { name: 'Fire', mana_cost: '{1}{R}', type_line: 'Instant', oracle_text: 'Fire deals 2 damage divided as you choose among one or two targets.' },
    { name: 'Ice', mana_cost: '{1}{U}', type_line: 'Instant', oracle_text: 'Tap target permanent.\nDraw a card.' },
  ] };
const idOf = (r) => `mtg-${r.id}`;
const RULES = ['type_line', 'oracle_text', 'mana_cost', 'power', 'toughness', 'loyalty', 'keywords'];

async function main() {
  await db.initDb();

  // ---- 1. The migration adds the columns, once, and an upgrade schedules the
  // backfill: clearing the MTG sweep stamp makes this boot's catch-up sweep
  // re-fetch owned and decked cards, and with them their rules text.
  const cols = async () => (await db.all(`PRAGMA table_info(card_cache)`)).map(c => c.name);
  for (const col of RULES) assert.ok((await cols()).includes(col), `card_cache.${col} exists`);
  await db.initDb();
  assert.strictEqual((await cols()).filter(c => RULES.includes(c)).length, RULES.length, 'running the migration again adds nothing');
  await db.run(`UPDATE app_settings SET mtg_prices_swept_at = CURRENT_TIMESTAMP WHERE id = 1`);
  await db.initDb();
  assert.ok((await db.get(`SELECT mtg_prices_swept_at AS at FROM app_settings WHERE id = 1`)).at, 'a boot with nothing to add keeps the stamp');
  await db.run(`ALTER TABLE card_cache DROP COLUMN keywords`);
  await db.initDb();
  assert.ok((await cols()).includes('keywords'), 'a missing column is added back');
  assert.strictEqual((await db.get(`SELECT mtg_prices_swept_at AS at FROM app_settings WHERE id = 1`)).at, null, 'and the stamp is cleared');
  console.log('PASS: migration adds the rules-text columns once and schedules their backfill');

  // ---- 2. normalizeCard reads them off Scryfall's card.
  const angel = scryfall.normalizeCard(ANGEL);
  assert.deepStrictEqual(
    RULES.reduce((o, k) => ({ ...o, [k]: angel[k] }), {}),
    { type_line: 'Creature — Angel', oracle_text: 'Flying, vigilance', mana_cost: '{3}{W}{W}', power: '4', toughness: '4', loyalty: null, keywords: ['Flying', 'Vigilance'] }
  );
  assert.strictEqual(angel.name, 'Serra Angel', 'the rest of the card is as before');
  assert.strictEqual(scryfall.normalizeCard(BEARS).oracle_text, '', 'a vanilla creature\'s empty text is known-empty, not unknown');
  assert.strictEqual(scryfall.normalizeCard(BEARS).mana_cost, '{1}{G}');
  const delver = scryfall.normalizeCard(DELVER);
  assert.strictEqual(delver.type_line, 'Creature — Human Wizard // Creature — Human Insect');
  assert.strictEqual(delver.oracle_text, 'At the beginning of your upkeep, look at the top card of your library.\n//\nFlying', 'both faces\' text');
  assert.strictEqual(delver.mana_cost, '{U}', 'a face with no cost adds nothing');
  assert.deepStrictEqual([delver.power, delver.toughness], ['1', '1'], 'the front face\'s stats');
  assert.deepStrictEqual(delver.keywords, ['Flying', 'Transform']);
  assert.strictEqual(scryfall.normalizeCard(JACE).loyalty, '3');
  const fireIce = scryfall.normalizeCard(FIRE_ICE);
  assert.strictEqual(fireIce.mana_cost, '{1}{R} // {1}{U}', 'a split card keeps Scryfall\'s joined cost');
  assert.strictEqual(fireIce.oracle_text, 'Fire deals 2 damage divided as you choose among one or two targets.\n//\nTap target permanent.\nDraw a card.');
  const bare = scryfall.normalizeCard({ id: '00000000-0000-4000-8000-00000000a0ff', name: 'Mystery', set: 'tst', collector_number: '1' });
  assert.deepStrictEqual(RULES.filter(k => k !== 'oracle_text').map(k => bare[k]), [null, null, null, null, null, null], 'nothing known is NULL, not empty');
  console.log('PASS: normalizeCard carries the rules text');

  // ---- 3. cacheCards stores them; a re-cache refreshes them; other games store NULL.
  await scryfall.cacheCards([ANGEL, BEARS, DELVER, JACE, FIRE_ICE].map(c => scryfall.normalizeCard(c)));
  const stored = await db.get(`SELECT ${RULES.join(', ')} FROM card_cache WHERE id = ?`, [idOf(ANGEL)]);
  assert.deepStrictEqual(stored, { type_line: 'Creature — Angel', oracle_text: 'Flying, vigilance', mana_cost: '{3}{W}{W}', power: '4', toughness: '4', loyalty: null, keywords: '["Flying","Vigilance"]' });
  assert.strictEqual((await db.get(`SELECT oracle_text FROM card_cache WHERE id = ?`, [idOf(BEARS)])).oracle_text, '');
  await scryfall.cacheCards([scryfall.normalizeCard({ ...ANGEL, oracle_text: 'Flying, vigilance (errata)' })]);
  assert.strictEqual((await db.get(`SELECT oracle_text FROM card_cache WHERE id = ?`, [idOf(ANGEL)])).oracle_text, 'Flying, vigilance (errata)', 're-caching refreshes the text');
  await scryfall.cacheCards([scryfall.normalizeCard(ANGEL)]);
  await cacheNormalizedCards([{ id: 'base1-4', name: 'Charizard', supertype: 'Pokémon', subtypes: ['Stage 2'], types: ['Fire'], set_id: 'base1', number: '4' }], 'pokemon');
  assert.deepStrictEqual(Object.values(await db.get(`SELECT ${RULES.join(', ')} FROM card_cache WHERE id = 'base1-4'`)), RULES.map(() => null), 'a Pokémon row stores NULL rules text');
  // parseCardRow turns the stored keywords back into a list, and leaves rows
  // without the column alone.
  assert.deepStrictEqual(parseCardRow(await db.get(`SELECT * FROM card_cache WHERE id = ?`, [idOf(ANGEL)])).keywords, ['Flying', 'Vigilance']);
  assert.strictEqual(parseCardRow(await db.get(`SELECT * FROM card_cache WHERE id = 'base1-4'`)).keywords, null);
  assert.ok(!('keywords' in parseCardRow({ id: 'x', subtypes: '[]' })), 'a row selected without keywords gains no key');
  console.log('PASS: cacheCards stores the rules text');

  // ---- 4. GET /api/collection hands it to the collection screen.
  const alice = (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, 'member', ?)`,
    ['alice', db.hashPassword('x'), `share-alice-${process.pid}`]
  )).lastID;
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, printing, game) VALUES (?, ?, 1, 'Holofoil', 'mtg')`, [idOf(ANGEL), alice]);
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, printing, game) VALUES (?, ?, 1, 'Normal', 'mtg')`, [idOf(DELVER), alice]);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: alice, role: 'member' }; next(); });
  app.use('/api', require('../src/routes/collection'));
  const base = await new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const rows = await (await fetch(`${base}/api/collection`)).json();
  const row = rows.find(r => r.card_id === idOf(ANGEL));
  assert.strictEqual(row.type_line, 'Creature — Angel');
  assert.strictEqual(row.oracle_text, 'Flying, vigilance');
  assert.strictEqual(row.mana_cost, '{3}{W}{W}');
  assert.deepStrictEqual([row.power, row.toughness, row.loyalty], ['4', '4', null]);
  assert.deepStrictEqual(row.keywords, ['Flying', 'Vigilance'], 'keywords arrive as a list');
  assert.strictEqual(row.price_trend, 2, 'priced for the foil copy, which is what usd> filters by');
  assert.strictEqual(rows.find(r => r.card_id === idOf(DELVER)).oracle_text.split('\n//\n').length, 2, 'both faces reach the screen');
  console.log('PASS: GET /api/collection carries the rules text');
}

main()
  .then(async () => { await cleanup(); console.log('mtgrulestext.test.js: all assertions passed'); process.exit(0); })
  .catch(async (err) => { console.error(err); await cleanup(); process.exit(1); });
