// The deck screens, rendered with react-dom/server through Vite's SSR loader (as
// renderSmoke.test.js does for every view): their text comes from en.json, a
// counted phrase is not preceded by its own number again, and a deck's badge
// names its own game.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const storage = new Map();
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => { storage.set(k, String(v)); },
  removeItem: (k) => { storage.delete(k); },
  clear: () => storage.clear(),
};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.location = new URL('https://bindarr.test/');
globalThis.history = { state: null, length: 1, pushState() {}, replaceState() {}, back() {} };

const noop = () => {};
let vite;
let React;
let renderToString;
const load = (path) => vite.ssrLoadModule(path);
const render = (Component, props) => renderToString(React.createElement(Component, props));
// Text only, so assertions read like what is on screen. React separates
// adjacent text with <!-- --> comments, which are not on screen.
const text = (html) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('../..', import.meta.url)),
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  React = await import('react');
  ({ renderToString } = await import('react-dom/server'));
});

after(async () => { await vite?.close(); });

const DECKS = [
  { id: 1, name: 'Ink Tide', game: 'lorcana', total_cards: 12, target_size: 60, category: 'Casual', description: '', created_at: '2026-01-02T00:00:00Z' },
  { id: 2, name: 'Sol Tron', game: 'mtg', total_cards: 100, target_size: 100, category: 'Competitive', description: 'Big mana', created_at: '2026-01-01T00:00:00Z', checked_out: 1, checked_out_at: '2026-01-03T00:00:00Z' },
];

const listProps = (mode) => ({
  decks: DECKS, loading: false, checkingOut: false,
  deckSearchTerm: '', setDeckSearchTerm: noop, deckGameFilter: 'all', setDeckGameFilter: noop,
  deckStatusFilter: 'all', setDeckStatusFilter: noop, deckSortBy: 'created_desc', setDeckSortBy: noop,
  deckSelectionViewMode: mode, setDeckSelectionViewMode: noop,
  setShowCreateModal: noop, openDeck: noop, handleCheckout: noop, handleReturn: noop, handleDeleteDeck: noop,
});

for (const mode of ['grid', 'table']) {
  test(`the deck list (${mode}) labels each deck with its own game and its counts`, async () => {
    const { default: DeckList } = await load('/src/components/deck/DeckList.jsx');
    const html = render(DeckList, listProps(mode));
    const shown = text(html);
    // The badge sits after the name on a card and before it in a table row.
    assert.match(shown, /Ink Tide Lorcana|Lorcana Ink Tide/, 'a Lorcana deck is labelled Lorcana');
    assert.doesNotMatch(shown, /Ink Tide Pokémon|Pokémon Ink Tide/, 'not Pokémon');
    assert.match(shown, /12 \/ 60 cards/);
    assert.match(shown, /Casual/);
    assert.match(shown, /In Play/);
    // Every icon-only delete button has a name.
    assert.equal((html.match(/aria-label="Delete Deck"/g) || []).length, DECKS.length);
  });
}

test('the deck list header follows the theme instead of a fixed dark gradient', async () => {
  const { default: DeckList } = await load('/src/components/deck/DeckList.jsx');
  const html = render(DeckList, listProps('grid'));
  assert.doesNotMatch(html, /rgba\(30, 41, 59/);
  assert.doesNotMatch(html, /rgba\(15, ?23, ?42, ?0\.(65|8)\)/);
});

test('an open deck heads its groups with real plurals and says each count once', async () => {
  const { default: DeckEditor } = await load('/src/components/deck/DeckEditor.jsx');
  const { rulesFor } = await load('/src/utils/deckRules.js');
  const activeDeck = {
    id: 2, name: 'Sol Tron', game: 'mtg', format: 'Standard', target_size: 60, checked_out: 0,
    cards: [
      { id: 'mtg-a', name: 'Opt', quantity: 2, owned_qty: 4, subtypes: ['Instant'], set_name: 'Set', number: '1' },
      { id: 'mtg-b', name: 'Divination', quantity: 1, owned_qty: 1, subtypes: ['Sorcery'], set_name: 'Set', number: '2' },
    ],
  };
  const html = render(DeckEditor, {
    activeDeck, deckGame: 'mtg', deckRules: rulesFor('mtg', 'Standard'), showToast: noop,
    deckDraft: null, setDeckDraft: noop, handleSaveDeckProperties: noop,
    openDeck: noop, setShowExportModal: noop, setShowImportModal: noop, loadDeckDetails: noop,
    checkingOut: false, handleCheckout: noop, handleReturn: noop, startSimulator: noop,
    deckSearchGame: 'mtg', setDeckSearchGame: noop, searchQuery: '', setSearchQuery: noop, searching: false, searchResults: [], handleSearchCards: noop,
    savingCard: false, atCopyLimit: () => false, copyLimitText: () => '', handleAddCardToDeck: noop, handleUpdateCardQty: noop, handleToggleCommander: noop,
    cardDisplayMode: 'list', setCardDisplayMode: noop, deckCardSortBy: 'type', setDeckCardSortBy: noop, deckCardLocations: {}, setPreviewCard: noop,
  });
  const shown = text(html);
  assert.match(shown, /Sorceries/);
  assert.match(shown, /Instants/);
  assert.doesNotMatch(shown, /Sorcerys|Instantss/);
  assert.match(shown, /\(3 \/ 60 cards\)/);
  assert.match(shown, /Deck Cards \(3 \/ 60\)/);
  // Deck Health: "2 titles", not "2 2 titles".
  assert.match(shown, /Unique Cards: 2 titles/);
  assert.doesNotMatch(shown, /\b2 2 titles\b/);
  assert.match(html, /aria-label="Back to decks"/);
});

test('ContainerList names the kebab button and translates the container type', async () => {
  const { default: ContainerList } = await load('/src/components/storage/ContainerList.jsx');
  const loc = { id: 5, name: 'Main', type: 'Toploader Binder', locked: 0, total_cards: 3 };
  const html = render(ContainerList, {
    locations: [loc], activeLocationId: 5, setActiveLocationId: noop, selectedLoc: loc,
    compartments: [], cardsByCompartment: new Map(), cardsInActiveLocation: [],
    isBinderType: true, isCustom: false, filingMode: false, moveMode: false, setMoveMode: noop, setPickedEntryId: noop,
    containerViewMode: 'layout', setContainerViewMode: noop, viewMode: 'layout', containerCardScale: 1, setContainerCardScale: noop,
    storage: { selectMode: true, selectedIds: new Set([1]), setSelectMode: noop, exitSelectMode: noop, setSelectedIds: noop, runBulk: noop },
    setShowCreate: noop, handleContainerImportFile: noop, handleToggleContainerLock: noop, handleAddCompartment: noop, handleRemoveCompartment: noop,
    startResort: noop, openContainerSettings: noop, handleDeleteLocation: noop,
  });
  const shown = text(html);
  assert.match(html, /aria-label="Container actions"/);
  assert.match(shown, /Main \(Toploader Binder\)/);
  assert.match(shown, /1 selected/);
  assert.match(shown, /Select all \(0\)/);
});
