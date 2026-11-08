// One owner for the browser history: app routes (utils/router.js) and the
// back-guards that close a popup on Back (utils/useBackGuard.js) both write
// through here. No React and no Capacitor, so node:test drives it with a fake
// window (navHistory.test.js).
//
// Every entry we write carries its position, `idx`, in history.state. On
// popstate that tells us which way the user went and how far, which the old
// guard stack could not know -- it closed the topmost popup on ANY popstate, so
// Forward behaved like Back:
//   - Back to idx N closes every open guard whose entry is above N, topmost
//     first, and nothing else.
//   - Forward never closes anything. Landing on a guard entry whose popup is
//     already closed (a dead entry) skips over it.
//
// Closing a popup from a button consumes its entry with a silent back. Those
// are coalesced per tick into one history.go(-n), and any write made before the
// browser reports it is queued: a pushState that ran first would be undone by
// the traversal still in flight (the race that used to drop the app to
// about:blank on rapid tab switches).
export function createNavHistory(win, { settleTimeoutMs = 1000 } = {}) {
  const h = win.history;
  const readIdx = (state) => (state && Number.isInteger(state.idx) ? state.idx : 0);

  let idx = readIdx(h.state);
  if (!h.state || !Number.isInteger(h.state.idx)) h.replaceState({ ...(h.state || {}), idx }, '');
  let top = idx; // highest idx in the current branch, as far as we know
  const guards = []; // open guards, oldest first: { idx, close, dead }
  const guardEntries = new Set(); // idx of every guard entry written this page load
  const listeners = new Set();

  let backlog = 0; // silent steps back requested this tick
  let flushScheduled = false;
  let inFlight = null; // 'silent' | 'walk' while a traversal we started is pending
  let settleTimer = null;
  const queue = []; // history writes waiting for that traversal

  const isLive = (i) => guards.some(g => g.idx === i);
  const isDeadGuard = (i) => guardEntries.has(i) && !isLive(i);
  const emit = () => listeners.forEach(fn => fn());

  const busy = () => inFlight !== null || backlog > 0;
  const write = (fn) => { if (busy()) queue.push(fn); else fn(); };
  const drain = () => { while (queue.length && !busy()) queue.shift()(); };

  const startTraversal = (kind, go) => {
    inFlight = kind;
    // A traversal the browser never reports (it was cancelled, or went nowhere)
    // must not hold writes back for good.
    settleTimer = setTimeout(() => { inFlight = null; idx = readIdx(h.state); drain(); }, settleTimeoutMs);
    go();
  };

  const flush = () => {
    flushScheduled = false;
    if (!backlog) { drain(); return; }
    const n = backlog;
    backlog = 0;
    startTraversal('silent', () => h.go(-n));
  };

  // Step back n entries without treating the move as navigation. idx moves now,
  // so a second close in the same tick counts from where the first one leaves us.
  const stepBack = (n) => {
    backlog += n;
    idx -= n;
    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flush);
    }
  };

  // How many entries to drop to leave the current one: itself plus any dead
  // guard entries directly beneath it, which would otherwise be Back presses
  // that do nothing.
  const depthToLeave = () => {
    let n = 1;
    while (idx - n > 0 && isDeadGuard(idx - n)) n++;
    return n;
  };

  const onPopState = (e) => {
    const state = e.state || {};
    const to = readIdx(state);

    if (inFlight) {
      clearTimeout(settleTimer);
      const kind = inFlight;
      inFlight = null;
      if (kind === 'silent') {
        idx = to;
        drain();
        return;
      }
      // 'walk': we skipped a dead entry; this landing is real navigation.
    }

    const from = idx;
    idx = to;
    if (to > top) top = to;

    if (to < from) {
      for (let i = guards.length - 1; i >= 0; i--) {
        if (guards[i].idx > to) {
          const [g] = guards.splice(i, 1);
          g.dead = true;
          g.close();
        }
      }
      if (state.guard && !isLive(to) && to > 0) {
        // A guard whose popup was closed while something sat above it.
        startTraversal('walk', () => h.back());
        return;
      }
    } else if (to > from && state.guard && !isLive(to)) {
      // Forward cannot reopen a popup. Skip on to whatever follows; if nothing
      // does, return to where we were.
      if (to < top) {
        startTraversal('walk', () => h.forward());
        return;
      }
      stepBack(1);
    }
    emit();
    drain();
  };
  win.addEventListener('popstate', onPopState);

  // Push an entry for an app route. `extra` is kept in history.state.
  const push = (url, extra = {}) => write(() => {
    idx += 1;
    top = idx;
    for (const i of guardEntries) if (i >= idx) guardEntries.delete(i);
    h.pushState({ ...extra, idx }, '', url);
  });

  // Rewrite the current entry's URL. A guard entry stays a guard entry.
  const replace = (url, extra = {}) => write(() => {
    const cur = h.state || {};
    h.replaceState({ ...extra, ...(cur.guard ? { guard: true } : {}), idx }, '', url);
  });

  // Leave the current entry the way Back would, without it counting as
  // navigation (the caller has already updated its own state).
  const back = () => { if (idx > 0) stepBack(depthToLeave()); };

  // A guard: Back pops its entry and runs close() instead of leaving the page.
  // Returns a disposer for closing it any other way.
  const pushGuard = (close) => {
    const g = { idx: -1, close, dead: false };
    guards.push(g);
    write(() => {
      if (g.dead) return;
      idx += 1;
      top = idx;
      for (const i of guardEntries) if (i >= idx) guardEntries.delete(i);
      g.idx = idx;
      guardEntries.add(idx);
      h.pushState({ idx, guard: true }, '');
    });
    return () => {
      if (g.dead) return;
      g.dead = true;
      const i = guards.indexOf(g);
      if (i === -1) return; // already popped by a back gesture
      guards.splice(i, 1);
      if (g.idx === -1) return; // closed before its entry was ever written
      // Only the entry we stand on can be stepped off. One below something else
      // (a route pushed while the popup was open, or a popup above it) stays in
      // place as a dead entry that the traversals above step over.
      if (g.idx === idx) stepBack(depthToLeave());
    };
  };

  return {
    push,
    replace,
    back,
    pushGuard,
    state: () => h.state,
    canGoBack: () => idx > 0,
    openGuards: () => guards.length,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // For tests.
    _debug: () => ({ idx, top, backlog, inFlight, queued: queue.length }),
  };
}
