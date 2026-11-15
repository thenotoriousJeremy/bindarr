import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bulkResultKey, bulkResultText } from './bulkResult.js';
import { translate } from './translate.js';

const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));
const tEn = (key, vars) => translate(en, en, 'en', key, vars);
// A German reader with no translation for these yet still gets English, never the
// server's sentence.
const tDe = (key, vars) => translate({}, en, 'de', key, vars);

test('counted actions are phrased here, with plural forms', () => {
  assert.equal(bulkResultText(tEn, 'delete', null, { message: 'Deleted 1 card(s)', affected: 1, trash_batch: 'b' }), 'Deleted 1 card');
  assert.equal(bulkResultText(tEn, 'delete', null, { message: 'Deleted 3 card(s)', affected: 3 }), 'Deleted 3 cards');
  assert.equal(bulkResultText(tEn, 'trade', null, { message: 'Updated 2 card(s)', affected: 2 }), 'Marked 2 cards for trade');
  assert.equal(bulkResultText(tEn, 'untrade', null, { message: 'Updated 1 card(s)', affected: 1 }), 'Removed 1 card from trade');
  assert.equal(bulkResultText(tEn, 'condition', 'Near Mint', { affected: 4 }), 'Set the condition of 4 cards');
  assert.equal(bulkResultText(tEn, 'printing', 'Holofoil', { affected: 1 }), 'Set the printing of 1 card');
  assert.equal(bulkResultText(tEn, 'language', 'German', { affected: 2 }), 'Set the language of 2 cards');
  assert.equal(bulkResultText(tEn, 'add_to_deck', '7', { message: 'Added 5 card(s) to deck', affected: 5, rejected: 0 }), 'Added 5 cards to the deck');
  assert.equal(bulkResultText(tEn, 'list_type', 'wishlist', { affected: 1 }), 'Moved 1 card to the wishlist');
  assert.equal(bulkResultText(tEn, 'list_type', 'collection', { affected: 1200 }), 'Moved 1,200 cards to the collection');
});

test('a move names Unsorted when it unfiles, and unlinking a sealed unit is a count', () => {
  assert.equal(bulkResultText(tEn, 'move', null, { message: 'Moved 2 card(s)', affected: 2, previous: [] }), 'Moved 2 cards to Unsorted');
  assert.equal(bulkResultText(tEn, 'move', '12', { message: 'Moved 1 card(s)', affected: 1, container_full: false }), 'Moved 1 card');
  assert.equal(bulkResultText(tEn, 'set_sealed_unit', null, { message: 'Linked 3 card(s) to the sealed unit', affected: 3 }), 'Unlinked 3 cards from their sealed product');
});

test("what only the server can say is left in the server's words", () => {
  const partialDeck = { message: 'Added 2 card(s). Cannot have more than 4 copies of Sol Ring.', affected: 2, rejected: 1 };
  assert.equal(bulkResultText(tEn, 'add_to_deck', '7', partialDeck), partialDeck.message);
  const full = { message: 'Moved 3 card(s); 2 did not fit because the container is full', affected: 3, container_full: true };
  assert.equal(bulkResultText(tEn, 'move', '12', full), full.message);
  const split = { message: 'Split $12.00 across 3 card(s) (by value)', affected: 3 };
  assert.equal(bulkResultText(tEn, 'purchase_split', { total: 12 }, split), split.message);
  const link = { message: 'Linked 3 card copy/copies; allocated $4.99 across the opened pack', affected: 3 };
  assert.equal(bulkResultText(tEn, 'set_sealed_unit', '9', link), link.message);
  assert.equal(bulkResultText(tEn, 'link_sealed_unit', { unit_id: 9, total: 5 }, { message: 'Linked…', affected: 2 }), 'Linked…');
  assert.equal(bulkResultText(tEn, 'some_future_action', null, { message: 'Did a thing', affected: 1 }), 'Did a thing');
  assert.equal(bulkResultText(tEn, 'move', '12', { message: 'Moved 1, skipped 1', affected: 1, skipped: 1 }), 'Moved 1, skipped 1');
});

test('an answer with no count or message still says something', () => {
  assert.equal(bulkResultKey('delete', null, {}), null);
  assert.equal(bulkResultText(tEn, 'delete', null, {}), en['bulk.done']);
  assert.equal(bulkResultText(tEn, 'delete', null, null), en['bulk.done']);
  assert.equal(bulkResultText(tEn, 'list_type', 'binder', { message: 'Moved', affected: 1 }), 'Moved');
});

test('the phrasing follows the interface language, not the server', () => {
  // Untranslated keys fall back to English per key; the server's sentence is not used.
  assert.equal(bulkResultText(tDe, 'delete', null, { message: 'Deleted 2 card(s)', affected: 2 }), 'Deleted 2 cards');
});
