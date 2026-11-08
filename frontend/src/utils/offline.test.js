import test from 'node:test';
import assert from 'node:assert/strict';
import { clearOfflineData, isOffline, isWriteMethod, noteApiResponse, noteApiUnreachable, offlineWriteResponse, setWriteBlockedText, subscribeOffline } from './offline.js';
import { OFFLINE_HEADER, dataCacheName, shellCacheName } from './swPolicy.js';

test('a cached answer means offline; a network answer means back online', () => {
  const seen = [];
  const off = subscribeOffline(v => seen.push(v));
  noteApiResponse(new Response('{}', { headers: { [OFFLINE_HEADER]: '1' } }));
  assert.equal(isOffline(), true);
  noteApiResponse(new Response('{}'));
  assert.equal(isOffline(), false);
  noteApiUnreachable();
  assert.equal(isOffline(), true);
  noteApiResponse(new Response('{}'));
  off();
  assert.deepEqual(seen, [true, false, true, false]);
});

test('refused writes carry a code and the translated message', async () => {
  setWriteBlockedText('Hors ligne');
  const res = offlineWriteResponse();
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'Hors ligne', code: 'offline' });
  assert.equal(isWriteMethod('post'), true);
  assert.equal(isWriteMethod('DELETE'), true);
  assert.equal(isWriteMethod(undefined), false);
  assert.equal(isWriteMethod('GET'), false);
});

test('logout deletes every session cache, keeps the shell, and tells the worker', async () => {
  const names = new Set([shellCacheName('v1'), dataCacheName('alice'), dataCacheName('bob'), 'other']);
  const cacheStorage = {
    keys: async () => [...names],
    delete: async (n) => names.delete(n),
  };
  const messages = [];
  await clearOfflineData(cacheStorage, { controller: { postMessage: m => messages.push(m) } });
  assert.deepEqual([...names], [shellCacheName('v1'), 'other']);
  assert.deepEqual(messages, [{ type: 'logout' }]);
  // No worker, no Cache API (native, old browsers): a no-op, not a throw.
  await clearOfflineData(undefined, undefined);
});
