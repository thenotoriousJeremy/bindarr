import test from 'node:test';
import assert from 'node:assert/strict';
import { TAB_PATHS, parseRoute, routePath, stripBase, withBase, rememberIntended, takeIntended, clearIntended, setParam, parseSetParam } from './routes.js';

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
}

test('every tab round-trips through its path', () => {
  for (const tab of Object.keys(TAB_PATHS)) {
    assert.deepEqual(parseRoute(routePath(tab)), { tab, param: null }, tab);
  }
  assert.equal(routePath('dashboard'), '/');
  assert.equal(routePath('add-cards'), '/add');
});

test('sub-views round-trip with their id', () => {
  assert.equal(routePath('deckbuilder', 12), '/decks/12');
  assert.deepEqual(parseRoute('/decks/12'), { tab: 'deckbuilder', param: '12' });
  assert.equal(routePath('lists', '7'), '/lists/7');
  assert.deepEqual(parseRoute('/lists/7'), { tab: 'lists', param: '7' });
  assert.equal(routePath('storage', 3), '/storage/3');
  assert.deepEqual(parseRoute('/storage/3'), { tab: 'storage', param: '3' });
  assert.equal(routePath('deckbuilder', null), '/decks');
  // A tab without sub-views ignores a param rather than inventing a path.
  assert.equal(routePath('notes', 5), '/notes');
});

test('a set is game/set with an optional language', () => {
  assert.equal(routePath('sets', setParam({ game: 'pokemon', set: 'sv3pt5', lang: 'en' })), '/sets/pokemon/sv3pt5');
  assert.equal(routePath('sets', setParam({ game: 'pokemon', set: 'SV1a', lang: 'ja' })), '/sets/pokemon/SV1a/ja');
  assert.equal(routePath('sets', ['mtg', 'mh3']), '/sets/mtg/mh3');
  assert.deepEqual(parseRoute('/sets/pokemon/sv3pt5'), { tab: 'sets', param: 'pokemon/sv3pt5' });
  assert.deepEqual(parseRoute('/sets/pokemon/SV1a/ja'), { tab: 'sets', param: 'pokemon/SV1a/ja' });
  assert.deepEqual(parseRoute('/sets/lorcana/1'), { tab: 'sets', param: 'lorcana/1' });
  assert.deepEqual(parseRoute('/sets'), { tab: 'sets', param: null });
  assert.deepEqual(parseSetParam('pokemon/SV1a/ja'), { game: 'pokemon', set: 'SV1a', lang: 'ja' });
  assert.deepEqual(parseSetParam('mtg/mh3'), { game: 'mtg', set: 'mh3', lang: 'en' });
  assert.equal(parseSetParam(null), null);
  assert.equal(setParam({ set: 'sv1' }), null, 'no game, no path yet');
  // A set id with a space or other odd character survives the round trip.
  const odd = routePath('sets', setParam({ game: 'mtg', set: 'p 23' }));
  assert.equal(odd, '/sets/mtg/p%2023');
  assert.deepEqual(parseRoute(odd), { tab: 'sets', param: 'mtg/p 23' });
});

test('trailing slashes, query and hash do not change the route', () => {
  assert.deepEqual(parseRoute('/collection/'), { tab: 'collection', param: null });
  assert.deepEqual(parseRoute('/?oidc_token=abc'), { tab: 'dashboard', param: null });
  assert.deepEqual(parseRoute('/decks/4?x=1#y'), { tab: 'deckbuilder', param: '4' });
});

test('non-routes parse to null', () => {
  for (const p of ['/sets/pokemon', '/sets/Pokemon/sv1', '/sets/pokemon/sv1/ja/x', '/share/abc123', '/nope', '/decks/abc', '/decks/1/2', '/notes/3', '/dashboard', '//evil.example/decks', 'decks', '', null, undefined, '/%E0%A4%A']) {
    assert.equal(parseRoute(p), null, String(p));
  }
});

test('base path is stripped and restored (demo build lives under /bindarr/)', () => {
  assert.equal(stripBase('/decks/3', '/'), '/decks/3');
  assert.equal(stripBase('/bindarr/decks/3', '/bindarr/'), '/decks/3');
  assert.equal(stripBase('/bindarr', '/bindarr/'), '/');
  assert.equal(stripBase('/bindarr/', '/bindarr/'), '/');
  assert.equal(withBase('/decks/3', '/'), '/decks/3');
  assert.equal(withBase('/decks/3', '/bindarr/'), '/bindarr/decks/3');
});

test('an intended deep link survives the login screen, once', () => {
  const s = memoryStorage();
  rememberIntended('/decks/12', s);
  // The SSO redirect comes back to '/'; that must not overwrite the target.
  rememberIntended('/', s);
  assert.equal(takeIntended(s), '/decks/12');
  assert.equal(takeIntended(s), null, 'read once');
});

test('only app routes are remembered or handed back', () => {
  const s = memoryStorage();
  rememberIntended('/share/abc', s);
  rememberIntended('/unknown', s);
  assert.equal(takeIntended(s), null);
  // Whatever lands in storage, never an off-site target.
  s.setItem('bindarr_intended_path', '//evil.example/decks');
  assert.equal(takeIntended(s), null);
  s.setItem('bindarr_intended_path', 'https://evil.example/');
  assert.equal(takeIntended(s), null);
});

test('clearIntended forgets the target; blocked storage is not an error', () => {
  const s = memoryStorage();
  rememberIntended('/lists/2', s);
  clearIntended(s);
  assert.equal(takeIntended(s), null);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.doesNotThrow(() => rememberIntended('/lists/2', blocked));
  assert.doesNotThrow(() => clearIntended(blocked));
  assert.equal(takeIntended(blocked), null);
});
