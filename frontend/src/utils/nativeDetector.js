// The live detector, run by native ONNX Runtime in the app (native-detector/).
//
// In the WebView the corner model runs on one wasm thread: the app's WebView is
// never cross-origin isolated, so wasm gets no threads, and wasm costs about twice
// native code on the same core besides — ~150 ms a frame on a phone. The plugin
// runs the same model on the phone's real cores and picks its fastest engine on
// first load. Everything after inference (the gate, corner order, focus score, card
// signature) is detectResult.js, the same code the wasm worker uses.
//
// Only the app has the plugin. On the web, or in an app build that predates it,
// nativeDetectorAvailable() is false and cardDetector keeps the wasm worker.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { cornerResult } from './detectResult.js';

const NativeDetector = registerPlugin('NativeDetector');

// Which engine the plugin uses: 'auto' (default: time them all on this phone, keep
// the fastest), or one of 'cpu', 'xnnpack' (Android), 'coreml' (iOS) to compare
// them by hand. Set from the WebView console; the scanner's debug row names the
// engine that actually ran.
export const ENGINE_KEY = 'bindarr.nativeDetectorEngine';

export function nativeDetectorAvailable() {
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('NativeDetector');
  } catch {
    return false;
  }
}

function chosenEngine() {
  try { return localStorage.getItem(ENGINE_KEY) || 'auto'; } catch { return 'auto'; }
}

// A cheap identity for the model bytes, so a scanner reopen does not push the
// same ~4 MB across the bridge again, but a model swap (or an engine override)
// does reload. Size plus FNV-1a over a strided sample: it only has to tell the
// models this app has ever shipped apart, not resist anyone.
export function modelTag(bytes, engine = 'auto') {
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(bytes.length / 4096));
  for (let i = 0; i < bytes.length; i += step) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${bytes.length}-${h.toString(16)}-${engine}`;
}

// Base64 without building a giant binary string on the main thread: the reader
// encodes natively, off the JS heap's hot path.
function base64Of(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => reject(r.error || new Error('could not read the frame'));
    r.readAsDataURL(blob);
  });
}

// JPEG, not raw RGBA: the bridge carries JSON strings, and ~30 KB of JPEG is far
// cheaper to encode, send and decode than ~800 KB of base64'd pixels. toBlob
// encodes off the main thread, unlike toDataURL.
function jpegOf(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('frame did not encode'))), 'image/jpeg', 0.92);
  });
}

let ready = null;

// Resolves with the engine name once the plugin holds the model. getModel is
// cardDetector's model fetch (server, cache, or device-mode download).
export function loadNativeDetector(getModel) {
  if (!ready) {
    ready = (async () => {
      const bytes = new Uint8Array(await getModel());
      const engine = chosenEngine();
      const tag = modelTag(bytes, engine);
      const st = await NativeDetector.status();
      if (st?.tag === tag && st.engine) return st.engine;
      const res = await NativeDetector.load({ model: await base64Of(new Blob([bytes])), tag, ep: engine });
      const errors = res.errors && Object.keys(res.errors).length ? ` (unavailable: ${JSON.stringify(res.errors)})` : '';
      console.log(`[nativeDetector] ${res.engine} ready in ${res.loadMs}ms, per-run timings ${JSON.stringify(res.timings)}${errors}`);
      return res.engine;
    })().catch((err) => {
      ready = null;   // retried on the next scanner open
      throw err;
    });
  }
  return ready;
}

// One frame. The canvas is the scanner's 384x384 framed crop; its pixels are read
// here too, for the focus score and card signature the result carries.
export async function detectNative(canvas, seq, engine) {
  const w = canvas.width, h = canvas.height;
  const blob = jpegOf(canvas);
  const rgba = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const out = await NativeDetector.detect({ image: await base64Of(await blob) });
  return {
    ...cornerResult({ seq, engine, runMs: out.runMs, corners: out.corners, score: out.sharpness, rgba, w, h }),
    prepMs: out.prepMs,
  };
}
