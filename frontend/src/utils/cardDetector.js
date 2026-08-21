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
// Matches cornelius's 384x384 input, so the preview frame is fed at the model's
// native resolution instead of being upscaled inside the worker.
export const DETECT_W = 384;

let worker = null;
let pending = false;
let seq = 0;
// The pixel buffer is transferred to the worker and handed straight back, so one
// allocation serves the whole session instead of one per frame.
let spare = null;

function ensureWorker(onResult) {
  if (worker) return worker;
  worker = new Worker(new URL('./detectWorker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    pending = false;
    const { buf, ...result } = e.data;
    spare = buf;                 // reclaim the buffer for the next frame
    onResult(result);
  };
  // Answer even when the worker itself blew up. The caller paces off results —
  // a silent error would stop the detection loop dead, and the outline would
  // simply freeze with no way to tell that from "no card".
  worker.onerror = (e) => {
    console.error('[cardDetector] Worker error event:', e);
    pending = false;
    onResult({ seq, detected: false, error: e?.message || 'detect worker failed' });
  };
  return worker;
}

// Submit a canvas for detection. Returns false if a frame is already in flight —
// the caller should simply skip, not queue: a queue of stale frames is worse than
// a lower frame rate, because every result would describe a scene that has moved.
export function requestDetect(canvas, onResult) {
  const w = canvas.width, h = canvas.height;
  if (!w || !h) return false;
  const wk = ensureWorker(onResult);
  if (pending) return false;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  // Reuse the returned buffer when it still fits; otherwise let this one be the
  // new spare after the round trip.
  let bytes;
  if (spare && spare.byteLength === img.data.byteLength) {
    new Uint8ClampedArray(spare).set(img.data);
    bytes = spare;
    spare = null;
  } else {
    bytes = img.data.buffer;
  }
  pending = true;
  seq += 1;
  wk.postMessage({ buf: bytes, w, h, seq }, [bytes]);
  return true;
}

export function stopDetect() {
  if (worker) { worker.terminate(); worker = null; }
  pending = false;
  spare = null;
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
