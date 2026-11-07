import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPageColumns, pageColumns, pageGrid, PAGE_COLUMN_CHOICES, MAX_PAGE_COLUMNS, layoutPockets } from './binderLayout.js';

test('standard pocket pages get their real width', () => {
  const expected = { 4: 2, 6: 3, 8: 4, 9: 3, 12: 4, 16: 4, 18: 6, 20: 5, 24: 6, 25: 5, 36: 6 };
  for (const [cap, cols] of Object.entries(expected)) {
    assert.equal(defaultPageColumns(Number(cap)), cols, `${cap} pockets`);
  }
});

test('a 12-pocket page is 4 wide and 3 tall, not 3 by 4 (issue #90)', () => {
  assert.deepEqual(pageGrid(12), { columns: 4, rows: 3 });
});

test('an unlisted capacity falls back to the nearest square', () => {
  assert.equal(defaultPageColumns(13), 4);
  assert.equal(defaultPageColumns(2), 1);
  assert.equal(defaultPageColumns(49), 7);
});

test('missing or nonsense capacity still draws one column', () => {
  assert.equal(defaultPageColumns(0), 1);
  assert.equal(defaultPageColumns(undefined), 1);
  assert.equal(defaultPageColumns('abc'), 1);
});

test('the binder setting overrides the default', () => {
  assert.equal(pageColumns(12, 3), 3);
  assert.equal(pageColumns(9, '4'), 4);
  assert.deepEqual(pageGrid(12, 3), { columns: 3, rows: 4 });
});

test('rows round up when the capacity does not divide evenly', () => {
  assert.deepEqual(pageGrid(10, 4), { columns: 4, rows: 3 });
});

test('a null, empty or out-of-range setting means automatic', () => {
  for (const off of [null, undefined, '', 0, -2, MAX_PAGE_COLUMNS + 1, 2.5, 'x']) {
    assert.equal(pageColumns(12, off), 4, `override ${JSON.stringify(off)}`);
  }
});

test('the picker offers every width from 1 to the maximum', () => {
  assert.equal(PAGE_COLUMN_CHOICES.length, MAX_PAGE_COLUMNS);
  assert.equal(PAGE_COLUMN_CHOICES[0], 1);
  assert.equal(PAGE_COLUMN_CHOICES.at(-1), MAX_PAGE_COLUMNS);
});

const pocketCard = (entry_id, position, extra = {}) => ({ entry_id, card_id: `c${entry_id}`, position, quantity: 1, ...extra });
const ids = (pockets) => pockets.map(p => (p ? p.entry_id : null));

test('cards sit in the pocket their position names, gaps stay empty', () => {
  const pockets = layoutPockets([pocketCard(1, 3000), pocketCard(2, 1000)], 4);
  assert.deepEqual(ids(pockets), [2, null, 1, null]);
});

test('an unplaced card, or one whose pocket is taken, fills the first free pocket', () => {
  const pockets = layoutPockets([pocketCard(1, 2000), pocketCard(2, 2000), pocketCard(3, 0)], 3);
  assert.deepEqual(ids(pockets), [2, 1, 3]);
});

test('a page holding more than its capacity grows rather than hiding cards', () => {
  assert.deepEqual(ids(layoutPockets([pocketCard(1, 1000), pocketCard(2, 0)], 1)), [1, 2]);
  assert.deepEqual(ids(layoutPockets([pocketCard(1, 5000)], 2)), [null, null, null, null, 1]);
});

test('a stacking binder gives every copy of a card one pocket', () => {
  const copies = [pocketCard(1, 0, { card_id: 'x' }), pocketCard(2, 2000, { card_id: 'x' })];
  const pockets = layoutPockets(copies, 2, true);
  assert.deepEqual(ids(pockets), [null, 1]);
  assert.equal(pockets[1].quantity, 2);
  assert.equal(layoutPockets(copies, 2, false).filter(Boolean).length, 2);
});
