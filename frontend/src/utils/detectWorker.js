// Card detection, off the main thread.
//
// This runs cornelius — the SAME corner model the server dewarps with before
// embedding — so the outline on screen and the crop the scan actually matches
// cannot disagree. They did disagree for exactly one commit, and the green box
// showing a different quad from the one being identified is worse than no box:
// it tells the user to aim in a way that does not help.
//
// Detection measures ~80ms per frame end to end on the wasm EP (32ms for the
// same model through onnxruntime-node, so the browser tax is real but bounded).
// On the main thread that is most of a frame budget with no rendering and no
// touch handling, which is what made the camera freeze the app, so the worker
// stays.
//
// The pixel buffer is TRANSFERRED rather than copied in both directions: a
// 256x360 RGBA frame is ~370KB, and copying that several times a second is the
// kind of waste that is invisible until it is not.
// The CPU-only entry point, NOT 'onnxruntime-web/webgpu' and not the bare
// 'onnxruntime-web' either. The session below names 'wasm' as its ONLY execution
// provider, deliberately, for the measured reason spelled out there — so every
// other backend ORT can ship is dead weight:
//
//   'onnxruntime-web/webgpu'  pulls the JSEP backend and staged four wasm binaries
//                             into public/ort — jsep 26.8 MB, asyncify 24.3 MB,
//                             jspi 15.0 MB on top of the 13.5 MB actually used.
//   'onnxruntime-web'         resolves to ort.bundle.min.mjs, which still emits the
//                             26.8 MB jsep binary into dist/assets.
//   'onnxruntime-web/wasm'    the CPU backend alone, which is all this can reach.
import * as ort from 'onnxruntime-web/wasm';
import { sharpness } from './sharpness.js';

// Served by the backend from data/models.
//
// THREADS. This graph parallelises almost linearly — measured on the same model
// via onnxruntime-node: 30.6ms on one thread, 17.2ms on two, 10.6ms on four. One
// thread was leaving that on the floor, and on a phone the difference is a 270ms
// detection against roughly 110ms.
//
// Multi-threaded wasm needs SharedArrayBuffer, which needs the DOCUMENT to be
// cross-origin isolated (COOP + COEP). The server sends those headers, but a
// reverse proxy can strip them and the Capacitor WebView never had them, so this
// is asked, never assumed: crossOriginIsolated is false there and the session
// stays single-threaded rather than failing to construct. Cap at 4 — phones
// report 8 cores of which half are little ones, and oversubscribing a 384x384
// graph costs more in synchronisation than it buys.
ort.env.wasm.wasmPaths = '/ort/';
const THREADS = self.crossOriginIsolated
  ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1))
  : 1;
ort.env.wasm.numThreads = THREADS;

const CORN_SIZE = 384;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
// Below this the SimCC peaks are flat: the model is not looking at a card.
const SHARPNESS_GATE = 0.02;

// Shoelace area of a quad in normalised (0..1) coordinates, so the result is the
// fraction of the frame it covers. Absolute value: corner order decides the sign
// and a mirrored detection is still a detection.
function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i], n = q[(i + 1) % 4];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

// Cornelius is preferred, but it is a 4 MB fetch from a route the server has to
// actually expose. When that fails — an older backend, a proxy that swallows
// /models, a browser with no working wasm — the answer must NOT be "no detector".
// A silent absence of detections reads to the caller as "nothing seen yet", which
// is exactly the state auto-scan treats as permission to fire, so a missing model
// turned auto-scan into a shutter that photographed empty desks. Fall back to the
// contour detector that shipped before this: worse corners, but a real answer.
let sessionPromise = null;
let fallback = null;
// Which execution provider actually bound, reported with every detection.
let engine = 'cornelius';

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const res = await fetch('/models/cornelius.onnx');
      // A SPA catch-all answers 200 with index.html; ORT would then fail deep
      // inside a protobuf parse with a message that names nothing useful.
      const type = res.headers.get('content-type') || '';
      if (!res.ok || type.includes('text/html')) {
        throw new Error(`cornelius.onnx not served (${res.status} ${type || 'no type'})`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      // wasm, NOT WebGPU, and the EP is named explicitly rather than left as a
      // preference list — passing both lets ORT choose silently, which is how a
      // 1075ms-per-frame outline went unattributed for so long.
      //
      // Measured on the same device, same model: 80ms per frame on wasm against
// 1075ms on WebGPU. And 32ms single-threaded on a desktop CPU via
      // onnxruntime-node, and 1075ms on WebGPU in the browser. MobileViT's
      // attention blocks hit ops the WebGPU EP does not implement, and each one
      // round-trips the tensor GPU->CPU->GPU. A 1M-parameter model is too small
      // to win that back.
      // Thread count in the name: a deployment whose proxy ate the isolation
      // headers reads 'cornelius-wasm x1' and is three times slower for a reason
      // no other readout would show.
      engine = `cornelius-wasm x${THREADS}`;
      return ort.InferenceSession.create(bytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    })().catch((err) => {
      sessionPromise = null;      // allow a later retry
      throw err;
    });
  }
  return sessionPromise;
}

async function getFallback() {
  if (!fallback) {
    const { createDetector } = await import('../../../shared/cardDetectPure.mjs');
    fallback = createDetector();
  }
  return fallback;
}

// The contour detector, in the shape this worker returns. `fill` stays the
// quad's area fraction so the caller's gate means the same thing either way.
async function detectWithFallback(rgba, w, h, seq, why) {
  const det = await getFallback();
  const card = det.detectCard(rgba, w, h);
  if (!card) return { seq, detected: false, engine: 'contour', degraded: why };
  const quad = card.quad.map(p => ({ x: p.x / w, y: p.y / h }));
  return {
    seq, detected: true, quad, engine: 'contour', degraded: why,
    pick: { fill: quadArea(quad) },
    sharp: sharpness(rgba, w, h),
  };
}

// Square-resize into the model's input. `fit: fill` on the server, so squash
// here too — letterboxing would move the corners the model predicts.
//
// Resize and normalise in ONE pass straight into the tensor. The obvious version
// goes through a canvas (putImageData -> drawImage -> getImageData), which is
// three full-frame copies plus an OffscreenCanvas allocation per frame; at 12
// frames a second that allocation churn was most of the jitter between a 45ms
// and a 199ms detection.
const PLANE = CORN_SIZE * CORN_SIZE;
const tensorData = new Float32Array(3 * PLANE);   // reused every frame

function toTensor(rgba, w, h) {
  const xs = w / CORN_SIZE, ys = h / CORN_SIZE;
  for (let oy = 0; oy < CORN_SIZE; oy++) {
    const sy = (oy + 0.5) * ys - 0.5;
    const y0 = Math.max(0, Math.min(h - 1, sy | 0));
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = sy - y0;
    const row0 = y0 * w, row1 = y1 * w;
    for (let ox = 0; ox < CORN_SIZE; ox++) {
      const sx = (ox + 0.5) * xs - 0.5;
      const x0 = Math.max(0, Math.min(w - 1, sx | 0));
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = sx - x0;
      const i00 = (row0 + x0) << 2, i01 = (row0 + x1) << 2;
      const i10 = (row1 + x0) << 2, i11 = (row1 + x1) << 2;
      const o = oy * CORN_SIZE + ox;
      for (let ch = 0; ch < 3; ch++) {
        const top = rgba[i00 + ch] * (1 - fx) + rgba[i01 + ch] * fx;
        const bot = rgba[i10 + ch] * (1 - fx) + rgba[i11 + ch] * fx;
        tensorData[ch * PLANE + o] = ((top * (1 - fy) + bot * fy) / 255 - MEAN[ch]) / STD[ch];
      }
    }
  }
  return new ort.Tensor('float32', tensorData, [1, 3, CORN_SIZE, CORN_SIZE]);
}

self.onmessage = async (e) => {
  const { buf, w, h, seq } = e.data;
  const rgba = new Uint8ClampedArray(buf);
  let result;
  try {
    let session;
    try {
      session = await getSession();
    } catch (loadErr) {
      // Degraded, but still answering. The caller can tell the difference.
      const r = await detectWithFallback(rgba, w, h, seq, loadErr.message);
      self.postMessage({ ...r, buf: rgba.buffer }, [rgba.buffer]);
      return;
    }
    // Split so a slow frame says WHERE it was slow: the JS resize+normalise and
    // the sharpness scan are ordinary array work, inference is not.
    const tensor = toTensor(rgba, w, h);
    const tRun = performance.now();
    const out = await session.run({ image: tensor });
    const runMs = Math.round(performance.now() - tRun);
    const c = out.corners.data;
    const sharp = out.sharpness ? out.sharpness.data[0] : 1;

    if (sharp > SHARPNESS_GATE) {
      // Cornelius emits BL, BR, TL, TR — NOT the TL,TR,BR,BL its model card
      // documents. The overlay draws this as a polygon and the server warps from
      // the same order, so getting it wrong is a visibly twisted box.
      const order = [2, 3, 1, 0]; // -> TL, TR, BR, BL
      const quad = order.map(i => ({ x: c[i * 2], y: c[i * 2 + 1] }));
      result = {
        seq,
        detected: true,
        engine,
        runMs,
        quad,
        // `pick.fill` gates auto-capture (>= 0.7). The old contour detector meant
        // "how solidly the quad fills its own contour"; cornelius has no contour,
        // so the equivalent question is how much of the guide crop the card
        // covers — which is what the gate was really protecting against, a
        // detection that is too small or too skewed to be the card being aimed.
        pick: { fill: quadArea(quad) },
        // The model's corner confidence, not image focus. Both matter and they
        // are not the same thing, so both are reported.
        corners: sharp,
        // Computed here, where the pixels already are — sending them back for
        // the main thread to score would undo the point of the transfer.
        sharp: sharpness(rgba, w, h),
      };
    } else {
      result = { seq, detected: false, engine, runMs, corners: sharp };
    }
  } catch (err) {
    result = { seq, detected: false, error: err?.message || 'detect failed' };
  }
  // Hand the buffer back so the caller can reuse it instead of allocating a new
  // one per frame.
  self.postMessage({ ...result, buf: rgba.buffer }, [rgba.buffer]);
};
