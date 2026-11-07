import test from 'node:test';
import assert from 'node:assert/strict';
import { LatestRequest, QueryCore, ResponseCache, fetchJson, ApiError, isAbortError } from './request.js';

// A promise resolved from outside, so a test decides the order responses land in.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Stand-in for fetch(): rejects with AbortError when the signal fires, the way
// the real one does.
const abortable = (signal, promise) => new Promise((resolve, reject) => {
  signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  promise.then(resolve, reject);
});

test('LatestRequest aborts the previous request and only the newest is latest', () => {
  const latest = new LatestRequest();
  const a = latest.begin();
  assert.equal(a.isLatest(), true);
  const b = latest.begin();
  assert.equal(a.signal.aborted, true, 'starting b aborts a');
  assert.equal(a.isLatest(), false);
  assert.equal(b.isLatest(), true);
  latest.cancel();
  assert.equal(b.signal.aborted, true);
  assert.equal(b.isLatest(), false, 'cancel retires the request in flight too');
});

test('QueryCore: a slow first response cannot overwrite a newer one', async () => {
  const core = new QueryCore();
  const slow = deferred();
  const fast = deferred();
  // Ignores its signal on purpose: a response already parsed when the next
  // request begins cannot be aborted, and must still not land.
  const first = core.run(() => slow.promise);
  const second = core.run(() => fast.promise);
  fast.resolve('pikachu');
  assert.deepEqual(await second, { data: 'pikachu' });
  slow.resolve('pika');
  assert.deepEqual(await first, { stale: true });
  assert.equal(core.state.data, 'pikachu');
  assert.equal(core.state.loading, false);
  assert.equal(core.state.refreshing, false);
});

test('QueryCore: starting a new run aborts the old fetch, and the abort is not an error', async () => {
  const core = new QueryCore();
  let firstSignal;
  const never = deferred();
  const first = core.run(({ signal }) => { firstSignal = signal; return abortable(signal, never.promise); });
  const second = core.run(async () => 'b');
  assert.equal(firstSignal.aborted, true);
  assert.deepEqual(await first, { stale: true });
  await second;
  assert.equal(core.state.error, null);
  assert.equal(core.state.data, 'b');
});

test('QueryCore: a refetch keeps the old data on screen until the new data arrives', async () => {
  const seen = [];
  const core = new QueryCore((s) => seen.push({ ...s }));
  await core.run(async () => ['a']);
  const next = deferred();
  const run = core.run(() => next.promise);
  assert.deepEqual(core.state.data, ['a'], 'stale data stays while revalidating');
  assert.equal(core.state.refreshing, true);
  assert.equal(core.state.loading, false, 'loading is only for a first load with nothing to show');
  next.resolve(['a', 'b']);
  await run;
  assert.deepEqual(core.state.data, ['a', 'b']);
  assert.equal(seen[0].loading, true, 'the very first run did report loading');
});

test('QueryCore: a failed refetch keeps the data and reports the error', async () => {
  const core = new QueryCore();
  await core.run(async () => 'kept');
  const result = await core.run(async () => { throw new ApiError(500, { error: 'boom' }); });
  assert.equal(result.error.message, 'boom');
  assert.equal(core.state.data, 'kept');
  assert.equal(core.state.error.status, 500);
});

test('QueryCore: push shows a partial answer, but not from a superseded run', async () => {
  const core = new QueryCore();
  const gate = deferred();
  let pushOld;
  const old = core.run(({ push }) => { pushOld = push; return gate.promise; });
  const fresh = deferred();
  const current = core.run(({ push }) => { push(['first page']); return fresh.promise; });
  assert.deepEqual(core.state.data, ['first page']);
  pushOld(['old page']);
  assert.deepEqual(core.state.data, ['first page'], 'a superseded run cannot push');
  fresh.resolve(['first page', 'rest']);
  gate.resolve('old');
  await Promise.all([old, current]);
  assert.deepEqual(core.state.data, ['first page', 'rest']);
});

test('QueryCore.optimistic applies at once and rolls back on failure', async () => {
  const core = new QueryCore(null, [1, 2, 3]);
  const commit = deferred();
  const pending = core.optimistic(rows => rows.filter(r => r !== 2), () => commit.promise);
  assert.deepEqual(core.state.data, [1, 3], 'the edit shows before the server answers');
  commit.reject(new Error('nope'));
  await assert.rejects(pending, /nope/);
  assert.deepEqual(core.state.data, [1, 2, 3], 'and is undone when it fails');

  const ok = await core.optimistic(rows => [...rows, 4], async () => 'saved');
  assert.equal(ok, 'saved');
  assert.deepEqual(core.state.data, [1, 2, 3, 4]);
});

test('QueryCore.optimistic does not roll back over data that arrived meanwhile', async () => {
  const core = new QueryCore(null, ['a', 'b']);
  const commit = deferred();
  const pending = core.optimistic(rows => rows.slice(1), () => commit.promise);
  await core.run(async () => ['fresh from the server']);
  commit.reject(new Error('nope'));
  await assert.rejects(pending);
  assert.deepEqual(core.state.data, ['fresh from the server']);
});

test('QueryCore.cancel aborts the run in flight and clears the busy flags', async () => {
  const core = new QueryCore();
  let signal;
  const run = core.run(({ signal: s }) => { signal = s; return abortable(s, new Promise(() => {})); });
  core.cancel();
  assert.equal(signal.aborted, true);
  assert.deepEqual(await run, { stale: true });
  assert.equal(core.state.loading, false);
});

test('fetchJson throws ApiError carrying the server message, and passes the signal', async () => {
  let gotSignal;
  const fetchImpl = async (url, init) => {
    gotSignal = init.signal;
    return url === '/ok'
      ? { ok: true, status: 200, json: async () => ({ a: 1 }) }
      : { ok: false, status: 404, json: async () => ({ error: 'Not here' }) };
  };
  const controller = new AbortController();
  const { data } = await fetchJson('/ok', { signal: controller.signal, fetchImpl });
  assert.deepEqual(data, { a: 1 });
  assert.equal(gotSignal, controller.signal);
  await assert.rejects(fetchJson('/missing', { fetchImpl }), (err) => err instanceof ApiError && err.status === 404 && err.message === 'Not here');
  assert.equal(isAbortError({ name: 'AbortError' }), true);
});

test('ResponseCache keeps the most recently used entries', () => {
  const cache = new ResponseCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a');
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined, 'b was least recently used');
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
});
