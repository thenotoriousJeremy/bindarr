import test from 'node:test';
import assert from 'node:assert/strict';
import { scrubUser, loadStoredUser, saveStoredUser } from './storedUser.js';

function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
}

// What builds before the has_* flags left in localStorage.
const LEGACY = {
  username: 'ash', role: 'admin', share_token: 'share', share_enabled: 1, share_locations: 0,
  tcg_api_key: 'tcg-secret', psa_api_token: 'psa-secret', graded_price_api_key: 'ppt-secret', api_key: 'bnd_secret',
};

test('an old stored copy loses its keys on first load, and keeps everything else', () => {
  const storage = memoryStorage({ bindarr_user: JSON.stringify(LEGACY) });
  const user = loadStoredUser(storage);
  assert.deepEqual(user, { username: 'ash', role: 'admin', share_token: 'share', share_enabled: 1, share_locations: 0 });
  // Cleaned in storage too, not just in memory: the keys must not wait for a save.
  const stored = storage.getItem('bindarr_user');
  for (const secret of ['tcg-secret', 'psa-secret', 'ppt-secret', 'bnd_secret']) {
    assert.ok(!stored.includes(secret), `${secret} must be gone from storage`);
  }
  // CardArtEditor reads role straight from storage.
  assert.equal(JSON.parse(stored).role, 'admin');
});

test('saving never writes a key, whatever the object carries', () => {
  const storage = memoryStorage();
  saveStoredUser({ ...LEGACY, has_tcg_api_key: true }, storage);
  const stored = JSON.parse(storage.getItem('bindarr_user'));
  assert.equal(stored.has_tcg_api_key, true, 'the flags are kept');
  assert.equal('tcg_api_key' in stored, false);
  assert.equal('api_key' in stored, false);
});

test('a current copy is read as-is and not rewritten', () => {
  const current = { username: 'misty', role: 'member', has_api_key: false };
  let writes = 0;
  const storage = memoryStorage({ bindarr_user: JSON.stringify(current) });
  const setItem = storage.setItem;
  storage.setItem = (k, v) => { writes++; setItem(k, v); };
  assert.deepEqual(loadStoredUser(storage), current);
  assert.equal(writes, 0);
});

test('nothing stored, or something unreadable, is no user', () => {
  assert.equal(loadStoredUser(memoryStorage()), null);
  assert.equal(loadStoredUser(memoryStorage({ bindarr_user: '{not json' })), null);
  assert.equal(loadStoredUser(memoryStorage({ bindarr_user: 'null' })), null);
  assert.equal(scrubUser(null), null);
});
