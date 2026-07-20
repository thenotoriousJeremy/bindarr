import { useRef, useEffect } from 'react';

// Long-press gesture (mouse + touch via one set of pointer handlers). Fires
// onLongPress(arg) after `delay` ms unless the pointer moves more than `moveTol`
// px first (so it coexists with swipe/scroll). `fired` is a ref a follow-up
// click reads to swallow the press. Single source of truth for hold-to-select,
// shared by useMultiSelect and CompartmentView so every screen behaves the same.
// A null onLongPress disables arming (used where selection is optional).
export function useLongPress(onLongPress, { delay = 450, moveTol = 10, vibrate = 25 } = {}) {
  const timer = useRef(null);
  const fired = useRef(false);
  const start = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const begin = (e, arg) => {
    if (!onLongPress) return;
    fired.current = false;
    start.current = { x: e.clientX, y: e.clientY };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      fired.current = true;
      onLongPress(arg);
      if (vibrate && navigator.vibrate) navigator.vibrate(vibrate);
    }, delay);
  };
  const move = (e) => {
    if (!start.current) return;
    if (Math.abs(e.clientX - start.current.x) > moveTol || Math.abs(e.clientY - start.current.y) > moveTol) {
      clearTimeout(timer.current);
    }
  };
  const end = () => { clearTimeout(timer.current); start.current = null; };

  const handlers = (arg) => ({
    onPointerDown: (e) => begin(e, arg),
    onPointerMove: move,
    onPointerUp: end,
    onPointerLeave: end,
    onContextMenu: (e) => e.preventDefault(), // suppress mobile long-press image popup
  });

  return { handlers, fired };
}
