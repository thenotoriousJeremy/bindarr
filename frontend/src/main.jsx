import React from 'react'
import ReactDOM from 'react-dom/client'
import './apiBase.js' // installs native fetch shim before any request
import './nativeInit.js' // Capacitor status-bar setup (no-op on web)
import { isNative, canRunOnDevice } from './apiBase.js'
import { registerServiceWorker } from './utils/registerSw.js'
import App from './App.jsx'
import { I18nProvider } from './utils/i18n.jsx'
import { reloadForStaleBuild } from './utils/chunkReload.js'
import './index.css'

// Vite raises this for every dynamic import that fails — a view, a locale, the
// name dictionaries. In a tab left open across an upgrade that is a chunk the
// new build removed, and one reload fixes it (guarded in chunkReload.js). Not
// preventDefault()ed: the import still rejects, so its own error handling runs
// whenever the guard decides against reloading.
window.addEventListener('vite:preloadError', () => { reloadForStaleBuild() })

// Demo build (GitHub Pages): install the fixture-backed fetch shim and seed a
// fake session BEFORE first render. Guard is a static env check, so a normal
// build tree-shakes the whole ./demo chunk out.
if (import.meta.env.VITE_DEMO) {
  await import('./demo/install.js')
}

// Offline shell + read-only cache on a production web build (utils/registerSw.js).
registerServiceWorker({ native: isNative, device: canRunOnDevice, env: import.meta.env })

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
)
