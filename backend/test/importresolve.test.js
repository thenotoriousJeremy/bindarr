// A CSV import must resolve each row to a real card, or say it could not (#75).
//
// The importer used to mint an id from the row — `<set>-<number>`, or the card
// name as a slug when it found no set/number columns — and insert a placeholder
// card_cache row with no image and no price. No provider ever saw those rows, so
// a 786-card import showed blank art and $0.00 on every card and the TCGCSV sweep
// skipped them all. Offline: TCGdex is answered by an axios adapter.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-importresolve-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const axios = require('axios');
const db = require('../src/db');
const tcgdexApi = require('../src/tcgdexApi');
const scryfallApi = require('../src/scryfallApi');
const lorcastApi = require('../src/lorcastApi');
const importRouter = require('../src/routes/importExport');

axios.defaults.adapter = async (config) => { throw new Error(`Unexpected network request: ${config.url}`); };

const SETS = [
  { id: 'sv01', name: 'Scarlet & Violet', cardCount: { official: 198, total: 258 } },
  { id: 'sv09', name: 'Journey Together', cardCount: { official: 159, total: 190 } },
];
const SPRIGATITO = {
  id: 'sv01-001', localId: '001', name: 'Sprigatito', category: 'Pokemon', rarity: 'Common',
  image: 'https://assets.tcgdex.net/en/sv/sv01/001', set: { id: 'sv01', name: 'Scarlet & Violet' },
};
const requests = [];
tcgdexApi.client.defaults.adapter = async (config) => {
  requests.push(config.url);
  const ok = (data) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
  if (config.url === '/en/sets') return ok(SETS);
  if (config.url === '/en/sets/sv01') return ok({ ...SETS[0], cards: [{ id: 'sv01-001', localId: '001', name: 'Sprigatito' }] });
  if (config.url === '/en/sets/sv09') return ok({ ...SETS[1], cards: [] });
  if (config.url === '/en/cards/sv01-001') return ok(SPRIGATITO);
  const err = new Error('Not found');
  err.response = { status: 404 };
  throw err;
};

// Scryfall's /cards/collection: knows MH3 #1 only.
const BREAKER = '11111111-2222-3333-4444-555555555555';
const scryfallBatches = [];
scryfallApi.client.defaults.adapter = async (config) => {
  const { identifiers } = JSON.parse(config.data);
  scryfallBatches.push(identifiers);
  const data = identifiers.filter(i => i.set === 'mh3' && i.collector_number === '1').map(() => ({
    id: BREAKER, name: 'Breaker of Creation', set: 'mh3', set_name: 'Modern Horizons 3', collector_number: '1',
    rarity: 'mythic', prices: { usd: '2.50' }, image_uris: { normal: 'https://cards.scryfall.io/normal/front/breaker.jpg' },
  }));
  const not_found = identifiers.filter(i => !(i.set === 'mh3' && i.collector_number === '1'));
  return { data: { object: 'list', data, not_found }, status: 200, statusText: 'OK', headers: {}, config };
};

// Lorcast search: set 1, number 1 only.
lorcastApi.client.defaults.adapter = async (config) => {
  const q = (config.params && config.params.q) || '';
  const results = q.includes('number:1') && q.includes('set:1') && !q.includes('number:10') ? [{
    id: 'crd_ariel', name: 'Ariel', version: 'On Human Legs', collector_number: '1', rarity: 'Uncommon',
    set: { code: '1', name: 'The First Chapter' }, prices: { usd: '0.40' },
    image_uris: { digital: { normal: 'https://cards.lorcast.io/ariel.avif' } },
  }] : [];
  return { data: { results }, status: 200, statusText: 'OK', headers: {}, config };
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

async function main() {
  await db.initDb();
  await db.run(`UPDATE app_settings SET pokemon_provider = 'tcgdex' WHERE id = 1`);

  // A third-party export: set NAME in a "Set" column, "Number" as printed. The
  // last two rows cannot be identified — a number the set does not have, and a
  // name with no set or number at all — and must be reported, not stored.
  const res = await importCsv([
    'Name,Set,Number,Quantity',
    'Sprigatito,Scarlet & Violet,001/198,2',
    "Iono's Voltorb,Journey Together,999,1",
    'Parasect,,,1',
  ].join('\n'));

  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.count, 2, 'both Sprigatito copies are imported');
  assert.deepStrictEqual(res.body.unresolved.map(r => r.name), ["Iono's Voltorb", 'Parasect']);
  assert.match(res.body.message, /2 rows could not be matched/);

  const rows = await db.all(`
    SELECT c.card_id, cc.set_id, cc.number, cc.image_url
      FROM collection c JOIN card_cache cc ON cc.id = c.card_id`);
  assert.strictEqual(rows.length, 2);
  for (const row of rows) {
    assert.strictEqual(row.card_id, 'tcgdex-en-sv01-001');
    assert.strictEqual(row.set_id, 'sv01', 'set id is what the TCGCSV sweep prices by');
    assert.strictEqual(row.number, '001');
    assert.ok(row.image_url.endsWith('/low.png'), 'resolved card carries its art');
  }
  assert.strictEqual(await db.get(`SELECT id FROM card_cache WHERE id IN ('parasect', 'journey together-999')`), undefined,
    'no placeholder card is minted for an unresolved row');

  // Bindarr's own export columns, carrying pokemontcg.io's set id (sv1) on a
  // TCGdex install that numbers the same set sv01.
  const own = await importCsv(['Name,Set ID,Card Number,Quantity', 'Sprigatito,sv1,1,1'].join('\n'));
  assert.strictEqual(own.statusCode, 200, JSON.stringify(own.body));
  assert.strictEqual(own.body.count, 1);
  assert.deepStrictEqual(own.body.unresolved, []);

  // Nothing resolvable at all is a failed import, not "Successfully imported 0".
  const none = await importCsv(['Name,Quantity', 'Parasect,1'].join('\n'));
  assert.strictEqual(none.statusCode, 400);
  assert.strictEqual(none.body.unresolved.length, 1);

  assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM collection`)).n, 3);
  assert.ok(requests.includes('/en/cards/sv01-001'));

  // MTG and Lorcana exports give set code + collector number, no card id. MTG
  // goes to Scryfall in one batch; the zero-padded 001 must still pair with #1.
  const other = await importCsv([
    'Name,Set Code,Card Number,Quantity,Game',
    'Breaker of Creation,MH3,001,2,mtg',
    'Not A Card,MH3,999,1,mtg',
    'Ariel - On Human Legs,1,1,1,lorcana',
    'Nobody,1,10,1,lorcana',
  ].join('\n'));
  assert.strictEqual(other.statusCode, 200, JSON.stringify(other.body));
  assert.strictEqual(other.body.count, 3);
  assert.deepStrictEqual(other.body.unresolved.map(r => r.name), ['Not A Card', 'Nobody']);
  assert.strictEqual(scryfallBatches.length, 1, 'MTG rows are asked for in one batch');
  assert.strictEqual(scryfallBatches[0].length, 2);
  const art = await db.all(`
    SELECT DISTINCT c.card_id, cc.image_url FROM collection c JOIN card_cache cc ON cc.id = c.card_id
     WHERE c.game IN ('mtg', 'lorcana') ORDER BY c.card_id`);
  assert.deepStrictEqual(art.map(r => r.card_id), ['lorcana-crd_ariel', `mtg-${BREAKER}`]);
  for (const r of art) assert.ok(r.image_url.startsWith('https://'), `${r.card_id} carries its art`);
}

main()
  .then(() => console.log('Import card resolution self-check passed'))
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => {
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  });
