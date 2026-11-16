// The Riftbound sets RiftCodex lacks, served from TCGplayer's catalogue
// (riftboundTcgplayer.js): the ids it works out, what it writes and what it leaves
// to RiftCodex, the reads that see it, prices, and the hand-over when RiftCodex
// adds the set — same ids, held cards kept (#181).
//
// Offline: the TCGCSV cache is stubbed on tcgcsvApi with real category 89 rows
// (test/fixtures/riftbound/tcgplayer-89.json), RiftCodex is an axios adapter over
// the RiftCodex fixtures, and the one sync the fallback may start is a stub.
//
// No framework — plain node + assert. Run: `node test/riftboundtcgplayer.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-riftboundtcgplayer-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.RIFTCODEX_BASE_URL = 'https://riftcodex.example.test';
process.env.RIFTCODEX_GAP_MS = '0';
process.env.BINDARR_DISABLE_TCGCSV_SYNC = '1';

const clone = (v) => JSON.parse(JSON.stringify(v));
const FIX = require('./fixtures/riftbound/tcgplayer-89.json');
const LATER = require('./fixtures/riftbound/riftcodex-later.json');
const CARDS = require('./fixtures/riftbound/cards.json');
const SETS = require('./fixtures/riftbound/sets.json');

const db = require('../src/db');
const tcgcsv = require('../src/tcgcsvApi');
const tcgcsvGames = require('../src/tcgcsvGameApi');
const rc = require('../src/riftcodexApi');
const fallback = require('../src/riftboundTcgplayer');
const prices = require('../src/riftboundPrices');
const cardApi = require('../src/utils/cardApi');
const setListing = require('../src/setListing');

// --- the TCGCSV cache ---
let GROUPS = clone(FIX.groups);
let PRODUCTS = clone(FIX.products);
let PRICES = clone(FIX.prices);
let version = null;
let cached89 = true;
const miss = (p) => Object.assign(new Error(`TCGCSV cache is missing ${p}`), { code: 'TCGCSV_CACHE_MISS' });
const has89 = (cat) => version && cached89 && cat === 89;
tcgcsv.currentVersion = async () => version;
tcgcsv.getGroups = async (cat) => { if (!has89(cat)) throw miss(`/tcgplayer/${cat}/groups`); return GROUPS; };
let productsGate = null;   // { gid, promise }: a read of that group's products waits on it
tcgcsv.getProducts = async (cat, gid) => {
  if (!has89(cat) || !(gid in PRODUCTS)) throw miss(`/tcgplayer/${cat}/${gid}/products`);
  if (productsGate && String(productsGate.gid) === String(gid)) await productsGate.promise;
  return PRODUCTS[gid];
};
tcgcsv.getPrices = async (cat, gid) => {
  if (!has89(cat) || !(gid in PRODUCTS)) throw miss(`/tcgplayer/${cat}/${gid}/prices`);
  return PRICES[gid] || [];
};
tcgcsv.syncIfUpdatedSafely = async () => null;   // the price sweep's own sync
let syncs = 0;
tcgcsvGames.setFirstUseSync(async () => { syncs++; cached89 = true; return { updated: true }; });

// --- RiftCodex ---
let rcCards = [...CARDS, ...LATER.PR];
let rcSets = [...SETS.items];
rc.client.defaults.adapter = async (config) => {
  const page = Number(config.params && config.params.page) || 1;
  const size = Number(config.params && config.params.size) || 100;
  const source = config.url === '/cards' ? rcCards : config.url === '/sets' ? rcSets : null;
  if (!source) throw new Error(`unexpected RiftCodex request ${config.url}`);
  const items = source.slice((page - 1) * size, page * size);
  return { data: { items, total: source.length, page, size, pages: Math.ceil(source.length / size) }, status: 200, statusText: 'OK', headers: {}, config };
};

const card = (id) => db.get(`SELECT * FROM card_cache WHERE id = ?`, [id]);
const ids = async (setId) => (await db.all(`SELECT id FROM card_cache WHERE set_id = ? ORDER BY id`, [setId])).map(r => r.id);
const state = async () => JSON.parse((await db.get(
  `SELECT product_hashes FROM tcgcsv_catalogues WHERE game = ?`, [fallback.STATE_KEY]
)).product_hashes);

const RAD = {
  ekko: 'riftbound-rad-061-167',
  ekkoAlt: 'riftbound-rad-061a-167',
  jarvan: 'riftbound-rad-179.2a-167',
  aphelios: 'riftbound-rad-179.2a-167~tcgp724664',
  rune: 'riftbound-rad-r02',
  kaisa: 'riftbound-rad-sp4-005',
  blade: 'riftbound-rad-150-167',
  token: 'riftbound-rad-tcgp728142',
};

async function main() {
  await db.initDb();
  const quiet = console.log;
  console.log = () => {};
  try {
    // --- 1. Ids: RiftCodex's own, from TCGplayer's numbers ---------------------
    assert.strictEqual(fallback.codeTail('061a/167'), '061a-167');
    assert.strictEqual(fallback.codeTail('229*/219'), '229*-219');
    assert.strictEqual(fallback.codeTail('R02a'), 'r02a');
    assert.strictEqual(fallback.codeTail('SP4/005'), 'sp4-005');
    for (const odd of ['T02 // T05', 'T1S 001/005', '', null, '1/2/3', '*12/5']) {
      assert.strictEqual(fallback.codeTail(odd), null, `${JSON.stringify(odd)} has no RiftCodex shape`);
    }
    assert.strictEqual(fallback.looseNumber('T02 // T05'), 't02 // t05');
    assert.strictEqual(fallback.looseNumber('T1S 001/005'), 't1s 001');

    // The same ids RiftCodex gives the same printings: Unleashed's Vi, both of them.
    const unl = fallback.assignIds('unl', FIX.products['24560']);
    const theirs = new Map(rc.normalizeCatalogue(CARDS).map(c => [c.tcgplayer_product_id, c.id]));
    for (const pid of [685521, 685522]) assert.strictEqual(unl.get(pid).id, theirs.get(pid), `product ${pid}`);
    assert.strictEqual(unl.get(685522).number, '229*');

    // One Number, several products: no printing marker first, then the oldest product.
    const annie = [
      { productId: 669265, name: 'Annie, Dark Child (Metal) (Best Of)', number: '017/024' },
      { productId: 680247, name: 'Annie, Dark Child', number: '017/024' },
      { productId: 689178, name: 'Annie, Dark Child (Metal) (Prize Wall)', number: '017/024' },
    ];
    const a = fallback.assignIds('opp', annie);
    assert.strictEqual(a.get(680247).id, 'riftbound-opp-017-024', 'the plain printing keeps the plain id, though newer');
    assert.strictEqual(a.get(669265).id, 'riftbound-opp-017-024~tcgp669265');
    assert.strictEqual(a.get(689178).id, 'riftbound-opp-017-024~tcgp689178');
    assert.deepStrictEqual([...fallback.assignIds('opp', [...annie].reverse())].sort(), [...a].sort(), 'order makes no difference');
    assert.deepStrictEqual(rc.parseCardId(a.get(669265).id), { riftboundId: 'opp-017-024', variant: 'tcgp669265' });
    // A Number of no RiftCodex shape: the product id, unique even for twins.
    const t1 = fallback.assignIds('t12025', [
      { productId: 716012, name: 'Ambessa, The Wolf (T1 Bundle)', number: 'T1S 001/005' },
      { productId: 716013, name: 'Ambessa, The Wolf (T1 Bundle) (Serial Numbered)', number: 'T1S 001/005' },
    ]);
    assert.deepStrictEqual([t1.get(716012).id, t1.get(716013).id], ['riftbound-t12025-tcgp716012', 'riftbound-t12025-tcgp716013']);
    assert.strictEqual(t1.get(716012).number, 't1s 001');

    // --- 2. Nothing is written before RiftCodex's catalogue is ------------------
    version = 'v1';
    assert.deepStrictEqual(await fallback.ensure({ sync: false }), { skipped: 'RiftCodex catalogue not cached' });
    assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM card_cache`)).n, 0, 'anything might be RiftCodex\'s');

    // --- 3. RiftCodex, then the groups it lacks -----------------------------------
    await rc.refreshCatalogue();
    assert.ok((await state()).riftcodex.includes('riftbound-unl'), 'RiftCodex\'s sets are recorded at its refresh');
    const first = await fallback.ensure({ sync: false });
    assert.deepStrictEqual(first, { cards: 9, removed: 0, kept: 0 }, JSON.stringify(first));
    assert.deepStrictEqual(await ids('riftbound-rad'), Object.values(RAD).sort());

    const alt = await card(RAD.ekkoAlt);
    assert.strictEqual(alt.name, 'Ekko, Ingenious (Alternate Art)');
    assert.strictEqual(alt.number, '061a', 'the number as RiftCodex writes it');
    assert.strictEqual(alt.rarity, 'Showcase');
    assert.strictEqual(alt.set_name, 'Radiance');
    assert.strictEqual(alt.game, 'riftbound');
    assert.strictEqual(alt.language, 'English');
    assert.strictEqual(alt.tcgplayer_product_id, 722295);
    assert.strictEqual(alt.tcgplayer_url, 'https://www.tcgplayer.com/product/722295');
    assert.strictEqual(alt.image_url, 'https://tcgplayer-cdn.tcgplayer.com/product/722295_200w.jpg');
    assert.deepStrictEqual([alt.price_trend, alt.price_normal, alt.price_holofoil, alt.price_source], [0.99, null, 0.99, 'tcgcsv'],
      'today\'s quote: Foil only, so the foil price and the trend');
    const rune = await card(RAD.rune);
    assert.deepStrictEqual([rune.number, rune.price_normal, rune.price_trend], ['r02', 0.09, 0.09]);
    assert.strictEqual((await card(RAD.jarvan)).image_url, '', 'no TCGplayer picture: no image, not a url that answers 403');
    assert.strictEqual((await card(RAD.aphelios)).name, 'Aphelios, Exalted (Heartsteel Signature)');
    assert.strictEqual((await card(RAD.token)).number, 't02 // t05');
    assert.strictEqual(await db.get(`SELECT id FROM card_cache WHERE tcgplayer_product_id = 711362`), undefined, 'sealed product is not a card');

    const radSet = await db.get(`SELECT * FROM sets WHERE id = 'riftbound-rad'`);
    assert.deepStrictEqual(
      [radSet.name, radSet.ptcgo_code, radSet.release_date, radSet.series, radSet.total, radSet.game],
      ['Radiance', 'RAD', '2026-10-23', 'TCGplayer', 8, 'riftbound']
    );
    // RiftCodex's sets and products are its own.
    const vi = await db.all(`SELECT id, name FROM card_cache WHERE tcgplayer_product_id = 685522`);
    assert.deepStrictEqual(vi.map(r => r.name), ['Vi - Piltover Enforcer (Signature)'], 'Unleashed is not duplicated');
    assert.deepStrictEqual(await ids('riftbound-rwb'), ['riftbound-rwb-278a-298~tcgp722659'],
      'the bundle\'s Bandle Tree is RiftCodex\'s (under PR); only its Oversized printing is written');
    assert.strictEqual(await db.get(`SELECT id FROM sets WHERE id = 'riftbound-lgc'`), undefined, 'a group of sealed product only is no set');

    // --- 4. Every read sees them ----------------------------------------------------
    const byName = await rc.searchCards({ name: 'Ekko' });
    assert.deepStrictEqual(byName.cards.map(c => c.id).sort(), [RAD.ekko, RAD.ekkoAlt]);
    const browse = await rc.searchCards({ set: 'RAD' });
    assert.strictEqual(browse.total, 8);
    assert.strictEqual(browse.cards[0].set_id, 'riftbound-rad', 'newest set first');
    assert.strictEqual((await rc.getCardById(RAD.kaisa)).name, "Kai'Sa, Rebel (K/DA Special Art Card)");
    assert.strictEqual((await cardApi.getCardById(RAD.aphelios, { game: 'riftbound' })).tcgplayer_product_id, 724664);
    const codes = await rc.listSetCodes();
    assert.ok(codes.includes('rad') && codes.includes('rwb') && codes.includes('unl'), codes.join(','));
    assert.strictEqual((await rc.getCardsBySet('RAD')).length, 8);
    const listing = await setListing.getListing('riftbound', 'RAD');
    assert.strictEqual(listing.ids.length, 8);
    assert.strictEqual(listing.set.name, 'Radiance');
    assert.strictEqual(listing.set.tcgplayer_set_code, 'RAD', 'TCGplayer\'s abbreviation for Mass Entry');

    // --- 5. Only what changed is written; a day without data takes nothing away ---
    assert.deepStrictEqual(await fallback.ensure({ sync: false }), { unchanged: true });
    version = 'v2';
    assert.deepStrictEqual(await fallback.ensure({ sync: false }), { cards: 0, removed: 0, kept: 0 }, 'a new day, the same products');
    version = 'v3';
    const held = PRODUCTS['24819'];
    PRODUCTS['24819'] = [];
    assert.deepStrictEqual(await fallback.ensure({ sync: false }), { cards: 0, removed: 0, kept: 0 });
    assert.strictEqual((await ids('riftbound-rad')).length, 8, 'no product list today: the set stays as it was');
    PRODUCTS['24819'] = held;
    cached89 = false;
    version = 'v3-nothing';
    assert.deepStrictEqual(await fallback.ensure({ sync: false }), { missing: true });
    assert.strictEqual((await ids('riftbound-rad')).length, 8, 'no category 89 at all: nothing removed either');
    cached89 = true;

    // --- 6. Prices: the Riftbound sweep, by product id -----------------------------
    const user = (await db.run(`INSERT INTO users (username, password_hash, share_token) VALUES ('u', 'x', 't')`)).lastID;
    await db.run(`INSERT INTO collection (card_id, user_id, game) VALUES (?, ?, 'riftbound')`, [RAD.ekkoAlt, user]);
    await db.run(`INSERT INTO collection (card_id, user_id, game) VALUES (?, ?, 'riftbound')`, [RAD.kaisa, user]);
    version = 'v4';
    PRICES['24819'] = PRICES['24819'].map(p => (p.productId === 722295 ? { ...p, marketPrice: 1.5 } : p));
    const swept = await prices.updateCollectionPrices(true);
    assert.ok(swept.priced >= 9, JSON.stringify(swept));
    assert.strictEqual((await card(RAD.ekkoAlt)).price_holofoil, 1.5, 'priced off its own product');
    assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM price_history WHERE card_id = ?`, [RAD.ekkoAlt])).n, 1, 'a held card gets its history point');

    // --- 7. TCGplayer renumbers one product and drops another someone holds ---------
    const deck = (await db.run(`INSERT INTO decks (user_id, name, game) VALUES (?, 'd', 'riftbound')`, [user])).lastID;
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, 1)`, [deck, RAD.blade]);
    await db.run(`INSERT INTO price_history (card_id, price) VALUES (?, 1)`, [RAD.aphelios]);
    PRODUCTS['24819'] = PRODUCTS['24819']
      .filter(p => p.productId !== 722279)
      .map(p => (p.productId === 724664 ? { ...p, number: '184*/167' } : p));
    version = 'v5';
    const renumbered = await fallback.ensure({ sync: false });
    assert.deepStrictEqual(renumbered, { cards: 7, removed: 1, kept: 1 }, JSON.stringify(renumbered));
    assert.strictEqual(await card(RAD.aphelios), undefined, 'the old id goes: nothing held it');
    assert.strictEqual(await db.get(`SELECT card_id FROM price_history WHERE card_id = ?`, [RAD.aphelios]), undefined, 'with its history');
    assert.strictEqual((await card('riftbound-rad-184.2a-167')).tcgplayer_product_id, 724664, 'its new number, its own id');
    assert.ok(await card(RAD.blade), 'a decked card TCGplayer no longer lists stays');
    assert.strictEqual((await card(RAD.jarvan)).name, 'Jarvan IV, Exemplar of Demacia (Signature)', 'the twin left alone has its id still');

    // Never over a row of RiftCodex's: a card of another set on one of these ids.
    await db.run(`INSERT INTO card_cache (id, name, game, set_id) VALUES ('riftbound-zzz-001-010', 'RiftCodex''s', 'riftbound', 'riftbound-unl')`);
    GROUPS = [...GROUPS, { groupId: 99999, name: 'Zed Set', abbreviation: 'ZZZ', publishedOn: '2026-11-01T00:00:00' }];
    PRODUCTS['99999'] = [{ productId: 99001, name: 'Zed', number: '001/010' }, { productId: 99002, name: 'Zed Two', number: '002/010' }];
    version = 'v6';
    await fallback.ensure({ sync: false });
    assert.strictEqual((await card('riftbound-zzz-001-010')).name, "RiftCodex's", 'left as it was');
    assert.deepStrictEqual(await ids('riftbound-zzz'), ['riftbound-zzz-002-010']);

    // --- 8. RiftCodex adds Radiance: same ids, its rows win, held cards stay ---------
    await db.run(`INSERT INTO set_listings (game, language, set_id, source, card_ids) VALUES ('riftbound', 'en', 'riftbound-rad', 'riftcodex', '[]')
      ON CONFLICT(game, language, set_id) DO UPDATE SET card_ids = '[]'`);
    rcCards = [...rcCards, ...LATER.RAD];
    rcSets = [...rcSets, LATER.RAD_SET];
    await rc.refreshCatalogue();
    const taken = await card(RAD.ekkoAlt);
    assert.strictEqual(taken.name, 'Ekko - Ingenious (Alternate Art)', 'the same id, now RiftCodex\'s card');
    assert.strictEqual(taken.supertype, 'Unit');
    assert.match(taken.image_url, /cmsassets\.rgpub\.io/);
    assert.strictEqual(taken.price_holofoil, 1.5, 'and the price the sweep found');
    assert.strictEqual((await db.get(`SELECT card_id FROM collection WHERE card_id = ?`, [RAD.ekkoAlt])).card_id, RAD.ekkoAlt,
      'the collection is not renumbered');
    assert.strictEqual((await card(RAD.jarvan)).supertype, 'Legend');
    assert.strictEqual((await card(RAD.kaisa)).name, "Kai'Sa, Rebel (K/DA Special Art Card)", 'held, and RiftCodex lacks it: kept as it was');
    assert.ok(await card(RAD.blade), 'decked: kept');
    assert.strictEqual(await card(RAD.token), undefined, 'nobody holds it and RiftCodex lacks it: gone');
    assert.strictEqual(await card('riftbound-rad-184.2a-167'), undefined);
    assert.strictEqual((await db.get(`SELECT series FROM sets WHERE id = 'riftbound-rad'`)).series, 'Riftbound', 'the set is RiftCodex\'s');
    assert.strictEqual(await db.get(`SELECT set_id FROM set_listings WHERE set_id = 'riftbound-rad'`), undefined, 'its listing is read afresh');
    const after = await state();
    assert.ok(!Object.values(after.groups).some(g => g.set === 'riftbound-rad'), 'no longer the fallback\'s');
    assert.ok(after.riftcodex.includes('riftbound-rad'));
    // Rewritten from scratch, the fallback still leaves it to RiftCodex.
    await fallback.materialize({ force: true });
    assert.strictEqual((await card(RAD.ekkoAlt)).name, 'Ekko - Ingenious (Alternate Art)');
    assert.deepStrictEqual(await ids('riftbound-rwb'), ['riftbound-rwb-278a-298~tcgp722659'], 'the sets RiftCodex still lacks are untouched');

    // --- 9. A group TCGplayer drops ------------------------------------------------
    GROUPS = GROUPS.filter(g => g.groupId !== 24502);
    version = 'v7';
    assert.deepStrictEqual(await fallback.ensure({ sync: false }), { cards: 0, removed: 1, kept: 0 });
    assert.strictEqual((await ids('riftbound-rwb')).length, 0);
    assert.strictEqual(await db.get(`SELECT id FROM sets WHERE id = 'riftbound-rwb'`), undefined, 'and its set');

    // --- 10. The sync a missing category 89 starts ------------------------------------
    // TCGCSV data cached, but not category 89: filled in, once an hour at most.
    cached89 = false;
    version = 'v8';
    const filled = await fallback.ensure({ waitForSync: true });
    assert.strictEqual(syncs, 1, 'one sync');
    assert.ok(!filled.missing, `written once it came: ${JSON.stringify(filled)}`);
    cached89 = false;
    version = 'v9';
    assert.deepStrictEqual(await fallback.ensure({ waitForSync: true }), { missing: true });
    assert.strictEqual(syncs, 1, 'not again within the hour');
    // No TCGCSV data at all: the scheduled sync brings it, not a read.
    version = null;
    assert.deepStrictEqual(await fallback.ensure(), { missing: true });
    assert.strictEqual(syncs, 1);

    // --- 11. RiftCodex refreshes in the middle of a write -----------------------------
    // No lock between the two (a phone's request could wait on one for ever): the
    // refresh records its sets before it caches, and every group write checks that
    // record in its own transaction. A write already past the check is overwritten
    // by RiftCodex's rows; one after it writes nothing.
    version = 'v10';
    cached89 = true;
    PRODUCTS['99999'] = [...PRODUCTS['99999'], { productId: 99003, name: 'Zed Three', number: '003/010' }];
    let release;
    productsGate = { gid: 99999, promise: new Promise((resolve) => { release = resolve; }) };
    const midway = fallback.materialize();
    await new Promise(resolve => setTimeout(resolve, 50));   // it is waiting on the Zed Set's products now
    rcCards = [...rcCards, { ...CARDS[0], id: '6b20000000000000000000a1', name: 'Zed Two', riftbound_id: 'zzz-002-010',
      tcgplayer_id: '99002', set: { set_id: 'ZZZ', label: 'Zed Set' } }];
    await rc.refreshCatalogue();
    release();
    productsGate = null;
    await midway;
    assert.strictEqual((await card('riftbound-zzz-002-010')).name, 'Zed Two');
    assert.strictEqual((await card('riftbound-zzz-002-010')).supertype, 'Legend', 'RiftCodex\'s row, not written over');
    assert.strictEqual(await card('riftbound-zzz-003-010'), undefined, 'nothing written into a set RiftCodex has taken');
    assert.ok(!Object.values((await state()).groups).some(g => g.set === 'riftbound-zzz'));
    assert.strictEqual((await db.get(`SELECT catalogue_version FROM tcgcsv_catalogues WHERE game = ?`, [fallback.STATE_KEY])).catalogue_version,
      null, 'and that write does not call itself current: the next read weighs everything again');
  } finally {
    console.log = quiet;
  }
}

main().then(() => {
  console.log('riftboundtcgplayer.test.js: all assertions passed');
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(async () => {
  try { await new Promise(ok => db.dbConnection.close(ok)); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
  }
});
