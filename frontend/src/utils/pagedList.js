// Lists the server hands out a page at a time: GET /api/transfers,
// /api/transfers/history and /api/transfers/external answer { <items>,
// next_cursor }, where next_cursor is opaque and null after the last page, and
// take ?limit= (default 50, at most 100) and ?cursor=. The first page carries
// every item still open (a pending offer, a recorded trade awaiting
// confirmation) whatever its age; later pages hold closed items only.
//
// "Load more" appends a page. Refreshing reloads the first page and merges it
// into what is shown, so the pages a reader has already loaded stay put. An
// action the server has answered edits the list in place instead of reloading
// it (prependItem, replaceItem, removeItem).
import { LatestRequest, isAbortError } from './request.js';

export const PAGE_SIZE = 50;

const byId = (item) => String(item.id);
const never = () => false;

export const emptyPagedList = () => ({
  items: [], cursor: null, pages: 0, loaded: false, loading: false, loadingMore: false, error: null,
});

// `base` with ?limit= and, past the first page, ?cursor=. `base` may already
// carry a query string.
export function pageUrl(base, { cursor = null, limit = PAGE_SIZE } = {}) {
  const params = new URLSearchParams();
  if (limit != null) params.set('limit', String(limit));
  if (cursor != null && cursor !== '') params.set('cursor', String(cursor));
  const query = params.toString();
  if (!query) return base;
  return `${base}${base.includes('?') ? '&' : '?'}${query}`;
}

// A page as the server sent it, its items under `field`. A server that does not
// page yet sends no next_cursor, which reads as "nothing after this".
export function readPage(data, field) {
  const items = data && Array.isArray(data[field]) ? data[field] : [];
  return { items, nextCursor: data?.next_cursor ?? null };
}

function dedupe(items, keyOf) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// A later page goes after what is shown. An item already shown is replaced where
// it stands by the page's copy, the newer of the two (cursors are positions in
// a list that changes between requests).
export function appendPage(state, items, nextCursor, keyOf = byId) {
  const incoming = new Map(items.map(item => [keyOf(item), item]));
  const merged = state.items.map(item => incoming.get(keyOf(item)) ?? item);
  const shown = new Set(state.items.map(keyOf));
  for (const item of dedupe(items, keyOf)) {
    if (!shown.has(keyOf(item))) merged.push(item);
  }
  return { ...state, items: merged, cursor: nextCursor ?? null, pages: state.pages + 1, loaded: true };
}

// A fresh first page. With nothing past the first page loaded, it simply is the
// list. Otherwise it goes on top, replacing the copies it carries, and the older
// items "Load more" brought in stay below it with the cursor past them. An item
// shown as open that the new first page does not carry has closed since (the
// first page carries every open one): it drops out until the page it now
// belongs to is loaded, rather than being shown with a state it no longer has.
export function mergeFirstPage(state, items, nextCursor, { keyOf = byId, isOpen = never } = {}) {
  const page = dedupe(items, keyOf);
  if (!state.loaded || state.pages <= 1) {
    return { ...state, items: page, cursor: nextCursor ?? null, pages: 1, loaded: true };
  }
  const onPage = new Set(page.map(keyOf));
  const older = state.items.filter(item => !onPage.has(keyOf(item)) && !isOpen(item));
  return { ...state, items: [...page, ...older], loaded: true };
}

// Local edits, for an action the server has already answered.
export function prependItem(state, item, keyOf = byId) {
  const key = keyOf(item);
  return { ...state, items: [item, ...state.items.filter(other => keyOf(other) !== key)] };
}

export function replaceItem(state, key, updater, keyOf = byId) {
  return {
    ...state,
    items: state.items.map(item => (keyOf(item) === String(key)
      ? (typeof updater === 'function' ? updater(item) : updater)
      : item)),
  };
}

export function removeItem(state, key, keyOf = byId) {
  return { ...state, items: state.items.filter(item => keyOf(item) !== String(key)) };
}

// One paged list's state machine, free of React like request.js's QueryCore so
// it can be tested with node:test. `fetchPage({ cursor, signal })` resolves to
// { items, nextCursor } (readPage).
//
//   refresh(fetchPage)   the first page, merged in; the newest refresh wins, and
//                        a "Load more" still on its way is dropped, since it
//                        was asked for against the list being replaced.
//   loadMore(fetchPage)  the page after the cursor; one at a time.
//   find(match, fetchPage, maxPages)
//                        the first item matching, loading further pages until
//                        it turns up or the list ends.
//   edit(fn)             replace the state with fn(state).
export class PagedQuery {
  constructor(onChange, { keyOf = byId, isOpen = never } = {}) {
    this.onChange = onChange;
    this.keyOf = keyOf;
    this.isOpen = isOpen;
    this.first = new LatestRequest();
    this.more = new LatestRequest();
    this.firstRun = null;
    this.moreRun = null;
    this.state = emptyPagedList();
  }

  set(next) {
    this.state = next;
    if (this.onChange) this.onChange(next);
  }

  refresh(fetchPage) {
    const req = this.first.begin();
    this.more.cancel();
    this.moreRun = null;
    this.set({ ...this.state, loading: !this.state.loaded, loadingMore: false, error: null });
    const run = this.fetchFirst(fetchPage, req);
    this.firstRun = run;
    run.then(() => { if (this.firstRun === run) this.firstRun = null; });
    return run;
  }

  async fetchFirst(fetchPage, req) {
    try {
      const page = await fetchPage({ cursor: null, signal: req.signal });
      if (!req.isLatest()) return { stale: true };
      const merged = mergeFirstPage(this.state, page.items, page.nextCursor, { keyOf: this.keyOf, isOpen: this.isOpen });
      this.set({ ...merged, loading: false });
      return { ok: true };
    } catch (error) {
      if (!req.isLatest() || isAbortError(error)) return { stale: true };
      this.set({ ...this.state, loading: false, error });
      return { error };
    }
  }

  loadMore(fetchPage) {
    if (this.moreRun) return this.moreRun;
    const cursor = this.state.cursor;
    if (cursor == null) return Promise.resolve({ done: true });
    const req = this.more.begin();
    this.set({ ...this.state, loadingMore: true, error: null });
    const run = this.fetchMore(fetchPage, req, cursor);
    this.moreRun = run;
    run.then(() => { if (this.moreRun === run) this.moreRun = null; });
    return run;
  }

  async fetchMore(fetchPage, req, cursor) {
    try {
      const page = await fetchPage({ cursor, signal: req.signal });
      if (!req.isLatest()) return { stale: true };
      this.set({ ...appendPage(this.state, page.items, page.nextCursor, this.keyOf), loadingMore: false });
      return { ok: true };
    } catch (error) {
      if (!req.isLatest() || isAbortError(error)) return { stale: true };
      this.set({ ...this.state, loadingMore: false, error });
      return { error };
    }
  }

  async find(match, fetchPage, maxPages = 20) {
    if (this.firstRun) await this.firstRun;
    for (let page = 0; ; page++) {
      const hit = this.state.items.find(match);
      if (hit || this.state.cursor == null || page >= maxPages) return hit || null;
      const result = await this.loadMore(fetchPage);
      if (result.error || result.stale) return this.state.items.find(match) || null;
    }
  }

  edit(fn) {
    this.set(fn(this.state));
  }

  cancel() {
    this.first.cancel();
    this.more.cancel();
    this.firstRun = null;
    this.moreRun = null;
    if (this.state.loading || this.state.loadingMore) this.set({ ...this.state, loading: false, loadingMore: false });
  }
}
