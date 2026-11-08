// A tab that stays open across an upgrade is still running the previous build,
// and every lazily loaded piece of it — each view, each locale, the name
// dictionaries — is a content-hashed file the new build replaced. The next one it
// asks for is gone, the import fails, and the view crashes, when a reload would
// simply have picked up the new build. So a failed chunk load reloads the page.
//
// Once. The timestamp in sessionStorage is the guard: a chunk that is still
// missing after the reload (a half-finished deploy, a proxy holding stale files)
// shows the error instead of reloading forever.

const KEY = 'bindarr_chunk_reload_at';

// Long enough that a slow reload on a phone cannot fail again outside it, short
// enough that a second upgrade later in the same tab still heals itself.
export const RELOAD_WINDOW_MS = 60 * 1000;

// The pure half: records a reload and returns true, or returns false when one
// already happened inside the window. No storage (blocked, private mode) also
// means false — an unguarded reload is exactly the loop this exists to prevent.
export function claimReload(storage, now, windowMs = RELOAD_WINDOW_MS) {
  try {
    const last = Number(storage.getItem(KEY));
    // A timestamp from the future (the clock was set back) is no evidence of a
    // recent reload; overwriting it keeps the guard working from here on.
    if (last && now >= last && now - last < windowMs) return false;
    storage.setItem(KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

// One reload per page, however many imports fail at once: the first failure
// claims it, and every later one is told it is already underway, so they wait
// for it rather than render an error. Offline is left alone, because there a
// reload only swaps the error for the browser's own offline page.
export function createChunkReloader({ storage, reload, isOnline = () => true, now = () => Date.now(), windowMs = RELOAD_WINDOW_MS }) {
  let pending = false;
  return function reloadOnce() {
    if (pending) return true;
    if (!isOnline()) return false;
    if (!claimReload(storage, now(), windowMs)) return false;
    pending = true;
    reload();
    return true;
  };
}

// The import half of a React.lazy view: when its chunk fails and a reload is
// underway, never settle, so Suspense keeps its spinner up until the new build
// arrives instead of the error boundary flashing a crash in between. Without a
// reload the error goes to the boundary as before.
export const reloadingImport = (factory, reloadOnce) => () => factory().catch((err) => {
  if (reloadOnce()) return new Promise(() => {});
  throw err;
});

let appReloader = null;

// The app's own reloader, created on first use because a node test has no window.
export function reloadForStaleBuild() {
  if (!appReloader) {
    let storage = null;
    try { storage = window.sessionStorage; } catch { /* blocked: no guard, so no reload */ }
    appReloader = createChunkReloader({
      storage,
      reload: () => window.location.reload(),
      isOnline: () => navigator.onLine !== false,
    });
  }
  return appReloader();
}
