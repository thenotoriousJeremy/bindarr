// The display currency and the ECB rates, as one hook every price display shares.
//
// The rates are fetched once per page load (GET /api/fx is public, so a shared
// collection gets them too) and kept at module level; they change once a day.
// The display currency stays a localStorage preference (formatPrice.js): it is a
// per-device display choice like the theme, it works on public share pages with
// no account to store it on, and it keeps the server's own totals in a currency
// the client names per request (?currency=) rather than one stored per user.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getCurrency } from './formatPrice.js';
import { displayPrice } from './convertPrice.js';

let fxState = null;
let inflight = null;
const listeners = new Set();

export function loadFx() {
  if (fxState || inflight) return inflight;
  inflight = fetch('/api/fx')
    .then(res => (res.ok ? res.json() : null))
    .then(body => {
      if (body && body.rates) {
        fxState = body;
        listeners.forEach(l => l());
      }
    })
    .catch(() => { /* no rates: prices stay as quoted */ })
    .finally(() => { inflight = null; });
  return inflight;
}

const subscribeFx = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };
const getFx = () => fxState;

const subscribeCurrency = (cb) => {
  window.addEventListener('bindarr_currency_change', cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener('bindarr_currency_change', cb);
    window.removeEventListener('storage', cb);
  };
};

export function useFx() {
  const fx = useSyncExternalStore(subscribeFx, getFx);
  const currency = useSyncExternalStore(subscribeCurrency, getCurrency);
  useEffect(() => { loadFx(); }, []);
  // (amount, rowCurrency) -> the displayPrice result, in the display currency.
  const show = useCallback((amount, from) => displayPrice(amount, from, currency, fx), [currency, fx]);
  return { fx, currency, show };
}
