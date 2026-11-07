// Pure decisions behind the shared <Modal>: where Tab moves focus inside a
// dialog, and whether a close request may go ahead. Kept free of React and the
// DOM so they can be tested with node:test.

// The <Modal>s currently open, topmost last. Shared so non-modal overlays (the
// quick-add drawers, see useEscape) can leave Esc to a dialog stacked on them.
export const openModals = [];

// Everything a keyboard user can land on. Hidden/disabled elements are dropped
// by the component after querying (see isTabbable in Modal.jsx).
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// Tab inside a dialog. `count` is the number of tabbable elements, `index` the
// position of the focused one (-1 when focus sits on the dialog itself or
// somewhere outside it). Returns the index to focus, -1 to focus the dialog
// container (nothing tabbable), or null to let the browser move focus normally.
export function trapTabTarget(count, index, shiftKey) {
  if (count <= 0) return -1;
  if (shiftKey) return index <= 0 ? count - 1 : null;
  return index === -1 || index >= count - 1 ? 0 : null;
}

// What a close request should do.
//   source:          'backdrop' | 'escape' | 'button'
//   dirty:           the dialog holds unsaved edits
//   closeOnBackdrop: false for edit dialogs that must never close on a stray click
// Returns 'close', 'confirm' (ask before discarding) or 'ignore'.
export function closeDecision({ source, dirty = false, closeOnBackdrop = true }) {
  if (source === 'backdrop' && !closeOnBackdrop) return 'ignore';
  if (source === 'button') return 'close';
  return dirty ? 'confirm' : 'close';
}
