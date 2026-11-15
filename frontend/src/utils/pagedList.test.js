import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAGE_SIZE, PagedQuery, appendPage, emptyPagedList, mergeFirstPage, pageUrl, prependItem, readPage, removeItem, replaceItem,
} from './pagedList.js';

// A promise resolved from outside, so a test decides the order responses land in.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const ids = (state) => state.items.map(item => item.id);
const isOpen = (item) => item.status === 'pending';
const loaded = (items, extra = {}) => ({ ...emptyPagedList(), items, loaded: true, pages: 1, ...extra });

test('pageUrl adds the limit, and the cursor only past the first page', () => {
  assert.equal(pageUrl('/api/transfers'), `/api/transfers?limit=${PAGE_SIZE}`);
  assert.equal(pageUrl('/api/transfers', { cursor: 'abc=/+', limit: 100 }), '/api/transfers?limit=100&cursor=abc%3D%2F%2B');
  assert.equal(pageUrl('/api/x?game=mtg', { cursor: 'c2' }), `/api/x?game=mtg&limit=${PAGE_SIZE}&cursor=c2`);
  assert.equal(pageUrl('/api/x', { cursor: '', limit: null }), '/api/x');
});

test('readPage takes the named field and treats a missing cursor as the end', () => {
  assert.deepEqual(readPage({ trades: [{ id: 1 }], next_cursor: 'n' }, 'trades'), { items: [{ id: 1 }], nextCursor: 'n' });
  assert.deepEqual(readPage({ transfers: [{ id: 1 }] }, 'transfers'), { items: [{ id: 1 }], nextCursor: null });
  assert.deepEqual(readPage(null, 'transfers'), { items: [], nextCursor: null });
});

test('a later page is appended, and an item already shown is replaced where it stands', () => {
  const state = loaded([{ id: 3, v: 'old' }, { id: 2 }], { cursor: 'c1' });
  const next = appendPage(state, [{ id: 3, v: 'new' }, { id: 1 }, { id: 1 }], 'c2');
  assert.deepEqual(ids(next), [3, 2, 1]);
  assert.equal(next.items[0].v, 'new');
  assert.equal(next.cursor, 'c2');
  assert.equal(next.pages, 2);
  assert.equal(appendPage(next, [], null).cursor, null, 'no cursor: the end');
});

test('a first page with only the first page shown replaces the list and its cursor', () => {
  const state = loaded([{ id: 9, status: 'pending' }, { id: 8 }], { cursor: 'old' });
  const next = mergeFirstPage(state, [{ id: 10 }, { id: 8 }], 'fresh', { isOpen });
  assert.deepEqual(ids(next), [10, 8]);
  assert.equal(next.cursor, 'fresh');
  assert.equal(next.pages, 1);
  assert.deepEqual(ids(mergeFirstPage(emptyPagedList(), [{ id: 1 }, { id: 1 }], null)), [1], 'duplicates dropped');
});

test('a first page merged over loaded pages keeps the older items and the cursor past them', () => {
  // Pages 1 and 2 shown; 7 was pending and has closed since, so the new first
  // page (which carries every open item) no longer has it.
  const state = { ...loaded([{ id: 7, status: 'pending' }, { id: 6, status: 'accepted' }, { id: 5 }, { id: 4 }]), pages: 2, cursor: 'after-4' };
  const next = mergeFirstPage(state, [{ id: 11, status: 'pending' }, { id: 6, status: 'accepted', v: 2 }], 'after-6', { isOpen });
  assert.deepEqual(ids(next), [11, 6, 5, 4], '7 drops out until its page loads; 5 and 4 stay');
  assert.equal(next.items[1].v, 2, 'the fresh copy wins');
  assert.equal(next.cursor, 'after-4', 'still past what "Load more" brought in');
  assert.equal(next.pages, 2);
});

test('local edits after an answered action', () => {
  const state = loaded([{ id: 1, status: 'pending' }, { id: 2 }]);
  assert.deepEqual(ids(prependItem(state, { id: 3 })), [3, 1, 2]);
  assert.deepEqual(ids(prependItem(state, { id: 2, v: 1 })), [2, 1], 'an item already there moves up, not twice');
  assert.equal(replaceItem(state, 1, item => ({ ...item, status: 'rejected' })).items[0].status, 'rejected');
  assert.deepEqual(replaceItem(state, '2', { id: 2, x: true }).items[1], { id: 2, x: true });
  assert.deepEqual(ids(removeItem(state, 1)), [2]);
});

test('PagedQuery loads the first page, then more until the cursor runs out', async () => {
  const seen = [];
  const pages = { null: { items: [{ id: 3 }, { id: 2 }], nextCursor: 'c1' }, c1: { items: [{ id: 1 }], nextCursor: null } };
  const fetchPage = async ({ cursor }) => { seen.push(cursor); return pages[cursor]; };
  const changes = [];
  const list = new PagedQuery(state => changes.push(state));
  const first = list.refresh(fetchPage);
  assert.equal(list.state.loading, true, 'a first load with nothing to show is loading');
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(ids(list.state), [3, 2]);
  assert.equal(list.state.loading, false);
  assert.deepEqual(await list.loadMore(fetchPage), { ok: true });
  assert.deepEqual(ids(list.state), [3, 2, 1]);
  assert.equal(list.state.cursor, null);
  assert.deepEqual(await list.loadMore(fetchPage), { done: true }, 'nothing after the end');
  assert.deepEqual(seen, [null, 'c1']);
  assert.ok(changes.length >= 4, 'every change is reported');
});

test('PagedQuery: two clicks on "Load more" fetch the next page once', async () => {
  let calls = 0;
  const gate = deferred();
  const list = new PagedQuery();
  list.edit(() => loaded([{ id: 2 }], { cursor: 'c1' }));
  const fetchPage = async () => { calls++; await gate.promise; return { items: [{ id: 1 }], nextCursor: null }; };
  const a = list.loadMore(fetchPage);
  const b = list.loadMore(fetchPage);
  assert.equal(a, b);
  assert.equal(list.state.loadingMore, true);
  gate.resolve();
  await a;
  assert.equal(calls, 1);
  assert.deepEqual(ids(list.state), [2, 1]);
  assert.equal(list.state.loadingMore, false);
});

test('PagedQuery: a refresh drops a "Load more" still on its way', async () => {
  const late = deferred();
  const list = new PagedQuery(null, { isOpen });
  list.edit(() => loaded([{ id: 2, status: 'pending' }], { cursor: 'c1' }));
  const more = list.loadMore(() => late.promise);
  const refresh = list.refresh(async () => ({ items: [{ id: 3 }, { id: 2, status: 'accepted' }], nextCursor: 'c2' }));
  assert.equal(list.state.loadingMore, false);
  await refresh;
  late.resolve({ items: [{ id: 1 }], nextCursor: null });
  assert.deepEqual(await more, { stale: true });
  assert.deepEqual(ids(list.state), [3, 2], 'the old page never lands');
  assert.equal(list.state.cursor, 'c2');
});

test('PagedQuery: only the newest refresh lands, and a failure keeps what was shown', async () => {
  const slow = deferred();
  const list = new PagedQuery();
  const first = list.refresh(() => slow.promise);
  const second = list.refresh(async () => ({ items: [{ id: 5 }], nextCursor: null }));
  assert.deepEqual(await second, { ok: true });
  slow.resolve({ items: [{ id: 4 }], nextCursor: null });
  assert.deepEqual(await first, { stale: true });
  assert.deepEqual(ids(list.state), [5]);

  const failure = Object.assign(new Error('HTTP 500'), { status: 500 });
  const result = await list.refresh(async () => { throw failure; });
  assert.equal(result.error, failure);
  assert.equal(list.state.error, failure);
  assert.deepEqual(ids(list.state), [5], 'a failed refresh is not an empty list');
  const aborted = await list.refresh(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
  assert.deepEqual(aborted, { stale: true });
});

test('PagedQuery.find waits for the first page and loads pages until the item turns up', async () => {
  const pages = {
    null: { items: [{ id: 30 }], nextCursor: 'c1' },
    c1: { items: [{ id: 20 }], nextCursor: 'c2' },
    c2: { items: [{ id: 10 }], nextCursor: null },
  };
  const fetchPage = async ({ cursor }) => pages[cursor];
  const list = new PagedQuery();
  list.refresh(fetchPage);
  const hit = await list.find(item => item.id === 20, fetchPage);
  assert.deepEqual(hit, { id: 20 });
  assert.deepEqual(ids(list.state), [30, 20], 'stops at the page that has it');
  assert.equal(await list.find(item => item.id === 99, fetchPage), null, 'searched to the end');
  assert.deepEqual(ids(list.state), [30, 20, 10]);

  const capped = new PagedQuery();
  capped.edit(() => loaded([{ id: 1 }], { cursor: 'c' }));
  let calls = 0;
  const endless = async () => { calls++; return { items: [{ id: 100 + calls }], nextCursor: 'c' }; };
  assert.equal(await capped.find(item => item.id === -1, endless, 3), null);
  assert.equal(calls, 3, 'gives up after maxPages');
});

test('PagedQuery.cancel retires whatever is in flight', async () => {
  const never = deferred();
  const list = new PagedQuery();
  const run = list.refresh(({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    never.promise.then(resolve);
  }));
  list.cancel();
  assert.equal(list.state.loading, false);
  assert.deepEqual(await run, { stale: true });
});
