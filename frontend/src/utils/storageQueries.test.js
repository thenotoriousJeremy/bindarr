import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLatestLoader, applyCardPatch, createCardStore, readCardPatch,
  evictedText, applyAllText, importContainerText,
} from './storageQueries.js';

// A promise resolved from outside, so a test decides the order answers land in.
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

const answer = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Echoes the key and its variables, so a test can see which key was chosen.
const t = (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);

test("a container's pages that arrive late never land under the next container", async () => {
  const pending = {};
  const loader = createLatestLoader({
    fetchImpl: (url) => { pending[url] = deferred(); return pending[url].promise; },
  });
  const a = loader.load('/api/locations/1/compartments');
  const b = loader.load('/api/locations/2/compartments');
  pending['/api/locations/2/compartments'].resolve(answer([{ id: 20 }]));
  pending['/api/locations/1/compartments'].resolve(answer([{ id: 10 }]));
  assert.deepEqual(await b, { data: [{ id: 20 }] });
  assert.deepEqual(await a, { stale: true }, 'container 1 was replaced by container 2');
});

test('cancel retires a load in flight', async () => {
  const d = deferred();
  const loader = createLatestLoader({ fetchImpl: () => d.promise });
  const p = loader.load('/api/locations/1/compartments');
  loader.cancel();
  d.resolve(answer([{ id: 1 }]));
  assert.deepEqual(await p, { stale: true });
});

test('a failed newest load throws, an {error} body is never data', async () => {
  const loader = createLatestLoader({ fetchImpl: async () => answer({ error: 'Location not found' }, 404) });
  await assert.rejects(loader.load('/api/locations/9/compartments'), /Location not found/);
});

const row = (entry_id, compartment_id, extra = {}) => ({ entry_id, compartment_id, location_id: compartment_id ? 1 : null, ...extra });

test('a patch replaces the touched compartments and entries, nothing else', () => {
  const cards = [row(1, 10), row(2, 10), row(3, 11), row(4, null)];
  // Card 4 was filed into compartment 10; the server re-sorted it there.
  const next = applyCardPatch(cards, {
    compartments: [10],
    entries: [4],
    rows: [row(1, 10, { position: 1000 }), row(4, 10, { position: 2000 }), row(2, 10, { position: 3000 })],
  });
  assert.deepEqual(next.map(c => c.entry_id).sort(), [1, 2, 3, 4]);
  assert.equal(next.find(c => c.entry_id === 4).compartment_id, 10, 'no longer unsorted');
  assert.equal(next.find(c => c.entry_id === 2).position, 3000);
  assert.equal(next.find(c => c.entry_id === 3), cards[2], 'an untouched compartment keeps its rows');
});

test('a patch drops a deleted entry and unfiles one taken out of its compartment', () => {
  const cards = [row(1, 10), row(2, 10), row(3, 10)];
  const deleted = applyCardPatch(cards, { compartments: [10], entries: [2], rows: [row(1, 10), row(3, 10)] });
  assert.deepEqual(deleted.map(c => c.entry_id).sort(), [1, 3]);
  const unfiled = applyCardPatch(cards, { compartments: [10], entries: [3], rows: [row(1, 10), row(2, 10), row(3, null)] });
  assert.equal(unfiled.length, 3);
  assert.equal(unfiled.find(c => c.entry_id === 3).compartment_id, null);
});

const filed4 = { compartments: [10], entries: [4], rows: [row(4, 10)] };

test('a patch sent during a whole read is applied again on top of it', () => {
  const store = createCardStore();
  const stamp = store.beginRead();
  // While the read is in flight, card 4 is filed and its compartment patched.
  assert.equal(store.accept(store.issue(), filed4), true);
  // The read was sent before the filing: it still has card 4 unsorted.
  const landed = store.landRead([row(1, 10), row(4, null)], stamp);
  assert.equal(landed.find(c => c.entry_id === 4).compartment_id, 10);
  // Once landed, later reads start clean.
  const next = store.beginRead();
  assert.deepEqual(store.landRead([row(4, null)], next), [row(4, null)]);
});

test('a patch sent before a whole read is not applied again on top of it', () => {
  const store = createCardStore();
  const ticket = store.issue();
  const stamp = store.beginRead();
  // Its answer arrives while the newer read is still in flight: shown for now...
  assert.equal(store.accept(ticket, filed4), true);
  // ...but the read is newer (the card was unfiled again since), and it wins.
  assert.deepEqual(store.landRead([row(4, null)], stamp), [row(4, null)]);
});

test('a patch sent before the last whole read that landed is dropped', () => {
  const store = createCardStore();
  const ticket = store.issue();
  const stamp = store.beginRead();
  store.landRead([row(4, null)], stamp);
  assert.equal(store.accept(ticket, filed4), false, 'its answer is older than what is shown');
  assert.equal(store.accept(store.issue(), filed4), true, 'a patch sent after it is newer');
});

test('a failed read forgets the patches it was holding', () => {
  const store = createCardStore();
  const first = store.beginRead();
  store.accept(store.issue(), filed4);
  store.failRead(first);
  const second = store.beginRead();
  assert.deepEqual(store.landRead([row(4, null)], second), [row(4, null)]);
});

test('readCardPatch reads each compartment and entry once, and a deleted entry as none', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url === '/api/collection?compartment_id=10') return answer([row(1, 10)]);
    if (url === '/api/collection/4') return answer(row(4, 10));
    if (url === '/api/collection/5') return answer({ error: 'Collection entry not found' }, 404);
    throw new Error(`unexpected ${url}`);
  };
  const patch = await readCardPatch({ compartments: [10, 10, null], entries: [4, 5, 4] }, { fetchImpl });
  assert.deepEqual(urls.sort(), ['/api/collection/4', '/api/collection/5', '/api/collection?compartment_id=10']);
  assert.deepEqual(patch, { compartments: [10], entries: [4, 5], rows: [row(1, 10), row(4, 10)] });
});

test('readCardPatch fails when a compartment cannot be read, so the caller reads everything', async () => {
  const fetchImpl = async () => answer({ error: 'Failed to fetch collection' }, 500);
  await assert.rejects(readCardPatch({ compartments: [10] }, { fetchImpl }));
});

test('settings and rules toasts say how many cards went to Unsorted', () => {
  assert.equal(evictedText(t, { evicted: 0 }, 'loc.containerUpdated', 'loc.containerUpdatedEvicted'), 'loc.containerUpdated');
  assert.equal(evictedText(t, {}, 'loc.containerUpdated', 'loc.containerUpdatedEvicted'), 'loc.containerUpdated');
  assert.equal(evictedText(t, { evicted: 3 }, 'loc.containerUpdated', 'loc.containerUpdatedEvicted'), 'loc.containerUpdatedEvicted {"count":3}');
});

test('Auto-File All is phrased from its counts, the server message only without them', () => {
  assert.equal(applyAllText(t, { message: 'Filed 2 of 5 card(s).', filed: 2, total: 5 }), 'loc.filedOfTotal {"count":5,"filed":2}');
  assert.equal(applyAllText(t, { message: 'Something new' }), 'Something new');
  assert.equal(applyAllText(t, null), 'bulk.done');
});

test('a ManaBox container import names the container and the cards it could not find', () => {
  assert.equal(importContainerText(t, { id: 3, count: 40, missing: 0 }, 'Box A'), 'loc.importedContainer {"count":40,"name":"Box A"}');
  assert.equal(
    importContainerText(t, { id: 3, count: 40, missing: 2 }, 'Box A'),
    'loc.importedContainer {"count":40,"name":"Box A"} loc.importedContainerMissing {"count":2}',
  );
  assert.equal(importContainerText(t, { message: 'Created Box A.' }, 'Box A'), 'Created Box A.');
});
