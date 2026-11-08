// The user's default Wishlist, as the hearts on cards see it: one shared set of
// card ids, so every heart in every view agrees. The list itself is made by the
// server on the first add (routes/lists.js, /api/lists/default), so wanting a
// card needs no setup. Pure (fetch is injected), so it runs under node:test;
// useWishlist.js is the React side.
//
// Adds and removes show at once and are undone if the server refuses; the
// server's answer then replaces the set, so it never drifts from the list.

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function createWishlistStore(fetchFn = (...args) => globalThis.fetch(...args)) {
  let ids = new Set();
  let loaded = false;
  let pending = null;
  // Adds/removes still waiting on the server. Only the last to settle takes the
  // server's set, so an earlier answer cannot drop a heart tapped after it.
  let inflight = 0;
  let version = 0;
  const listeners = new Set();

  const emit = () => {
    version++;
    listeners.forEach(fn => fn());
  };
  const replace = (cardIds) => {
    ids = new Set(cardIds);
    loaded = true;
    emit();
  };

  // Read once; force re-reads (after the Lists view changed the list).
  function load({ force = false } = {}) {
    if (pending) return pending;
    if (loaded && !force) return Promise.resolve();
    pending = fetchFn('/api/lists/default')
      .then(res => (res.ok ? res.json() : null))
      .then(body => { if (body && Array.isArray(body.card_ids)) replace(body.card_ids); })
      .catch(() => { /* offline: the hearts show what they last knew */ })
      .finally(() => { pending = null; });
    return pending;
  }

  // Resolves to { added, already, failed, error }.
  async function add(cardIds) {
    const wanted = [...new Set((cardIds || []).filter(Boolean))];
    if (wanted.length === 0) return { added: 0, already: 0, failed: [], error: null };
    const fresh = wanted.filter(id => !ids.has(id));
    const undo = () => {
      if (!fresh.length) return;
      ids = new Set([...ids].filter(id => !fresh.includes(id)));
      emit();
    };
    if (fresh.length) {
      ids = new Set([...ids, ...fresh]);
      emit();
    }
    inflight++;
    try {
      const res = await fetchFn('/api/lists/default/items', {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ card_ids: wanted }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        undo();
        return { added: 0, already: 0, failed: wanted, error: body.error || null };
      }
      if (inflight === 1 && Array.isArray(body.card_ids)) replace(body.card_ids);
      return { added: body.added || 0, already: body.already || 0, failed: body.failed || [], error: null };
    } catch {
      undo();
      return { added: 0, already: 0, failed: wanted, error: null };
    } finally {
      inflight--;
    }
  }

  // Resolves to true when the card came off.
  async function remove(cardId) {
    if (!cardId) return false;
    const had = ids.has(cardId);
    if (had) {
      ids = new Set([...ids].filter(id => id !== cardId));
      emit();
    }
    const undo = () => {
      if (!had) return;
      ids = new Set([...ids, cardId]);
      emit();
    };
    inflight++;
    try {
      const res = await fetchFn(`/api/lists/default/items/${encodeURIComponent(cardId)}`, { method: 'DELETE' });
      if (!res.ok) { undo(); return false; }
      const body = await res.json().catch(() => ({}));
      if (inflight === 1 && Array.isArray(body.card_ids)) replace(body.card_ids);
      return true;
    } catch {
      undo();
      return false;
    } finally {
      inflight--;
    }
  }

  return {
    load,
    add,
    remove,
    has: (cardId) => ids.has(cardId),
    size: () => ids.size,
    isLoaded: () => loaded,
    // A new session must not see the last account's hearts.
    reset() {
      ids = new Set();
      loaded = false;
      emit();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getVersion: () => version,
  };
}

export const wishlist = createWishlistStore();
