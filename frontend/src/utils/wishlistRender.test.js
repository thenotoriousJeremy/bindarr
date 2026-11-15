// One wishlist (WEB-03), as the screens draw it: rendered through Vite's SSR
// loader and react-dom/server, as renderSmoke.test.js renders the views (a first
// paint, no effects, no requests).
//
// The collection no longer holds wanted cards, so the card popup has no
// "wishlist item" state to show or leave, and the bulk bars add to the Wishlist
// (non-destructive) instead of moving copies onto it.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserGlobals, startRenderer } from './renderHarness.js';

installBrowserGlobals();

const noop = () => {};
// A copy as an older server could still hand over: on the collection's old wishlist.
const OLD_WISHLIST_ROW = {
  entry_id: 7, card_id: 'sv1-25', name: 'Pikachu', game: 'pokemon', set_name: 'Scarlet & Violet',
  number: '25', rarity: 'Common', quantity: 1, condition: 'Near Mint', printing: 'Normal',
  language: 'English', list_type: 'wishlist', price_trend: 1.5,
};

let renderer;
const load = (path) => renderer.load(path);
const render = (Component, props) => renderer.render(Component, props);

before(async () => { renderer = await startRenderer(); });
after(async () => { await renderer?.close(); });

test('the card popup has no wishlist-copy state: no badge, no "Obtained", the location always shown', async () => {
  const { default: CardInspectorModal } = await load('/src/components/CardInspectorModal.jsx');
  const html = render(CardInspectorModal, { card: OLD_WISHLIST_ROW, onClose: noop, showToast: noop, onViewStorage: noop });
  assert.doesNotMatch(html, /Wishlist Item/i);
  assert.doesNotMatch(html, />Obtained</);
  assert.match(html, /Location:/, 'where the copy is, like any other copy');
  assert.match(html, /aria-pressed="false"[^>]*>.*Want/s, 'the one way to want a card is the heart');
});

test("the scanner's recent strip adds the selection to the Wishlist instead of moving it there", async () => {
  const { default: RecentScans } = await load('/src/components/scanner/RecentScans.jsx');
  const html = render(RecentScans, {
    recentSelect: { selectMode: true, selectedIds: new Set([7]), runBulk: noop, exitSelectMode: noop, pressHandlers: () => ({}) },
    recentScans: [{ ...OLD_WISHLIST_ROW, list_type: 'collection' }],
    setRecentScans: noop,
    activateRecent: noop,
    showToast: noop,
  });
  assert.match(html, /Add to Wishlist/);
  assert.doesNotMatch(html, /Move to Wishlist/);
});

test('the Wishlist tab and a list both start on their own read, and the hint names the heart', async () => {
  const { default: WishlistTab } = await load('/src/components/WishlistTab.jsx');
  assert.match(render(WishlistTab, { showToast: noop }), /class="spinner"/);
  const { default: ListDetail, WishlistStartHint } = await load('/src/components/ListDetail.jsx');
  assert.match(render(ListDetail, { listId: 3, showToast: noop }), /class="spinner"/);
  assert.match(render(WishlistStartHint, {}), /Tap the heart on any card/);
});
