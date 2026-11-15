// The selection bar and the view toggle the Collection, Add Cards search,
// Browse and Sealed screens share (components/SelectionBar.jsx, ViewToggle.jsx),
// rendered with react-dom/server through Vite's SSR loader, the way
// renderSmoke.test.js renders the views.
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
const h = (...args) => React.createElement(...args);

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

test('the selection bar counts the selection and offers select all, clear and done', async () => {
  const { default: SelectionBar, BarDivider } = await vite.ssrLoadModule('/src/components/SelectionBar.jsx');
  const html = renderToString(h(SelectionBar, { count: 3, total: 12, onSelectAll: noop, onClear: noop, onDone: noop },
    h(BarDivider), h('button', { type: 'button' }, 'Delete')));
  assert.match(html, /3 selected/);
  assert.match(html, /Select all \(12\)/);
  assert.match(html, />Clear</);
  assert.match(html, />Done</);
  assert.match(html, /bulk-action-bar/, 'the class that compacts the bar on a phone');
  assert.match(html, /aria-hidden="true"/, 'the divider is decoration');
  assert.ok(html.indexOf('Delete') > html.indexOf('Clear') && html.indexOf('Delete') < html.indexOf('Done'),
    "the screen's actions sit between Clear and Done");
});

test('the selection bar leaves out Done without a handler and places extras before Clear', async () => {
  const { default: SelectionBar } = await vite.ssrLoadModule('/src/components/SelectionBar.jsx');
  const html = renderToString(h(SelectionBar, {
    count: 0, total: 5, onSelectAll: noop, onClear: noop,
    selectExtras: h('button', { type: 'button' }, 'Select missing'),
  }));
  assert.doesNotMatch(html, />Done</);
  assert.ok(html.indexOf('Select all') < html.indexOf('Select missing') && html.indexOf('Select missing') < html.indexOf('>Clear<'));
});

test('the view toggle names each view, marks the current one and follows the theme', async () => {
  const { default: ViewToggle } = await vite.ssrLoadModule('/src/components/ViewToggle.jsx');
  const Icon = (props) => h('svg', props);
  const html = renderToString(h(ViewToggle, {
    value: 'list',
    onChange: noop,
    options: [{ value: 'gallery', label: 'Gallery View', icon: Icon }, { value: 'list', label: 'List Table View', icon: Icon }],
  }));
  assert.match(html, /aria-label="Gallery View"[^>]*aria-pressed="false"/);
  assert.match(html, /aria-label="List Table View"[^>]*aria-pressed="true"/);
  assert.match(html, /background:var\(--surface-2\)/);
  assert.doesNotMatch(html, /rgba\(0, ?0, ?0/, 'no fixed dark tint, which smudged the light theme');
});

// useApi reports `loading` only once its effect has started, so a view that
// read it would paint "nothing here yet" first.
test('the Sealed tab paints Loading, not its empty state, before its first answer', async () => {
  const { default: SealedList } = await vite.ssrLoadModule('/src/components/SealedList.jsx');
  const html = renderToString(h(SealedList, { showToast: noop, active: true, statsTrigger: 0 }));
  assert.match(html, />Loading</);
  assert.doesNotMatch(html, /No sealed products yet/);
});
