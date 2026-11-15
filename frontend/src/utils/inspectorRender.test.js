// Render checks for the card popup and the views around it, through Vite's SSR
// loader and react-dom/server as in renderSmoke.test.js: a first paint, no
// effects, no requests.
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
const CARD = {
  entry_id: 7, card_id: 'sv1-25', name: 'Pikachu', game: 'pokemon', set_name: 'Scarlet & Violet',
  number: '25', rarity: 'Common', quantity: 1, condition: 'Near Mint', printing: 'Normal',
  language: 'English', list_type: 'collection', price_trend: 1.5,
};

let vite;
let React;
let renderToString;
const load = (path) => vite.ssrLoadModule(path);
const render = (Component, props) => renderToString(React.createElement(Component, props));
// The opening tag of the dialog backdrop Modal draws.
const overlayTag = (html) => (html.match(/<div class="modal-overlay"[^>]*>/) || [''])[0];

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

test('the card popup renders, with its backdrop left to .modal-overlay', async () => {
  const { default: CardInspectorModal } = await load('/src/components/CardInspectorModal.jsx');
  const html = render(CardInspectorModal, { card: CARD, onClose: noop, onUpdate: noop, showToast: noop });
  assert.match(html, /role="dialog"/);
  assert.match(html, /Pikachu/);
  const overlay = overlayTag(html);
  assert.ok(overlay, 'the popup draws the shared backdrop');
  assert.doesNotMatch(overlay, /z-index|position/, 'no copied position or z-index of its own');
});

test("the card popup's icon buttons are named", async () => {
  const { default: CardInspectorModal } = await load('/src/components/CardInspectorModal.jsx');
  const html = render(CardInspectorModal, { card: CARD, onClose: noop, showToast: noop });
  assert.match(html, /aria-label="Mark as Favorite"/);
  assert.match(html, /aria-label="Delete Card"/);
});

test('the full-screen zoom keeps only its own darker backdrop', async () => {
  const { default: CardImageZoom } = await load('/src/components/CardImageZoom.jsx');
  const overlay = overlayTag(render(CardImageZoom, { card: CARD, onClose: noop }));
  assert.match(overlay, /background-color:rgba\(0,\s*0,\s*0,\s*0\.92\)/);
  assert.doesNotMatch(overlay, /z-index|position/);
});

test('the Dashboard loads the card popup only when a card is opened', async () => {
  const { code } = await vite.transformRequest('/src/components/Dashboard.jsx', { ssr: true });
  const popup = /CardInspectorModal\.jsx/;
  const staticImports = [...code.matchAll(/__vite_ssr_import__\(\s*"([^"]+)"/g)].map(m => m[1]);
  const dynamicImports = [...code.matchAll(/__vite_ssr_dynamic_import__\(\s*"([^"]+)"/g)].map(m => m[1]);
  assert.ok(!staticImports.some(p => popup.test(p)), `static imports: ${staticImports.join(', ')}`);
  assert.ok(dynamicImports.some(p => popup.test(p)), `dynamic imports: ${dynamicImports.join(', ')}`);
});

test('Notes renders, and with no notes yet shows its loading state', async () => {
  const { default: Notes } = await load('/src/components/Notes.jsx');
  assert.match(render(Notes, { showToast: noop, active: false }), /class="spinner"/);
});
