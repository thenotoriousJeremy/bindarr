import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_NAV_TABS, pinnedTabs, navBarTabs, litNavTab, toggleNavTab, collectionTarget, isCollectionView,
} from './navTabs.js';

test('the default bar folds Browse, Lists and Sealed into Collection', () => {
  const bar = navBarTabs(null);
  assert.deepEqual(bar, ['dashboard', 'add-cards', 'collection', 'storage', 'deckbuilder', 'notes', 'settings']);
  for (const tab of ['sets', 'lists', 'sealed']) assert.ok(!bar.includes(tab), tab);
});

test('anything but an array is the default set', () => {
  for (const v of [null, undefined, 'lists', { lists: true }]) assert.deepEqual(pinnedTabs(v), DEFAULT_NAV_TABS);
  assert.deepEqual(pinnedTabs([]), []);
  assert.deepEqual(pinnedTabs(['sealed', 'bogus', 'lists', 'dashboard']), ['lists', 'sealed'], 'known optional tabs, bar order');
});

test('dashboard, collection and settings stay with nothing pinned; admin only for an admin', () => {
  assert.deepEqual(navBarTabs([]), ['dashboard', 'collection', 'settings']);
  assert.deepEqual(navBarTabs([], { showAdmin: true }), ['dashboard', 'collection', 'settings', 'admin']);
});

test('a pinned sub-view gets its own tab, in bar order', () => {
  assert.deepEqual(navBarTabs(['lists', 'sets']), ['dashboard', 'collection', 'sets', 'lists', 'settings']);
});

test('an open hidden tab shows while open, but a Collection sub-view does not', () => {
  assert.ok(navBarTabs([], { activeTab: 'notes' }).includes('notes'));
  assert.ok(!navBarTabs([], { activeTab: 'lists' }).includes('lists'));
});

test('the lit tab: itself when on the bar, otherwise Collection for a sub-view', () => {
  const bar = navBarTabs(null);
  assert.equal(litNavTab('lists', bar), 'collection');
  assert.equal(litNavTab('sets', bar), 'collection');
  assert.equal(litNavTab('collection', bar), 'collection');
  assert.equal(litNavTab('notes', bar), 'notes');
  assert.equal(litNavTab('lists', navBarTabs(['lists'])), 'lists', 'a pinned sub-view lights its own tab');
});

test('toggling pins and unpins in bar order, never the always tabs', () => {
  assert.deepEqual(toggleNavTab(null, 'lists'), ['add-cards', 'storage', 'deckbuilder', 'lists', 'notes']);
  assert.deepEqual(toggleNavTab(null, 'notes'), ['add-cards', 'storage', 'deckbuilder']);
  assert.deepEqual(toggleNavTab(['sealed'], 'sets'), ['sets', 'sealed']);
  assert.deepEqual(toggleNavTab(['sealed'], 'collection'), ['sealed']);
  assert.deepEqual(toggleNavTab(['sealed'], 'settings'), ['sealed']);
});

test('the Collection tab returns to the last sub-view, or Cards from inside', () => {
  assert.equal(collectionTarget('dashboard', 'lists'), 'lists');
  assert.equal(collectionTarget('dashboard', null), 'collection');
  assert.equal(collectionTarget('dashboard', 'notes'), 'collection');
  assert.equal(collectionTarget('lists', 'lists'), 'collection');
  assert.equal(collectionTarget('dashboard', 'lists', navBarTabs(['lists'])), 'collection', 'a pinned view is reached by its own tab');
  assert.ok(isCollectionView('sealed'));
  assert.ok(!isCollectionView('storage'));
});
