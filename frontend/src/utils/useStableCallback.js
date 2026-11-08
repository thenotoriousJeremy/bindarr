import { useCallback, useLayoutEffect, useRef } from 'react';

// A function whose identity never changes but which always calls the latest
// `fn`. For handlers passed to memoized tiles: an inline arrow is a new prop on
// every render, which would re-render every tile in the grid for nothing.
// Not for use during render — only in event handlers and effects.
export function useStableCallback(fn) {
  const ref = useRef(fn);
  useLayoutEffect(() => { ref.current = fn; });
  return useCallback((...args) => ref.current(...args), []);
}
