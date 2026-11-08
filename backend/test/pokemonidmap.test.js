// The pokemontcg.io -> TCGdex id mapping table, from fixtures (utils/pokemonIdMap).
//
// The fixtures are shaped like the two APIs' payloads but are not copies of them:
// tcgdex-en.json is what /v2/en/sets and /v2/en/sets/{id} return, cut down to the
// sets the cases need, and pokemontcgio-cards.json is pokemontcg.io v2 cards. Each
// case is a numbering difference the migration has to survive, or a trap it must
// refuse to guess its way through. No database and no network.
const assert = require('assert');
const idMap = require('../src/utils/pokemonIdMap');
const tcgdex = require('./fixtures/pokemonmigration/tcgdex-en.json');
const legacy = require('./fixtures/pokemonmigration/pokemontcgio-cards.json');

let passed = 0;
const check = (fn, label) => { fn(); passed++; if (process.env.VERBOSE) console.log(`ok - ${label}`); };

// The provider rows the migration builds from a set listing (tcgdexApi.getSetCards).
const targetSets = tcgdex.sets.map(s => ({ id: s.id, name: s.name }));
const listingFor = (setId) => (tcgdex.details[setId].cards || []).map(c => ({
  id: `tcgdex-en-${c.id}`, set_id: setId, set_name: tcgdex.details[setId].name, number: c.localId, name: c.name, product_id: null,
}));
const sources = [
  ...legacy.map(c => ({ id: c.id, set_id: c.set.id, set_name: c.set.name, number: c.number, name: c.name, product_id: null })),
  // Referenced by a deck only, never cached: the id is all there is to go on.
  { id: 'base1-58', set_id: 'base1', set_name: '', number: '58', name: '', product_id: null },
];
const sourceProducts = { 'sv1-3': 3003, 'sma-SV2': 1002, 'fut20-5': 2111 };
for (const s of sources) s.product_id = sourceProducts[s.id] || null;

// The TCGCSV product map, keyed both ways as pokemonMigration loads it.
const productMap = [
  { product_id: 42382, set_id: 'base1', set_name: 'Base Set', number: '4/102' },
  { product_id: 9999, set_id: 'sv01', set_name: 'Scarlet & Violet', number: '003/198' },
  { product_id: 1002, set_id: 'sma', set_name: 'Hidden Fates: Shiny Vault', number: 'SV02' },
  { product_id: 2002, set_id: 'sm11.5', set_name: 'Hidden Fates', number: 'SV02' },
  { product_id: 2111, set_id: 'fut2020', set_name: 'Pokémon Futsal 2020', number: '5/5' },
];
const catalog = new Map(productMap.map(p => [p.product_id, p]));
const bySetNumber = new Map(productMap.map(p => [idMap.setNumberKey(p.set_id, p.number), p.product_id]));
const products = { catalog, bySetNumber, ofTarget: new Map(), known: new Map() };

const needed = idMap.setsToList({ sources, targetSets, products });
const failedSets = new Set(needed.filter(s => !tcgdex.details[s]));
const listings = new Map(needed.filter(s => tcgdex.details[s]).map(s => [s, listingFor(s)]));
const entries = idMap.buildPlan({ sources, targetSets, listings, failedSets, products });
const byOld = new Map(entries.map(e => [e.old_id, e]));

// --- the mapping table ---------------------------------------------------------
const TABLE = [
  // [old id, class, new id or reason, what it exercises]
  ['sv1-1', 'mapped', 'tcgdex-en-sv01-001', 'sv1 <-> sv01: unpadded set id, padded number'],
  ['sv3pt5-25', 'mapped', 'tcgdex-en-sv03.5-025', 'sv3pt5 <-> sv03.5: pt5 written as .5'],
  ['sv3pt5-6', 'mapped', 'tcgdex-en-sv03.5-006', 'same set, single-digit number'],
  ['swshp-SWSH050', 'mapped', 'tcgdex-en-swshp-SWSH050', 'SWSH promo with a letter prefix'],
  ['swsh9tg-TG01', 'mapped', 'tcgdex-en-swsh9tg-TG01', 'Trainer Gallery subset with a set of its own'],
  ['swsh12pt5gg-GG01', 'mapped', 'tcgdex-en-swsh12.5-GG01', 'Galarian Gallery subset folded into its parent set'],
  ['pgo-11', 'mapped', 'tcgdex-en-swsh10.5-011', 'pgo <-> swsh10.5: no shared id, matched on the folded set name'],
  ['base1-4', 'mapped', 'tcgdex-en-base1-4', 'base set: same id on both sides'],
  ['base1-58', 'mapped', 'tcgdex-en-base1-58', 'uncached deck-only id, parsed from the id itself'],
  ['xyp-XY121a', 'mapped', 'tcgdex-en-xyp-XY121a', 'letter-suffixed number keeps its suffix (XY121 is a different card)'],
  ['sma-SV2', 'mapped', 'tcgdex-en-sma-SV02', 'listed twice; the product id chooses'],
  ['fut20-5', 'product', 'tcgdex-en-fut2020-5', 'no set match: the TCGplayer product names the card'],
  ['sv1-3', 'ambiguous', 'product_mismatch', 'set and number agree, the product ids do not'],
  ['sv2-11', 'ambiguous', 'name_mismatch', 'the number lands on a different card'],
  ['sma-SV1', 'ambiguous', 'several_cards', 'the same card in the subset and its parent, nothing to choose by'],
  ['sv1-999', 'unmapped', 'number_not_found', 'the set exists, the number does not'],
  ['mcd14-1', 'unmapped', 'set_not_found', 'a set the target does not carry'],
  ['sv4-1', 'unmapped', 'listing_failed', 'the target set could not be listed'],
];

check(() => assert.strictEqual(entries.length, TABLE.length, 'every source has exactly one entry'), 'one entry per source');
for (const [oldId, cls, expected, label] of TABLE) {
  check(() => {
    const e = byOld.get(oldId);
    assert.ok(e, `${oldId} classified`);
    assert.strictEqual(e.class, cls, `${oldId} (${label}): class ${e.class}, reason ${e.reason}`);
    if (cls === 'mapped' || cls === 'product') {
      assert.strictEqual(e.new_id, expected, `${oldId} (${label})`);
      assert.strictEqual(e.target.id, expected);
    } else {
      assert.strictEqual(e.reason, expected, `${oldId} (${label})`);
      assert.strictEqual(e.new_id, null, `${oldId} must not be re-keyed`);
    }
  }, label);
}

check(() => {
  assert.strictEqual(byOld.get('base1-4').confirmed, true, 'base1-4: the product map has the same product on both sides');
  assert.strictEqual(byOld.get('sma-SV2').confirmed, true);
  assert.strictEqual(byOld.get('sv1-1').confirmed, false, 'no product id on either side is not a confirmation');
  assert.strictEqual(byOld.get('fut20-5').method, 'product-id');
  assert.strictEqual(byOld.get('sv1-1').method, 'set-number');
}, 'confirmation and method');

check(() => {
  // An ambiguous entry carries what it could not choose between, so the admin can.
  assert.deepStrictEqual(byOld.get('sma-SV1').candidates.map(c => c.id).sort(), ['tcgdex-en-sm11.5-SV1', 'tcgdex-en-sma-SV1']);
  assert.deepStrictEqual(byOld.get('sv2-11').candidates.map(c => c.name), ['Charmander']);
  assert.ok(byOld.get('sv1-3').candidates.some(c => c.id === 'tcgdex-en-sv01-003'));
}, 'ambiguous entries list their candidates');

check(() => {
  // Two old ids landing on one new id: one of them is wrong, so neither moves.
  const twins = [
    { id: 'swsh12pt5gg-GG01', set_id: 'swsh12pt5gg', set_name: 'Crown Zenith Galarian Gallery', number: 'GG01', name: 'Simisage' },
    { id: 'swsh12pt5-GG01', set_id: 'swsh12pt5', set_name: 'Crown Zenith', number: 'GG01', name: 'Simisage' },
  ];
  const out = idMap.buildPlan({ sources: twins, targetSets, listings: new Map([['swsh12.5', listingFor('swsh12.5')]]) });
  for (const e of out) {
    assert.strictEqual(e.class, 'ambiguous');
    assert.strictEqual(e.reason, 'same_target');
    assert.strictEqual(e.new_id, null);
  }
}, 'two old ids on one new id are both refused');

check(() => {
  // A target card the price sweep already priced carries its product on the row.
  const ofTarget = new Map([['tcgdex-en-sv01-003', 3003]]);
  const [e] = idMap.buildPlan({
    sources: [sources.find(s => s.id === 'sv1-3')], targetSets,
    listings: new Map([['sv01', listingFor('sv01')]]), products: { ofTarget },
  });
  assert.strictEqual(e.class, 'mapped');
  assert.strictEqual(e.confirmed, true);
}, 'a stored target product id confirms a set-and-number match');

// --- the pieces ------------------------------------------------------------------
check(() => {
  for (const [a, b] of [['1', '001'], ['TG01', 'TG1'], ['SV001', 'SV1'], ['SWSH050', 'swsh50'], ['004/165', '4'],
    ['15_A1', '15A1'], ['GG01', 'gg1'], ['0', '00'], ['XY121a', 'XY0121A']]) {
    assert.strictEqual(idMap.numKey(a), idMap.numKey(b), `${a} ~ ${b}`);
  }
  for (const [a, b] of [['28a', '28'], ['TG12', 'SV12'], ['10', '1'], ['100', '10'], ['TG10', 'TG1']]) {
    assert.notStrictEqual(idMap.numKey(a), idMap.numKey(b), `${a} !~ ${b}`);
  }
}, 'collector numbers');

check(() => {
  for (const [a, b] of [['M Charizard-EX', 'Mega Charizard EX'], ["Professor's Research", "Professor's Research (Professor Oak)"],
    ['Pokémon Catcher', 'Pokemon Catcher'], ['Team Rocket’s Mewtwo ex', "Team Rocket's Mewtwo ex"], ['Nidoran ♀', 'Nidoran♀'],
    ['Pikachu', ''], ['Kingdra δ', 'Kingdra']]) {
    assert.ok(idMap.namesCompatible(a, b), `${a} ~ ${b}`);
  }
  for (const [a, b] of [['Charizard', 'Pikachu'], ['Zapdos ex', 'Moltres ex'], ['Pineco', 'Pinsir']]) {
    assert.ok(!idMap.namesCompatible(a, b), `${a} !~ ${b}`);
  }
}, 'card names');

check(() => {
  assert.deepStrictEqual(idMap.subsetParent('swsh9tg', 'Brilliant Stars Trainer Gallery'), { id: 'swsh9', name: 'Brilliant Stars' });
  assert.deepStrictEqual(idMap.subsetParent('swsh12pt5gg', 'Crown Zenith Galarian Gallery'), { id: 'swsh12pt5', name: 'Crown Zenith' });
  assert.deepStrictEqual(idMap.subsetParent('swsh45sv', 'Shining Fates Shiny Vault'), { id: 'swsh45', name: 'Shining Fates' });
  assert.deepStrictEqual(idMap.subsetParent('sma', 'Hidden Fates Shiny Vault'), { id: '', name: 'Hidden Fates' });
  assert.deepStrictEqual(idMap.subsetParent('cel25c', 'Celebrations: Classic Collection'), { id: 'cel25', name: 'Celebrations' });
  assert.strictEqual(idMap.subsetParent('swsh45sv', 'Shining Fates'), null, 'an id suffix alone is not evidence');
  assert.strictEqual(idMap.subsetParent('sv1', 'Scarlet & Violet'), null);
}, 'subset parents');

check(() => {
  assert.strictEqual(idMap.parseLegacyId('sv1-1').set_id, 'sv1');
  assert.strictEqual(idMap.parseLegacyId('swsh12pt5gg-GG01').number, 'GG01');
  for (const id of ['tcgdex-en-sv01-001', 'mtg-0b7c8a9e-1f2d-4e3a-9b8c-7d6e5f4a3b2c', 'pokemontcgapi-sv1-1', 'pokemontcgapi-bs', 'lorcana-crd_1', 'sv1', '', null]) {
    assert.strictEqual(idMap.isLegacyId(id), false, String(id));
  }
}, 'pokemontcg.io id shape');

// --- storage settings that name a set ------------------------------------------
check(() => {
  const { moves, blocked } = idMap.setMoves(entries, { targetSets, storageSets: [{ id: 'sv6', name: '' }, { id: 'base2', name: 'Jungle' }] });
  assert.deepStrictEqual(moves.get('sv3pt5'), { set_id: 'sv03.5', set_name: '151', from_name: '151' });
  assert.strictEqual(moves.get('pgo').set_id, 'swsh10.5');
  assert.strictEqual(blocked.get('sv1'), 'cards_left', 'sv1 still has cards on old ids, so a rule for it stays');
  assert.strictEqual(blocked.get('swsh12pt5gg'), 'merged', 'a Galarian Gallery rule must not widen to all of Crown Zenith');
  assert.strictEqual(blocked.get('fut20'), 'no_counterpart');
  assert.ok(!moves.has('sv6') && !moves.has('base2'), 'a set the target does not list stays as it is');

  const fixed = JSON.stringify([{ set_id: 'sv3pt5', start_slot: 1, max_number: 165 }, { set_id: 'SV1', start_slot: 200, max_number: null }]);
  assert.deepStrictEqual(JSON.parse(idMap.remapFixedSlots(fixed, moves)).map(e => e.set_id), ['sv03.5', 'SV1']);
  assert.strictEqual(idMap.remapFixedSlots(JSON.stringify([{ set_id: 'sv1', start_slot: 1 }]), moves), null, 'nothing to change');
  const rules = JSON.stringify({ rules: [{ field: 'set_id', operator: 'equals', value: 'pgo', action: 'include' },
    { field: 'set_name', operator: 'equals', value: 'Pokémon GO', action: 'include' }, { field: 'rarity', operator: 'equals', value: 'Common', action: 'exclude' }] });
  const next = JSON.parse(idMap.remapRules(rules, moves));
  assert.strictEqual(next.rules[0].value, 'swsh10.5');
  assert.strictEqual(next.rules[1].value, 'Pokémon GO', 'an unchanged set name stays');
  assert.strictEqual(next.rules[2].value, 'Common');
  assert.strictEqual(idMap.remapRules(JSON.stringify([{ field: 'set_id', operator: 'contains', value: 'pgo' }]), moves), null, 'only equals rules name a set');
  assert.strictEqual(idMap.remapRules('not json', moves), null);
}, 'storage settings');

console.log(`pokemonidmap.test.js: ${passed} checks passed`);
