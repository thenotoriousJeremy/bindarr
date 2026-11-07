import { useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { getNav } from './router';

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

// The stack itself, and the history bookkeeping that keeps Forward from acting
// like Back when guards are stacked, live in utils/navHistory.js, shared with the
// app's URL routes (utils/router.js).

// Capacitor Android: drive the hardware back button through the same history.
// If there is anywhere to go back to -- an open popup, or an earlier tab or deck
// -- step back one entry (fires popstate -> closes the topmost popup / shows the
// previous view); otherwise let the app exit.
if (Capacitor.isNativePlatform()) {
  CapacitorApp.addListener('backButton', () => {
    if (getNav().canGoBack()) window.history.back();
    else CapacitorApp.exitApp();
  });
}

// Push a guard entry: a back gesture pops it and runs onClose instead of
// leaving the page / exiting the app. Returns a disposer that removes the
// guard and consumes its history entry (for programmatic close via button).
export function pushBackGuard(onClose) {
  return getNav().pushGuard(onClose);
}

export function useBackGuard(isOpen, onClose) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    return pushBackGuard(() => onCloseRef.current && onCloseRef.current());
  }, [isOpen]);
}
