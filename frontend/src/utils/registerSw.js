// Registers /sw.js (built by scripts/swPlugin.mjs) where it belongs: a
// production web build. Not in the native apps, which load the bundle from the
// device already and point their API at a server of the user's choosing (or
// answer it on the device), not wherever device mode can run (the native apps
// and the VITE_DEVICE_WEB harness, where /api never reaches a server), not in
// the demo (served from a sub-path with a fixture fetch shim), and not in dev,
// where a cached shell would fight Vite's hot reload.
export function shouldRegisterSw({ native, device, prod, demo, supported }) {
  return !native && !device && !!prod && !demo && !!supported;
}

export function registerServiceWorker({ native, device, env }) {
  const supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  if (!shouldRegisterSw({ native, device, prod: env.PROD, demo: env.VITE_DEMO, supported })) return;
  // After load, so the worker's precache downloads never compete with the
  // first paint.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.warn('Service worker registration failed:', err));
  });
}
