// Render smoke tests. Everything else in this folder tests plain functions, and
// nothing rendered a component, which is how 1.9.0 shipped a login screen that
// threw on every logout (React refuses an object as a child, and the toast is
// an object). Vite's own SSR loader compiles the JSX and resolves imports the
// way the app build does; react-dom/server renders the first paint. Effects
// never run there, so no request is made: each view draws its loading state,
// which is enough to catch a broken import, a bad prop or a throw in render.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// The browser globals the app's modules read while loading or rendering.
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
globalThis.dispatchEvent = () => true;
globalThis.location = new URL('https://bindarr.test/');
globalThis.history = { state: null, length: 1, pushState() {}, replaceState() {}, back() {} };

const USER = { id: 1, username: 'ash', role: 'admin', nav_tabs: null };
const noop = () => {};
// A toast pill, as opposed to the always-there region around it.
const TOAST_PILL = /class="toast( toast-action)?"/;

let vite;
let React;
let renderToString;
const load = (path) => vite.ssrLoadModule(path);
const render = (Component, props = {}) => renderToString(React.createElement(Component, props));

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('../..', import.meta.url)),
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  // The same React the loaded modules use: Vite leaves node_modules to Node.
  React = await import('react');
  ({ renderToString } = await import('react-dom/server'));
});

after(async () => { await vite?.close(); });

function signOut() {
  localStorage.removeItem('bindarr_token');
  localStorage.removeItem('bindarr_user');
}

function signIn(user = USER) {
  localStorage.setItem('bindarr_token', 'smoke-token');
  localStorage.setItem('bindarr_user', JSON.stringify(user));
}

test('the login screen renders', async () => {
  signOut();
  const { default: App } = await load('/src/App.jsx');
  const toasts = await load('/src/utils/toast.js');
  toasts.dismissToast();
  const html = render(App);
  assert.match(html, /role="status"/, 'the toast region is there before any toast');
  assert.doesNotMatch(html, TOAST_PILL);
});

test('the login screen renders with a toast up (the 1.9.0 logout crash)', async () => {
  signOut();
  const { default: App } = await load('/src/App.jsx');
  const toasts = await load('/src/utils/toast.js');
  toasts.showToast('Logged out');
  const html = render(App);
  assert.match(html, /Logged out/);
  toasts.showToast('Card deleted', { onAction: noop });
  assert.match(render(App), /Undo/, 'an action toast keeps its button on this screen too');
  toasts.dismissToast();
});

test('the signed-in app renders with a toast up', async () => {
  signIn();
  try {
    const { default: App } = await load('/src/App.jsx');
    const toasts = await load('/src/utils/toast.js');
    toasts.showToast('Welcome back');
    const html = render(App);
    assert.match(html, /Welcome back/);
    assert.match(html, /class="nav-tabs"/);
    toasts.dismissToast();
  } finally {
    signOut();
  }
});

test('the shared Toast component never renders an object', async () => {
  const { default: Toast } = await load('/src/components/Toast.jsx');
  assert.match(render(Toast, { toast: 'Plain string' }), /Plain string/);
  assert.match(render(Toast, { toast: { message: 'From an object', id: 3 } }), /From an object/);
  assert.match(render(Toast, { toast: { error: 'From a server body' } }), /From a server body/);
  assert.doesNotMatch(render(Toast, { toast: null }), TOAST_PILL);
});

// Every view App lazy-loads, with the props App gives it.
const VIEWS = {
  Dashboard: { statsTrigger: 0, onNavigate: noop, onOpenSet: noop, setSelectedLocationId: noop, setFocusEntryId: noop, onUpdate: noop, showToast: noop },
  AddCards: { active: true, onAddSuccess: noop, showToast: noop, setActiveTab: noop },
  CollectionList: { statsTrigger: 0, onUpdate: noop, showToast: noop, selectedCardFilter: '', setSelectedCardFilter: noop, onNavigate: noop, setSelectedLocationId: noop, setFocusEntryId: noop },
  LocationManager: { statsTrigger: 0, onUpdate: noop, showToast: noop, selectedLocationId: null, setSelectedLocationId: noop, focusEntryId: null, setFocusEntryId: noop },
  SetCompletion: { focusSet: null, statsTrigger: 0, showToast: noop },
  DeckBuilder: { showToast: noop, statsTrigger: 0 },
  Lists: { active: true, statsTrigger: 0, showToast: noop },
  Notes: { showToast: noop },
  SealedList: { showToast: noop },
  Settings: { user: USER, onUpdateUser: noop, showToast: noop, onLeaveDevice: noop, onDataChanged: noop },
  AdminPanel: { user: USER, onUpdateUser: noop, showToast: noop },
  SetupWizard: { user: USER, onUpdateUser: noop, showToast: noop, onClose: noop },
  SharedCollection: { shareToken: 'abc' },
  SharedContainer: { shareToken: 'abc', containerId: '1' },
};

for (const [name, props] of Object.entries(VIEWS)) {
  test(`${name} renders its first paint`, async () => {
    signIn();
    try {
      const { default: View } = await load(`/src/components/${name}.jsx`);
      const html = render(View, props);
      assert.equal(typeof html, 'string');
    } finally {
      signOut();
    }
  });
}
