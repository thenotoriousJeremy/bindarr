import test from 'node:test';
import assert from 'node:assert/strict';
import { stackCollectionRows, stackPocketCards } from './stackTiles.js';

const row = (entry_id, extra = {}) => ({
  entry_id, card_id: 'mtg-a', quantity: 1, condition: 'Near Mint', printing: 'Normal', language: 'English', ...extra,
});

test('a collection tile names every row it stands for, the shown one first', () => {
  const rows = [
    row(5), row(4, { condition: 'Lightly Played' }), row(3), row(2, { condition: 'Lightly Played' }), row(1),
    row(9, { card_id: 'mtg-b' }),
  ];
  const [a, b] = stackCollectionRows(rows);
  assert.equal(a.entry_id, 5, 'the tile is the first row of its group');
  assert.equal(a.quantity, 5);
  assert.deepEqual(a.member_ids, [5, 4, 3, 2, 1], 'the x5 of 3 NM + 2 LP is all five rows');
  assert.deepEqual(b.member_ids, [9]);
});

test('splitting by condition or printing splits the members too', () => {
  const rows = [row(1), row(2, { condition: 'Lightly Played' }), row(3), row(4, { printing: 'Holofoil' })];
  const byCondition = stackCollectionRows(rows, { byCondition: true });
  assert.deepEqual(byCondition.map(t => [t.quantity, t.member_ids]), [[3, [1, 3, 4]], [1, [2]]]);
  const byBoth = stackCollectionRows(rows, { byCondition: true, byPrinting: true });
  assert.deepEqual(byBoth.map(t => t.member_ids), [[1, 3], [2], [4]]);
});

test('tiles keep the order the rows came in, whatever the card ids look like', () => {
  const tiles = stackCollectionRows([row(1, { card_id: 'zzz' }), row(2, { card_id: '42' }), row(3, { card_id: '7' })]);
  assert.deepEqual(tiles.map(t => t.card_id), ['zzz', '42', '7']);
});

test('a stacking pocket names its rows and keeps the filed position', () => {
  const pocket = stackPocketCards([
    row(1, { position: 0 }),
    row(2, { position: 3000, condition: 'Damaged' }),
    row(3, { position: 3000, printing: 'Holofoil' }),
  ]);
  assert.equal(pocket.length, 2, 'a different printing is its own pocket; condition is not');
  assert.equal(pocket[0].quantity, 2);
  assert.deepEqual(pocket[0].member_ids, [1, 2]);
  assert.equal(pocket[0].position, 3000, 'an unplaced copy does not drag the pocket to no position');
  assert.deepEqual(pocket[1].member_ids, [3]);
});

test('the rows themselves are not modified', () => {
  const rows = [row(1), row(2)];
  stackCollectionRows(rows);
  stackPocketCards(rows);
  assert.deepEqual(rows, [row(1), row(2)]);
});
