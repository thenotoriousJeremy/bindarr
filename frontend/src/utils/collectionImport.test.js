import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importFormatFor } from './collectionImport.js';

test('the extension picks the import format', () => {
  assert.equal(importFormatFor('collection.json'), 'json');
  assert.equal(importFormatFor('Deck.TXT'), 'manabox');
  assert.equal(importFormatFor('tcgplayer.csv'), 'csv');
  // A spreadsheet saved as CSV, or no extension at all: the CSV mappers sort it out.
  assert.equal(importFormatFor('cards'), 'csv');
  assert.equal(importFormatFor(undefined), 'csv');
});
