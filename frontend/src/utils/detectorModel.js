// Where the live detector's model is fetched from.
//
// Pure on purpose: cardDetector owns the worker and the network, this owns the
// one decision that broke the native app (issue #80) and is worth a test.

// The query is a one-time cache bust, ignored by the server. Until 1.8.9 this URL
// was served `immutable` for 30 days (and cached forever in the native app), so a
// device that loaded the old cornelius model never saw fastweb-single replace it.
// A new URL is the only thing that reaches those caches; from here on the server
// sends `no-cache` and an ETag, so a future model swap needs no new query.
export const MODEL_PATH = '/models/cornelius.onnx?v=2';

// The model lives on the Bindarr server. On the web that is the page's own
// origin, so the relative path is right. In the native app the page's origin is
// the BUNDLED assets, which have no /models route — the SPA fallback answers with
// index.html, and the scanner silently dropped to the ~1 fps contour detector.
export function modelUrl(native, serverUrl) {
  return native ? `${serverUrl || ''}${MODEL_PATH}` : MODEL_PATH;
}
