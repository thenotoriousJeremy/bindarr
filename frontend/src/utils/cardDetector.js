// Local card detection for the live preview, run on a worker thread.
//
// The detector is cornelius, run in-browser via onnxruntime-web — the SAME
// corner model the server dewarps with before embedding — so the outline on
// screen and the crop the scan uses cannot disagree. The model is fetched once
// from the backend (~4.2 MB, immutably cached) and then it is local arithmetic;
// no frame ever crosses the network.
//
// Why local: the previous version posted a JPEG per preview frame, roughly
// 2.7 MB per minute of pointing the camera at a card. Wasteful anywhere,
// unacceptable on a metered connection, and detection is pure arithmetic over a
// small array — there was never a good reason for it to cross the network.
//
// Why a worker: detection is ~80ms on a desktop and ~300ms on a phone. On the
// main thread that is a third of a second per frame with no rendering, no touch
// handling and no animation, which is what made the camera freeze the app.
import { isNative, getServerUrl } from '../apiBase';
import { modelUrl } from './detectorModel.js';

// Matches cornelius's 384x384 input, so the preview frame is fed at the model's
// native resolution instead of being upscaled inside the worker.
export const DETECT_W = 384;

let worker = null;
let pending = false;
let seq = 0;
// The worker itself failed to load. No engine can answer, so stop submitting
// frames into it; the caller offers a manual capture instead.
let dead = false;

// The model is fetched HERE, on the main thread, and handed to the worker —
// never by the worker itself. In the native app a worker's relative fetch
// resolves to the bundled assets (no /models there), and neither the apiBase
// rewrite nor CapacitorHttp applies inside a worker at all, so even an absolute
// URL would be a plain cross-origin fetch at the mercy of CORS. The main-thread
// fetch goes through CapacitorHttp's native proxy instead. (#80)
let modelPromise = null;

async function fetchModel() {
  const url = modelUrl(isNative, getServerUrl());
  // Native only: CapacitorHttp bypasses the WebView's HTTP cache, so without this
  // every scanner open re-downloads ~3 MB. The web revalidates through the
  // server's no-cache + ETag headers instead.
  //
  // The cached copy is checked against the server with a HEAD first. It used to
  // be trusted forever, which is how phones kept running the old cornelius model
  // long after their server had switched to fastweb-single. Offline, or with a
  // HEAD the server will not answer, the cached copy is still used.
  let cache = null;
  if (isNative) {
    try {
      cache = await caches.open('bindarr-models');
      const hit = await cache.match(url);
      if (hit) {
        let serverTag = null;
        try {
          const head = await fetch(url, { method: 'HEAD' });
          if (head.ok) serverTag = head.headers.get('etag') || head.headers.get('content-length');
        } catch { /* unreachable: use the cached copy */ }
        if (!serverTag || serverTag === hit.headers.get('x-model-tag')) return await hit.arrayBuffer();
      }
    } catch { cache = null; }
  }
  const res = await fetch(url);
  const type = res.headers.get('content-type') || '';
  // A SPA catch-all answers 200 with index.html; ORT would then fail deep inside
  // a protobuf parse with a message that names nothing useful.
  if (!res.ok || type.includes('text/html')) {
    throw new Error(`${url} not served (${res.status} ${type || 'no type'})`);
  }
  const buf = await res.arrayBuffer();
  if (cache) {
    // Same tag the HEAD above reads: the ETag, or the size when a proxy strips it.
    const tag = res.headers.get('etag') || String(buf.byteLength);
    cache.put(url, new Response(buf.slice(0), { headers: { 'x-model-tag': tag } })).catch(() => {});
    // Copies stored under the old, un-versioned URL are never read again.
    cache.keys().then(keys => keys.filter(k => k.url !== url).forEach(k => cache.delete(k))).catch(() => {});
  }
  return buf;
}

function loadModel() {
  if (!modelPromise) {
    modelPromise = fetchModel().catch((err) => {
      modelPromise = null;   // retried on the next scanner open, not every frame
      throw err;
    });
  }
  return modelPromise;
}

function ensureWorker(onResult) {
  if (worker) return worker;
  const wk = new Worker(new URL('./detectWorker.js', import.meta.url), { type: 'module' });
  worker = wk;
  // Frames posted before this lands wait inside the worker for it. The model is
  // cloned, not transferred: the next scanner open's worker needs it again.
  loadModel().then(
    (model) => wk.postMessage({ init: { model } }),
    (err) => {
      console.error('[cardDetector] Detector model unavailable, using the contour fallback:', err.message);
      wk.postMessage({ init: { model: null, error: err.message } });
    },
  );
  wk.onmessage = (e) => {
    pending = false;
    onResult(e.data);
  };
  // Answer even when the worker itself blew up. The caller paces off results —
  // a silent error would stop the detection loop dead, and the outline would
  // simply freeze with no way to tell that from "no card".
  wk.onerror = (e) => {
    console.error('[cardDetector] Worker error event:', e);
    pending = false;
    dead = true;
    onResult({ seq, detected: false, engine: 'none', fatal: true, error: e?.message || 'detect worker failed' });
  };
  return wk;
}

// Submit a canvas for detection. Returns false if a frame is already in flight —
// the caller should simply skip, not queue: a queue of stale frames is worse than
// a lower frame rate, because every result would describe a scene that has moved.
export function requestDetect(canvas, onResult) {
  const w = canvas.width, h = canvas.height;
  if (!w || !h) return false;
  if (pending || dead) return false;
  const wk = ensureWorker(onResult);
  // getImageData allocates a fresh buffer every call, so it is simply transferred
  // (zero-copy) rather than copied into a recycled one — that copy was pure extra
  // work on top of an allocation that happened anyway.
  const bytes = canvas.getContext('2d').getImageData(0, 0, w, h).data.buffer;
  pending = true;
  seq += 1;
  wk.postMessage({ buf: bytes, w, h, seq }, [bytes]);
  return true;
}

export function stopDetect() {
  if (worker) { worker.terminate(); worker = null; }
  pending = false;
  dead = false;
}

// Exponential smoothing of the quad between detections.
//
// Raw per-frame detections jitter a few pixels even on a still card, which reads
// as an unstable, untrustworthy outline. Easing toward each new result makes it
// glide — and the drift between RAW results is the cheapest available measure of
// whether the card has actually stopped moving.
// alpha was 0.45 against the contour detector, whose raw quads jittered several
// pixels frame to frame. Cornelius is far steadier (0 collapse cases in its own
// rotation stress), so that much easing buys nothing and costs everything: at
// ~70ms per detection, converging over four frames is a visibly late outline.
// Two frames is enough to take the jitter off without the box trailing the card.
export function smoothQuad(prev, next, alpha = 0.75) {
  if (!prev || prev.length !== 4 || !next || next.length !== 4) return next;
  return next.map((p, i) => ({
    x: prev[i].x + (p.x - prev[i].x) * alpha,
    y: prev[i].y + (p.y - prev[i].y) * alpha,
  }));
}

// MEAN corner movement between two quads, in normalised units. The steadiness gate
// wants an average: a single noisy corner should not reset the steady-frame count
// on an otherwise motionless card. autoCapture.worstCornerDrift is the other
// metric, with its own threshold — the two are not interchangeable.
export function meanCornerDrift(a, b) {
  if (!a || !b || a.length !== 4 || b.length !== 4) return Infinity;
  return a.reduce((s, p, i) => s + Math.hypot(p.x - b[i].x, p.y - b[i].y), 0) / 4;
}
