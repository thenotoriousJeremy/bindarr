import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_NAV_TABS, OPTIONAL_NAV_TABS, pinnedTabs, navBarTabs, moreTabs, litNavTab, toggleNavTab, collectionTarget, isCollectionView,
} from './navTabs.js';

test('the default bar folds Browse, Lists and Sealed into Collection', () => {
  const bar = navBarTabs(null);
  assert.deepEqual(bar, ['dashboard', 'add-cards', 'collection', 'storage', 'deckbuilder', 'notes']);
  for (const tab of ['sets', 'lists', 'sealed']) assert.ok(!bar.includes(tab), tab);
});

test('Settings and Admin live in the header, never on the bar', () => {
  for (const pins of [null, [], OPTIONAL_NAV_TABS]) {
    const bar = navBarTabs(pins);
    assert.ok(!bar.includes('settings') && !bar.includes('admin'), JSON.stringify(pins));
  }
  assert.ok(!navBarTabs([], { activeTab: 'settings' }).includes('settings'), 'not even while open');
});

test('every unpinned tab stays reachable: on the bar, under More, or inside Collection', () => {
  for (const pins of [null, [], ['notes'], ['sets', 'lists', 'sealed'], OPTIONAL_NAV_TABS]) {
    const bar = navBarTabs(pins);
    const more = moreTabs(bar);
    for (const tab of OPTIONAL_NAV_TABS) {
      assert.ok(bar.includes(tab) || more.includes(tab) || isCollectionView(tab), `${tab} with ${JSON.stringify(pins)}`);
    }
  }
});

test('More holds the unpinned tabs in bar order, and nothing the bar shows', () => {
  assert.deepEqual(moreTabs(navBarTabs(null)), [], 'the default bar pins every tab More would hold');
  assert.deepEqual(moreTabs(navBarTabs([])), ['add-cards', 'storage', 'deckbuilder', 'notes']);
  assert.deepEqual(moreTabs(navBarTabs(['storage'])), ['add-cards', 'deckbuilder', 'notes']);
  const open = navBarTabs([], { activeTab: 'notes' });
  assert.ok(open.includes('notes') && !moreTabs(open).includes('notes'), 'an open tab is on the bar, not under More');
});

test('anything but an array is the default set', () => {
  for (const v of [null, undefined, 'lists', { lists: true }]) assert.deepEqual(pinnedTabs(v), DEFAULT_NAV_TABS);
  assert.deepEqual(pinnedTabs([]), []);
  assert.deepEqual(pinnedTabs(['sealed', 'bogus', 'lists', 'dashboard']), ['lists', 'sealed'], 'known optional tabs, bar order');
});

test('dashboard and collection stay with nothing pinned', () => {
  assert.deepEqual(navBarTabs([]), ['dashboard', 'collection']);
});

test('a pinned sub-view gets its own tab, in bar order', () => {
  assert.deepEqual(navBarTabs(['lists', 'sets']), ['dashboard', 'collection', 'sets', 'lists']);
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
