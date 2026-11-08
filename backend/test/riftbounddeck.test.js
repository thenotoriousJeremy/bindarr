// Runnable checks for Riftbound deck construction — its entry in
// shared/deckRules.mjs, the one table the server and the deck builder share.
//
// Built from the real fixture cards, normalized exactly as the provider caches
// them, so the rules read the fields a real deck carries (supertype, the
// supertype-then-tags subtypes, domains in `types`). The rules are Riot's: one
// Champion Legend, a 40+ Main Deck with its Chosen Champion, three of a card,
// twelve runes, three different battlefields, everything inside the Legend's
// domains, and Signature cards only of the Legend's champion.
//
// No framework — plain node + assert. Run: `node test/riftbounddeck.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

// riftcodexApi (for normalizeCatalogue) loads db.js, which opens DB_PATH at require
// time; never let that be the real database.
process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-riftbounddeck-${process.pid}.db`);
const { normalizeCatalogue } = require('../src/riftcodexApi');
const CARDS = normalizeCatalogue(require('./fixtures/riftbound/cards.json'));

const card = (id) => {
  const c = CARDS.find(x => x.id === id);
  if (!c) throw new Error(`no fixture card ${id}`);
  return c;
};
const row = (id, quantity) => ({ ...card(id), quantity });
// Synthetic filler of the right shape, for counts the fixture is too small for.
const filler = (n, domain = 'Fury') => Array.from({ length: n }, (_, i) => ({
  id: `riftbound-test-${i}`, name: `Filler ${i}`, supertype: 'Unit', subtypes: [], types: [domain], quantity: 1,
}));
const rune = (domain, quantity) => ({ id: `riftbound-rune-${domain}`, name: `${domain} Rune`, supertype: 'Rune', subtypes: ['Basic'], types: [domain], quantity });
const field = (name) => ({ id: `riftbound-bf-${name}`, name, supertype: 'Battlefield', subtypes: [], types: ['Colorless'], quantity: 1 });

const LEGEND = 'riftbound-unl-229.2a-219';      // Vi - Piltover Enforcer (Signature), Fury + Order
const CHAMPION = 'riftbound-unl-176a-219';      // Vi - Peacekeeper (Alternate Art), Champion unit, Order
const SIGNATURE = 'riftbound-unl-188-219';      // Hextech Gauntlets, Vi's Signature gear
const OFF_DOMAIN = 'riftbound-unl-139-219';     // Bone Skewer, a Chaos spell

(async () => {
  const rules = await import('../../shared/deckRules.mjs');
  const codes = (cards) => rules.deckWarnings({ game: 'riftbound', format: 'Constructed', cards }).map(w => w.code).sort();
  const constructed = rules.rulesFor('riftbound', 'Constructed');

  // --- the table entry --------------------------------------------------------
  assert.deepStrictEqual(rules.formatNames('riftbound'), ['Constructed', 'Casual']);
  assert.strictEqual(rules.defaultTargetSize('riftbound', 'Constructed'), 56, 'Legend + 40 + 12 runes + 3 battlefields');

  // --- zones and names ----------------------------------------------------------
  assert.strictEqual(rules.riftboundZone(card(LEGEND)), 'legend');
  assert.strictEqual(rules.riftboundZone(card('riftbound-ven-r06')), 'rune');
  assert.strictEqual(rules.riftboundZone(card('riftbound-unl-215-219')), 'battlefield');
  assert.strictEqual(rules.riftboundZone(card('riftbound-sfd-t03')), 'token');
  assert.strictEqual(rules.riftboundZone(card(CHAMPION)), 'main');
  assert.strictEqual(rules.riftboundName('Vi - Piltover Enforcer (Signature)'), rules.riftboundName('Vi - Piltover Enforcer (Overnumbered)'),
    'printings of one card are one card to the copy limit');
  assert.strictEqual(rules.riftboundName('Rengar, Trophy Hunter'), rules.riftboundName('Rengar - Trophy Hunter'),
    'RiftCodex writes some sets with a comma and some with a dash');
  assert.strictEqual(rules.copyKey(card(CHAMPION), 'riftbound'), rules.copyKey(card('riftbound-unl-176-219'), 'riftbound'));

  // --- a legal deck has no warnings ----------------------------------------------
  const legal = [
    row(LEGEND, 1), row(CHAMPION, 3), row(SIGNATURE, 3), ...filler(34),
    rune('Fury', 6), rune('Order', 6),
    field('Star Spring'), field('Black Flame Altar'), field('Trapping Grounds'),
  ];
  assert.deepStrictEqual(codes(legal), [], 'a legal 56-card deck has nothing to say');

  // --- every rule, broken one at a time --------------------------------------------
  assert.deepStrictEqual(codes(legal.filter(c => c.id !== LEGEND)), ['rb_legendCount']);
  assert.deepStrictEqual(codes([...legal, row('riftbound-unl-229-219', 1)]), ['rb_legendCount'], 'two Legends is wrong too');
  assert.deepStrictEqual(codes(legal.map(c => (c.id === CHAMPION ? { ...c, quantity: 1 } : c))), ['rb_mainDeckSize']);
  const noChampion = legal.filter(c => c.id !== CHAMPION).concat(filler(3).map(f => ({ ...f, id: `${f.id}-x`, name: `${f.name} x` })));
  const w = rules.deckWarnings({ game: 'riftbound', cards: noChampion });
  assert.deepStrictEqual(w.map(x => x.code), ['rb_noChosenChampion']);
  assert.strictEqual(w[0].champion, 'Vi');
  assert.ok(codes([...legal, { ...card('riftbound-unl-176-219'), quantity: 1 }]).includes('rb_tooManyCopies'),
    '3 alt art + 1 base is four of Vi - Peacekeeper');
  assert.deepStrictEqual(codes(legal.map(c => (c.name === 'Order Rune' ? { ...c, quantity: 5 } : c))), ['rb_runeCount']);
  assert.deepStrictEqual(codes(legal.filter(c => c.name !== 'Trapping Grounds')), ['rb_battlefieldCount']);
  assert.deepStrictEqual(codes(legal.filter(c => c.name !== 'Trapping Grounds').concat(field('Star Spring'))), ['rb_duplicateBattlefield']);
  const od = rules.deckWarnings({ game: 'riftbound', cards: legal.map(c => (c.id === 'riftbound-test-0' ? row(OFF_DOMAIN, 1) : c)) });
  assert.deepStrictEqual(od.map(x => x.code), ['rb_offDomain']);
  assert.strictEqual(od[0].domains, 'Chaos');
  assert.deepStrictEqual(codes(legal.map(c => (c.name === 'Fury Rune' ? { ...c, types: ['Mind'] } : c))), ['rb_offDomain'],
    'runes must match the Legend too');
  const pyke = { id: 'riftbound-x-sig', name: 'Death from Below', supertype: 'Spell', subtypes: ['Signature', 'Pyke'], types: ['Fury'], quantity: 1 };
  assert.deepStrictEqual(codes(legal.map(c => (c.id === SIGNATURE ? { ...c, quantity: 2 } : c)).concat(pyke)), ['rb_signatureMismatch']);
  assert.ok(codes(legal.map(c => (c.id === SIGNATURE ? { ...c, quantity: 4 } : c)).filter(c => c.id !== 'riftbound-test-2'))
    .includes('rb_tooManySignatures'));
  assert.ok(codes([...legal, row('riftbound-sfd-t03', 1)]).includes('rb_tokenInDeck'));

  // --- copy limits by zone ------------------------------------------------------------
  assert.strictEqual(rules.copyLimit(card(LEGEND), constructed), 1);
  assert.strictEqual(rules.copyLimit(card('riftbound-unl-215-219'), constructed), 1, 'battlefields are all different');
  assert.strictEqual(rules.copyLimit(card('riftbound-ven-r06'), constructed), 12);
  assert.strictEqual(rules.copyLimit(card(CHAMPION), constructed), 3);
  assert.strictEqual(rules.copyLimit(card('riftbound-sfd-t03'), constructed), 0, 'tokens never go in a deck');

  // --- the server enforces them through deckRules -------------------------------------
  const { validateDeckAddition } = require('../src/utils/deckRules');
  const asRow = (c, quantity) => ({ card_id: c.id, quantity, name: c.name, oracle_id: null, supertype: c.supertype, subtypes: JSON.stringify(c.subtypes) });
  const fake = (deckRows) => ({
    async get(sql) {
      if (/FROM card_cache WHERE id/.test(sql)) return { ...card(CHAMPION), subtypes: JSON.stringify(card(CHAMPION).subtypes), types: '[]' };
      if (/FROM decks WHERE id/.test(sql)) return { game: 'riftbound', format: 'Constructed', any_printing: 0 };
      return null;
    },
    async all(sql) {
      if (/FROM deck_cards/.test(sql)) return deckRows;
      if (/FROM collection/.test(sql)) return [{ card_id: CHAMPION, quantity: 10, name: card(CHAMPION).name, oracle_id: null }];
      return [];
    },
  });
  const base = { deckId: 1, userId: 1, cardId: CHAMPION };
  assert.strictEqual((await validateDeckAddition({ ...base, newQty: 3, dbClient: fake([]) })).ok, true);
  const four = await validateDeckAddition({ ...base, newQty: 4, dbClient: fake([]) });
  assert.strictEqual(four.ok, false);
  assert.ok(/more than 3/.test(four.error), four.error);
  const withBase = await validateDeckAddition({ ...base, newQty: 2, dbClient: fake([asRow(card('riftbound-unl-176-219'), 2)]) });
  assert.strictEqual(withBase.ok, false, 'another printing of the same card counts toward the three');
  console.log('riftbounddeck.test.js passed');
})().catch(e => { console.error(e); process.exit(1); });
