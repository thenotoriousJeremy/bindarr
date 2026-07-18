import { useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';

// Make the back gesture (browser edge-swipe, Android system back) mean
// "close the topmost popup / go back a level" instead of leaving the page or
// exiting the app.
//
// How: when an overlay opens we push a throwaway history entry. A back gesture
// pops that entry (fires `popstate`) and we run the overlay's close handler
// rather than navigating away. Closing via a button/backdrop instead consumes
// the pushed entry with history.back() so history never accumulates.
//
// Web: the edge-swipe / browser back fires popstate, so guarding history is
// enough. Capacitor Android is different -- the native back gesture checks the
// WebView's own page history (canGoBack), which does NOT see pushState entries,
// so it would exit the app instead of firing popstate. We bridge that below via
// @capacitor/app's backButton event, routing it through the same guard stack.

const stack = []; // { close } entries, topmost last
let ignorePops = 0; // pops we triggered ourselves (programmatic close)
let listening = false;

function onPopState() {
  if (ignorePops > 0) {
    ignorePops--;
    return;
  }
  const entry = stack.pop();
  if (entry) entry.close(); // its guard state was just consumed by this back
}

// Capacitor Android: drive the hardware back button through the guard stack.
// If anything is open, step back one history entry (fires popstate -> closes
// the topmost overlay/tab); otherwise let the app exit.
if (Capacitor.isNativePlatform()) {
  CapacitorApp.addListener('backButton', () => {
    if (stack.length > 0) window.history.back();
    else CapacitorApp.exitApp();
  });
}

// Push a guard entry: a back gesture pops it and runs onClose instead of
// leaving the page / exiting the app. Returns a disposer that removes the
// guard and consumes its history entry (for programmatic close via button).
export function pushBackGuard(onClose) {
  if (!listening) {
    window.addEventListener('popstate', onPopState);
    listening = true;
  }
  const entry = { close: onClose };
  stack.push(entry);
  window.history.pushState({ backGuard: true }, '');

  return () => {
    const i = stack.indexOf(entry);
    if (i === -1) return; // already popped by a back gesture
    stack.splice(i, 1);
    ignorePops++;
    window.history.back();
  };
}

export function useBackGuard(isOpen, onClose) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    return pushBackGuard(() => onCloseRef.current && onCloseRef.current());
  }, [isOpen]);
}
