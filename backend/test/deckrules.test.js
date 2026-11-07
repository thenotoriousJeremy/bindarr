// Deck construction rules: the shared table (shared/deckRules.mjs) case by case,
// then the server-side enforcement (validateDeckAddition) against a real temporary
// SQLite database. Plain node + assert: `node test/deckrules.test.js`.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-deck-rules-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const db = require('../src/db');
const { validateDeckAddition, loadRules } = require('../src/utils/deckRules');

// Card rows shaped the way scryfallApi.normalizeCard stores them: the whole type
// line split into words in `subtypes`, colour identity as colour names.
const typeLine = (line) => line.split(/[^A-Za-z]+/).filter(Boolean);
const mtg = (name, line, { identity = [], text = '', oracle = null, id = null } = {}) => ({
  id: id || `mtg-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  name, game: 'mtg', supertype: 'MTG', subtypes: typeLine(line),
  color_identity: identity, oracle_text: text, oracle_id: oracle,
});
const inDeck = (card, quantity = 1, extra = {}) => ({ ...card, quantity, ...extra });
const commander = (card) => inDeck(card, 1, { is_commander: 1 });

const FOREST = mtg('Forest', 'Basic Land — Forest', { identity: ['Green'] });
const SNOW_ISLAND = mtg('Snow-Covered Island', 'Basic Snow Land — Island', { identity: ['Blue'] });
const WASTES = mtg('Wastes', 'Basic Land');
const MOUNTAIN = mtg('Mountain', 'Basic Land — Mountain', { identity: ['Red'] });
const BREEDING_POOL = mtg('Breeding Pool', 'Land — Forest Island', { identity: ['Blue', 'Green'] });
const TROPICAL_ISLAND = mtg('Tropical Island', 'Land — Forest Island', { identity: ['Blue', 'Green'] });
const DRYAD_ARBOR = mtg('Dryad Arbor', 'Land Creature — Forest Dryad', { identity: ['Green'] });
const SOL_RING = mtg('Sol Ring', 'Artifact', { text: '{T}: Add {C}{C}.', oracle: 'oracle-sol-ring' });
const RATS = mtg('Relentless Rats', 'Creature — Rat', { identity: ['Black'], text: 'Relentless Rats gets +1/+1 for each other creature you control named Relentless Rats.\nA deck can have any number of cards named Relentless Rats.' });
const DWARVES = mtg('Seven Dwarves', 'Creature — Dwarf', { identity: ['Red'], text: 'Seven Dwarves gets +1/+1 for each other creature you control named Seven Dwarves.\nA deck can have up to seven cards named Seven Dwarves.' });
const NAZGUL = mtg('Nazgûl', 'Creature — Wraith Knight', { identity: ['Black'], text: 'Deathtouch\nA deck can have up to nine cards named Nazgûl.' });
const BOLT = mtg('Lightning Bolt', 'Instant', { identity: ['Red'], text: 'Lightning Bolt deals 3 damage to any target.' });
const ELVES = mtg('Llanowar Elves', 'Creature — Elf Druid', { identity: ['Green'], text: '{T}: Add {G}.' });
const COUNTERSPELL = mtg('Counterspell', 'Instant', { identity: ['Blue'], text: 'Counter target spell.' });
const JOTUN = mtg('Jötun Grunt', 'Creature — Giant Soldier', { identity: ['White'], text: 'Cumulative upkeep—Put two cards from a single graveyard on the bottom of their owner\'s library.' });
// Commanders.
const KRENKO = mtg('Krenko, Mob Boss', 'Legendary Creature — Goblin Warrior', { identity: ['Red'], text: '{T}: Create X 1/1 red Goblin creature tokens, where X is the number of Goblins you control.' });
const GISHATH = mtg('Gishath, Sun\'s Avatar', 'Legendary Creature — Dinosaur Avatar', { identity: ['Red', 'Green', 'White'], text: 'Vigilance, trample, haste' });
const NIV = mtg('Niv-Mizzet, Parun', 'Legendary Creature — Dragon Wizard', { identity: ['Blue', 'Red'], text: 'This spell can\'t be countered.\nFlying' });
const THRASIOS = mtg('Thrasios, Triton Hero', 'Legendary Creature — Merfolk Wizard', { identity: ['Green', 'Blue'], text: '{4}: Scry 1, then reveal the top card of your library.\nPartner (You can have two commanders if both have partner.)' });
const TYMNA = mtg('Tymna the Weaver', 'Legendary Creature — Human Cleric', { identity: ['White', 'Black'], text: 'Lifelink\nAt the beginning of your postcombat main phase, you may pay X life.\nPartner (You can have two commanders if both have partner.)' });
const PIR = mtg('Pir, Imaginative Rascal', 'Legendary Creature — Human', { identity: ['Green'], text: 'Partner with Toothy, Imaginary Friend (When this creature enters, target player may put Toothy into their hand from their library, then shuffle.)\nIf one or more counters would be put on a permanent your team controls, that many plus one of each of those kinds of counters are put on that permanent instead.' });
const TOOTHY = mtg('Toothy, Imaginary Friend', 'Legendary Creature — Illusion', { identity: ['Blue'], text: 'Partner with Pir, Imaginative Rascal (When this creature enters, target player may put Pir into their hand from their library, then shuffle.)\nWhenever you draw a card, put a +1/+1 counter on Toothy.' });
const WILSON = mtg('Wilson, Refined Grizzly', 'Legendary Creature — Bear Warrior', { identity: ['Green'], text: 'Choose a Background (You can have a Background as a second commander.)\nReach, trample\nWard {2}' });
const NOBLE_HERITAGE = mtg('Noble Heritage', 'Legendary Enchantment — Background', { identity: ['White'], text: 'At the beginning of combat on your turn, put a +1/+1 counter on each creature you control.' });
const BJORNA = mtg('Bjorna, Nightfall Alchemist', 'Legendary Creature — Human Wizard', { identity: ['Blue', 'Red'], text: 'Friends forever (You can have two commanders if both have friends forever.)' });
const LAEZEL = mtg('Lae\'zel, Vlaakith\'s Champion', 'Legendary Creature — Gith Warrior', { identity: ['White'], text: 'If you would put one or more counters on a creature or planeswalker you control, put that many plus one instead.\nChoose a Background' });
const IMOEN = mtg('Imoen, Mystic Trickster', 'Legendary Creature — Human Wizard', { identity: ['Blue'], text: 'Friends forever (You can have two commanders if both have friends forever.)' });
const DONNA = mtg('Donna Noble', 'Legendary Creature — Human', { identity: ['Red'], text: 'Whenever Donna Noble or a creature you control is dealt damage, Donna Noble deals that much damage to target opponent.\nDoctor\'s companion (You can have two commanders if the other is the Doctor.)' });
const TENTH_DOCTOR = mtg('The Tenth Doctor', 'Legendary Creature — Time Lord Doctor', { identity: ['Red', 'Green', 'Blue'], text: 'Allons-y! — Whenever you expend 4, ...' });
const GOBLIN = mtg('Goblin Guide', 'Creature — Goblin Scout', { identity: ['Red'], text: 'Haste' });
const TEFERI = mtg('Teferi, Master of Time', 'Legendary Planeswalker — Teferi', { identity: ['Blue'], text: 'You may activate loyalty abilities of Teferi on any player\'s turn any time you could cast an instant.' });
const GRIST = mtg('Grist, the Hunger Tide', 'Legendary Planeswalker — Grist', { identity: ['Black', 'Green'], text: 'As long as Grist isn\'t on the battlefield, it\'s a 1/1 Insect creature in addition to its other types.\nGrist, the Hunger Tide can be your commander.' });

// A complete, legal Commander deck around a single commander: the commander,
// `extra`, and basic lands (Forests unless told otherwise) up to 100.
const commanderDeck = (lead, extra = [], land = FOREST) => {
  const extraCount = extra.reduce((s, c) => s + c.quantity, 0);
  return [commander(lead), ...extra, inDeck(land, 99 - extraCount)];
};
const codes = (warnings) => warnings.map(w => w.code);

async function testRuleTable() {
  const R = await loadRules();
  const commanderRules = R.rulesFor('mtg', 'Commander / EDH');
  const modern = R.rulesFor('mtg', 'Modern');
  const warn = (format, cards) => R.deckWarnings({ game: 'mtg', format, cards });

  const cases = [
    // --- What counts as a basic land ---
    ['Forest (Basic Land — Forest) is a basic land', () => assert.strictEqual(R.isBasicLand(FOREST), true)],
    ['Snow-Covered Island (Basic Snow Land) is a basic land', () => assert.strictEqual(R.isBasicLand(SNOW_ISLAND), true)],
    ['Wastes (Basic Land, no land type) is a basic land', () => assert.strictEqual(R.isBasicLand(WASTES), true)],
    ['Breeding Pool (Land — Forest Island) is NOT basic', () => assert.strictEqual(R.isBasicLand(BREEDING_POOL), false)],
    ['Tropical Island (Land — Forest Island) is NOT basic', () => assert.strictEqual(R.isBasicLand(TROPICAL_ISLAND), false)],
    ['Dryad Arbor (Land Creature — Forest Dryad) is NOT basic', () => assert.strictEqual(R.isBasicLand(DRYAD_ARBOR), false)],
    ['a row cached without a type line falls back to the basic names', () => {
      assert.strictEqual(R.isBasicLand({ name: 'Forest', subtypes: '[]' }), true);
      assert.strictEqual(R.isBasicLand({ name: 'Breeding Pool', subtypes: '[]' }), false);
    }],
    ['type words arrive as a JSON string from the database too', () =>
      assert.strictEqual(R.isBasicLand({ ...FOREST, subtypes: JSON.stringify(FOREST.subtypes) }), true)],

    // --- Copy limits ---
    ['Commander is singleton: Sol Ring limit 1', () => assert.strictEqual(R.copyLimit(SOL_RING, commanderRules), 1)],
    ['Modern allows four: Sol Ring limit 4', () => assert.strictEqual(R.copyLimit(SOL_RING, modern), 4)],
    ['basic lands are unlimited in Commander', () => assert.strictEqual(R.copyLimit(FOREST, commanderRules), Infinity)],
    ['snow basics are unlimited too', () => assert.strictEqual(R.copyLimit(SNOW_ISLAND, commanderRules), Infinity)],
    ['a shockland is singleton in Commander', () => assert.strictEqual(R.copyLimit(BREEDING_POOL, commanderRules), 1)],
    ['a shockland is a four-of in Modern', () => assert.strictEqual(R.copyLimit(BREEDING_POOL, modern), 4)],
    ['Relentless Rats: any number, read from its text', () => assert.strictEqual(R.copyLimit(RATS, commanderRules), Infinity)],
    ['Relentless Rats cached without text: the fallback list still exempts it', () =>
      assert.strictEqual(R.copyLimit({ ...RATS, oracle_text: null }, commanderRules), Infinity)],
    ['a new any-number card is caught from its text alone', () =>
      assert.strictEqual(R.copyLimit(mtg('Swarm of Tests', 'Creature — Insect', { text: 'A deck can have any number of cards named Swarm of Tests.' }), commanderRules), Infinity)],
    ['Seven Dwarves: up to seven, even in Commander', () => assert.strictEqual(R.copyLimit(DWARVES, commanderRules), 7)],
    ['Nazgûl: up to nine', () => assert.strictEqual(R.copyLimit(NAZGUL, commanderRules), 9)],
    ['Nazgul spelled without the accent, no text: still nine', () =>
      assert.strictEqual(R.copyLimit(mtg('Nazgul', 'Creature — Wraith Knight', { text: null }), commanderRules), 9)],
    ['an accented name that is NOT exempt stays singleton', () => assert.strictEqual(R.copyLimit(JOTUN, commanderRules), 1)],
    ['Pokémon: basic Energy unlimited, Special Energy four', () => {
      const std = R.rulesFor('pokemon', 'Standard');
      assert.strictEqual(R.copyLimit({ name: 'Fire Energy', supertype: 'Energy', subtypes: '["Basic"]', game: 'pokemon' }, std), Infinity);
      assert.strictEqual(R.copyLimit({ name: 'Double Turbo Energy', supertype: 'Energy', subtypes: '["Special"]', game: 'pokemon' }, std), 4);
      assert.strictEqual(R.copyLimit({ name: 'Pikachu', supertype: 'Pokémon', subtypes: '["Basic"]', game: 'pokemon' }, std), 4);
    }],
    ['Lorcana: four of a full name, no exemptions', () =>
      assert.strictEqual(R.copyLimit({ name: 'Mickey Mouse - Brave Little Tailor', supertype: 'Character', subtypes: [], game: 'lorcana' }, R.rulesFor('lorcana', 'Core (Constructed)')), 4)],

    // --- Commander deck warnings ---
    ['a complete legal Commander deck has no warnings', () =>
      assert.deepStrictEqual(warn('Commander / EDH', commanderDeck(KRENKO, [inDeck(SOL_RING), inDeck(GOBLIN)], MOUNTAIN)), [])],
    ['two printings of Sol Ring break singleton by name', () => {
      const other = { ...SOL_RING, id: 'mtg-sol-ring-c21' };
      const w = warn('Commander / EDH', commanderDeck(KRENKO, [inDeck(SOL_RING), inDeck(other)]));
      assert.deepStrictEqual(w.filter(x => x.code === 'copy_limit'), [{ code: 'copy_limit', name: 'Sol Ring', count: 2, limit: 1 }]);
    }],
    ['thirty Relentless Rats are fine', () =>
      assert.deepStrictEqual(codes(R.deckWarnings({ game: 'mtg', format: 'Commander / EDH', cards: [commander(mtg('Marrow-Gnawer', 'Legendary Creature — Rat Rogue', { identity: ['Black'], text: 'Fear' })), inDeck(RATS, 30), inDeck(mtg('Swamp', 'Basic Land — Swamp', { identity: ['Black'] }), 69)] })), [])],
    ['99 cards is one short of 100', () => {
      const w = warn('Commander / EDH', [commander(KRENKO), inDeck(MOUNTAIN, 98)]);
      assert.deepStrictEqual(w, [{ code: 'size_exact', expected: 100, actual: 99 }]);
    }],
    ['the commander counts toward the 100', () => {
      const w = warn('Commander / EDH', [commander(KRENKO), inDeck(MOUNTAIN, 99)]);
      assert.deepStrictEqual(w, []);
    }],
    ['no commander chosen is reported, once', () =>
      assert.deepStrictEqual(codes(warn('Commander / EDH', [inDeck(FOREST, 100)])), ['commander_missing'])],
    ['a non-legendary creature cannot lead', () =>
      assert.ok(codes(warn('Commander / EDH', commanderDeck(GOBLIN))).includes('commander_not_legal'))],
    ['a planeswalker leads in Commander only when its text says so', () => {
      assert.ok(codes(warn('Commander / EDH', commanderDeck(TEFERI))).includes('commander_not_legal'));
      assert.ok(!codes(warn('Commander / EDH', commanderDeck(GRIST))).includes('commander_not_legal'));
    }],
    ['in Brawl any legendary planeswalker leads', () =>
      assert.ok(!codes(warn('Brawl', commanderDeck(TEFERI))).includes('commander_not_legal'))],
    ['a green card in an Izzet deck is outside its colour identity', () => {
      const w = warn('Commander / EDH', commanderDeck(NIV, [inDeck(COUNTERSPELL), inDeck(ELVES)]));
      const ci = w.find(x => x.code === 'color_identity');
      assert.deepStrictEqual(ci, { code: 'color_identity', identity: ['U', 'R'], cards: [{ name: 'Llanowar Elves', colors: ['G'] }, { name: 'Forest', colors: ['G'] }] });
    }],
    ['a colourless artifact fits any identity', () =>
      assert.ok(!codes(warn('Commander / EDH', commanderDeck(KRENKO, [inDeck(SOL_RING)], MOUNTAIN))).includes('color_identity'))],
    ['a basic land carries its colour: Forest is off-colour under mono-red', () => {
      const w = warn('Commander / EDH', commanderDeck(KRENKO));
      assert.deepStrictEqual(w.find(x => x.code === 'color_identity').cards, [{ name: 'Forest', colors: ['G'] }]);
    }],
    ['identity accepts letters as well as names', () =>
      assert.deepStrictEqual([...R.colorIdentity({ color_identity: '["W","Blue","Colorless"]' })], ['W', 'U'])],

    // --- Partners and Backgrounds ---
    ['Thrasios + Tymna (both Partner) are a legal pair, and pool their colours', () => {
      const w = warn('Commander / EDH', [commander(THRASIOS), commander(TYMNA), inDeck(FOREST, 50), inDeck(mtg('Plains', 'Basic Land — Plains', { identity: ['White'] }), 48)]);
      assert.deepStrictEqual(w, []);
    }],
    ['a red card is outside a Thrasios + Tymna deck', () => {
      const w = warn('Commander / EDH', [commander(THRASIOS), commander(TYMNA), inDeck(BOLT), inDeck(FOREST, 97)]);
      assert.deepStrictEqual(w.find(x => x.code === 'color_identity').cards, [{ name: 'Lightning Bolt', colors: ['R'] }]);
    }],
    ['"Partner with" pairs only with the card it names', () => {
      assert.strictEqual(R.isLegalPair(PIR, TOOTHY), true);
      assert.strictEqual(R.isLegalPair(PIR, THRASIOS), false);
    }],
    ['Choose a Background pairs with a Background, in either order', () => {
      assert.strictEqual(R.isLegalPair(WILSON, NOBLE_HERITAGE), true);
      assert.strictEqual(R.isLegalPair(NOBLE_HERITAGE, LAEZEL), true);
    }],
    ['a Background beside a legend that does not choose one is not a pair', () =>
      assert.strictEqual(R.isLegalPair(NOBLE_HERITAGE, KRENKO), false)],
    ['a Background cannot lead alone', () =>
      assert.ok(codes(warn('Commander / EDH', commanderDeck(NOBLE_HERITAGE))).includes('commander_not_legal'))],
    ['Friends forever pairs with friends forever', () => assert.strictEqual(R.isLegalPair(BJORNA, IMOEN), true)],
    ["Doctor's companion pairs with a Time Lord Doctor", () => assert.strictEqual(R.isLegalPair(DONNA, TENTH_DOCTOR), true)],
    ['two arbitrary legends are not a pair', () => {
      const w = warn('Commander / EDH', [commander(KRENKO), commander(GISHATH), inDeck(MOUNTAIN, 98)]);
      assert.deepStrictEqual(w.filter(x => x.code === 'commander_pair'), [{ code: 'commander_pair', names: ['Krenko, Mob Boss', "Gishath, Sun's Avatar"] }]);
    }],
    ['three commanders is too many', () => {
      const w = warn('Commander / EDH', [commander(THRASIOS), commander(TYMNA), commander(KRENKO), inDeck(FOREST, 97)]);
      assert.ok(w.some(x => x.code === 'commander_too_many' && x.count === 3 && x.max === 2));
    }],
    ['a pair is not judged from rows whose text was never cached', () => {
      const w = warn('Commander / EDH', [commander({ ...KRENKO, oracle_text: null }), commander({ ...GISHATH, oracle_text: null }), inDeck(FOREST, 98)]);
      assert.ok(!codes(w).includes('commander_pair'));
    }],

    // --- Other formats and games ---
    ['Modern: 59 cards is short, 75 is fine', () => {
      assert.deepStrictEqual(warn('Modern', [inDeck(BOLT, 4), inDeck(MOUNTAIN, 55)]), [{ code: 'size_min', min: 60, actual: 59 }]);
      assert.deepStrictEqual(warn('Modern', [inDeck(BOLT, 4), inDeck(MOUNTAIN, 71)]), []);
    }],
    ['Modern: a fifth Lightning Bolt across printings', () => {
      const w = warn('Modern', [inDeck(BOLT, 3), inDeck({ ...BOLT, id: 'mtg-bolt-2' }, 2), inDeck(MOUNTAIN, 55)]);
      assert.deepStrictEqual(w, [{ code: 'copy_limit', name: 'Lightning Bolt', count: 5, limit: 4 }]);
    }],
    ['constructed formats have no command zone', () =>
      assert.ok(!codes(warn('Standard', [inDeck(BOLT, 4), inDeck(FOREST, 56)])).some(c => c.startsWith('commander')))],
    ['Pokémon decks are exactly 60', () => {
      const pika = { id: 'pika', name: 'Pikachu', supertype: 'Pokémon', subtypes: '["Basic"]', game: 'pokemon' };
      const fire = { id: 'fire', name: 'Fire Energy', supertype: 'Energy', subtypes: '["Basic"]', game: 'pokemon' };
      assert.deepStrictEqual(R.deckWarnings({ game: 'pokemon', format: 'Standard', cards: [inDeck(pika, 4), inDeck(fire, 56)] }), []);
      assert.deepStrictEqual(R.deckWarnings({ game: 'pokemon', format: 'Standard', cards: [inDeck(pika, 4), inDeck(fire, 57)] }), [{ code: 'size_exact', expected: 60, actual: 61 }]);
    }],
    ['Lorcana decks are 60 or more', () => {
      const mickey = { id: 'l1', name: 'Mickey Mouse - Brave Little Tailor', supertype: 'Character', subtypes: [], game: 'lorcana' };
      assert.deepStrictEqual(R.deckWarnings({ game: 'lorcana', format: 'Core (Constructed)', cards: [inDeck(mickey, 4)] }), [{ code: 'size_min', min: 60, actual: 4 }]);
    }],
    ['format names: EDH is Commander, an unknown one gets the game rules', () => {
      assert.strictEqual(R.rulesFor('mtg', 'EDH').format, 'Commander / EDH');
      assert.strictEqual(R.rulesFor('mtg', 'commander').copies, 1);
      const kitchen = R.rulesFor('mtg', 'Kitchen Table');
      assert.deepStrictEqual([kitchen.copies, kitchen.size, kitchen.commander], [4, { min: 60 }, null]);
    }],
    ['format lists and defaults come from the table', () => {
      assert.strictEqual(R.defaultFormat('mtg'), 'Commander / EDH');
      assert.ok(R.formatNames('mtg').includes('Brawl'));
      assert.deepStrictEqual(
        [R.defaultTargetSize('mtg', 'Commander / EDH'), R.defaultTargetSize('mtg', 'Brawl'), R.defaultTargetSize('mtg', 'Modern'), R.defaultTargetSize('pokemon', 'Standard'), R.defaultTargetSize('lorcana', 'Casual')],
        [100, 100, 60, 60, 60]
      );
    }],

    // --- What "any printing" means per game ---
    ['MTG: another printing with the same oracle id is the same card', () => {
      const a = { card_id: 'mtg-a', name: 'Sol Ring', oracle_id: 'o1' };
      assert.strictEqual(R.sameCard(a, { card_id: 'mtg-b', name: 'Sol Ring', oracle_id: 'o1' }, 'mtg', true), true);
      assert.strictEqual(R.sameCard(a, { card_id: 'mtg-b', name: 'Sol Ring', oracle_id: 'o1' }, 'mtg', false), false);
      assert.strictEqual(R.sameCard(a, { card_id: 'mtg-c', name: 'Sol Ring', oracle_id: 'o2' }, 'mtg', true), false);
    }],
    ['MTG: a row without an oracle id yet is matched by name', () =>
      assert.strictEqual(R.sameCard({ card_id: 'mtg-a', name: 'Sol Ring', oracle_id: 'o1' }, { card_id: 'mtg-old', name: 'Sol Ring', oracle_id: null }, 'mtg', true), true)],
    ['Lorcana: the same full name is the same card; another version is not', () => {
      const tailor = { card_id: 'l1', name: 'Mickey Mouse - Brave Little Tailor' };
      assert.strictEqual(R.sameCard(tailor, { card_id: 'l2', name: 'Mickey Mouse - Brave Little Tailor' }, 'lorcana', true), true);
      assert.strictEqual(R.sameCard(tailor, { card_id: 'l3', name: 'Mickey Mouse - True Friend' }, 'lorcana', true), false);
    }],
    ['Pokémon is always exact, whatever the deck says', () => {
      assert.strictEqual(R.sameCard({ card_id: 'p1', name: 'Pikachu' }, { card_id: 'p2', name: 'Pikachu' }, 'pokemon', true), false);
      assert.deepStrictEqual([R.supportsAnyPrinting('pokemon'), R.defaultAnyPrinting('pokemon')], [false, false]);
      assert.deepStrictEqual([R.defaultAnyPrinting('mtg'), R.defaultAnyPrinting('lorcana')], [true, true]);
    }],
  ];

  for (const [name, check] of cases) {
    try {
      check();
    } catch (err) {
      console.error(`Rule case failed: ${name}`);
      throw err;
    }
  }
  assert.ok(cases.length >= 30, 'the rule table should cover at least 30 cases');
  console.log(`  ${cases.length} deck rule cases passed`);
}

// --- Server-side enforcement, against real SQLite ---------------------------

async function cacheCard(card) {
  await db.run(
    `INSERT INTO card_cache (id, name, supertype, subtypes, game, color_identity, oracle_id, oracle_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [card.id, card.name, card.supertype, JSON.stringify(card.subtypes), card.game, JSON.stringify(card.color_identity || []), card.oracle_id || null, card.oracle_text ?? null]
  );
}
async function own(userId, cardId, copies) {
  for (let i = 0; i < copies; i++) {
    await db.run(`INSERT INTO collection (card_id, quantity, game, user_id) VALUES (?, 1, 'mtg', ?)`, [cardId, userId]);
  }
}
async function deck(userId, format) {
  return (await db.run(`INSERT INTO decks (name, game, format, user_id) VALUES (?, 'mtg', ?, ?)`, [format, format, userId])).lastID;
}
const put = (deckId, cardId, quantity) => db.run(
  `INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, ?) ON CONFLICT(deck_id, card_id) DO UPDATE SET quantity = excluded.quantity`,
  [deckId, cardId, quantity]
);

async function testEnforcement() {
  await db.initDb();
  const userId = (await db.get(`SELECT id FROM users WHERE username = 'admin'`)).id;
  const ringC21 = { ...SOL_RING, id: 'mtg-sol-ring-c21' };
  for (const card of [SOL_RING, ringC21, FOREST, BREEDING_POOL]) await cacheCard(card);
  await own(userId, SOL_RING.id, 4);
  await own(userId, ringC21.id, 1);
  await own(userId, FOREST.id, 40);
  await own(userId, BREEDING_POOL.id, 4);

  const edh = await deck(userId, 'Commander / EDH');
  const check = (deckId, cardId, newQty) => validateDeckAddition({ deckId, userId, cardId, newQty });

  assert.strictEqual((await check(edh, SOL_RING.id, 1)).ok, true, 'one Sol Ring in Commander');
  await put(edh, SOL_RING.id, 1);
  const second = await check(edh, SOL_RING.id, 2);
  assert.strictEqual(second.ok, false, 'a second Sol Ring is refused in Commander');
  assert.match(second.error, /more than 1 copy of Sol Ring/);
  assert.strictEqual((await check(edh, ringC21.id, 1)).ok, false, 'another printing of it counts by name');
  assert.strictEqual((await check(edh, FOREST.id, 40)).ok, true, 'forty Forests in Commander');
  assert.strictEqual((await check(edh, BREEDING_POOL.id, 2)).ok, false, 'Breeding Pool is no basic: singleton');

  const modern = await deck(userId, 'Modern');
  assert.strictEqual((await check(modern, BREEDING_POOL.id, 4)).ok, true, 'four Breeding Pools in Modern');
  await put(modern, SOL_RING.id, 4);
  assert.strictEqual((await check(modern, ringC21.id, 1)).ok, false, 'a fifth Sol Ring across printings is refused');

  // A Commander deck built under the old four-copy rule can still be cut down.
  await put(edh, SOL_RING.id, 4);
  assert.strictEqual((await check(edh, SOL_RING.id, 3)).ok, true, 'lowering an over-limit count always passes');
  assert.strictEqual((await check(edh, SOL_RING.id, 5)).ok, false, 'raising it does not');

  // Ownership: one C21 Sol Ring owned, so a deck may not list two of them.
  const exact = await deck(userId, 'Modern');
  assert.strictEqual((await check(exact, ringC21.id, 2)).ok, false, 'only one C21 owned');
}

async function main() {
  try {
    await testRuleTable();
    await testEnforcement();
    console.log('deckrules.test.js passed');
  } finally {
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
