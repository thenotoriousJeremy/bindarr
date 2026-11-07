import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavHistory } from './navHistory.js';

// A session history that behaves like a browser's where it matters: pushState
// and replaceState are synchronous and drop forward entries; go()/back() are
// asynchronous, moving and firing popstate on a later task. Writing while a
// traversal is pending is the race that used to throw the app onto
// about:blank, so the fake fails the test if it happens.
function fakeWindow(url = '/') {
  const entries = [{ state: null, url }];
  let i = 0;
  let pending = 0;
  const listeners = [];
  const clone = (s) => (s == null ? null : JSON.parse(JSON.stringify(s)));
  const history = {
    get state() { return entries[i].state; },
    get length() { return entries.length; },
    pushState(state, _title, u) {
      assert.equal(pending, 0, 'pushState while a traversal is in flight');
      entries.splice(i + 1);
      entries.push({ state: clone(state), url: u ?? entries[i].url });
      i++;
    },
    replaceState(state, _title, u) {
      assert.equal(pending, 0, 'replaceState while a traversal is in flight');
      entries[i] = { state: clone(state), url: u ?? entries[i].url };
    },
    go(n) {
      pending++;
      setTimeout(() => {
        pending--;
        const t = i + n;
        if (t < 0 || t >= entries.length || n === 0) return;
        i = t;
        listeners.forEach(fn => fn({ state: entries[i].state }));
      }, 0);
    },
    back() { this.go(-1); },
    forward() { this.go(1); },
  };
  return {
    history,
    addEventListener: (type, fn) => { if (type === 'popstate') listeners.push(fn); },
    // Test helpers
    reload: () => { listeners.length = 0; },
    url: () => entries[i].url,
    index: () => i,
    entries,
  };
}

// Let queued microtasks, traversals and their popstates all run.
const settle = () => new Promise(r => setTimeout(r, 20));

function setup() {
  const win = fakeWindow('/');
  const nav = createNavHistory(win, { settleTimeoutMs: 200 });
  const closed = [];
  const guard = (name) => nav.pushGuard(() => closed.push(name));
  return { win, nav, closed, guard };
}

test('stamps the landing entry with its position', () => {
  const { win, nav } = setup();
  assert.equal(win.history.state.idx, 0);
  assert.equal(nav.canGoBack(), false);
  nav.push('/collection');
  assert.equal(win.history.state.idx, 1);
  assert.equal(nav.canGoBack(), true);
});

test('Back closes only the topmost guard, one per press', async () => {
  const { win, nav, closed, guard } = setup();
  guard('a');
  guard('b');
  win.history.back();
  await settle();
  assert.deepEqual(closed, ['b']);
  win.history.back();
  await settle();
  assert.deepEqual(closed, ['b', 'a']);
  assert.equal(nav.openGuards(), 0);
});

test('Forward after Back does not close anything (it used to act like Back)', async () => {
  const { win, nav, closed, guard } = setup();
  guard('a');
  guard('b');
  win.history.back(); // closes b
  await settle();
  win.history.forward(); // onto b's dead entry: must not close a
  await settle();
  assert.deepEqual(closed, ['b']);
  assert.equal(nav.openGuards(), 1);
  // ...and it does not leave a dead step behind: one Back closes a.
  win.history.back();
  await settle();
  assert.deepEqual(closed, ['b', 'a']);
});

test('Forward skips a dead guard entry to reach the route beyond it', async () => {
  const { win, nav, closed, guard } = setup();
  nav.push('/collection');
  const closeA = guard('a');
  nav.push('/storage'); // tab switch with the popup still open
  win.history.back(); // back to the popup's entry: it is still open there
  await settle();
  assert.deepEqual(closed, []);
  assert.equal(win.url(), '/collection');
  closeA(); // closed with its button; the entry below is the route
  await settle();
  assert.equal(win.url(), '/collection');
  win.history.forward(); // onto a's dead entry -> carries on to /storage
  await settle();
  assert.equal(win.url(), '/storage');
  assert.deepEqual(closed, []);
});

test('a guard closed by its button steps back silently', async () => {
  const { win, nav, closed, guard } = setup();
  const seen = [];
  nav.subscribe(() => seen.push(win.url()));
  nav.push('/decks');
  const close = guard('modal');
  assert.equal(win.index(), 2);
  close();
  await settle();
  assert.equal(win.index(), 1);
  assert.deepEqual(closed, [], 'disposing is not a back gesture');
  assert.deepEqual(seen, [], 'nor navigation');
  close(); // twice is harmless
  await settle();
  assert.equal(win.index(), 1);
});

test('closing and pushing in the same tick never races the traversal', async () => {
  const { win, nav, guard } = setup();
  const close = guard('modal');
  close();
  nav.push('/collection'); // queued until the silent back lands
  nav.push('/storage');
  await settle();
  assert.deepEqual(win.entries.map(e => e.url), ['/', '/collection', '/storage']);
  assert.equal(win.index(), 2);
  assert.deepEqual(win.entries.map(e => e.state.idx), [0, 1, 2]);
});

test('closes in the same tick coalesce into one traversal', async () => {
  const { win, guard } = setup();
  const closeA = guard('a');
  const closeB = guard('b');
  closeB();
  closeA();
  await settle();
  assert.equal(win.index(), 0);
});

test('closing a lower guard does not navigate; the top one then steps over both', async () => {
  const { win, closed, guard } = setup();
  const closeA = guard('a');
  const closeB = guard('b');
  closeA();
  await settle();
  assert.equal(win.index(), 2, 'b is still open on top');
  closeB();
  await settle();
  assert.equal(win.index(), 0);
  assert.deepEqual(closed, []);
});

test('Back onto a dead guard entry walks past it', async () => {
  const { win, nav, closed, guard } = setup();
  nav.push('/collection');
  const closeA = guard('a');
  nav.push('/storage');
  closeA(); // not on top: stays as a dead entry under /storage
  await settle();
  assert.equal(win.index(), 3);
  const seen = [];
  nav.subscribe(() => seen.push(win.url()));
  win.history.back();
  await settle();
  assert.equal(win.index(), 1, 'one press, back to the route');
  assert.equal(seen.at(-1), '/collection');
  assert.deepEqual(closed, []);
});

test('a multi-step jump back closes every guard above the target', async () => {
  const { win, nav, closed, guard } = setup();
  nav.push('/decks');
  guard('a');
  guard('b');
  win.history.go(-3);
  await settle();
  assert.deepEqual(closed, ['b', 'a']);
  assert.equal(win.index(), 0);
});

test('Back to a route below an open popup keeps the popup for when you return', async () => {
  const { win, nav, closed, guard } = setup();
  nav.push('/collection');
  guard('inspector');
  nav.push('/storage');
  win.history.back();
  await settle();
  assert.deepEqual(closed, [], 'the popup comes back with its tab');
  win.history.back();
  await settle();
  assert.deepEqual(closed, ['inspector']);
});

test('back() leaves a route entry without emitting', async () => {
  const { win, nav } = setup();
  const seen = [];
  nav.subscribe(() => seen.push(win.url()));
  nav.push('/decks');
  nav.push('/decks/4', { from: '/decks' });
  assert.equal(nav.state().from, '/decks');
  nav.back();
  nav.push('/collection'); // waits for the step back
  await settle();
  assert.deepEqual(win.entries.map(e => e.url), ['/', '/decks', '/collection']);
  assert.deepEqual(seen, []);
});

test('replace keeps a guard entry a guard', async () => {
  const { win, nav, closed, guard } = setup();
  nav.push('/storage');
  guard('a');
  nav.replace('/storage/3');
  assert.equal(win.history.state.guard, true);
  win.history.back();
  await settle();
  assert.deepEqual(closed, ['a']);
});

test('after a reload, a guard entry from before is dead and skipped', async () => {
  const win = fakeWindow('/');
  const first = createNavHistory(win, { settleTimeoutMs: 200 });
  first.push('/decks');
  first.pushGuard(() => {});
  first.push('/decks/2');
  // Reload: a new instance over the same history.
  win.reload();
  const nav = createNavHistory(win, { settleTimeoutMs: 200 });
  assert.equal(nav.canGoBack(), true);
  win.history.back();
  await settle();
  assert.equal(win.url(), '/decks');
  assert.equal(win.index(), 1);
});

test('entries written by someone else count as the start', async () => {
  const { win, nav, closed, guard } = setup();
  guard('a');
  // e.g. SharedCollection pushing its own { path } state
  win.history.pushState({ path: '/share/x?list=wish' }, '', '/share/x?list=wish');
  win.history.back();
  await settle();
  assert.deepEqual(closed, []);
  assert.equal(nav.openGuards(), 1);
});
