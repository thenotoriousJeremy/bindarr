// What the two scan models take, in the one copy every scan path builds its
// input from: the server's scan (backend/src/cvScan.js) and catalog build
// (backend/src/catalog.js), the scanner's live outline (frontend/src/utils/
// detectWorker.js and detectResult.js), and device mode's scan on the phone
// (frontend/src/device/scanEngine.js).
//
// Every catalog a scan is matched against was embedded with fixed preprocessing
// (a local build through this very module, in catalog.js), and a change here
// does not fail: a different constant, rounding or interpolation quietly shifts
// every embedding, and the accuracy it costs is not measured anywhere.
// backend/test/scanshared.test.js pins everything here to the copies it
// replaced, bit for bit.
//
// A plain ES module with no Node or DOM API in it: the backend require()s it
// (Node 22.12+), and the app and its device-mode backend bundle it.
import { orderQuad, getPerspectiveTransform } from './imgproc.mjs';

// cornelius, the corner model, takes a 384 square. milo, the embedder, takes a
// 448 one, which is also the square a card is dewarped onto.
export const CORN_SIZE = 384;
export const EMBED_SIZE = 448;

// The widest a frame is decoded for the dewarp: plenty of source resolution for
// a 448 crop, and it keeps the bilinear sample loop cheap.
export const DEWARP_SOURCE_WIDTH = 1200;

// Below this the corner head's SimCC peaks are flat: cornelius is not looking at
// a card.
export const SHARPNESS_GATE = 0.02;

// ImageNet's per-channel mean and standard deviation, RGB. Frozen: every path
// reads these, and the lookup table below is built from them once.
export const MEAN = Object.freeze([0.485, 0.456, 0.406]);
export const STD = Object.freeze([0.229, 0.224, 0.225]);

// (v / 255 - MEAN) / STD for every byte value, per channel, rounded to float32 as
// the tensor stores it. The same expression as the arithmetic in imagenetChw, so
// a byte read through the table lands on the same float as one computed in full.
const BYTE_TABLE = MEAN.map((mean, c) => {
  const t = new Float32Array(256);
  for (let v = 0; v < 256; v++) t[v] = (v / 255 - mean) / STD[c];
  return t;
});

// Interleaved pixels -> ImageNet-normalised planar float32 (NCHW without the N):
// every R, then every G, then every B. `channels` is the input's stride, 3 for
// sharp's raw RGB and 4 for a canvas's RGBA, whose alpha is skipped. `out` lets a
// caller that runs every frame reuse one buffer.
//
// Bytes, which is what every caller passes, go through the table: the detect
// worker's per-frame budget is why. Anything else gets the arithmetic itself.
export function imagenetChw(px, size, channels = 3, out = new Float32Array(3 * size * size)) {
  const plane = size * size;
  if (px instanceof Uint8Array || px instanceof Uint8ClampedArray) {
    const [t0, t1, t2] = BYTE_TABLE;
    for (let p = 0, j = 0; p < plane; p++, j += channels) {
      out[p] = t0[px[j]];
      out[plane + p] = t1[px[j + 1]];
      out[2 * plane + p] = t2[px[j + 2]];
    }
    return out;
  }
  for (let p = 0; p < plane; p++) {
    out[p] = (px[p * channels] / 255 - MEAN[0]) / STD[0];
    out[plane + p] = (px[p * channels + 1] / 255 - MEAN[1]) / STD[1];
    out[2 * plane + p] = (px[p * channels + 2] / 255 - MEAN[2]) / STD[2];
  }
  return out;
}

// From cornelius's answer to the homography that dewarps the card onto milo's
// square. `corners` is the model's 8 numbers (x, y per corner, 0..1 of the frame
// it saw) and w, h the frame they are scaled to. Returns { quad, M }: the corners
// in pixels, sorted into TL, TR, BR, BL (cornelius emits BL, BR, TL, TR, which is
// not the order its model card documents), and the 8 homography coefficients.
//
// nullIfSingular: M is null when the corners do not span a plane (three in a
// line, two on one spot), so the caller can match the frame instead. The server
// does; device mode never has, and warps through getPerspectiveTransform's tiny
// pivot instead (see there).
export function dewarpTransform(corners, w, h, { nullIfSingular = false } = {}) {
  const pts = [];
  for (let k = 0; k < 4; k++) pts.push({ x: corners[k * 2] * w, y: corners[k * 2 + 1] * h });
  const quad = orderQuad(pts);
  const n = EMBED_SIZE - 1;
  const square = [{ x: 0, y: 0 }, { x: n, y: 0 }, { x: n, y: n }, { x: 0, y: n }];
  return { quad, M: getPerspectiveTransform(quad, square, { nullIfSingular }) };
}
