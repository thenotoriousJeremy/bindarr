import { useCallback, useEffect, useRef, useState } from 'react';
import { QueryCore, ResponseCache, fetchJson } from './request.js';

// Shared across mounts. Cleared on logout by App (clearApiCache), so one
// account's answers never paint under the next.
const cache = new ResponseCache(30);
export const clearApiCache = () => cache.clear();

// A latest-wins, stale-while-revalidate data hook. Deliberately tiny: no
// global invalidation, no retries, no polling.
//
//   const { data, error, loading, refreshing, refetch, mutate, optimistic } =
//     useApi(key, fetcher, { enabled, deps });
//
// `key` names the answer (it is the cache key; null disables the query).
// `fetcher({ signal, hasData, push })` returns the data; when omitted, key is
// fetched as a JSON URL. The query re-runs when key, enabled or any of `deps`
// changes (statsTrigger, say); the previous data stays on screen meanwhile
// (`refreshing`), and only a first load with nothing to show is `loading`.
// Unmounting aborts whatever is in flight.
export function useApi(key, fetcher, { enabled = true, deps = [] } = {}) {
  const [state, setState] = useState(() => ({
    data: key != null ? cache.get(key) : undefined, error: null, loading: false, refreshing: false,
  }));
  const coreRef = useRef(null);
  if (!coreRef.current) coreRef.current = new QueryCore(setState, state.data);
  const core = coreRef.current;

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refetch = useCallback(async () => {
    if (key == null) return { stale: true };
    const fn = fetcherRef.current || (async ({ signal }) => (await fetchJson(key, { signal })).data);
    const result = await core.run(fn);
    if (result && 'data' in result) cache.set(key, result.data);
    return result;
  }, [core, key]);

  const depsKey = deps.map(String).join('|');
  useEffect(() => {
    if (!enabled || key == null) return;
    // A key with an answer already cached shows it while it revalidates.
    const cached = cache.get(key);
    if (cached !== undefined && cached !== core.state.data) core.mutate(cached);
    refetch();
  }, [core, key, enabled, depsKey, refetch]);

  useEffect(() => () => core.cancel(), [core]);

  const mutate = useCallback((updater) => {
    const next = core.mutate(updater);
    if (key != null) cache.set(key, next);
    return next;
  }, [core, key]);
  const optimistic = useCallback((updater, commit) => core.optimistic(updater, commit), [core]);

  return { ...state, refetch, mutate, optimistic };
}
