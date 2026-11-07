import { useEffect, useSyncExternalStore } from 'react';
import { wishlist } from './wishlist';

// The shared default-Wishlist store (utils/wishlist.js), read once on first use.
// Re-renders the caller whenever any heart changes; call wishlist.has(id) on
// the returned store.
export function useWishlist() {
  useSyncExternalStore(wishlist.subscribe, wishlist.getVersion);
  useEffect(() => { wishlist.load(); }, []);
  return wishlist;
}
