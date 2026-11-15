// The server half of a scan, run on the phone for device mode: turn the photo the
// scanner took into milo's 128-number embedding. The bundled backend then sweeps
// the downloaded catalog with it (backend/src/cvScan.js, via setScanSource), so
// matching, the not-in-catalog gate and naming the card are the server's code.
//
// Same steps as cvScan: a crop the scanner already dewarped is resized to 448;
// a whole frame first goes through cornelius for its corners and is dewarped
// here. Main thread and single-threaded wasm, like the detect worker: one milo
// pass on a phone is a few hundred milliseconds, once per scan.
//
// Same pieces as cvScan too (shared/scanModel.mjs): the sizes, the gate, the
// normalisation and the corners-to-homography step. What stays the phone's own is
// what it has no sharp for: decoding and resizing go through a canvas, and the
// warp is the RGBA one the browser's capture crop uses (shared/imgproc.mjs has
// how it differs from the server's). A quad whose corners do not span a plane is
// no card: like cvScan, the phone then matches the whole frame instead.
import * as ort from 'onnxruntime-web/wasm';
import { warpPerspective } from '../../../shared/imgproc.mjs';
import {
  CORN_SIZE, EMBED_SIZE, DEWARP_SOURCE_WIDTH, SHARPNESS_GATE, imagenetChw, dewarpTransform,
} from '../../../shared/scanModel.mjs';
import { readBytes } from './scanAssets';

ort.env.wasm.wasmPaths = '/ort/';
ort.env.wasm.numThreads = 1;

const sessions = {};
function session(name) {
  if (!sessions[name]) {
    sessions[name] = readBytes(name)
      .then(bytes => ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] }))
      .catch((err) => { delete sessions[name]; throw err; });
  }
  return sessions[name];
}

// The scanner closed (runtime.js releaseScanEngine): free both models' sessions
// instead of holding them for the rest of the app's life. The next scan loads
// them again, from the files already on the phone. wasm memory itself never
// shrinks, but released sessions are what the next ones reuse.
export async function releaseSessions() {
  const open = Object.values(sessions);
  for (const name of Object.keys(sessions)) delete sessions[name];
  for (const pending of open) {
    try {
      await (await pending).release();
    } catch { /* never finished loading: nothing to free */ }
  }
}

async function decode(dataUrl) {
  return createImageBitmap(await (await fetch(dataUrl)).blob());
}

function pixels(source, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

const tensor = (rgba, size) => new ort.Tensor('float32', imagenetChw(rgba, size, 4), [1, 3, size, size]);

// A whole frame: cornelius for the corners, then dewarp to a 448 square.
async function detectAndDewarp(bmp) {
  const corn = await session('cornelius.onnx');
  const out = await corn.run({ image: tensor(pixels(bmp, CORN_SIZE, CORN_SIZE), CORN_SIZE) });
  const sharpness = out.sharpness ? out.sharpness.data[0] : 1;
  if (!(sharpness > SHARPNESS_GATE)) return { rgba: pixels(bmp, EMBED_SIZE, EMBED_SIZE), detected: false };
  const s = Math.min(1, DEWARP_SOURCE_WIDTH / bmp.width);
  const w = Math.round(bmp.width * s);
  const h = Math.round(bmp.height * s);
  // Sorted into TL, TR, BR, BL first, as cvScan does: cornelius emits BL, BR, TL, TR.
  const { M } = dewarpTransform(out.corners.data, w, h, { nullIfSingular: true });
  // Corners that do not span a plane give no homography: the whole frame, as on a server.
  if (!M) return { rgba: pixels(bmp, EMBED_SIZE, EMBED_SIZE), detected: false };
  return { rgba: warpPerspective(pixels(bmp, w, h), w, h, M, EMBED_SIZE, EMBED_SIZE), detected: true };
}

function thumbnail(rgba) {
  const canvas = document.createElement('canvas');
  canvas.width = EMBED_SIZE;
  canvas.height = EMBED_SIZE;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), EMBED_SIZE, EMBED_SIZE), 0, 0);
  const small = document.createElement('canvas');
  small.width = 220;
  small.height = 220;
  small.getContext('2d').drawImage(canvas, 0, 0, 220, 220);
  return small.toDataURL('image/jpeg', 0.7);
}

// image: the data URL the scanner would have uploaded. cropped: whether it is
// already the dewarped card. Resolves { embedding, thumb, detected }.
export async function embedScan(image, cropped) {
  const bmp = await decode(image);
  const { rgba, detected } = cropped ? { rgba: pixels(bmp, EMBED_SIZE, EMBED_SIZE), detected: true } : await detectAndDewarp(bmp);
  bmp.close();
  const milo = await session('milo.onnx');
  const out = await milo.run({ image: tensor(rgba, EMBED_SIZE) });
  return { embedding: Array.from(out.embedding.data), thumb: thumbnail(rgba), detected };
}
