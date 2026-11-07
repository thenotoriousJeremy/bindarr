import test from 'node:test';
import assert from 'node:assert/strict';
import { filterItems, listAsText, currencyTotals, progressPercent } from './listText.js';

const items = [
  { card_id: 'mtg-a', quantity_wanted: 4, missing: 3, card: { name: 'Lightning Bolt', set_id: 'mtg-m10', number: '146' } },
  { card_id: 'pk-1', quantity_wanted: 1, missing: 0, card: { name: 'Pikachu', set_id: 'sv1', number: '25' } },
  { card_id: 'lorcana-x', quantity_wanted: 2, missing: 2, card: { name: 'Elsa', set_id: '', number: '' } },
];

test('filterItems: missing and owned split on what is still missing', () => {
  assert.deepEqual(filterItems(items, 'missing').map(i => i.card_id), ['mtg-a', 'lorcana-x']);
  assert.deepEqual(filterItems(items, 'owned').map(i => i.card_id), ['pk-1']);
  assert.equal(filterItems(items, 'all').length, 3);
});

test('listAsText: qty name [SET] number, set code without the mtg- prefix', () => {
  assert.equal(listAsText(items), '4 Lightning Bolt [M10] 146\n1 Pikachu [SV1] 25\n2 Elsa');
  assert.equal(listAsText(items, { useMissing: true }), '3 Lightning Bolt [M10] 146\n2 Elsa');
  assert.equal(listAsText([]), '');
});

test('currencyTotals: one row per currency, never summed together', () => {
  assert.deepEqual(currencyTotals({ USD: 5, EUR: 20, GBP: 0 }), [
    { currency: 'EUR', amount: 20 },
    { currency: 'USD', amount: 5 },
  ]);
  assert.deepEqual(currencyTotals(undefined), []);
});

test('progressPercent: owned over wanted copies', () => {
  assert.equal(progressPercent({ wanted: 8, owned: 2 }), 25);
  assert.equal(progressPercent({ wanted: 0, owned: 0 }), 0);
  assert.equal(progressPercent(null), 0);
});
