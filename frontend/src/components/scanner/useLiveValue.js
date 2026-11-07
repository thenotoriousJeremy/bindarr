import { useSyncExternalStore } from 'react';

// Subscribe a component to a live value (utils/liveValue.js): it re-renders when
// the value changes, and nothing above it does.
export function useLiveValue(store) {
  return useSyncExternalStore(store.subscribe, store.get);
}
