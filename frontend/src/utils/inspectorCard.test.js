import test from 'node:test';
import assert from 'node:assert/strict';
import { localizedPreview, savedPrintingFields } from './inspectorCard.js';

// A recent-scans tile: entry_id is the row, card_id and id the printing.
const tile = () => ({
  entry_id: 41, id: 'sv1-25', card_id: 'sv1-25', name: 'Pikachu', image_url: 'en.png',
  language: 'English', quantity: 2, member_ids: [41, 42],
});
const japanese = { id: 'sv1-25-ja', name: 'Pikachu', printed_name: 'ピカチュウ', image_url: 'ja.png', set_name: 'スカーレットex' };

test('a language preview is a copy: the caller\'s card is left as it was', () => {
  const card = tile();
  const before = structuredClone(card);
  const preview = localizedPreview(card, japanese, 'Japanese');
  assert.deepEqual(card, before, 'nothing written onto the caller\'s object');
  assert.notEqual(preview, card);
  assert.equal(preview.card_id, 'sv1-25-ja');
  assert.equal(preview.language, 'Japanese');
  assert.equal(preview.printed_name, 'ピカチュウ');
  assert.equal(preview.entry_id, 41, 'still the same entry');
  assert.equal(preview.quantity, 2);
});

test('a saved switch moves the card to the printing but keeps the ids it is found by', () => {
  const card = tile();
  Object.assign(card, savedPrintingFields(localizedPreview(card, japanese, 'Japanese')));
  assert.equal(card.entry_id, 41);
  assert.equal(card.id, 'sv1-25', 'id is not overwritten (on some screens it is the entry id)');
  assert.equal(card.card_id, 'sv1-25-ja');
  assert.equal(card.image_url, 'ja.png');
  assert.equal(card.language, 'Japanese');
  assert.deepEqual(card.member_ids, [41, 42]);
});

test('a preview of a card with no caller object still has the printing', () => {
  assert.deepEqual(localizedPreview(null, { id: 'x' }, 'German'), { id: 'x', card_id: 'x', language: 'German' });
});
