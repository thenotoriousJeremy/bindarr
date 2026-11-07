import { useCallback, useLayoutEffect, useRef, useState } from 'react';

// A function whose identity never changes but which always runs the latest
// render's version of `fn`. For event handlers handed to memoized children: a new
// arrow every render would re-render the child every time the parent renders,
// which is what memoizing it was meant to stop. Only for handlers called from
// events, never during render (the ref is updated after render commits).
export function useStableCallback(fn) {
  const latest = useRef(fn);
  useLayoutEffect(() => { latest.current = fn; });
  return useCallback((...args) => latest.current(...args), []);
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
