// Runnable checks for the Riftbound provider (riftcodexApi) and the catalog
// builder's view of it.
//
// Offline: every RiftCodex response is served from test/fixtures/riftbound by an
// axios adapter, and anything else the code tries to reach is a test failure.
// What is pinned is mostly what fails quietly when wrong — an id that does not
// round-trip (a card that cannot be found again after a CSV import), two printings
// collapsed into one (a Metal valued as the plain promo), a re-cache that erases
// swept prices, an id the API never minted costing a catalogue fetch per request.
//
// No framework — plain node + assert. Run: `node test/riftbound.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-riftbound-${process.pid}.db`);
process.env.RIFTCODEX_BASE_URL = 'https://riftcodex.example.test';
process.env.RIFTCODEX_GAP_MS = '0';

const CARDS = require('./fixtures/riftbound/cards.json');
const SETS = require('./fixtures/riftbound/sets.json');

const db = require('../src/db');
const rc = require('../src/riftcodexApi');
const cardApi = require('../src/utils/cardApi');

// The RiftCodex stand-in: pages of `pageSize` regardless of what is asked, so the
// walk has to follow `pages` rather than trusting its own page size.
const served = [];
let pageSize = 4;
let reportPages = true;
let failWith = null;
// For the walk without a reported page count: 250 synthetic records served at the
// size asked for, so only a genuinely short page can end it.
const MANY = Array.from({ length: 250 }, (_, i) => ({ ...CARDS[0], id: `synthetic${i}`, riftbound_id: `zzz-${i}-250` }));
let source250 = false;
rc.client.defaults.adapter = async (config) => {
  served.push(`${config.url}?page=${config.params && config.params.page}`);
  if (failWith) {
    const err = new Error(`Request failed with status code ${failWith}`);
    err.response = { status: failWith, headers: {}, data: 'nope' };
    err.config = config;
    throw err;
  }
  const page = Number(config.params && config.params.page) || 1;
  const source = config.url === '/cards' ? (source250 ? MANY : CARDS) : config.url === '/sets' ? SETS.items : null;
  if (!source) throw new Error(`unexpected RiftCodex request ${config.url}`);
  const size = config.url === '/cards' && !source250 ? pageSize : Number(config.params && config.params.size) || 100;
  const items = source.slice((page - 1) * size, page * size);
  const data = { items, total: source.length, page, size };
  if (reportPages) data.pages = Math.ceil(source.length / size);
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};

const ID = {
  viSignature: 'riftbound-unl-229.2a-219',
  viOvernumbered: 'riftbound-unl-229-219',
  peacekeeperAlt: 'riftbound-unl-176a-219',
  battlefield: 'riftbound-unl-215-219',
  rune: 'riftbound-ven-r06',
  token: 'riftbound-sfd-t03',
  yasuo: 'riftbound-opp-259-298',
  yasuoMetal: 'riftbound-opp-259-298~69bc5bf1d308c64675ca89f7',
  akali: 'riftbound-ven-189-166',
  akaliPlaceholder: 'riftbound-ven-189-166~6a518b2837f518eaadf8bb0f',
};

(async () => {
  // --- 1. Ids round-trip and stay URL/CSV/SQL-safe --------------------------
  const codes = ['unl-229*-219', 'unl-116a-219', 'sfd-t03', 'ven-sp4-006', 'ogn-001-298', 'x~y.z', 'déjà-1', 'a b/c?d#e'];
  for (const code of codes) {
    const id = rc.cardIdFor(code);
    assert.ok(/^riftbound-[a-z0-9.-]+$/.test(id), `${code} -> ${id} uses only [a-z0-9.-]`);
    assert.strictEqual(encodeURIComponent(id), id, `${id} needs no URL escaping`);
    assert.deepStrictEqual(rc.parseCardId(id), { riftboundId: code.toLowerCase(), variant: null }, `${code} round-trips`);
    const variant = rc.cardIdFor(code, '69BC5BF1d308c64675ca89f7');
    assert.strictEqual(encodeURIComponent(variant), variant);
    assert.deepStrictEqual(rc.parseCardId(variant), { riftboundId: code.toLowerCase(), variant: '69bc5bf1d308c64675ca89f7' });
  }
  assert.strictEqual(rc.cardIdFor('UNL-229*-219'), ID.viSignature, 'case-insensitive, as RiftCodex documents its codes');
  for (const bad of ['', 'mtg-abc', 'riftbound-', 'riftbound-UNL-1', 'riftbound-a*b', 'riftbound-a.zz', 'riftbound-a~b~c', 'riftbound-a~']) {
    assert.strictEqual(rc.parseCardId(bad), null, `${JSON.stringify(bad)} is not a Riftbound id`);
  }
  assert.strictEqual(rc.numberOf('unl-229*-219'), '229*', 'the printing suffix is part of the number');
  assert.strictEqual(rc.numberOf('unl-116a-219'), '116a');
  assert.strictEqual(rc.numberOf('sfd-t03'), 't03');
  assert.strictEqual(rc.numberOf('ven-sp4-006'), 'sp4');

  // --- 2. Normalization and collisions, from real records --------------------
  const cards = rc.normalizeCatalogue(CARDS);
  const byId = new Map(cards.map(c => [c.id, c]));
  assert.strictEqual(cards.length, 14, '15 records: one rune listed twice is one printing');
  assert.strictEqual(new Set(cards.map(c => c.id)).size, cards.length, 'every id is unique');
  for (const id of Object.values(ID)) assert.ok(byId.has(id), `${id} is in the catalogue`);

  const sig = byId.get(ID.viSignature);
  assert.strictEqual(sig.name, 'Vi - Piltover Enforcer (Signature)');
  assert.strictEqual(sig.number, '229*');
  assert.strictEqual(byId.get(ID.viOvernumbered).number, '229', 'the twin keeps its own number');
  assert.strictEqual(sig.supertype, 'Legend');
  assert.deepStrictEqual(sig.types, ['Fury', 'Order'], 'domains are the colours');
  assert.deepStrictEqual(sig.color_identity, ['Fury', 'Order']);
  assert.strictEqual(sig.set_id, 'riftbound-unl');
  assert.strictEqual(sig.set_name, 'Unleashed');
  assert.strictEqual(sig.rarity, 'Rare');
  assert.strictEqual(sig.tcgplayer_product_id, 685522);
  assert.strictEqual(sig.tcgplayer_url, 'https://www.tcgplayer.com/product/685522');
  assert.strictEqual(sig.language, 'English');
  assert.strictEqual(sig.game, 'riftbound');
  assert.strictEqual(sig.artist, 'Jonathan Santoro');
  assert.ok(/excess damage/.test(sig.card_text), 'rules text is kept');
  assert.strictEqual(sig.price_trend, null, 'no price is null, never 0');
  assert.strictEqual(sig.price_currency, 'USD');
  const img = new URL(sig.image_url);
  assert.strictEqual(img.hostname, 'cmsassets.rgpub.io', 'hotlinked from Riot, not copied');
  assert.strictEqual(img.searchParams.get('w'), '480');
  assert.strictEqual(img.searchParams.get('fm'), 'webp');
  assert.strictEqual(img.searchParams.get('accountingTag'), 'RB', "Riot's own query parameter survives");
  assert.strictEqual(new URL(rc.embedImageUrl(sig.image_url)).searchParams.get('w'), '744', 'the catalog embeds the full width');
  assert.strictEqual(rc.displayImageUrl('https://elsewhere.example/x.png'), 'https://elsewhere.example/x.png', 'only Riot\'s CDN is resized');

  const unit = byId.get(ID.peacekeeperAlt);
  assert.strictEqual(unit.supertype, 'Unit');
  assert.deepStrictEqual(unit.subtypes, ['Champion', 'Vi', 'Piltover'], 'supertype first, then the tags');
  assert.strictEqual(unit.cmc, 5, 'energy is the cost');
  assert.deepStrictEqual(unit.attributes, { energy: 5, might: 5, power: 1 }, 'stats kept as an object');

  const field = byId.get(ID.battlefield);
  assert.deepStrictEqual(field.attributes, null, 'a card with no stats has none, rather than an object of nulls');
  assert.strictEqual(field.supertype, 'Battlefield');
  assert.strictEqual(field.orientation, 'landscape', 'battlefields are printed sideways');
  assert.strictEqual(sig.orientation, 'portrait');
  assert.ok(byId.get(ID.token).subtypes.includes('Token'));
  const rune = byId.get(ID.rune);
  assert.strictEqual(rune.supertype, 'Rune');
  assert.strictEqual(rune.tcgplayer_product_id, 706078, 'of a printing listed twice, the record with a product is kept');

  // Same code, different products: never merged, the listed base promo keeps the
  // plain id and the Metal gets its RiftCodex id.
  assert.strictEqual(byId.get(ID.yasuo).name, 'Yasuo - Unforgiven');
  assert.strictEqual(byId.get(ID.yasuoMetal).name, 'Yasuo - Unforgiven (Metal)');
  assert.notStrictEqual(byId.get(ID.yasuo).tcgplayer_product_id, byId.get(ID.yasuoMetal).tcgplayer_product_id);
  // Same code, a stale record under another name: kept (names never merge
  // printings), but the listed one is canonical.
  assert.strictEqual(byId.get(ID.akali).tcgplayer_product_id, 706095);
  assert.strictEqual(byId.get(ID.akaliPlaceholder).tcgplayer_product_id, null);

  // Ids do not depend on the order the API returned the records in.
  const shuffled = [...CARDS].reverse();
  assert.deepStrictEqual(rc.normalizeCatalogue(shuffled).map(c => c.id).sort(), cards.map(c => c.id).sort(),
    'the same records give the same ids in any order');

  // --- 3. Paging -----------------------------------------------------------------
  await db.initDb();
  served.length = 0;
  const walked = await rc.fetchAllPages('/cards');
  assert.strictEqual(walked.length, CARDS.length, 'every page is walked');
  assert.deepStrictEqual(served, ['/cards?page=1', '/cards?page=2', '/cards?page=3', '/cards?page=4']);
  reportPages = false;
  source250 = true;
  served.length = 0;
  assert.strictEqual((await rc.fetchAllPages('/cards')).length, 250, 'without `pages`, the walk goes on to a short page');
  assert.deepStrictEqual(served, ['/cards?page=1', '/cards?page=2', '/cards?page=3']);
  source250 = false;
  reportPages = true;

  // --- 4. The catalogue is fetched on first use, then read from the cache ------
  served.length = 0;
  const first = await rc.searchCards({ name: 'Vi' });
  assert.ok(served.some(u => u.startsWith('/sets')) && served.some(u => u.startsWith('/cards')), 'first use fetches the catalogue');
  assert.ok(first.cards.length >= 4, 'search reads the cached catalogue');
  served.length = 0;
  await rc.searchCards({ name: 'Yasuo' });
  assert.deepStrictEqual(served, [], 'a second search asks RiftCodex nothing');

  const ids = (r) => r.cards.map(c => c.id);
  const byNumber = await rc.searchCards({ number: '229' });
  assert.deepStrictEqual(ids(byNumber).sort(), [ID.viOvernumbered, ID.viSignature].sort(),
    'a number finds both printings that carry it');
  assert.deepStrictEqual(ids(await rc.searchCards({ number: '229*' })), [ID.viSignature], 'the suffix narrows it');
  for (const set of ['UNL', 'unl', 'riftbound-unl', 'Unleashed']) {
    const r = await rc.searchCards({ set });
    assert.ok(r.cards.length === 8 && r.cards.every(c => c.set_id === 'riftbound-unl'), `browsing set ${set} lists the set`);
    assert.strictEqual(r.total, 8, 'the total is the whole match, for paging');
  }
  const browse = await rc.searchCards({ set: 'UNL', limit: 3, page: 2 });
  assert.strictEqual(browse.cards.length, 3);
  assert.strictEqual(browse.total, 8);
  assert.deepStrictEqual(ids(await rc.searchCards({ filters: { type: 'Battlefield' } })), [ID.battlefield]);
  assert.ok((await rc.searchCards({ filters: { domain: 'Fury' } })).cards.every(c => c.types.includes('Fury')));
  assert.ok((await rc.searchCards({ filters: { rarity: 'rare' } })).cards.every(c => c.rarity === 'Rare'), 'rarity is case-insensitive');
  assert.ok((await rc.searchCards({ filters: { supertype: 'Signature' } })).cards.every(c => c.subtypes.includes('Signature')));
  const sets = await db.all(`SELECT id, ptcgo_code, total, release_date FROM sets WHERE game = 'riftbound' ORDER BY id`);
  assert.ok(sets.some(s => s.id === 'riftbound-unl' && s.ptcgo_code === 'UNL' && s.total === 8 && s.release_date === '2026-05-08'),
    `sets are cached with what was cached as their total (${JSON.stringify(sets)})`);

  // --- 5. Ids survive SQLite, and resolve through the card-id dispatch ---------
  assert.strictEqual(cardApi.gameOf(ID.viSignature), 'riftbound');
  assert.strictEqual(cardApi.gameOf(ID.yasuoMetal, 'pokemon'), 'riftbound', 'the prefix outranks the request');
  served.length = 0;
  const fetched = await cardApi.getCardById(ID.yasuoMetal);
  assert.strictEqual(fetched && fetched.name, 'Yasuo - Unforgiven (Metal)', 'a collision id resolves through cardApi');
  assert.strictEqual((await db.get(`SELECT id FROM card_cache WHERE id = ?`, [ID.viSignature])).id, ID.viSignature);
  // An unknown id of ours refreshes the catalogue at most hourly; one that is not
  // ours never reaches RiftCodex at all.
  assert.strictEqual(await cardApi.getCardById('riftbound-unl-999-219'), null);
  assert.strictEqual(await cardApi.getCardById('riftbound-NOT*VALID'), null);
  assert.deepStrictEqual(served, [], 'misses right after a refresh cost no requests');

  // --- 6. A re-cache never erases a swept price -----------------------------------
  await db.run(`UPDATE card_cache SET price_trend = 90.88, price_holofoil = 90.88, price_source = 'tcgcsv' WHERE id = ?`, [ID.viOvernumbered]);
  await rc.refreshCatalogue();
  const kept = await db.get(`SELECT price_trend, price_holofoil, price_source, name FROM card_cache WHERE id = ?`, [ID.viOvernumbered]);
  assert.deepStrictEqual(kept, { price_trend: 90.88, price_holofoil: 90.88, price_source: 'tcgcsv', name: 'Vi - Piltover Enforcer (Overnumbered)' },
    'RiftCodex has no prices, so its re-cache must keep the ones the sweep wrote');

  // --- 7. The catalog builder's sources --------------------------------------------
  const cardSets = require('../src/cardSets');
  const catalog = require('../src/catalog');
  assert.ok(catalog.GAMES.includes('riftbound'), 'Riftbound catalogs can be built');
  const setCodes = await cardSets.listAllSets('riftbound', 'English');
  assert.ok(['unl', 'opp', 'ven', 'sfd'].every(code => setCodes.includes(code)), `the walk covers the cached sets (${setCodes})`);
  const unl = await cardSets.cacheSetCards('riftbound', 'unl', 'English');
  assert.strictEqual(unl.length, 8);
  assert.ok(unl.every(c => c.img && c.set === 'riftbound-unl'), 'each set card carries its art');
  await assert.rejects(cardSets.cacheSetCards('riftbound', 'nope', 'English'), e => e.absent,
    'a set with nothing cached is a gap, not a failure');
  // The image the scanner matches: Riot's full-width rendition, for portrait and
  // landscape cards alike (catalog.js squashes both into the 448 square the camera
  // dewarp also produces, so a battlefield photographed the way it is printed matches).
  const fieldRow = await db.get(`SELECT id, image_url FROM card_cache WHERE id = ?`, [ID.battlefield]);
  const embed = new URL(catalog.embedUrl(fieldRow));
  assert.strictEqual(embed.searchParams.get('w'), '744');
  assert.ok(/1039x744\.png$/.test(embed.pathname), 'the landscape original, unrotated');
  assert.strictEqual(catalog.embedUrl({ id: 'tcgdex-en-x-1', image_url: 'https://assets.tcgdex.net/en/x/1/low.png' }),
    'https://assets.tcgdex.net/en/x/1/high.png', 'the other providers keep their own swaps');
  // --- 7b. Set completion lists a Riftbound set from the cached catalogue --------
  const setListing = require('../src/setListing');
  assert.ok(setListing.supports('riftbound'));
  served.length = 0;
  const listing = await setListing.getListing('riftbound', 'UNL', 'en');
  assert.strictEqual(listing.ids.length, 8, 'the whole set, from the cache');
  assert.ok(listing.ids.includes(ID.viSignature) && listing.ids.includes(ID.battlefield));
  assert.strictEqual(listing.set.id, 'riftbound-unl');
  assert.strictEqual(listing.set.tcgplayer_set_code, 'UNL', "TCGplayer's group code is the set code");
  assert.strictEqual(listing.source, 'riftcodex');
  assert.deepStrictEqual(served, [], 'listing a set asks RiftCodex nothing once the catalogue is cached');
  assert.deepStrictEqual(setListing.listingKey('riftbound', 'riftbound-UNL', 'ja'), { setId: 'riftbound-unl', lang: 'en' });
  assert.strictEqual(await setListing.getListing('riftbound', 'NOPE', 'en'), null, 'an unknown set lists nothing');

  // No catalog built: the scanner says so rather than guessing.
  assert.strictEqual(require('../src/cvScan').isBuilt('riftbound', 'English'), false);

  // --- 8. RiftCodex down with nothing cached is a clean 503, and it backs off --------
  await db.run(`DELETE FROM card_cache WHERE game = 'riftbound'`);
  failWith = 503;
  await assert.rejects(rc.searchCards({ name: 'Vi' }), /UPSTREAM_UNAVAILABLE/);
  const tries = served.length;
  await assert.rejects(rc.searchCards({ name: 'Vi' }), /UPSTREAM_UNAVAILABLE/);
  assert.strictEqual(served.length, tries, 'a second miss inside the backoff does not ask again');
  failWith = null;

  console.log('riftbound self-check passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
