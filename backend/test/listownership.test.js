// Owned vs wanted for card lists (utils/listOwnership.js): exact and
// any-printing matching, condition/language narrowing, and money that never
// mixes currencies nor counts an unpriced card as free.
const assert = require('assert');
const {
  parseQuantity, sameCard, evaluateItems, summarize,
} = require('../src/utils/listOwnership');

// parseQuantity: whole numbers 1-9999 only.
assert.strictEqual(parseQuantity(1), 1);
assert.strictEqual(parseQuantity(9999), 9999);
assert.strictEqual(parseQuantity('12'), 12);
for (const bad of [0, -1, 2.5, 10000, '3x', '', null, undefined, '1e3', true]) {
  assert.strictEqual(parseQuantity(bad), null, `${JSON.stringify(bad)} must be refused`);
}

const bolt = (id, extra = {}) => ({ id, name: 'Lightning Bolt', game: 'mtg', price_currency: 'USD', ...extra });

// sameCard: game first, then English or printed name; oracle_id wins when both have it.
assert.ok(sameCard(bolt('mtg-a'), bolt('mtg-b')));
assert.ok(!sameCard(bolt('mtg-a'), { id: 'x', name: 'Lightning Bolt', game: 'lorcana' }), 'other game is another card');
assert.ok(sameCard({ name: 'Pikachu', game: 'pokemon' }, { name: 'ピカチュウ', printed_name: 'Pikachu', game: 'pokemon' }));
assert.ok(!sameCard(bolt('a', { oracle_id: 'o1' }), bolt('b', { oracle_id: 'o2' })), 'oracle_id decides when both carry one');
assert.ok(sameCard(bolt('a', { oracle_id: 'o1' }), bolt('b')), 'falls back to name when one lacks it');

const owned = [
  { card_id: 'mtg-a', condition: 'Near Mint', language: 'English', qty: 1, name: 'Lightning Bolt', game: 'mtg' },
  { card_id: 'mtg-b', condition: 'Heavily Played', language: 'English', qty: 2, name: 'Lightning Bolt', game: 'mtg' },
  { card_id: 'mtg-c', condition: 'Near Mint', language: 'Japanese', qty: 1, name: 'Lightning Bolt', printed_name: '稲妻', game: 'mtg' },
  { card_id: 'lorcana-x', condition: 'Near Mint', language: 'English', qty: 5, name: 'Lightning Bolt', game: 'lorcana' },
];

const item = (over) => ({ card_id: 'mtg-a', quantity_wanted: 4, any_printing: 0, condition_min: null, language: null, card: bolt('mtg-a', { price_trend: 2 }), ...over });

// Exact: only mtg-a counts.
let [e] = evaluateItems([item()], owned);
assert.strictEqual(e.owned, 1);
assert.strictEqual(e.missing, 3);
assert.strictEqual(e.missing_value, 6);

// Any printing: every MTG Lightning Bolt, never the Lorcana namesake.
[e] = evaluateItems([item({ any_printing: 1 })], owned);
assert.strictEqual(e.owned, 4);
assert.strictEqual(e.missing, 0);
assert.strictEqual(e.missing_value, 0);

// condition_min: Heavily Played copies do not satisfy a Lightly Played want.
[e] = evaluateItems([item({ any_printing: 1, condition_min: 'Lightly Played' })], owned);
assert.strictEqual(e.owned, 2);
// language narrows to the Japanese copy.
[e] = evaluateItems([item({ any_printing: 1, language: 'Japanese' })], owned);
assert.strictEqual(e.owned, 1);

// Money: per currency, unknown prices excluded and counted as unpriced.
const evaluated = evaluateItems([
  item({ id: 1, quantity_wanted: 3, card: bolt('mtg-a', { price_trend: 2.5 }) }),                       // 2 missing x $2.50
  item({ id: 2, card_id: 'tcgdex-de-x', quantity_wanted: 2, card: { id: 'tcgdex-de-x', name: 'Glurak', game: 'pokemon', price_trend: 10, price_currency: 'EUR' } }),
  item({ id: 3, card_id: 'none-1', quantity_wanted: 1, card: { id: 'none-1', name: 'Unpriced', game: 'pokemon', price_trend: null } }),
  item({ id: 4, card_id: 'none-2', quantity_wanted: 1, card: { id: 'none-2', name: 'Zero', game: 'pokemon', price_trend: 0, price_currency: 'USD' } }),
], owned);
assert.strictEqual(evaluated[2].missing_value, null, 'no price is unknown, not 0');
assert.strictEqual(evaluated[3].missing_value, null, 'a 0 price is no price');
const s = summarize(evaluated);
assert.deepStrictEqual(s.missing_value, { USD: 5, EUR: 20 });
assert.strictEqual(s.unpriced, 2);
assert.strictEqual(s.wanted, 7);
assert.strictEqual(s.owned, 1);
assert.strictEqual(s.missing, 6);
assert.strictEqual(s.complete, 0);

// Owning more than wanted caps the owned total at what the list asks for.
const capped = summarize(evaluateItems([item({ any_printing: 1, quantity_wanted: 1 })], owned));
assert.strictEqual(capped.owned, 1);
assert.strictEqual(capped.complete, 1);
assert.deepStrictEqual(capped.missing_value, {});

console.log('listownership.test.js: all assertions passed');
