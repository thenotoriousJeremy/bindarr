import test from 'node:test';
import assert from 'node:assert/strict';
import { linkableCardsUrl, purchasesUrl, purchasesFrom } from './sealedQueries.js';

const paramsOf = (url) => Object.fromEntries(new URL(url, 'https://bindarr.test').searchParams);

test("linking cards to a pack reads one game's copies in the grid's slim columns", () => {
  // The whole collection with every column (38 MB at 20,000 copies) was read
  // to list a handful of cards from one game.
  const url = linkableCardsUrl('mtg');
  assert.ok(url.startsWith('/api/collection?'));
  assert.deepEqual(paramsOf(url), { list_type: 'collection', fields: 'grid', game: 'mtg' });
});

test('a purchase without a game reads every game rather than none', () => {
  assert.deepEqual(paramsOf(linkableCardsUrl(null)), { list_type: 'collection', fields: 'grid' });
  assert.deepEqual(paramsOf(linkableCardsUrl('')), { list_type: 'collection', fields: 'grid' });
});

test('the purchases list asks for claimed units only when shown', () => {
  assert.equal(purchasesUrl(false), '/api/sealed/purchases');
  assert.equal(purchasesUrl(true), '/api/sealed/purchases?show_claimed_by_others=1');
});

test('an error body is never taken for a list of purchases', () => {
  assert.deepEqual(purchasesFrom({ error: 'Failed to fetch purchases' }), []);
  assert.deepEqual(purchasesFrom(null), []);
  assert.deepEqual(purchasesFrom({ purchases: 'nope' }), []);
  assert.deepEqual(purchasesFrom({ purchases: [{ id: 1 }] }), [{ id: 1 }]);
});
