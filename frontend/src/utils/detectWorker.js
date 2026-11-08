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
// The pixel buffer is TRANSFERRED rather than copied: a 384x384 RGBA frame is
// ~590KB, and copying that several times a second is the kind of waste that is
// invisible until it is not.
//
// Engine order, fastest first (issue #80): this model on single-threaded wasm,
// then the pure-JS contour detector, then (in CameraScanner) a manual shutter if
// this worker cannot load at all. Every step down is logged and the engine name
// rides on every result, so the scanner's debug readout says which one runs.

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
import { quadSignature } from './cardSignature.js';
import { cornerResult, quadArea } from './detectResult.js';
import { createDetector } from '../../../shared/cardDetectPure.mjs';

// The wasm binaries ship with the frontend bundle (scripts/copy-ort.mjs), so
// /ort/ resolves on the web AND inside the native app's bundled assets.
//
// Single-threaded, and NOT for lack of trying. Measured in Chromium with the page
// cross-origin isolated (#80): numThreads 4 inside this module worker never
// returns from InferenceSession.create — a hang, not an error, so no fallback
// could even catch it — while the same model on 4 threads on the MAIN thread runs
// in 8ms and on 1 thread here in ~20ms (FastWeb). Threads would mean inference on
// the main thread, which is what used to freeze the camera on phones; one thread
// in a worker already keeps up with the camera. The Capacitor WebView is never
// cross-origin isolated anyway.
ort.env.wasm.wasmPaths = '/ort/';
ort.env.wasm.numThreads = 1;

const CORN_SIZE = 384;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
// Cornelius is preferred, but it is a 4 MB fetch from a route the server has to
// actually expose. When that fails — an older backend, a proxy that swallows
// /models, a browser with no working wasm — the answer must NOT be "no detector".
// A silent absence of detections reads to the caller as "nothing seen yet", which
// is exactly the state auto-scan treats as permission to fire, so a missing model
// turned auto-scan into a shutter that photographed empty desks. Fall back to the
// contour detector that shipped before this: worse corners, but a real answer.
let fallback = null;
// Which model actually bound, reported with every detection.
let engine = 'none';

// Resolved by the main thread's { init: { model, error } } message: the model
// is fetched there, never here (see cardDetector). Frames that arrive first
// simply wait on it.
let configure;
const sessionReady = new Promise((r) => { configure = r; }).then(async (cfg) => {
  if (!cfg.model) throw new Error(cfg.error || 'no model');
  const bytes = new Uint8Array(cfg.model);
  // ONE execution provider, named explicitly. Never a preference list: ORT then
  // chooses silently, which is how a 1075ms-per-frame WebGPU outline went
  // unattributed. wasm measured 80ms for this model against WebGPU's 1075ms.
  engine = bytes.length < 4000000 ? 'fastweb-wasm' : 'cornelius-wasm';
  const s = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  // Warm-up off the first real frame (kernel setup and allocation land on the
  // first run), timed so the console says what this device actually does.
  const t0 = performance.now();
  await s.run({ image: new ort.Tensor('float32', tensorData, [1, 3, CORN_SIZE, CORN_SIZE]) });
  console.log(`[detectWorker] ${engine} ready (${bytes.length} bytes, warm-up ${Math.round(performance.now() - t0)}ms)`);
  return s;
});
sessionReady.catch((err) => console.error(`[detectWorker] ${engine === 'none' ? 'model' : engine} unavailable:`, err?.message || err));

function getFallback() {
  if (!fallback) {
    fallback = createDetector();
  }
  return fallback;
}

// The contour detector, in the shape this worker returns. `fill` stays the
// quad's area fraction so the caller's gate means the same thing either way.
function detectWithFallback(rgba, w, h, seq, why) {
  const det = getFallback();
  const card = det.detectCard(rgba, w, h);
  if (!card) return { seq, detected: false, engine: 'contour', degraded: why };
  const quad = card.quad.map(p => ({ x: p.x / w, y: p.y / h }));
  return {
    seq, detected: true, quad, engine: 'contour', degraded: why,
    pick: { fill: quadArea(quad) },
    sharp: sharpness(rgba, w, h),
    sig: quadSignature(rgba, w, h, quad),
  };
}

// Square-resize into the model's input. `fit: fill` on the server, so squash
// here too — letterboxing would move the corners the model predicts.
//
// Resize and normalise straight into the tensor. When the caller passes a 384x384
// canvas (scaled in GPU hardware), this is a direct 1:1 vectorised normalisation pass.
const PLANE = CORN_SIZE * CORN_SIZE;
const tensorData = new Float32Array(3 * PLANE);   // reused every frame
const invStd0 = 1 / (255 * STD[0]), invStd1 = 1 / (255 * STD[1]), invStd2 = 1 / (255 * STD[2]);
const offset0 = -MEAN[0] / STD[0], offset1 = -MEAN[1] / STD[1], offset2 = -MEAN[2] / STD[2];
const lut0 = new Float32Array(256), lut1 = new Float32Array(256), lut2 = new Float32Array(256);
for (let v = 0; v < 256; v++) {
  lut0[v] = v * invStd0 + offset0;
  lut1[v] = v * invStd1 + offset1;
  lut2[v] = v * invStd2 + offset2;
}

function toTensor(rgba, w, h) {
  if (w === CORN_SIZE && h === CORN_SIZE) {
    const p0 = 0, p1 = PLANE, p2 = 2 * PLANE;
    for (let i = 0, j = 0; i < PLANE; i++, j += 4) {
      tensorData[p0 + i] = lut0[rgba[j]];
      tensorData[p1 + i] = lut1[rgba[j + 1]];
      tensorData[p2 + i] = lut2[rgba[j + 2]];
    }
    return new ort.Tensor('float32', tensorData, [1, 3, CORN_SIZE, CORN_SIZE]);
  }
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
  if (e.data.init) { configure(e.data.init); return; }
  const { buf, w, h, seq } = e.data;
  const rgba = new Uint8ClampedArray(buf);
  let result;
  try {
    let session;
    try {
      session = await sessionReady;
    } catch (loadErr) {
      // Degraded, but still answering. The caller can tell the difference.
      self.postMessage(detectWithFallback(rgba, w, h, seq, loadErr?.message || String(loadErr)));
      return;
    }
    // Split so a slow frame says WHERE it was slow: the JS resize+normalise and
    // the sharpness scan are ordinary array work, inference is not.
    const tensor = toTensor(rgba, w, h);
    const tRun = performance.now();
    const out = await session.run({ image: tensor });
    const runMs = Math.round(performance.now() - tRun);
    result = cornerResult({
      seq, engine, runMs,
      corners: out.corners.data,
      score: out.sharpness ? out.sharpness.data[0] : undefined,
      rgba, w, h,
    });
  } catch (err) {
    // Inference itself failed on this frame. Answer from the contour detector
    // rather than with nothing, and say why.
    result = detectWithFallback(rgba, w, h, seq, `${engine} run failed: ${err?.message || err}`);
  }
  self.postMessage(result);
};
