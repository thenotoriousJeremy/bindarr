import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupForUpload } from './backupUpload.js';

const backup = {
  version: 1,
  exported_at: '2026-11-15T00:00:00.000Z',
  data: {
    collection: [{ id: 1, card_id: 'a' }],
    decks: [],
    card_cache: [{ id: 'a', name: 'Pikachu' }],
    price_history: [{ card_id: 'a', price: 1 }],
    tcgplayer_product: [{ card_id: 'a', product_id: 9 }],
  },
};

test("a member's upload leaves out the shared card data the server would ignore", () => {
  const sent = backupForUpload(backup, 'member');
  assert.deepEqual(Object.keys(sent.data).sort(), ['collection', 'decks']);
  assert.equal(sent.version, 1, 'everything outside data is kept');
  assert.ok(backup.data.card_cache, 'the parsed file itself is not changed');
});

test("an admin's upload is sent whole", () => {
  assert.equal(backupForUpload(backup, 'admin'), backup);
});

test('a file without a data object is passed through for the server to refuse', () => {
  assert.equal(backupForUpload(null, 'member'), null);
  const odd = { version: 1 };
  assert.equal(backupForUpload(odd, 'member'), odd);
});
