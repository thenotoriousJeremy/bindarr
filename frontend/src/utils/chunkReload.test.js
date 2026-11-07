import test from 'node:test';
import assert from 'node:assert/strict';
import { claimReload, createChunkReloader, reloadingImport, RELOAD_WINDOW_MS } from './chunkReload.js';

const memoryStorage = () => {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
  };
};

test('claimReload allows one reload per window', () => {
  const storage = memoryStorage();
  assert.equal(claimReload(storage, 1_000), true, 'first failure reloads');
  assert.equal(claimReload(storage, 1_000 + 5_000), false, 'failing again right after the reload does not loop');
  assert.equal(claimReload(storage, 1_000 + RELOAD_WINDOW_MS - 1), false, 'still inside the window');
  assert.equal(claimReload(storage, 1_000 + RELOAD_WINDOW_MS), true, 'a later upgrade in the same tab heals again');
  assert.equal(claimReload(storage, 1_000 + RELOAD_WINDOW_MS + 10), false, 'and that one is guarded too');
});

test('claimReload refuses when there is nowhere to record the reload', () => {
  assert.equal(claimReload(null, 1_000), false, 'no storage at all');
  const throwing = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => {} };
  assert.equal(claimReload(throwing, 1_000), false, 'storage blocked on read');
  const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
  assert.equal(claimReload(full, 1_000), false, 'storage refusing the write');
});

test('claimReload ignores a timestamp from the future', () => {
  const storage = memoryStorage();
  storage.setItem('bindarr_chunk_reload_at', '50000');
  assert.equal(claimReload(storage, 1_000), true, 'clock set back since: not a recent reload');
  assert.equal(claimReload(storage, 2_000), false, 'and the overwritten stamp guards again');
});

test('one reload per page however many imports fail', () => {
  let reloads = 0;
  const reloadOnce = createChunkReloader({ storage: memoryStorage(), reload: () => { reloads++; }, now: () => 1_000 });
  assert.equal(reloadOnce(), true);
  assert.equal(reloadOnce(), true, 'a second failure waits for the reload already underway');
  assert.equal(reloads, 1);
});

test('a reload already spent shows the error instead', () => {
  const storage = memoryStorage();
  let reloads = 0;
  const firstPage = createChunkReloader({ storage, reload: () => { reloads++; }, now: () => 1_000 });
  assert.equal(firstPage(), true);
  // The page after the reload, still finding the chunk missing.
  const secondPage = createChunkReloader({ storage, reload: () => { reloads++; }, now: () => 4_000 });
  assert.equal(secondPage(), false);
  assert.equal(reloads, 1);
});

test('offline never reloads', () => {
  let reloads = 0;
  const reloadOnce = createChunkReloader({ storage: memoryStorage(), reload: () => { reloads++; }, isOnline: () => false });
  assert.equal(reloadOnce(), false);
  assert.equal(reloads, 0);
});

test('reloadingImport waits for the reload, or hands the error on', async () => {
  const mod = { default: 'View' };
  assert.equal(await reloadingImport(() => Promise.resolve(mod), () => true)(), mod, 'a working import is untouched');

  const gone = new TypeError('Failed to fetch dynamically imported module');
  await assert.rejects(reloadingImport(() => Promise.reject(gone), () => false)(), gone, 'no reload: the boundary gets the error');

  const waiting = reloadingImport(() => Promise.reject(gone), () => true)();
  const winner = await Promise.race([waiting.then(() => 'settled', () => 'settled'), new Promise(r => setTimeout(() => r('pending'), 20))]);
  assert.equal(winner, 'pending', 'reloading: never settles, so Suspense keeps the spinner');
});
