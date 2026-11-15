// The app's one toast, kept outside React state so every screen reads the same
// thing: App shows it over the login screen and over the app alike, through
// components/Toast.jsx, and a test can set one before rendering
// (renderSmoke.test.js).
//
// A toast is { id, message, onAction?, actionLabel? }. Whatever reaches
// showToast is turned into that shape first: 1.9.0 stored a bare string in one
// place and rendered the whole object in another, and React throws on an
// object child, which blanked the page on every logout.

let current = null;
let nextId = 1;
const listeners = new Set();

// Text for a toast from whatever a caller had to hand: a string, an Error, or
// a server's { error } / { message } body.
function textOf(value) {
  if (value == null || value === false) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    if (typeof value.message === 'string') return value.message;
    if (typeof value.error === 'string') return value.error;
  }
  return '';
}

// showToast(message) or showToast(message, { onAction, actionLabel }); an
// object that already looks like a toast is taken as it is. Returns null when
// there is nothing to say.
export function normalizeToast(input, options) {
  const base = input && typeof input === 'object' && !(input instanceof Error) ? input : {};
  const message = textOf(input);
  if (!message) return null;
  const merged = { ...base, ...(options || {}) };
  const toast = { id: merged.id ?? null, message };
  if (typeof merged.onAction === 'function') {
    toast.onAction = merged.onAction;
    if (typeof merged.actionLabel === 'string' && merged.actionLabel) toast.actionLabel = merged.actionLabel;
  }
  return toast;
}

function emit() {
  listeners.forEach(fn => fn());
}

export function showToast(message, options) {
  const toast = normalizeToast(message, options);
  if (!toast) return;
  // A fresh id per toast, so the same text said twice replays its animation.
  current = { ...toast, id: nextId++ };
  emit();
}

// With an id, only that toast: a timer from an earlier toast must not close the
// one that replaced it.
export function dismissToast(id) {
  if (!current || (id != null && current.id !== id)) return;
  current = null;
  emit();
}

export const getToast = () => current;

export function subscribeToast(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
