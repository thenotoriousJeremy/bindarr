// Render smoke tests. Everything else in this folder tests plain functions, and
// nothing rendered a component, which is how 1.9.0 shipped a login screen that
// threw on every logout (React refuses an object as a child, and the toast is
// an object). renderHarness.js loads the app through Vite's SSR loader and
// react-dom/server renders the first paint. Effects never run there, so no
// request is made: each view draws its loading state, which is enough to catch
// a broken import, a bad prop or a throw in render.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserGlobals, startRenderer } from './renderHarness.js';

installBrowserGlobals();
// The network under App.jsx's fetch wrapper, which wraps whatever fetch is there
// when App loads: /api/aborted fails as a cancelled request does, and
// /api/unreachable as a server that cannot be reached.
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes('/api/aborted')) throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
  if (url.includes('/api/unreachable')) throw new TypeError('fetch failed');
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const USER = { id: 1, username: 'ash', role: 'admin', nav_tabs: null };
const noop = () => {};
// A toast pill, as opposed to the always-there region around it.
const TOAST_PILL = /class="toast( toast-action)?"/;

let renderer;
const load = (path) => renderer.load(path);
const render = (Component, props) => renderer.render(Component, props);

before(async () => { renderer = await startRenderer(); });
after(async () => { await renderer?.close(); });

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

test('with nothing pinned, More and the header still reach every tab (#107)', async () => {
  signIn({ ...USER, nav_tabs: [] });
  try {
    const { default: App } = await load('/src/App.jsx');
    const html = render(App);
    assert.match(html, /aria-haspopup="menu"[^>]*aria-expanded="false"|aria-expanded="false"[^>]*aria-haspopup="menu"/, 'a closed More button');
    assert.match(html, /<button[^>]*header-tab-btn[^>]*aria-label="Settings"/);
    assert.match(html, /<button[^>]*header-tab-btn[^>]*aria-label="Admin"/);
    assert.doesNotMatch(html, /class="nav-tab[^"]*"[^>]*aria-label="Settings"/, 'Settings is no longer a bar tab');
  } finally {
    signOut();
  }
  signIn({ ...USER, role: 'user' });
  try {
    const { default: App } = await load('/src/App.jsx');
    const html = render(App);
    assert.doesNotMatch(html, /aria-haspopup="menu"/, 'the default bar leaves nothing for More');
    assert.doesNotMatch(html, /aria-label="Admin"/, 'no Admin button for a member');
  } finally {
    signOut();
  }
});

test('a cancelled request does not put the app offline; an unreachable server does', async () => {
  await load('/src/App.jsx'); // installs the fetch wrapper
  const offline = await load('/src/utils/offline.js');
  await assert.rejects(fetch('/api/aborted'), { name: 'AbortError' });
  assert.equal(offline.isOffline(), false, 'useApi and the storage loaders abort superseded reads');
  await assert.rejects(fetch('/api/unreachable'), TypeError);
  assert.equal(offline.isOffline(), true);
  await fetch('/api/ok');
  assert.equal(offline.isOffline(), false, 'an answer from the network clears it');
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
  AdminPanel: { showToast: noop, onRunSetup: noop },
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
