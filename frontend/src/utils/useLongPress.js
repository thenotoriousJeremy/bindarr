import { useRef, useEffect, useCallback } from 'react';

// Long-press gesture (mouse + touch via one set of pointer handlers). Fires
// onLongPress(arg) after `delay` ms unless the pointer moves more than `moveTol`
// px first (so it coexists with swipe/scroll). `fired` is a ref a follow-up
// click reads to swallow the press. Single source of truth for hold-to-select,
// shared by useMultiSelect and CompartmentView so every screen behaves the same.
// A null onLongPress disables arming (used where selection is optional).
//
// `handlers` keeps one identity for the life of the component, reading the
// latest options through a ref, so a memoized tile that receives it is not
// re-rendered by every render of the grid around it.
export function useLongPress(onLongPress, { delay = 450, moveTol = 10, vibrate = 25 } = {}) {
  const timer = useRef(null);
  const fired = useRef(false);
  const start = useRef(null);
  const opts = useRef(null);
  opts.current = { onLongPress, delay, moveTol, vibrate };

  useEffect(() => () => clearTimeout(timer.current), []);

  const handlers = useCallback((arg) => {
    const begin = (e) => {
      if (!opts.current.onLongPress) return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const { onLongPress: fire, vibrate: buzz } = opts.current;
        fired.current = true;
        if (fire) fire(arg);
        if (buzz && navigator.vibrate) navigator.vibrate(buzz);
      }, opts.current.delay);
    };
    const move = (e) => {
      if (!start.current) return;
      const tol = opts.current.moveTol;
      if (Math.abs(e.clientX - start.current.x) > tol || Math.abs(e.clientY - start.current.y) > tol) {
        clearTimeout(timer.current);
      }
    };
    const end = () => { clearTimeout(timer.current); start.current = null; };
    return {
      onPointerDown: begin,
      onPointerMove: move,
      onPointerUp: end,
      onPointerLeave: end,
      onContextMenu: (e) => e.preventDefault(), // suppress mobile long-press image popup
    };
  }, []);

  return { handlers, fired };
}
