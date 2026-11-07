import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWishlistStore } from './wishlist.js';

const reply = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

// A fake server: records calls, answers from `handler`.
function fakeFetch(handler) {
  const calls = [];
  const fn = (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    return handler(url, opts);
  };
  fn.calls = calls;
  return fn;
}

test('loads once, and again only when forced', async () => {
  const fetch = fakeFetch(() => reply(200, { list: null, card_ids: ['a', 'b'] }));
  const store = createWishlistStore(fetch);
  assert.equal(store.isLoaded(), false);
  await Promise.all([store.load(), store.load()]);
  assert.equal(fetch.calls.length, 1, 'concurrent loads share one request');
  assert.ok(store.has('a') && store.has('b'));
  await store.load();
  assert.equal(fetch.calls.length, 1);
  await store.load({ force: true });
  assert.equal(fetch.calls.length, 2);
});

test('add shows at once, sends every id once, and takes the server set', async () => {
  let release;
  const fetch = fakeFetch(() => new Promise(r => { release = () => r(reply(201, { added: 2, already: 0, failed: [], card_ids: ['x', 'y'] })); }));
  const store = createWishlistStore(fetch);
  let notified = 0;
  store.subscribe(() => { notified++; });
  const done = store.add(['x', 'y', 'x', null]);
  assert.ok(store.has('x') && store.has('y'), 'optimistic');
  assert.ok(notified > 0);
  assert.deepEqual(fetch.calls[0].body, { card_ids: ['x', 'y'] });
  release();
  assert.deepEqual(await done, { added: 2, already: 0, failed: [], error: null });
  assert.equal(store.size(), 2);
});

test('a refused add is undone, leaving cards already there alone', async () => {
  const fetch = fakeFetch((url, opts) => (opts.method === 'POST'
    ? reply(400, { error: 'nope' })
    : reply(200, { card_ids: ['keep'] })));
  const store = createWishlistStore(fetch);
  await store.load();
  const result = await store.add(['keep', 'new']);
  assert.equal(result.error, 'nope');
  assert.ok(store.has('keep'), 'was there before');
  assert.ok(!store.has('new'), 'undone');
});

test('a network failure undoes a remove', async () => {
  const fetch = fakeFetch((url, opts) => (opts.method === 'DELETE'
    ? Promise.reject(new Error('offline'))
    : reply(200, { card_ids: ['c1'] })));
  const store = createWishlistStore(fetch);
  await store.load();
  assert.equal(await store.remove('c1'), false);
  assert.ok(store.has('c1'));
});

test('remove escapes the id and takes the server set', async () => {
  const fetch = fakeFetch((url, opts) => (opts.method === 'DELETE'
    ? reply(200, { removed: 1, card_ids: [] })
    : reply(200, { card_ids: ['a/b'] })));
  const store = createWishlistStore(fetch);
  await store.load();
  assert.equal(await store.remove('a/b'), true);
  assert.equal(fetch.calls[1].url, '/api/lists/default/items/a%2Fb');
  assert.ok(!store.has('a/b'));
});

test('an earlier answer does not drop a heart tapped after it', async () => {
  const pending = [];
  const fetch = fakeFetch((url, opts) => new Promise(r => pending.push({ r, body: JSON.parse(opts.body) })));
  const store = createWishlistStore(fetch);
  const first = store.add(['a']);
  const second = store.add(['b']);
  // The server answers the first before it has seen the second.
  pending[0].r(reply(201, { added: 1, card_ids: ['a'] }));
  await first;
  assert.ok(store.has('b'), 'b stays while its own add is in flight');
  pending[1].r(reply(201, { added: 1, card_ids: ['a', 'b'] }));
  await second;
  assert.ok(store.has('a') && store.has('b'));
});

test('reset forgets the last account', async () => {
  const fetch = fakeFetch(() => reply(200, { card_ids: ['a'] }));
  const store = createWishlistStore(fetch);
  await store.load();
  store.reset();
  assert.equal(store.has('a'), false);
  assert.equal(store.isLoaded(), false);
  await store.load();
  assert.equal(fetch.calls.length, 2, 'the next session reads its own');
});
