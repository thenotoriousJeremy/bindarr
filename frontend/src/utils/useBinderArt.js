import { useCallback, useEffect, useRef, useState } from 'react';

const revokeAll = (srcs) => Object.values(srcs).forEach(u => URL.revokeObjectURL(u));

// The artwork layers on one of the signed-in user's binders, plus a blob URL
// for each picture. The images sit behind the bearer token, which an <img src>
// cannot send, so each one is fetched (through the app's auth-aware fetch) and
// handed to the page as an object URL. The previous set is revoked only once
// its replacement is showing, so a reload after saving does not flash empty.
export function useBinderArt(locationId, enabled) {
  const [state, setState] = useState({ layers: [], srcs: {} });
  const [nonce, setNonce] = useState(0);
  const live = useRef({});
  const reload = useCallback(() => setNonce(n => n + 1), []);

  useEffect(() => {
    if (!enabled || !locationId) {
      revokeAll(live.current);
      live.current = {};
      setState({ layers: [], srcs: {} });
      return undefined;
    }
    let stop = false;
    const fresh = {};
    (async () => {
      try {
        const res = await fetch(`/api/locations/${locationId}/binder-art`);
        if (!res.ok || stop) return;
        const { layers = [] } = await res.json();
        for (const id of new Set(layers.map(l => l.artwork_id))) {
          const img = await fetch(`/api/binder-art/${id}/image`);
          if (stop) break;
          if (img.ok) fresh[id] = URL.createObjectURL(await img.blob());
        }
        if (stop) {
          revokeAll(fresh);
          return;
        }
        revokeAll(live.current);
        live.current = fresh;
        setState({ layers, srcs: fresh });
      } catch (err) {
        // Artwork is decoration: a failed load leaves the binder showing cards.
        revokeAll(fresh);
        console.warn('Binder artwork did not load', err);
      }
    })();
    return () => { stop = true; };
  }, [locationId, enabled, nonce]);

  // The latest set, on unmount: the ref is read at cleanup time on purpose.
  useEffect(() => {
    const holder = live;
    return () => revokeAll(holder.current);
  }, []);

  return { layers: state.layers, srcs: state.srcs, reload };
}
