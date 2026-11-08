import { useEffect, useRef } from 'react';
import { openModals } from './modalBehavior.js';

// Keyboard parity for elements that can't be a real <button> (they hold other
// controls, or a button would break the layout). Pair with role="button" and
// tabIndex={0}: Enter and Space then activate it the way they would a button.
// Keys pressed inside a nested control (an input, a child button) are left to
// that control.
export const onActivateKey = (handler) => (e) => {
  if (e.target !== e.currentTarget) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    handler(e);
  }
};

// Esc closes a non-modal overlay (the quick-add drawers) while it is open --
// the keyboard twin of tapping its backdrop. A <Modal> stacked on top of it
// takes Esc first.
export function useEscape(active, onEscape) {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented && openModals.length === 0) ref.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
}
