// Request primitives behind useApi, kept free of React so they can be tested
// with node:test.
//
// The app grew ~150 bare fetch() calls, and three things went wrong with them
// again and again: a slow response arriving after a newer one overwrote it (type
// "pika", then "pikachu", and get the "pika" results), a refetch blanked
// whatever was on screen until it came back, and leaving a view left its
// requests running. LatestRequest answers the first and third; QueryCore adds
// the second, plus optimistic edits that roll back on failure.

export const isAbortError = (err) => err?.name === 'AbortError';

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

// fetch → JSON, throwing ApiError (with the server's { error } as the message)
// on a non-2xx. Returns the Response too, for callers that read headers.
export async function fetchJson(url, { signal, fetchImpl = fetch, ...init } = {}) {
  const res = await fetchImpl(url, { ...init, signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return { data: body, res };
}

// Only the newest request counts. begin() aborts the one before it and hands
// back a signal for fetch plus isLatest(), which a caller checks after every
// await before it touches state: an aborted fetch rejects, but a response that
// was already parsed by the time the next request began does not.
export class LatestRequest {
  constructor() {
    this.seq = 0;
    this.controller = null;
  }

  begin() {
    if (this.controller) this.controller.abort();
    const controller = new AbortController();
    this.controller = controller;
    const id = ++this.seq;
    return {
      signal: controller.signal,
      isLatest: () => id === this.seq && !controller.signal.aborted,
    };
  }

  // Abort whatever is in flight and make sure nothing already begun can land.
  cancel() {
    this.seq++;
    if (this.controller) this.controller.abort();
    this.controller = null;
  }
}

const IDLE = Object.freeze({ data: undefined, error: null, loading: false, refreshing: false });

// One query's state machine.
//
//   run(fetcher)   latest-wins; while it runs, data already on screen stays put
//                  (refreshing: true) and only a first load reports loading.
//                  The fetcher gets { signal, hasData, push }: push(partial)
//                  shows part of the answer early, e.g. the first page of a
//                  long list, and is ignored once a newer run has begun.
//   mutate(fn)     replace data locally.
//   optimistic(fn, commit)
//                  apply fn now, await commit(); on failure put the old data
//                  back, unless something newer has replaced it meanwhile.
export class QueryCore {
  constructor(onChange, initialData) {
    this.onChange = onChange;
    this.latest = new LatestRequest();
    this.version = 0;
    this.state = { ...IDLE, data: initialData };
  }

  set(patch) {
    if ('data' in patch && patch.data !== this.state.data) this.version++;
    this.state = { ...this.state, ...patch };
    if (this.onChange) this.onChange(this.state);
  }

  async run(fetcher) {
    const req = this.latest.begin();
    const hasData = this.state.data !== undefined;
    this.set({ loading: !hasData, refreshing: hasData, error: null });
    const push = (partial) => {
      if (req.isLatest()) this.set({ data: partial, loading: false, refreshing: true });
    };
    try {
      const data = await fetcher({ signal: req.signal, hasData, push });
      if (!req.isLatest()) return { stale: true };
      this.set({ data, loading: false, refreshing: false });
      return { data };
    } catch (error) {
      if (!req.isLatest() || isAbortError(error)) return { stale: true };
      // Keep whatever was showing: a failed refresh is not an empty list.
      this.set({ error, loading: false, refreshing: false });
      return { error };
    }
  }

  mutate(updater) {
    const next = typeof updater === 'function' ? updater(this.state.data) : updater;
    this.set({ data: next });
    return next;
  }

  async optimistic(updater, commit) {
    const before = this.state.data;
    this.mutate(updater);
    const applied = this.version;
    try {
      return await commit();
    } catch (err) {
      if (this.version === applied) this.set({ data: before });
      throw err;
    }
  }

  cancel() {
    this.latest.cancel();
    if (this.state.loading || this.state.refreshing) this.set({ loading: false, refreshing: false });
  }
}

// A small LRU of the last answers by key, so a view that unmounts and comes
// back paints its previous data at once and revalidates behind it.
export class ResponseCache {
  constructor(limit = 30) {
    this.limit = limit;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
  }

  clear() { this.map.clear(); }
}
