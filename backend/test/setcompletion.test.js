// Set completion: the counting rules (utils/setCompletion.js) and the endpoint that
// applies them to a provider's listing (routes/setCompletion.js + setListing.js).
//
// Offline: every provider client has its axios adapter replaced, TCGdex and Scryfall
// answer from trimmed real responses in fixtures/setcompletion, and anything else
// that tries the network fails the test. Run: `node test/setcompletion.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-set-completion-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
process.env.SCRYFALL_GAP_SCALE = '0'; // the stubbed Scryfall is not rate limited
process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';

const db = require('../src/db');
const tcgdexApi = require('../src/tcgdexApi');
const scryfallApi = require('../src/scryfallApi');
const lorcastApi = require('../src/lorcastApi');
const tcgApi = require('../src/tcgApi');
const tcgcsvApi = require('../src/tcgcsvApi');
const completion = require('../src/utils/setCompletion');
const router = require('../src/routes/setCompletion');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'setcompletion', name), 'utf8'));
const handler = (p) => router.stack.find(l => l.route?.path === p && l.route.methods.get).route.stack.at(-1).handle;
const getCompletion = handler('/');
const getSets = handler('/sets');

async function call(fn, query, userId = 1) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await fn({ query, user: { id: userId } }, res);
  return res;
}

const reply = (config, data, status = 200) => {
  if (status >= 400) {
    const err = new Error(`Request failed with status code ${status}`);
    err.response = { status, data, headers: {}, config };
    err.config = config;
    throw err;
  }
  return { status, statusText: 'OK', headers: {}, config, data };
};
const refuse = (name) => async (config) => { throw new Error(`Unexpected ${name} request: ${config.url}`); };

// --- 1. Counting rules -------------------------------------------------------------
function testRules() {
  const { numberKey, compareNumbers, summarize, buildCompletion } = completion;

  // Providers disagree about padding and suffixes; the key must not.
  assert.strictEqual(numberKey('001'), '1');
  assert.strictEqual(numberKey('1'), '1');
  assert.strictEqual(numberKey('TG01'), 'tg1');
  assert.strictEqual(numberKey('4/102'), '4');
  assert.strictEqual(numberKey('100'), '100', 'zeros inside a number are not padding');
  assert.strictEqual(numberKey('0'), '0');
  assert.notStrictEqual(numberKey('1a'), numberKey('1'), '1a is its own card');
  assert.notStrictEqual(numberKey('1★'), numberKey('1'), 'a starred number is its own card');

  assert.deepStrictEqual(['10', 'TG01', '2', '1a', '001'].sort(compareNumbers), ['001', '1a', '2', '10', 'TG01']);

  // Unknown prices are counted, never summed as zero, and currencies never mix.
  const s = summarize([
    { owned: true, price: 9, currency: 'USD' },
    { owned: false, price: 1.25, currency: 'USD' },
    { owned: false, price: 2, currency: 'EUR' },
    { owned: false, price: null, currency: 'USD' },
  ]);
  assert.deepStrictEqual(s, { total: 4, owned: 1, missing: 3, percent: 25, missing_value: { USD: 1.25, EUR: 2 }, unpriced_missing: 1 });
  assert.strictEqual(summarize([]).percent, 0);

  // Variants: finishes come from priced columns, an owned finish the data did not
  // list is added, and a card with no finish data stays one entry.
  const set = { id: 'sv01', name: 'Scarlet & Violet' };
  const r = buildCompletion({
    game: 'pokemon',
    set,
    cards: [
      { id: 'a', number: '001', price_trend: 0.2, price_normal: 0.2, price_reverse_holofoil: 0.4, price_currency: 'USD', price_source: 'tcgcsv' },
      { id: 'b', number: '002', price_trend: 0 },
    ],
    owned: [
      { set_id: 'sv1', set_name: 'Scarlet & Violet', number: '1', quantity: 1, printing: 'Holofoil', list_type: 'collection' },
      { set_id: 'sv01', set_name: 'Scarlet & Violet', number: '002', quantity: 1, printing: 'Normal', list_type: 'wishlist' },
    ],
  });
  const a = r.cards.find(c => c.id === 'a');
  assert.deepStrictEqual(a.variants.map(v => [v.printing, v.owned]), [['Normal', 0], ['Reverse Holofoil', 0], ['Holofoil', 1]],
    'a Holofoil copy in hand is a finish that exists, even unpriced');
  const b = r.cards.find(c => c.id === 'b');
  assert.strictEqual(b.owned, 0, 'a wishlist row is not an owned copy');
  assert.strictEqual(b.wishlisted, true);
  assert.strictEqual(b.price, null, 'a zero price is an unknown price');
  assert.deepStrictEqual(r.summary.cards, { total: 2, owned: 1, missing: 1, percent: 50, missing_value: {}, unpriced_missing: 1 });
  assert.deepStrictEqual(r.summary.variants, { total: 4, owned: 1, missing: 3, percent: 25, missing_value: { USD: 0.6 }, unpriced_missing: 1 });

  // No finish data anywhere: the variant summary is absent, not a copy of the card one.
  const plain = buildCompletion({ game: 'pokemon', set, cards: [{ id: 'x', number: '1' }], owned: [] });
  assert.strictEqual(plain.summary.variants, null);
  // A TCGdex row's holo column can be Cardmarket's reverse-holo price, so it is not
  // evidence of a holo printing (TCGdex says sv01-001 is normal + reverse only).
  assert.deepStrictEqual(completion.knownVariants(
    { price_source: 'tcgdex', price_normal: 0.12, price_holofoil: 0.16, price_currency: 'USD' }), []);
  assert.deepStrictEqual(completion.knownVariants(
    { price_source: 'pokemontcgapi-cardmarket', price_normal: 0.1, price_reverse_holofoil: 0.3 }).map(v => v.printing),
  ['Normal', 'Reverse Holofoil']);
  // Magic has no variant mode, and its set codes are not matched by name.
  const mtg = buildCompletion({
    game: 'mtg', set: { id: 'fdn', name: 'Foundations' },
    cards: [{ id: 'm', number: '1', price_trend: 2, price_normal: 2, price_holofoil: 5 }],
    owned: [{ set_id: 'pfdn', set_name: 'Foundations', number: '1', quantity: 1, printing: 'Normal' }],
  });
  assert.deepStrictEqual(mtg.cards[0].variants, []);
  assert.strictEqual(mtg.cards[0].owned, 0, 'a promo-set copy is not a copy of the main set card');
  console.log('PASS: counting rules');
}

// --- 2. Pokémon via TCGdex ------------------------------------------------------------
async function testPokemon() {
  await db.run(`UPDATE app_settings SET pokemon_provider = 'tcgdex' WHERE id = 1`);
  const set = fixture('tcgdex-sv01.json');
  const requests = [];
  tcgdexApi.client.defaults.adapter = async (config) => {
    requests.push(config.url);
    if (config.url === '/en/sets') return reply(config, [{ id: 'sv01', name: 'Scarlet & Violet', cardCount: { official: 198, total: 258 } }]);
    if (config.url === '/en/sets/sv01') return reply(config, set);
    return reply(config, { error: 'not found' }, 404);
  };

  // A hydrated, TCGCSV-priced row the set brief must not overwrite.
  await db.run(`INSERT INTO card_cache (id, name, supertype, rarity, set_id, set_name, number, image_url, price_trend, price_normal,
      price_reverse_holofoil, price_currency, price_source, tcgplayer_product_id, game, language)
    VALUES ('tcgdex-en-sv01-002', 'Heracross', 'Pokémon', 'Uncommon', 'sv01', 'Scarlet & Violet', '002', 'img', 0.25, 0.25, 0.5, 'USD', 'tcgcsv', 490001, 'pokemon', 'English')`);
  // A Cardmarket-priced one, so the missing value has to keep euros apart.
  await db.run(`INSERT INTO card_cache (id, name, supertype, rarity, set_id, set_name, number, price_trend, price_normal, price_currency, game, language)
    VALUES ('tcgdex-en-sv01-003', 'Shroomish', 'Pokémon', 'Common', 'sv01', 'Scarlet & Violet', '003', 0.3, 0.3, 'EUR', 'pokemon', 'English')`);
  // A copy filed under pokemontcg.io's numbering of the same set (sv1, '1').
  await db.run(`INSERT INTO card_cache (id, name, set_id, set_name, number, game) VALUES ('sv1-1', 'Pineco', 'sv1', 'Scarlet & Violet', '1', 'pokemon')`);
  await db.run(`INSERT INTO card_cache (id, name, set_id, set_name, number, game) VALUES ('tcgdex-en-sv01-004', 'Breloom', 'sv01', 'Scarlet & Violet', '004', 'pokemon')`);
  await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('other', 'x', 'member', 'other-token')`);
  const other = (await db.get(`SELECT id FROM users WHERE username = 'other'`)).id;
  const add = (card, printing = 'Normal', listType = 'collection', user = 1) => db.run(
    `INSERT INTO collection (card_id, user_id, quantity, printing, list_type, game) VALUES (?, ?, 1, ?, ?, 'pokemon')`,
    [card, user, printing, listType]);
  await add('sv1-1', 'Normal');
  await add('sv1-1', 'Reverse Holofoil');
  await add('tcgdex-en-sv01-002', 'Normal');
  await add('tcgdex-en-sv01-004', 'Normal', 'wishlist');
  await add('tcgdex-en-sv01-003', 'Normal', 'collection', other); // somebody else's

  // A bare dashboard link in the OTHER numbering: game and language inferred, set resolved.
  let res = await call(getCompletion, { set: 'sv1' });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  const body = res.body;
  assert.strictEqual(body.game, 'pokemon');
  assert.strictEqual(body.lang, 'en');
  assert.strictEqual(body.set.id, 'sv01', 'sv1 is TCGdex sv01');
  assert.strictEqual(body.set.name, 'Scarlet & Violet');
  assert.strictEqual(body.set.total, 258);
  assert.ok(body.set.logo_url.endsWith('/logo.png'));
  assert.deepStrictEqual(body.cards.map(c => c.number), ['001', '002', '003', '004', '198', '245']);
  const byNum = Object.fromEntries(body.cards.map(c => [c.number, c]));
  assert.strictEqual(byNum['001'].owned, 2, 'copies under the other numbering count');
  assert.deepStrictEqual(byNum['001'].owned_printings, { Normal: 1, 'Reverse Holofoil': 1 });
  assert.strictEqual(byNum['002'].owned, 1);
  assert.strictEqual(byNum['003'].owned, 0, "another user's copy is not yours");
  assert.strictEqual(byNum['004'].owned, 0);
  assert.strictEqual(byNum['004'].wishlisted, true);
  assert.strictEqual(byNum['004'].image_url, '', 'a card with no art is still in the set');
  assert.strictEqual(byNum['002'].tcgplayer_product_id, 490001);
  assert.deepStrictEqual(body.summary.cards,
    { total: 6, owned: 2, missing: 4, percent: 33.3, missing_value: { EUR: 0.3 }, unpriced_missing: 3 });
  // 001 has no finish data (one entry, owned); 002 Normal owned + Reverse missing at
  // $0.50; 003 Normal missing at €0.30; the rest one unpriced entry each.
  assert.deepStrictEqual(body.summary.variants,
    { total: 7, owned: 2, missing: 5, percent: 28.6, missing_value: { USD: 0.5, EUR: 0.3 }, unpriced_missing: 3 });

  const kept = await db.get(`SELECT rarity, price_normal, tcgplayer_product_id FROM card_cache WHERE id = 'tcgdex-en-sv01-002'`);
  assert.deepStrictEqual(kept, { rarity: 'Uncommon', price_normal: 0.25, tcgplayer_product_id: 490001 }, 'a set brief must not clobber a hydrated row');
  const thin = await db.get(`SELECT name, image_url, last_updated FROM card_cache WHERE id = 'tcgdex-en-sv01-245'`);
  assert.strictEqual(thin.name, 'Gardevoir ex');
  assert.strictEqual(thin.last_updated, '1970-01-01 00:00:00', 'brief rows are stamped stale so adding one hydrates it');

  // The second view is a database read.
  const before = requests.length;
  res = await call(getCompletion, { set: 'sv01', game: 'pokemon' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(requests.length, before, 'a cached listing must not re-fetch the set');
  assert.strictEqual(res.body.summary.cards.owned, 2);

  // Unknown set, and a set id that is not one.
  res = await call(getCompletion, { set: 'nope1', game: 'pokemon' });
  assert.strictEqual(res.statusCode, 404);
  res = await call(getCompletion, { set: '../etc', game: 'pokemon' });
  assert.strictEqual(res.statusCode, 400);
  res = await call(getCompletion, { set: 'never-owned' });
  assert.strictEqual(res.statusCode, 400, 'a set the user owns nothing from needs its game');
  console.log('PASS: Pokémon listing via TCGdex');
}

// --- 3. Magic via Scryfall ----------------------------------------------------------
async function testMtg() {
  const pages = fixture('scryfall-fdn.json');
  const requested = [];
  scryfallApi.client.defaults.adapter = async (config) => {
    requested.push(config.url);
    const url = new URL(config.url, 'https://api.scryfall.com');
    if (url.pathname !== '/cards/search') throw new Error(`Unexpected Scryfall request: ${config.url}`);
    assert.strictEqual(url.searchParams.get('q'), 'set:fdn unique:prints include:extras -is:digital');
    return reply(config, url.searchParams.get('page') === '2' ? pages.page2 : pages.page1);
  };
  // A Japanese copy of #1 (its own Scryfall id), and a token from the token set.
  await db.run(`INSERT INTO card_cache (id, name, set_id, set_name, number, game, language)
    VALUES ('mtg-jp-1', 'Sire of Seven Deaths', 'fdn', 'Foundations', '1', 'mtg', 'Japanese')`);
  await db.run(`INSERT INTO card_cache (id, name, set_id, set_name, number, game) VALUES ('mtg-tok-1', 'Cat', 'tfdn', 'Foundations Tokens', '1', 'mtg')`);
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, printing, language, game) VALUES ('mtg-jp-1', 1, 1, 'Holofoil', 'Japanese', 'mtg')`);
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, game) VALUES ('mtg-tok-1', 1, 1, 'mtg')`);

  const res = await call(getCompletion, { set: 'mtg-fdn', game: 'mtg' });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(requested.length, 2, 'both result pages are read');
  const { body } = res;
  assert.strictEqual(body.set.id, 'fdn');
  assert.strictEqual(body.set.tcgplayer_set_code, 'FDN');
  assert.deepStrictEqual(body.cards.map(c => [c.number, c.owned]), [['1', 1], ['2', 0], ['272', 0]],
    'a Japanese copy completes the English number; a token does not');
  assert.deepStrictEqual(body.cards.map(c => c.tcgplayer_product_id), [567801, 567802, 567803]);
  assert.strictEqual(body.summary.variants, null, 'Magic has no variant mode');
  assert.deepStrictEqual(body.summary.cards,
    { total: 3, owned: 1, missing: 2, percent: 33.3, missing_value: { USD: 0.1 }, unpriced_missing: 1 });
  console.log('PASS: Magic listing via Scryfall');
}

// --- 4. Lorcana via Lorcast, and the owned-sets picker -----------------------------
async function testLorcanaAndPicker() {
  const set = fixture('lorcast-set1.json');
  lorcastApi.client.defaults.adapter = async (config) => {
    assert.strictEqual(config.url, '/cards/search');
    return reply(config, config.params.q === 'set:1' ? set : { results: [] });
  };
  await db.run(`INSERT INTO card_cache (id, name, set_id, set_name, number, game) VALUES ('lorcana-crd_mickey_1', 'Mickey Mouse - Brave Little Tailor', 'lorcana-1', 'The First Chapter', '115', 'lorcana')`);
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, game) VALUES ('lorcana-crd_mickey_1', 1, 1, 'lorcana')`);

  let res = await call(getCompletion, { set: 'lorcana-2' });
  assert.strictEqual(res.statusCode, 404, 'the set prefix says Lorcana; Lorcast has no cards for set 2 here');
  res = await call(getCompletion, { set: 'lorcana-1' });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.game, 'lorcana');
  assert.deepStrictEqual(res.body.cards.map(c => [c.number, c.owned]), [['115', 1], ['195', 0]]);
  assert.deepStrictEqual(res.body.summary.cards.missing_value, { USD: 2.32 });

  res = await call(getSets, {});
  assert.strictEqual(res.statusCode, 200);
  const keys = res.body.map(s => `${s.game}:${s.set_id}`);
  assert.ok(keys.includes('pokemon:sv1') && keys.includes('pokemon:sv01') && keys.includes('mtg:fdn') && keys.includes('lorcana:lorcana-1'), keys.join(','));
  assert.ok(!keys.includes('pokemon:sv01') || res.body.find(s => s.set_id === 'sv01').owned === 1, 'wishlist rows are not counted');
  res = await call(getSets, { game: 'mtg' });
  assert.ok(res.body.every(s => s.game === 'mtg'));
  res = await call(getSets, {}, 999);
  assert.deepStrictEqual(res.body, [], 'another user sees none of these sets');
  console.log('PASS: Lorcana listing and the owned-sets list');
}

async function main() {
  tcgApi.tcgClient.defaults.adapter = refuse('pokemontcg.io');
  tcgcsvApi.client.defaults.adapter = refuse('TCGCSV');
  try {
    await db.initDb();
    testRules();
    await testPokemon();
    await testMtg();
    await testLorcanaAndPicker();
  } finally {
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

main()
  .then(() => console.log('Set completion self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
