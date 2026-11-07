import { Capacitor } from '@capacitor/core';

// Web build is served same-origin as the API, so relative `/api/...` paths work
// untouched. A native app (Capacitor) has no server origin of its own, so it
// runs one of two ways:
//   - server mode: the user points it at their OWN self-hosted Bindarr. We store
//     that URL and prepend it to every `/api` request; CapacitorHttp (see
//     capacitor.config) routes these through native HTTP, sidestepping WebView
//     CORS entirely.
//   - device mode: no server at all. Every `/api` request is answered inside the
//     app by the bundled backend over an on-device SQLite database (src/device).

const KEY = 'bindarr_server';
const MODE_KEY = 'bindarr_mode';

export const isNative = Capacitor.isNativePlatform();
// Device mode needs the native SQLite plugin, so it is offered in the app. The
// one exception is the web dev harness (VITE_DEVICE_WEB=1 npm run dev), which
// runs the plugin's IndexedDB build so the mode can be exercised in a browser.
export const canRunOnDevice = isNative || !!import.meta.env.VITE_DEVICE_WEB;
export const isDeviceMode = () => canRunOnDevice && localStorage.getItem(MODE_KEY) === 'device';
export const setDeviceMode = (on) => {
  if (on) localStorage.setItem(MODE_KEY, 'device');
  else localStorage.removeItem(MODE_KEY);
};
export const getServerUrl = () => localStorage.getItem(KEY) || '';
export const setServerUrl = (url) =>
  localStorage.setItem(KEY, url.trim().replace(/\/+$/, ''));
export const needsServerUrl = () => isNative && !isDeviceMode() && !getServerUrl();

if (canRunOnDevice) {
  const orig = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/api')) {
      // Chosen per request, not once at load: the login screen switches modes
      // without a reload.
      if (isDeviceMode()) return import('./device/runtime.js').then(m => m.deviceFetch(input, init));
      if (isNative) input = getServerUrl() + input;
    }
    return orig(input, init);
  };
}
