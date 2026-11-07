// The server half of a scan, run on the phone for device mode: turn the photo the
// scanner took into milo's 128-number embedding. The bundled backend then sweeps
// the downloaded catalog with it (backend/src/cvScan.js, via setScanSource), so
// matching, the not-in-catalog gate and naming the card are the server's code.
//
// Same steps as cvScan: a crop the scanner already dewarped is resized to 448;
// a whole frame first goes through cornelius for its corners and is dewarped
// here. Main thread and single-threaded wasm, like the detect worker: one milo
// pass on a phone is a few hundred milliseconds, once per scan.
import * as ort from 'onnxruntime-web/wasm';
import { getPerspectiveTransform, warpPerspective, orderQuad } from '../../../shared/imgproc.mjs';
import { rgbaToChw } from '../utils/scanTensor';
import { readBytes } from './scanAssets';

const EMBED = 448;
const CORN = 384;
const SHARPNESS_GATE = 0.02;   // cvScan's: below it cornelius is not looking at a card
const SOURCE_MAX = 1200;       // cvScan's decode width for the dewarp source

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

const tensor = (rgba, size) => new ort.Tensor('float32', rgbaToChw(rgba, size), [1, 3, size, size]);

// A whole frame: cornelius for the corners, then dewarp to a 448 square.
async function detectAndDewarp(bmp) {
  const corn = await session('cornelius.onnx');
  const out = await corn.run({ image: tensor(pixels(bmp, CORN, CORN), CORN) });
  const sharpness = out.sharpness ? out.sharpness.data[0] : 1;
  if (!(sharpness > SHARPNESS_GATE)) return { rgba: pixels(bmp, EMBED, EMBED), detected: false };
  const s = Math.min(1, SOURCE_MAX / bmp.width);
  const w = Math.round(bmp.width * s);
  const h = Math.round(bmp.height * s);
  const c = out.corners.data;
  // orderQuad, not the model's own order: cornelius emits BL, BR, TL, TR, which is
  // not the order its model card documents. cvScan sorts the same way.
  const src = orderQuad([0, 1, 2, 3].map(k => ({ x: c[k * 2] * w, y: c[k * 2 + 1] * h })));
  const dst = [{ x: 0, y: 0 }, { x: EMBED - 1, y: 0 }, { x: EMBED - 1, y: EMBED - 1 }, { x: 0, y: EMBED - 1 }];
  const M = getPerspectiveTransform(src, dst);
  return { rgba: warpPerspective(pixels(bmp, w, h), w, h, M, EMBED, EMBED), detected: true };
}

function thumbnail(rgba) {
  const canvas = document.createElement('canvas');
  canvas.width = EMBED;
  canvas.height = EMBED;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), EMBED, EMBED), 0, 0);
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
  const { rgba, detected } = cropped ? { rgba: pixels(bmp, EMBED, EMBED), detected: true } : await detectAndDewarp(bmp);
  bmp.close();
  const milo = await session('milo.onnx');
  const out = await milo.run({ image: tensor(rgba, EMBED) });
  return { embedding: Array.from(out.embedding.data), thumb: thumbnail(rgba), detected };
}
