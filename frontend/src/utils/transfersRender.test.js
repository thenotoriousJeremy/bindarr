// Render checks for Trades & Gifts (components/transfers), through Vite's SSR
// loader and react-dom/server as in renderSmoke.test.js: a first paint, no
// effects, no requests. The pages are drawn from the data their props carry,
// so each is rendered with some, in the states that change what it shows:
// trading on, trading off (the opt-in), and a phone in device mode.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserGlobals, startRenderer } from './renderHarness.js';

installBrowserGlobals();

const noop = () => {};
const ME = { id: 1, username: 'ash', role: 'member', nav_tabs: null, trades_enabled: 1 };
const ON = { members: true, canTrade: true, needsOptIn: false };
const OFF = { members: true, canTrade: false, needsOptIn: true };
const DEVICE = { members: false, canTrade: false, needsOptIn: false };

const list = (items, extra = {}) => ({
  items, cursor: null, pages: 1, loaded: true, loading: false, loadingMore: false, error: null,
  refresh: noop, loadMore: noop, find: async () => null, edit: noop, ...extra,
});

const card = (id, extra = {}) => ({
  entry_id: id, card_id: `sv1-${id}`, name: `Card ${id}`, set_name: 'Scarlet & Violet', number: String(id),
  game: 'pokemon', rarity: 'Common', quantity: 2, condition: 'Near Mint', printing: 'Holofoil', language: 'English',
  location_id: null, type: 'card', id, ...extra,
});

const snapshotItem = (id, from, extra = {}) => ({
  id, from_user_id: from, item_type: 'card', source_collection_id: 100 + id, quantity: 1,
  purchase_cost: from === 1 ? 2.5 : null, received_cost: null,
  item_snapshot: { card_id: `sv1-${id}`, name: `Card ${id}`, set_name: 'Base', number: String(id), condition: 'Near Mint', printing: 'Normal' },
  ...extra,
});

const INCOMING = {
  id: 10, proposer_id: 2, proposer_username: 'misty', recipient_id: 1, recipient_username: 'ash',
  transfer_type: 'trade', status: 'pending', created_at: '2026-11-01 10:00:00',
  items: [snapshotItem(1, 2), snapshotItem(2, 1)],
};
const OUTGOING = {
  id: 11, proposer_id: 1, proposer_username: 'ash', recipient_id: 3, recipient_username: 'brock',
  transfer_type: 'gift', status: 'pending', created_at: '2026-11-02 10:00:00', items: [snapshotItem(3, 1)],
};

let renderer;
const load = (path) => renderer.load(path);
const render = (Component, props) => renderer.render(Component, props);

before(async () => { renderer = await startRenderer(); });
after(async () => { await renderer?.close(); });

test('the Trades area renders with trading on, off and on a phone', async () => {
  const { default: TransferManager } = await load('/src/components/transfers/TransferManager.jsx');
  const on = render(TransferManager, { user: ME, showToast: noop, onUpdateUser: noop, deviceMode: false });
  assert.match(on, /id="transfer-tab-new"/);
  assert.match(on, /id="transfer-tab-offers"/);
  assert.match(on, /id="transfer-tab-history"/);
  assert.doesNotMatch(on, /Turn on trade offers/);
  assert.match(on, /Record a past trade/);

  const off = render(TransferManager, { user: { ...ME, trades_enabled: 0 }, showToast: noop, onUpdateUser: noop, deviceMode: false });
  assert.match(off, /Trading with other members is off/);
  assert.match(off, /<button[^>]*>Turn on trade offers<\/button>/);
  assert.doesNotMatch(off, /Record a past trade/, 'recording a trade with a member needs trading on');
  assert.match(off, /id="transfer-tab-offers"/, 'offers stay readable');

  const phone = render(TransferManager, { user: ME, showToast: noop, deviceMode: true });
  assert.doesNotMatch(phone, /id="transfer-tab-offers"/, 'no members on a phone');
  assert.doesNotMatch(phone, /Turn on trade offers/);
  assert.doesNotMatch(phone, /Bindarr Users/);
  assert.match(phone, /Record an external deal/);
});

test('pending offers: answers while trading is on, a note while it is off', async () => {
  const { default: PendingOffers } = await load('/src/components/transfers/PendingOffers.jsx');
  const props = { list: list([INCOMING, OUTGOING]), incoming: [INCOMING], outgoing: [OUTGOING], me: 1, busy: false, onRespond: noop, onCounter: noop, locateCard: () => null };
  const on = render(PendingOffers, { ...props, canRespond: true });
  assert.match(on, /From misty/);
  assert.match(on, /To brock/);
  assert.match(on, />Accept<\/button>|Accept<\/button>/);
  assert.match(on, /Cancel proposal/);
  assert.match(on, /\$2\.50/, 'your own cost, formatted');
  const off = render(PendingOffers, { ...props, canRespond: false });
  assert.doesNotMatch(off, /Accept<\/button>/);
  assert.match(off, /Turn on trade offers to answer or cancel this offer/);
  const failed = render(PendingOffers, { ...props, list: list([], { loaded: false, error: { body: { code: 'trades_disabled', error: 'x' } } }), canRespond: true });
  assert.match(failed, /Trading is turned off/);
});

test('history pages each list, and a deleted member keeps their name', async () => {
  const { default: TransferHistory } = await load('/src/components/transfers/TransferHistory.jsx');
  const closed = { ...INCOMING, id: 12, status: 'accepted', proposer_id: null, proposer_username: 'gone', completed_at: '2026-11-03 10:00:00' };
  const trade = {
    id: 5, creator_id: 1, creator_username: 'ash', recipient_id: 2, recipient_username: 'misty', status: 'pending_confirmation',
    completed_at: '2026-03-01', items: [{ id: 1, from_user_id: 1, card_id: 'x', quantity: 2, item_snapshot: { name: 'Eevee' } }],
  };
  const deal = {
    id: 7, contact_name: 'Gary', transaction_type: 'trade', created_at: '2026-11-04 09:00:00',
    items: [{ id: 1, direction: 'given', purchase_cost: 1234.5, item_snapshot: { name: 'Snorlax' } }],
  };
  const html = render(TransferHistory, {
    me: 1, access: ON, busy: false, target: null,
    transfers: list([closed], { cursor: 'next' }), historical: list([trade], { cursor: 'more' }), external: list([deal], { cursor: 'deeper' }),
    onRecordPastTrade: noop, onReviewPastTrade: noop, onCancelPastTrade: noop,
  });
  assert.match(html, /Negotiation with gone/);
  assert.match(html, /Past trade with misty/);
  assert.match(html, /Mar 1, 2026/);
  assert.match(html, /2× Eevee/);
  assert.match(html, /Given: Snorlax/);
  assert.match(html, /\$1,234\.50/);
  assert.equal((html.match(/>Load more</g) || []).length, 3, 'one per list with a page after it');

  const phone = render(TransferHistory, {
    me: 1, access: DEVICE, busy: false, target: null,
    transfers: list([]), historical: list([]), external: list([deal]),
    onRecordPastTrade: noop, onReviewPastTrade: noop, onCancelPastTrade: noop,
  });
  assert.doesNotMatch(phone, /Transfer history/);
  assert.match(phone, /External deal history/);
  assert.doesNotMatch(phone, />Load more</);
});

test('the item picker draws its items, filters and deck warning', async () => {
  const { default: ItemPicker } = await load('/src/components/transfers/ItemPicker.jsx');
  const html = render(ItemPicker, {
    idPrefix: 'transfer-offer',
    items: [card(1, { checked_out_qty: 1 }), card(2, { location_id: 4, location_name: 'Blue binder' }), { type: 'sealed', id: 9, product_name: 'Booster Bundle', is_trade: 0 }],
    selected: { 'card:1': { type: 'card', id: 1, quantity: 1 } },
    filters: { query: '', game: '', type: 'all', location: '', sort: 'name-asc' },
    onPick: noop, onQuantity: noop, onFiltersChange: noop, onShowDetails: noop, onToggleSealedTrade: noop,
    locationOptions: [{ key: '4', label: 'Blue binder' }], emptyText: 'Nothing',
  });
  assert.match(html, /Selected items/);
  assert.match(html, /1 held by a checked-out deck/);
  assert.match(html, /Blue binder/);
  assert.match(html, /Mark for trade/);
  assert.match(html, /Booster Bundle/);
});

test('the composer offers only contacts when trading is off', async () => {
  const { default: TransferComposer } = await load('/src/components/transfers/TransferComposer.jsx');
  const composer = {
    state: { recipient: 'contact:4', type: 'trade', giftDirection: 'given', offered: {}, requested: {}, received: [], message: '', countering: null, addingContact: false, newContactName: '', notice: '' },
    patch: noop, reset: noop, setRecipient: noop, pickOffered: noop, pickRequested: noop, setOfferedQuantity: noop, setRequestedQuantity: noop, setReceived: noop,
  };
  const props = {
    composer, me: 1, users: [{ id: 2, username: 'misty' }], contacts: [{ id: 4, name: 'Gary' }], ownItems: [card(1)],
    locationOptions: [], setsList: [], loading: false, saving: false,
    onSubmit: noop, onAddContact: async () => null, onToggleSealedTrade: noop, onShowDetails: noop, locateCard: () => null,
  };
  const off = render(TransferComposer, { ...props, access: OFF });
  assert.doesNotMatch(off, /misty/);
  assert.match(off, /Gary/);
  assert.match(off, /Received/);
  assert.doesNotMatch(off, /Mark for trade/);
  const on = render(TransferComposer, { ...props, access: ON, composer: { ...composer, state: { ...composer.state, recipient: 'user:2', type: 'gift' } } });
  assert.match(on, /misty/);
  assert.match(on, /New proposal/);
});

test('the past-trade dialog renders to record and to review', async () => {
  const { default: HistoricalTradeModal } = await load('/src/components/transfers/HistoricalTradeModal.jsx');
  const common = { user: ME, users: [{ id: 2, username: 'misty' }], cards: [card(1)], onClose: noop, onCreate: noop, onConfirm: noop, onReject: noop };
  const create = render(HistoricalTradeModal, { ...common, mode: 'create' });
  assert.match(create, /class="modal-overlay"/);
  assert.match(create, /Send for confirmation/);
  const review = render(HistoricalTradeModal, {
    ...common,
    mode: 'review',
    trade: {
      id: 3, creator_id: 2, creator_username: 'misty', recipient_id: 1, recipient_username: 'ash', completed_at: '2026-03-01',
      items: [{ id: 1, from_user_id: 2, card_id: 'sv1-1', quantity: 1, item_snapshot: { name: 'Card 1' } }],
    },
  });
  assert.match(review, /Confirm trade with misty/);
  assert.match(review, /Trade date: Mar 1, 2026/);
  assert.match(review, /2 copies · Near Mint · Unsorted/);
});

test('a sealed unit that came as a gift says so in its details', async () => {
  const { default: ItemDetailsModal } = await load('/src/components/transfers/ItemDetailsModal.jsx');
  const html = render(ItemDetailsModal, {
    item: { type: 'sealed', id: 9, product_name: 'Booster Bundle', game: 'pokemon', acquired_transfer_type: 'gift', acquired_transfer_partner: 'Misty' },
    onClose: noop,
  });
  assert.match(html, /Received as a gift from Misty/);
});
