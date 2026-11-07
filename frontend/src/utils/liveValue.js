// A value that changes many times a second and that only a few small components
// draw. Holding it in a component's state re-renders that whole component on
// every change; holding it here re-renders only the components that subscribe
// (components/scanner/useLiveValue.js).
//
// set() behaves like a React state setter so code can switch between the two
// without changing: it takes a value or an updater of the previous value, and an
// update that returns the same value (Object.is) notifies nobody.
export function createLiveValue(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    get: () => value,
    set: (next) => {
      const resolved = typeof next === 'function' ? next(value) : next;
      if (Object.is(resolved, value)) return;
      value = resolved;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
