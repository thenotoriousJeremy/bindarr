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
// The server sends trades_enabled as a boolean.
const ME = { id: 1, username: 'ash', role: 'member', nav_tabs: null, trades_enabled: true };
const ON = { members: true, canTrade: true, canDecline: true, needsOptIn: false };
const OFF = { members: true, canTrade: false, canDecline: true, needsOptIn: true };
const DEVICE = { members: false, canTrade: false, canDecline: false, needsOptIn: false };
// Every button's text, in order: what a member can do on what is drawn.
const buttons = (html) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)]
  .map(m => m[1].replace(/<[^>]+>/g, '').replace(/<!-- -->/g, '').trim());

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

  for (const flag of [false, 0]) {
    const off = render(TransferManager, { user: { ...ME, trades_enabled: flag }, showToast: noop, onUpdateUser: noop, deviceMode: false });
    assert.match(off, /Trading with other members is off/);
    assert.match(off, /<button[^>]*>Turn on trade offers<\/button>/);
    assert.doesNotMatch(off, /Record a past trade/, 'recording a trade with a member needs trading on');
    assert.match(off, /id="transfer-tab-offers"/, 'offers stay readable');
  }
  assert.doesNotMatch(render(TransferManager, { user: { ...ME, trades_enabled: 1 }, showToast: noop, deviceMode: false }), /Turn on trade offers/, 'an older 0/1 profile reads the same');

  const phone = render(TransferManager, { user: ME, showToast: noop, deviceMode: true });
  assert.doesNotMatch(phone, /id="transfer-tab-offers"/, 'no members on a phone');
  assert.doesNotMatch(phone, /Turn on trade offers/);
  assert.doesNotMatch(phone, /Bindarr Users/);
  assert.match(phone, /Record an external deal/);
});

test('pending offers: every answer while trading is on, only saying no while it is off', async () => {
  const { default: PendingOffers } = await load('/src/components/transfers/PendingOffers.jsx');
  const props = { list: list([INCOMING, OUTGOING]), incoming: [INCOMING], outgoing: [OUTGOING], me: 1, busy: false, onRespond: noop, onCounter: noop, locateCard: () => null };
  const on = render(PendingOffers, { ...props, canTrade: true, canDecline: true });
  assert.match(on, /From misty/);
  assert.match(on, /To brock/);
  assert.deepEqual(buttons(on), ['Accept', 'Counter', 'Reject', 'Cancel proposal']);
  assert.match(on, /\$2\.50/, 'your own cost, formatted');
  assert.doesNotMatch(on, /role="note"/);

  const off = render(PendingOffers, { ...props, canTrade: false, canDecline: true });
  assert.deepEqual(buttons(off), ['Reject', 'Cancel proposal'], 'decline what was sent, withdraw what you sent');
  assert.match(off, /Turn on trade offers to accept or counter this offer/);

  const failed = render(PendingOffers, { ...props, list: list([], { loaded: false, error: { body: { code: 'trades_disabled', error: 'x' } } }), canTrade: true, canDecline: true });
  assert.match(failed, /Trading is turned off/);
});

test('an offer from a deleted member can still be rejected, and a snapshot names its sender', async () => {
  const { default: TransferCard } = await load('/src/components/transfers/TransferCard.jsx');
  const orphan = { ...INCOMING, proposer_id: null, proposer_username: null, proposer_name: 'dawn' };
  const html = render(TransferCard, { transfer: orphan, me: 1, canTrade: true, canDecline: true, onRespond: noop, onCounter: noop });
  assert.match(html, /From dawn/);
  assert.deepEqual(buttons(html), ['Reject'], 'nothing to trade with, but it can be cleared away');
  const graded = { ...OUTGOING, items: [snapshotItem(3, 1, { item_snapshot: { name: 'Charizard', grader: 'PSA', grade: 10, condition: 'Near Mint' } })] };
  assert.match(render(TransferCard, { transfer: graded, me: 1, onRespond: noop }), /PSA 10/);
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
  const handlers = { onRecordPastTrade: noop, onReviewPastTrade: noop, onDeclinePastTrade: noop, onCancelPastTrade: noop };
  const html = render(TransferHistory, {
    me: 1, access: ON, busy: false, target: null,
    transfers: list([closed], { cursor: 'next' }), historical: list([trade], { cursor: 'more' }), external: list([deal], { cursor: 'deeper' }),
    ...handlers,
  });
  assert.match(html, /Negotiation with gone/);
  assert.match(html, /Past trade with misty/);
  assert.match(html, /Mar 1, 2026/);
  assert.match(html, /2× Eevee/);
  assert.match(html, /Given: Snorlax/);
  assert.match(html, /\$1,234\.50/);
  assert.equal((html.match(/>Load more</g) || []).length, 3, 'one per list with a page after it');

  // A record sent to me awaiting my confirmation, and one of mine awaiting theirs.
  const sentToMe = { ...trade, id: 6, creator_id: 2, creator_username: 'misty', recipient_id: 1, recipient_username: 'ash' };
  const pastTrades = list([sentToMe, trade]);
  const trading = buttons(render(TransferHistory, { me: 1, access: ON, busy: false, target: null, transfers: list([]), historical: pastTrades, external: list([]), ...handlers }));
  assert.deepEqual(trading, ['Record a past trade', 'Review and confirm', 'Cancel proposal']);
  const offHtml = render(TransferHistory, { me: 1, access: OFF, busy: false, target: null, transfers: list([]), historical: pastTrades, external: list([]), ...handlers });
  assert.deepEqual(buttons(offHtml), ['Decline record', 'Cancel proposal'], 'confirming needs trading on; declining and cancelling do not');
  assert.match(offHtml, /Turn on trade offers to confirm this trade/);

  const phone = render(TransferHistory, {
    me: 1, access: DEVICE, busy: false, target: null,
    transfers: list([]), historical: list([]), external: list([deal]),
    ...handlers,
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

  // A member's marked slab: its grade in place of the condition, and what no
  // checked-out deck holds as the quantity on offer.
  const marked = render(ItemPicker, {
    idPrefix: 'transfer-request', isRequest: true,
    items: [card(5, { grader: 'PSA', grade: 9, quantity: 1 })],
    selected: {}, filters: { query: '', game: '', type: 'all', location: '', sort: 'name-asc' },
    onPick: noop, onQuantity: noop, onFiltersChange: noop, onShowDetails: noop, emptyText: 'Nothing',
  });
  assert.match(marked, /PSA 9/);
  assert.doesNotMatch(marked, /Near Mint/);
  assert.match(marked, /1 available/);
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

test('a sealed unit that came as a gift, from a member or from outside, says so in its details', async () => {
  const { default: ItemDetailsModal } = await load('/src/components/transfers/ItemDetailsModal.jsx');
  const unit = { type: 'sealed', id: 9, product_name: 'Booster Bundle', game: 'pokemon', acquired_transfer_type: null, acquired_transfer_partner: null, acquired_external_transaction_type: null, acquired_external_contact: null };
  const html = render(ItemDetailsModal, { item: { ...unit, acquired_transfer_type: 'gift', acquired_transfer_partner: 'Misty' }, onClose: noop });
  assert.match(html, /Received as a gift from Misty/);
  const outside = render(ItemDetailsModal, { item: { ...unit, acquired_external_transaction_type: 'trade', acquired_external_contact: 'Gary' }, onClose: noop });
  assert.match(outside, /Received in a trade with Gary, outside Bindarr/);
  assert.doesNotMatch(render(ItemDetailsModal, { item: unit, onClose: noop }), /Acquired/);
});

test('Settings carries the trade-offers switch next to sharing', async () => {
  const { default: Settings } = await load('/src/components/Settings.jsx');
  const props = { onUpdateUser: noop, showToast: noop, onLeaveDevice: noop, onDataChanged: noop };
  const tradesSwitch = (html) => (html.match(/<input[^>]*aria-label="Let other members send me trade offers"[^>]*>/) || [''])[0];
  // The server's boolean, and the 0/1 an older stored profile may hold.
  for (const flag of [true, 1]) {
    const on = tradesSwitch(render(Settings, { ...props, user: { ...ME, trades_enabled: flag } }));
    assert.match(on, /type="checkbox"/);
    assert.match(on, /checked=""/);
  }
  for (const flag of [false, 0, undefined]) {
    const off = tradesSwitch(render(Settings, { ...props, user: { ...ME, trades_enabled: flag } }));
    assert.ok(off, 'there whether on or off');
    assert.doesNotMatch(off, /checked=""/);
  }
});
