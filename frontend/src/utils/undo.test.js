import test from 'node:test';
import assert from 'node:assert/strict';
import { undoFor, placementUndo, deckCardUndo, runUndo, undoResult, undoToast, parseSqliteUtc, daysLeft } from './undo.js';

test('a delete offers its trash batch back, other bulk actions offer nothing', () => {
  assert.deepEqual(undoFor('delete', null, { trash_batch: 'b-1' }), { kind: 'trash', batch: 'b-1' });
  assert.equal(undoFor('delete', null, { affected: 0, trash_batch: null }), null, 'nothing was deleted');
  assert.equal(undoFor('trade', null, { affected: 2 }), null);
  assert.equal(undoFor('condition', 'Near Mint', { affected: 2 }), null);
  assert.equal(undoFor('delete', null, null), null);
});

test('a move to Unsorted offers its old placements; a move into a container does not', () => {
  const previous = [{ entry_id: 1, location_id: 2, compartment_id: 3, position: 4000 }];
  assert.deepEqual(undoFor('move', null, { previous }), { kind: 'placement', placements: previous });
  assert.equal(undoFor('move', null, { previous: [] }), null, 'every copy was already unsorted');
  assert.equal(undoFor('move', '7', { previous }), null);
});

test('single-copy unfile and deck removal build their own undo', () => {
  assert.deepEqual(placementUndo({ entry_id: 9, location_id: 1, compartment_id: 2, position: 3000 }), {
    kind: 'placement', placements: [{ entry_id: 9, location_id: 1, compartment_id: 2, position: 3000 }]
  });
  assert.equal(placementUndo({ entry_id: 9, location_id: null, compartment_id: null }), null);
  assert.deepEqual(deckCardUndo(5, { id: 'mtg-x', quantity: 3 }), { kind: 'deckCard', deckId: 5, cardId: 'mtg-x', quantity: 3 });
  assert.equal(deckCardUndo(5, { id: 'mtg-x', quantity: 0 }), null);
  assert.equal(deckCardUndo(null, { id: 'mtg-x', quantity: 1 }), null);
});

test('runUndo calls the inverse endpoint and never throws', async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push([url, init.method, init.body]);
    return { ok: true, json: async () => ({ restored: 2 }) };
  };
  assert.deepEqual(await runUndo({ kind: 'trash', batch: 'a/b' }, fake), { ok: true, data: { restored: 2 } });
  await runUndo({ kind: 'placement', placements: [{ entry_id: 1 }] }, fake);
  await runUndo({ kind: 'deckCard', deckId: 4, cardId: 'c', quantity: 2 }, fake);
  assert.deepEqual(calls, [
    ['/api/collection/trash/a%2Fb/restore', 'POST', undefined],
    ['/api/collection/restore-placement', 'POST', JSON.stringify({ placements: [{ entry_id: 1 }] })],
    ['/api/decks/4/cards', 'POST', JSON.stringify({ card_id: 'c', quantity: 2 })],
  ]);
  const down = async () => { throw new Error('offline'); };
  assert.deepEqual(await runUndo({ kind: 'trash', batch: 'x' }, down), { ok: false, data: {} });
});

test('undoResult says when copies could not go back to their slot', () => {
  const trash = { kind: 'trash', batch: 'b' };
  assert.deepEqual(undoResult(trash, { ok: true, data: { restored: 3, unsorted: 0 } }), { key: 'undo.restored', values: { count: 3 } });
  assert.deepEqual(undoResult(trash, { ok: true, data: { restored: 3, unsorted: 1 } }), { key: 'undo.restoredSomeUnsorted', values: { count: 3, unsorted: 1 } });
  assert.deepEqual(undoResult(trash, { ok: false, data: {} }), { key: 'undo.failed', values: {} });
  const placement = { kind: 'placement', placements: [] };
  assert.deepEqual(undoResult(placement, { ok: true, data: { restored: 1, unplaced: 1 } }), { key: 'undo.placedSomeUnsorted', values: { count: 1 } });
  assert.deepEqual(undoResult(placement, { ok: true, data: { restored: 1, unplaced: 0 } }), { key: 'undo.done', values: {} });
});

test('undoToast gives no button without an undo', () => {
  assert.equal(undoToast(null, { showToast: () => {}, t: k => k }), undefined);
  assert.equal(typeof undoToast({ kind: 'trash', batch: 'b' }, { showToast: () => {}, t: k => k }).onAction, 'function');
});

test('trash timestamps are UTC and count down in whole days', () => {
  assert.equal(parseSqliteUtc('2026-11-07 12:00:00').toISOString(), '2026-11-07T12:00:00.000Z');
  assert.equal(parseSqliteUtc('garbage'), null);
  const now = Date.parse('2026-11-07T12:00:00Z');
  assert.equal(daysLeft('2026-12-07 12:00:00', now), 30);
  assert.equal(daysLeft('2026-11-08 06:00:00', now), 1, 'part of a day left is a day');
  assert.equal(daysLeft('2026-11-01 00:00:00', now), 0, 'never negative');
  assert.equal(daysLeft(null, now), 0);
});
