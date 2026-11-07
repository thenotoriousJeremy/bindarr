import test from 'node:test';
import assert from 'node:assert/strict';
import { entriesOf, isComplete, filterCards, purchaseList, valueParts } from './setCompletion.js';

// Shaped like GET /api/set-completion cards.
const cards = [
  { id: 'a', name: 'Pineco', number: '001', owned: 2, price: 0.1, tcgplayer_product_id: 1,
    variants: [{ printing: 'Normal', owned: 1, price: 0.1 }, { printing: 'Reverse Holofoil', owned: 1, price: 0.3 }] },
  { id: 'b', name: 'Heracross', number: '002', owned: 1, price: 0.2, tcgplayer_product_id: 2,
    variants: [{ printing: 'Normal', owned: 1, price: 0.2 }, { printing: 'Reverse Holofoil', owned: 0, price: 0.5 }] },
  { id: 'c', name: 'Shroomish', number: '003', owned: 0, price: null, tcgplayer_product_id: null,
    variants: [{ printing: 'Normal', owned: 0, price: null }, { printing: 'Reverse Holofoil', owned: 0, price: null }] },
  { id: 'd', name: 'Youngster', number: '198', owned: 0, price: 0.4, tcgplayer_product_id: 4, variants: [] },
];

test('a card is one entry, or one per finish in the variant view', () => {
  assert.equal(entriesOf(cards[1]).length, 1);
  assert.equal(entriesOf(cards[1], true).length, 2);
  assert.equal(entriesOf(cards[3], true).length, 1, 'no finish data: the card itself');
  assert.equal(isComplete(cards[1]), true, 'one copy completes the card');
  assert.equal(isComplete(cards[1], true), false, 'but not its reverse holo');
});

test('owned and missing filters follow the view', () => {
  const ids = (list) => list.map(c => c.id);
  assert.deepEqual(ids(filterCards(cards, { show: 'all' })), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(filterCards(cards, { show: 'owned' })), ['a', 'b']);
  assert.deepEqual(ids(filterCards(cards, { show: 'missing' })), ['c', 'd']);
  assert.deepEqual(ids(filterCards(cards, { show: 'owned', variants: true })), ['a']);
  assert.deepEqual(ids(filterCards(cards, { show: 'missing', variants: true })), ['b', 'c', 'd']);
  assert.deepEqual(filterCards(undefined), []);
});

test('the purchase list is one line per card, quantity = finishes still to get', () => {
  assert.deepEqual(purchaseList(cards, { setCode: 'SV01' }), [
    { quantity: 1, name: 'Shroomish', setCode: 'SV01', number: '003', productId: null },
    { quantity: 1, name: 'Youngster', setCode: 'SV01', number: '198', productId: 4 },
  ]);
  assert.deepEqual(purchaseList(cards, { variants: true }).map(i => [i.name, i.quantity]),
    [['Heracross', 1], ['Shroomish', 2], ['Youngster', 1]]);
});

test('missing value parts never add currencies together', () => {
  assert.deepEqual(valueParts({ EUR: 4.1, USD: 12.3, GBP: 0 }), [['USD', 12.3], ['EUR', 4.1]]);
  assert.deepEqual(valueParts(null), []);
});
