import test from 'node:test';
import assert from 'node:assert/strict';
import { addCardsToList } from './listsApi.js';

// A stand-in for fetch() that records each request and answers from `respond`.
function stubFetch(respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const { status = 200, json } = respond(body, calls.length);
    return { status, ok: status >= 200 && status < 300, json: async () => json };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('addCardsToList sends one request for many cards, not one per card', async () => {
  const stub = stubFetch(body => ({ status: 201, json: { added: body.card_ids.length, failed: [], error: null } }));
  try {
    const result = await addCardsToList(7, ['a', 'b', 'a', 'c']);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, '/api/lists/7/items');
    assert.deepEqual(stub.calls[0].body, { card_ids: ['a', 'b', 'c'], quantity_wanted: 1 });
    assert.deepEqual(result, { added: 3, failed: [], error: null });
  } finally {
    stub.restore();
  }
});

test('addCardsToList splits a large selection into requests the server accepts', async () => {
  const ids = Array.from({ length: 1201 }, (_, i) => `card-${i}`);
  const stub = stubFetch(body => ({ status: 201, json: { added: body.card_ids.length, failed: [], error: null } }));
  try {
    const result = await addCardsToList(1, ids);
    assert.deepEqual(stub.calls.map(c => c.body.card_ids.length), [500, 500, 201]);
    assert.equal(result.added, 1201);
  } finally {
    stub.restore();
  }
});

test('addCardsToList passes on what the server refused', async () => {
  const stub = stubFetch(() => ({ status: 201, json: { added: 1, failed: ['lorcana-x'], error: 'This list only takes mtg cards.' } }));
  try {
    assert.deepEqual(await addCardsToList(1, ['mtg-a', 'lorcana-x']), { added: 1, failed: ['lorcana-x'], error: 'This list only takes mtg cards.' });
  } finally {
    stub.restore();
  }
  const none = stubFetch(() => ({ status: 400, json: { added: 0, failed: ['lorcana-x'], error: 'This list only takes mtg cards.' } }));
  try {
    assert.deepEqual(await addCardsToList(1, ['lorcana-x']), { added: 0, failed: ['lorcana-x'], error: 'This list only takes mtg cards.' });
    assert.equal(none.calls.length, 1, 'a refusal from a bulk-aware server is not retried card by card');
  } finally {
    none.restore();
  }
});

test('addCardsToList falls back to one card at a time on a server without the bulk form', async () => {
  const stub = stubFetch((body) => (body.card_ids
    ? { status: 400, json: { error: 'card_id is required' } }
    : { status: 201, json: { id: 1, card_id: body.card_id } }));
  try {
    const result = await addCardsToList(3, ['a', 'b']);
    assert.deepEqual(stub.calls.map(c => c.body), [
      { card_ids: ['a', 'b'], quantity_wanted: 1 },
      { card_id: 'a', quantity_wanted: 1 },
      { card_id: 'b', quantity_wanted: 1 },
    ]);
    assert.deepEqual(result, { added: 2, failed: [], error: null });
  } finally {
    stub.restore();
  }
});

test('addCardsToList reports every card of a request that never arrived', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  try {
    assert.deepEqual(await addCardsToList(1, ['a', 'b']), { added: 0, failed: ['a', 'b'], error: null });
  } finally {
    globalThis.fetch = original;
  }
});
