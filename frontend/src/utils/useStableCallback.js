import { useCallback, useLayoutEffect, useRef, useState } from 'react';

// A function whose identity never changes but which always calls the latest
// `fn`. For handlers passed to memoized tiles: an inline arrow is a new prop on
// every render, which would re-render every tile in the grid for nothing.
// Not for use during render — only in event handlers and effects.
export function useStableCallback(fn) {
  const ref = useRef(fn);
  useLayoutEffect(() => { ref.current = fn; });
  return useCallback((...args) => ref.current(...args), []);
}

// The same for a fixed set of named handlers at once: { name: fn } in, the same
// names out as stable wrappers. The set of names must not change between renders.
export function useStableHandlers(handlers) {
  const latest = useRef(handlers);
  useLayoutEffect(() => { latest.current = handlers; });
  const [stable] = useState(() => Object.fromEntries(
    Object.keys(handlers).map(name => [name, (...args) => latest.current[name](...args)])
  ));
  return stable;
}
