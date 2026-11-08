// ManaBox plaintext must preserve the exact set/collector printing needed for Scryfall.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseManaboxText, parseDecklistLine } = require('../src/utils/csvMappers');

const cards = parseManaboxText(fs.readFileSync(path.join(__dirname, 'fixtures', 'manabox', 'Patrick.txt'), 'utf8'));
const card = (set, number, printing = 'Normal') => cards.find(c =>
  c.set_code === set && c.collector_number === number && c.printing === printing
);

assert.deepStrictEqual(card('PLS', '58'), {
  name: 'Caldera Kavu',
  set_code: 'PLS',
  collector_number: '58',
  quantity: 2,
  condition: 'Near Mint',
  printing: 'Normal',
  game: 'mtg'
});
// † and ★ are part of Scryfall's collector number, not annotations: POR 118† is
// the Starter Deck printing of Blaze, a different card_cache row from POR 118, so
// stripping the mark looked up the wrong printing.
assert.strictEqual(card('POR', '118†').printing, 'Normal', 'a dagger must not make a card foil');
assert.strictEqual(card('POR', '118'), undefined, 'the dagger stays on the number');
assert.strictEqual(card('7ED', '339★', 'Holofoil').quantity, 1, 'ManaBox foil markers must be retained');
assert.ok(cards.length > 0, 'the supplied ManaBox export must yield cards');

// The tokens exporters put after a name are parsed out of it, never left on it.
const line = (text) => parseDecklistLine(text);
assert.deepStrictEqual(line('1 Master Transmuter (PLST) CON-31'),
  { quantity: 1, name: 'Master Transmuter', set_code: 'PLST', collector_number: 'CON-31', foil: false },
  "The List's set-prefixed number is read whole");
assert.deepStrictEqual(line('1 Rescue, Pepper Potts (MSC) 755 *F*'),
  { quantity: 1, name: 'Rescue, Pepper Potts', set_code: 'MSC', collector_number: '755', foil: true });
assert.strictEqual(line('1 Sol Ring (C21) 263 *E*').foil, true, 'etched is a foil finish');
assert.strictEqual(line('1 Sol Ring (C21) 263 foil').foil, true, 'a trailing finish word after a printing');
assert.deepStrictEqual(line('1 Foil (PCY) 34'),
  { quantity: 1, name: 'Foil', set_code: 'PCY', collector_number: '34', foil: false }, 'Foil is also a card');
for (const xmage of ['4 [M10:146] Lightning Bolt', '4 Lightning Bolt [M10:146]']) {
  assert.deepStrictEqual(line(xmage),
    { quantity: 4, name: 'Lightning Bolt', set_code: 'M10', collector_number: '146', foil: false }, xmage);
}
assert.deepStrictEqual(line('1x Sol Ring (c21) 263 [Ramp] ^Have,#37d67a^'),
  { quantity: 1, name: 'Sol Ring', set_code: 'c21', collector_number: '263', foil: false }, 'Archidekt tags');
assert.strictEqual(line('1 Hazmat Suit (Used) (UNH) 57').name, 'Hazmat Suit (Used)', 'the last (SET) is the printing');
assert.deepStrictEqual(line('4 Pikachu ex SVI 63'),
  { quantity: 4, name: 'Pikachu ex', set_code: 'SVI', collector_number: '63', foil: false });
assert.strictEqual(line('1 Mewtwo GX').name, 'Mewtwo GX', 'a trailing uppercase word is part of the name');
assert.strictEqual(line('// COMMANDER'), null);
assert.strictEqual(line(`1 ${' '.repeat(100000)}(`), null, 'a wall of text is not a card line (and is not backtracked over)');

// A printing whose lines add up to no copies is not a printing to import.
assert.deepStrictEqual(parseManaboxText('0 Sol Ring (C21) 263\n1 Blaze (POR) 118†').map(c => c.collector_number), ['118†']);

async function testImportRoute() {
  const os = require('os');
  const tmpDb = path.join(os.tmpdir(), `bindarr-manabox-test-${process.pid}.db`);
  process.env.DB_PATH = tmpDb;
  process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

  const db = require('../src/db');
  const scryfallApi = require('../src/scryfallApi');
  const importRouter = require('../src/routes/importExport');
  const originalBulkFetch = scryfallApi.bulkFetchByIdentifier;
  const originalCacheCards = scryfallApi.cacheCards;
  const handler = importRouter.stack.find(layer => layer.route?.path === '/import').route.stack.at(-1).handle;

  try {
    await db.initDb();
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES (?, ?, ?)`, ['mtg-caldera', 'Caldera Kavu', 'mtg']);
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES (?, ?, ?)`, ['mtg-mountain', 'Mountain', 'mtg']);

    scryfallApi.bulkFetchByIdentifier = async (rows) => ({
      cards: [],
      pairs: rows.map(row => ({
        row,
        card: { id: row.name === 'Caldera Kavu' ? 'mtg-caldera' : 'mtg-mountain' }
      }))
    });
    scryfallApi.cacheCards = async () => {};

    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await handler({
      body: { format: 'manabox', data: '2 Caldera Kavu (PLS) 58\n1 Mountain (7ED) 339★ *F*' },
      user: { id: 1 }
    }, res);

    assert.strictEqual(res.statusCode, 200);
    // One collection row per copy (#64), so `2 Caldera Kavu` lands as two rows.
    assert.strictEqual(res.body.count, 3);
    assert.deepStrictEqual(await db.all(
      `SELECT card_id, quantity, printing, game FROM collection ORDER BY card_id`
    ), [
      { card_id: 'mtg-caldera', quantity: 1, printing: 'Normal', game: 'mtg' },
      { card_id: 'mtg-caldera', quantity: 1, printing: 'Normal', game: 'mtg' },
      { card_id: 'mtg-mountain', quantity: 1, printing: 'Holofoil', game: 'mtg' }
    ]);
  } finally {
    scryfallApi.bulkFetchByIdentifier = originalBulkFetch;
    scryfallApi.cacheCards = originalCacheCards;
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

testImportRoute()
  .then(() => console.log('ManaBox parser and import self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
