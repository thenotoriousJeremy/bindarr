// The scan pipeline's geometry and preprocessing used to live in three or four
// copies: backend/src/cvScan.js, catalog.js, shared/imgproc.mjs and the
// frontend's detectResult.js, scanTensor.js, detectWorker.js and
// device/scanEngine.js. They are one copy each now, in shared/scanModel.mjs and
// shared/imgproc.mjs (PROV-20).
//
// The published catalogs were embedded with that preprocessing, and nothing
// fails when it changes: a moved pixel or a rounding difference just shifts
// embeddings and costs accuracy nobody measures. So the consolidation had to
// change no number on any path, and this holds it to that. Below are the
// replaced implementations, VERBATIM as of review/integration f438c8b1 (only
// re-indented; device mode's and the detect worker's are cut out of the canvas
// and onnxruntime-web code around them), run side by side with what each caller
// runs now, asserting bit-identical output: tensors and crops compared as bytes,
// coordinates and coefficients with Object.is.
//
// The copies are the reference. Do not edit them, and do not make a failure here
// pass by changing a copy: a difference is a change to every embedding that
// path produces.
//
// Run: node test/scanshared.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `bindarr-scanshared-${process.pid}-`));
process.env.CV_MODEL_DIR = path.join(tmpDir, 'models');
const tmpDb = path.join(os.tmpdir(), `bindarr-scanshared-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

const sharp = require('sharp');
const ort = require('onnxruntime-node');
const cvScan = require('../src/cvScan');
const catalog = require('../src/catalog');
const modelAssets = require('../src/utils/modelAssets');
const db = require('../src/db');
const scanModel = require('../../shared/scanModel.mjs');
const imgproc = require('../../shared/imgproc.mjs');

const SRC = path.join(__dirname, '..', 'src');

// ---- The replaced code, verbatim ------------------------------------------------

// backend/src/cvScan.js
const OLD_CVSCAN = (() => {
  const MODEL_DIR = process.env.CV_MODEL_DIR || path.join(SRC, '..', 'data', 'models');
  const CORN_SIZE = 384;     // cornelius input
  const EMBED_SIZE = 448;    // milo input, and the dewarp target
  const MEAN = [0.485, 0.456, 0.406];
  const STD = [0.229, 0.224, 0.225];
  const SHARPNESS_GATE = 0.02;

  // ImageNet-normalised NCHW float from raw interleaved RGB.
  function toTensor(rgb, size) {
    const x = new Float32Array(3 * size * size);
    const plane = size * size;
    for (let p = 0; p < plane; p++) {
      x[p] = (rgb[p * 3] / 255 - MEAN[0]) / STD[0];
      x[plane + p] = (rgb[p * 3 + 1] / 255 - MEAN[1]) / STD[1];
      x[2 * plane + p] = (rgb[p * 3 + 2] / 255 - MEAN[2]) / STD[2];
    }
    return new ort.Tensor('float32', x, [1, 3, size, size]);
  }

  function warpRgb(src, sw, sh, M, size) {
    const [a, b, c, d, e, f, g, i] = M;
    const det = a * (e - f * i) - b * (d - f * g) + c * (d * i - e * g);
    const inv = [
      (e - f * i) / det, (c * i - b) / det, (b * f - c * e) / det,
      (f * g - d) / det, (a - c * g) / det, (c * d - a * f) / det,
      (d * i - e * g) / det, (b * g - a * i) / det, (a * e - b * d) / det,
    ];
    const out = new Uint8Array(size * size * 3);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const den = inv[6] * x + inv[7] * y + inv[8];
        const sx = (inv[0] * x + inv[1] * y + inv[2]) / den;
        const sy = (inv[3] * x + inv[4] * y + inv[5]) / den;
        const o = (y * size + x) * 3;
        if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) continue;
        const x0 = sx | 0, y0 = sy | 0;
        const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
        const fx = sx - x0, fy = sy - y0;
        for (let ch = 0; ch < 3; ch++) {
          const p00 = src[(y0 * sw + x0) * 3 + ch], p01 = src[(y0 * sw + x1) * 3 + ch];
          const p10 = src[(y1 * sw + x0) * 3 + ch], p11 = src[(y1 * sw + x1) * 3 + ch];
          out[o + ch] = (p00 * (1 - fx) + p01 * fx) * (1 - fy) + (p10 * (1 - fx) + p11 * fx) * fy;
        }
      }
    }
    return out;
  }

  // Solve for the 8 homography coefficients mapping src quad -> dst quad.
  function perspectiveTransform(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      A.push([src[i].x, src[i].y, 1, 0, 0, 0, -src[i].x * dst[i].x, -src[i].y * dst[i].x]); b.push(dst[i].x);
      A.push([0, 0, 0, src[i].x, src[i].y, 1, -src[i].x * dst[i].y, -src[i].y * dst[i].y]); b.push(dst[i].y);
    }
    for (let col = 0; col < 8; col++) {
      let piv = col;
      for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      [A[col], A[piv]] = [A[piv], A[col]];
      [b[col], b[piv]] = [b[piv], b[col]];
      const p = A[col][col];
      if (!p) return null;
      for (let r = 0; r < 8; r++) {
        if (r === col) continue;
        const factor = A[r][col] / p;
        for (let k = col; k < 8; k++) A[r][k] -= factor * A[col][k];
        b[r] -= factor * b[col];
      }
    }
    return A.map((row, r) => b[r] / row[r]);
  }

  function orderQuad(pts) {
    if (!pts || pts.length !== 4) return pts;
    const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
    const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
    const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    let tlIdx = 0, minScore = Infinity;
    for (let i = 0; i < 4; i++) {
      const score = sorted[i].x + sorted[i].y;
      if (score < minScore) { minScore = score; tlIdx = i; }
    }
    const pTL = sorted[tlIdx];
    const pNext = sorted[(tlIdx + 1) % 4];
    const pPrev = sorted[(tlIdx + 3) % 4];
    if (pNext.x - pTL.x > pPrev.x - pTL.x || pPrev.y - pTL.y > pNext.y - pTL.y) {
      return [sorted[tlIdx], sorted[(tlIdx + 1) % 4], sorted[(tlIdx + 2) % 4], sorted[(tlIdx + 3) % 4]];
    } else {
      return [sorted[tlIdx], sorted[(tlIdx + 3) % 4], sorted[(tlIdx + 2) % 4], sorted[(tlIdx + 1) % 4]];
    }
  }

  async function detectAndDewarp(session, imageBuffer) {
    // One decode, downscaled once. 1200px is plenty of source resolution for a
    // 448px dewarp and keeps the bilinear sample loop cheap.
    const { data: rgb, info } = await sharp(imageBuffer)
      .resize({ width: 1200, withoutEnlargement: true })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });

    const { data: small } = await sharp(imageBuffer)
      .resize(CORN_SIZE, CORN_SIZE, { fit: 'fill' })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });

    const out = await session.run({ image: toTensor(small, CORN_SIZE) });
    const corners = out.corners.data;
    const sharpness = out.sharpness ? out.sharpness.data[0] : 1;

    if (!(sharpness > SHARPNESS_GATE)) {
      const { data } = await sharp(imageBuffer).resize(EMBED_SIZE, EMBED_SIZE, { fit: 'fill' })
        .removeAlpha().raw().toBuffer({ resolveWithObject: true });
      return { rgb: data, detected: false, sharpness };
    }

    // Order points into [TL, TR, BR, BL] around centroid to guarantee non-crossing quad.
    const pts = [];
    for (let k = 0; k < 4; k++) {
      pts.push({ x: corners[k * 2] * info.width, y: corners[k * 2 + 1] * info.height });
    }
    const src = orderQuad(pts);
    const dst = [
      { x: 0, y: 0 }, { x: EMBED_SIZE - 1, y: 0 },
      { x: EMBED_SIZE - 1, y: EMBED_SIZE - 1 }, { x: 0, y: EMBED_SIZE - 1 },
    ];
    const M = perspectiveTransform(src, dst);
    if (!M) {
      const { data } = await sharp(imageBuffer).resize(EMBED_SIZE, EMBED_SIZE, { fit: 'fill' })
        .removeAlpha().raw().toBuffer({ resolveWithObject: true });
      return { rgb: data, detected: false, sharpness };
    }
    return {
      rgb: warpRgb(rgb, info.width, info.height, M, EMBED_SIZE),
      detected: true, sharpness, corners: src,
    };
  }

  return { MODEL_DIR, CORN_SIZE, EMBED_SIZE, MEAN, STD, SHARPNESS_GATE, toTensor, warpRgb, perspectiveTransform, orderQuad, detectAndDewarp };
})();

// backend/src/catalog.js
const OLD_CATALOG = (() => {
  const MODEL_DIR = process.env.CV_MODEL_DIR || path.join(SRC, '..', 'data', 'models');
  const SIZE = 448;
  const MEAN = [0.485, 0.456, 0.406];
  const STD = [0.229, 0.224, 0.225];
  const suffix = (lang) => (!lang || lang === 'en' || lang === 'English' ? '' : `-${String(lang).toLowerCase()}`);
  const binPath = (game, lang) => path.join(MODEL_DIR, `milo-${game}${suffix(lang)}-local.bin`);
  const metaPath = (game, lang) => path.join(MODEL_DIR, `milo-${game}${suffix(lang)}-local.json`);

  function toTensor(rgb) {
    const plane = SIZE * SIZE;
    const x = new Float32Array(3 * plane);
    for (let p = 0; p < plane; p++) {
      x[p] = (rgb[p * 3] / 255 - MEAN[0]) / STD[0];
      x[plane + p] = (rgb[p * 3 + 1] / 255 - MEAN[1]) / STD[1];
      x[2 * plane + p] = (rgb[p * 3 + 2] / 255 - MEAN[2]) / STD[2];
    }
    return new ort.Tensor('float32', x, [1, 3, SIZE, SIZE]);
  }

  return { MODEL_DIR, SIZE, MEAN, STD, binPath, metaPath, toTensor };
})();

// backend/src/utils/modelAssets.js's own spelling, from one directory deeper.
const OLD_MODELASSETS_DIR = process.env.CV_MODEL_DIR || path.join(SRC, 'utils', '..', '..', 'data', 'models');

// shared/imgproc.mjs
const OLD_IMGPROC = (() => {
  // Perspective transform from 4 source points to 4 destination points, returned
  // as the 8 coefficients of the 3x3 homography (h22 fixed at 1).
  function getPerspectiveTransform(src, dst) {
    // Solve A x = b for the 8 unknowns, by Gaussian elimination.
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      A.push([src[i].x, src[i].y, 1, 0, 0, 0, -src[i].x * dst[i].x, -src[i].y * dst[i].x]);
      b.push(dst[i].x);
      A.push([0, 0, 0, src[i].x, src[i].y, 1, -src[i].x * dst[i].y, -src[i].y * dst[i].y]);
      b.push(dst[i].y);
    }
    for (let col = 0; col < 8; col++) {
      let piv = col;
      for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      [A[col], A[piv]] = [A[piv], A[col]];
      [b[col], b[piv]] = [b[piv], b[col]];
      const d = A[col][col] || 1e-12;
      for (let r = 0; r < 8; r++) {
        if (r === col) continue;
        const f = A[r][col] / d;
        for (let c = col; c < 8; c++) A[r][c] -= f * A[col][c];
        b[r] -= f * b[col];
      }
    }
    return A.map((row, i) => b[i] / (row[i] || 1e-12));
  }

  // Warp RGBA pixels through a homography into a dstW x dstH RGBA buffer, with
  // bilinear sampling. Inverse-mapped, so every destination pixel is filled.
  function warpPerspective(rgba, w, h, coeffs, dstW, dstH) {
    const [a, bb, c, d, e, f, g, i] = coeffs;
    // Invert the 3x3 [a b c; d e f; g i 1] to map destination back to source.
    const det = a * (e - f * i) - bb * (d - f * g) + c * (d * i - e * g);
    const inv = [
      (e - f * i) / det, (c * i - bb) / det, (bb * f - c * e) / det,
      (f * g - d) / det, (a - c * g) / det, (c * d - a * f) / det,
      (d * i - e * g) / det, (bb * g - a * i) / det, (a * e - bb * d) / det,
    ];
    const out = new Uint8ClampedArray(dstW * dstH * 4);
    for (let y = 0; y < dstH; y++) {
      for (let x = 0; x < dstW; x++) {
        const den = inv[6] * x + inv[7] * y + inv[8];
        const sx = (inv[0] * x + inv[1] * y + inv[2]) / den;
        const sy = (inv[3] * x + inv[4] * y + inv[5]) / den;
        const o = (y * dstW + x) * 4;
        if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) { out[o + 3] = 255; continue; }
        const x0 = sx | 0, y0 = sy | 0;
        const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
        const fx = sx - x0, fy = sy - y0;
        for (let ch = 0; ch < 4; ch++) {
          const p00 = rgba[(y0 * w + x0) * 4 + ch], p10 = rgba[(y0 * w + x1) * 4 + ch];
          const p01 = rgba[(y1 * w + x0) * 4 + ch], p11 = rgba[(y1 * w + x1) * 4 + ch];
          out[o + ch] = (p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy)
                       + p01 * (1 - fx) * fy + p11 * fx * fy + 0.5) | 0;
        }
        out[o + 3] = 255;
      }
    }
    return out;
  }

  // Order 4 points into [TL, TR, BR, BL] in perimeter clockwise order.
  // Sorts by polar angle around the centroid so the resulting polygon is convex
  // and mathematically guaranteed to never cross itself (eliminates hourglass/bowtie).
  function orderQuad(pts) {
    if (!pts || pts.length !== 4) return pts;
    const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
    const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;

    const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));

    let tlIdx = 0, minScore = Infinity;
    for (let i = 0; i < 4; i++) {
      const score = sorted[i].x + sorted[i].y;
      if (score < minScore) {
        minScore = score;
        tlIdx = i;
      }
    }

    const pTL = sorted[tlIdx];
    const pNext = sorted[(tlIdx + 1) % 4];
    const pPrev = sorted[(tlIdx + 3) % 4];

    if (pNext.x - pTL.x > pPrev.x - pTL.x || pPrev.y - pTL.y > pNext.y - pTL.y) {
      return [sorted[tlIdx], sorted[(tlIdx + 1) % 4], sorted[(tlIdx + 2) % 4], sorted[(tlIdx + 3) % 4]];
    } else {
      return [sorted[tlIdx], sorted[(tlIdx + 3) % 4], sorted[(tlIdx + 2) % 4], sorted[(tlIdx + 1) % 4]];
    }
  }

  return { getPerspectiveTransform, warpPerspective, orderQuad };
})();

// frontend/src/utils/detectResult.js
const OLD_DETECTRESULT = (() => {
  // Below this the SimCC peaks are flat: the model is not looking at a card.
  const SHARPNESS_GATE = 0.02;

  // Order 4 points into [TL, TR, BR, BL] in perimeter clockwise order.
  // Sorts by polar angle around the centroid so the resulting polygon is convex
  // and mathematically guaranteed to never cross itself (eliminates hourglass/bowtie).
  function orderQuad(pts) {
    if (!pts || pts.length !== 4) return pts;
    const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
    const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
    const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    let tlIdx = 0, minScore = Infinity;
    for (let i = 0; i < 4; i++) {
      const score = sorted[i].x + sorted[i].y;
      if (score < minScore) { minScore = score; tlIdx = i; }
    }
    const pTL = sorted[tlIdx];
    const pNext = sorted[(tlIdx + 1) % 4];
    const pPrev = sorted[(tlIdx + 3) % 4];
    if (pNext.x - pTL.x > pPrev.x - pTL.x || pPrev.y - pTL.y > pNext.y - pTL.y) {
      return [sorted[tlIdx], sorted[(tlIdx + 1) % 4], sorted[(tlIdx + 2) % 4], sorted[(tlIdx + 3) % 4]];
    } else {
      return [sorted[tlIdx], sorted[(tlIdx + 3) % 4], sorted[(tlIdx + 2) % 4], sorted[(tlIdx + 1) % 4]];
    }
  }

  return { SHARPNESS_GATE, orderQuad };
})();

// frontend/src/utils/scanTensor.js
const OLD_SCANTENSOR = (() => {
  const MEAN = [0.485, 0.456, 0.406];
  const STD = [0.229, 0.224, 0.225];

  function rgbaToChw(rgba, size) {
    const plane = size * size;
    const x = new Float32Array(3 * plane);
    for (let p = 0; p < plane; p++) {
      x[p] = (rgba[p * 4] / 255 - MEAN[0]) / STD[0];
      x[plane + p] = (rgba[p * 4 + 1] / 255 - MEAN[1]) / STD[1];
      x[2 * plane + p] = (rgba[p * 4 + 2] / 255 - MEAN[2]) / STD[2];
    }
    return x;
  }

  return { MEAN, STD, rgbaToChw };
})();

// frontend/src/utils/detectWorker.js. `ort` there is onnxruntime-web; its Tensor
// only carries the data, so a stand-in that does the same is enough here.
const OLD_DETECTWORKER = (() => {
  const ort = { Tensor: class { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } } };
  const CORN_SIZE = 384;
  const MEAN = [0.485, 0.456, 0.406];
  const STD = [0.229, 0.224, 0.225];

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
    throw new Error('the resize path is unchanged and not compared here');
  }

  return { CORN_SIZE, MEAN, STD, toTensor };
})();

// frontend/src/device/scanEngine.js: its constants, and the arithmetic half of
// its detectAndDewarp (orderQuad and getPerspectiveTransform were imgproc's).
const OLD_SCANENGINE = (() => {
  const { getPerspectiveTransform, orderQuad } = OLD_IMGPROC;
  const { rgbaToChw } = OLD_SCANTENSOR;
  const EMBED = 448;
  const CORN = 384;
  const SHARPNESS_GATE = 0.02;   // cvScan's: below it cornelius is not looking at a card
  const SOURCE_MAX = 1200;       // cvScan's decode width for the dewarp source

  function transform(c, w, h) {
    // orderQuad, not the model's own order: cornelius emits BL, BR, TL, TR, which is
    // not the order its model card documents. cvScan sorts the same way.
    const src = orderQuad([0, 1, 2, 3].map(k => ({ x: c[k * 2] * w, y: c[k * 2 + 1] * h })));
    const dst = [{ x: 0, y: 0 }, { x: EMBED - 1, y: 0 }, { x: EMBED - 1, y: EMBED - 1 }, { x: 0, y: EMBED - 1 }];
    const M = getPerspectiveTransform(src, dst);
    return { src, M };
  }

  return { EMBED, CORN, SHARPNESS_GATE, SOURCE_MAX, rgbaToChw, transform };
})();

// ---- Inputs ---------------------------------------------------------------------

// mulberry32: the same inputs on every run.
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261115);

// A card as cornelius sees one: a 63x88 rectangle, scaled, turned `angle`
// degrees, its top edge narrowed by `persp` (tilted away from the camera), and
// returned in the model's own BL, BR, TL, TR order as 0..1 fractions.
function cardCorners({ cx = 0.5, cy = 0.5, scale = 0.6, angle = 0, persp = 0, aspect = 1 }) {
  const hh = scale / 2, hw = (hh * 63 / 88) / aspect;
  const local = [[-hw, hh], [hw, hh], [-hw * (1 - persp), -hh], [hw * (1 - persp), -hh]];   // BL, BR, TL, TR
  const r = angle * Math.PI / 180;
  return Float32Array.from(local.flatMap(([x, y]) => [
    cx + (x * Math.cos(r) - y * Math.sin(r)) * aspect,
    cy + x * Math.sin(r) + y * Math.cos(r),
  ]));
}

// Corner sets: plausible cards at every angle and tilt, cards bleeding off the
// frame, random points (crossed and concave quads included), and the degenerate
// ones that decide the singular branch.
function cornerSets() {
  const sets = [];
  for (let angle = 0; angle < 360; angle += 7) {
    sets.push(cardCorners({ angle, persp: (angle % 3) * 0.15, cx: 0.4 + rand() * 0.2, cy: 0.4 + rand() * 0.2 }));
  }
  sets.push(cardCorners({ scale: 1.3 }), cardCorners({ cx: 0.9, angle: 12 }), cardCorners({ scale: 0.05, angle: 45 }));
  for (let n = 0; n < 60; n++) sets.push(Float32Array.from({ length: 8 }, () => rand() * 1.4 - 0.2));
  sets.push(
    new Float32Array(8).fill(0.5),                                // one point
    Float32Array.of(0.2, 0.2, 0.2, 0.2, 0.8, 0.8, 0.8, 0.8),      // two points
    Float32Array.of(0.1, 0.1, 0.3, 0.3, 0.6, 0.6, 0.9, 0.2),      // three in a line
    Float32Array.of(0.1, 0.5, 0.3, 0.5, 0.6, 0.5, 0.9, 0.5),      // all in a line
    Float32Array.of(0, 0, 1, 0, 1, 1, 0, 1),                      // the frame itself
    new Float32Array(8),                                          // all zero
    Float32Array.of(NaN, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9),      // a NaN corner
    Float32Array.of(Infinity, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9), // an infinite one
  );
  return sets;
}

// Points in pixels for the geometry alone: the corner sets above at the frame
// sizes the callers use, every order of each, plus exact ties and non-quads.
const FRAMES = [[1200, 900], [1200, 1600], [1200, 675], [1080, 1920], [800, 600], [384, 384], [448, 448], [1, 1]];
function pointSets() {
  const sets = [];
  const perms = [[0, 1, 2, 3], [3, 2, 1, 0], [2, 3, 1, 0], [1, 0, 3, 2], [2, 0, 3, 1], [0, 2, 1, 3]];
  for (const c of cornerSets()) {
    for (const [w, h] of FRAMES) {
      const pts = [0, 1, 2, 3].map(k => ({ x: c[k * 2] * w, y: c[k * 2 + 1] * h }));
      for (const p of perms) sets.push(p.map(i => pts[i]));
    }
  }
  // A diamond centred on its centroid exactly, so angles tie at +/-pi and 0.
  sets.push([{ x: 0, y: 1 }, { x: 1, y: 0 }, { x: 2, y: 1 }, { x: 1, y: 2 }]);
  sets.push([{ x: -0, y: 0 }, { x: 0, y: -0 }, { x: 0, y: 0 }, { x: -0, y: -0 }]);
  sets.push([{ x: 1e9, y: -1e9 }, { x: -1e9, y: 1e9 }, { x: 1e-9, y: 1e-9 }, { x: 3, y: 4 }]);
  return sets;
}

const noise = (n, Type = Uint8Array) => {
  const a = new Type(n);
  for (let i = 0; i < n; i++) a[i] = (rand() * 256) | 0;
  return a;
};
// Every byte value in every channel, at an offset per channel so no two match.
function everyValue(size, channels, Type = Uint8Array) {
  const a = new Type(size * size * channels);
  for (let p = 0; p < size * size; p++) for (let c = 0; c < channels; c++) a[p * channels + c] = (p + c * 85) & 255;
  return a;
}

// ---- Comparisons ----------------------------------------------------------------

const bytesOf = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
function sameArray(a, b, what) {
  assert.strictEqual(Object.getPrototypeOf(a), Object.getPrototypeOf(b), `${what}: ${a.constructor.name} vs ${b.constructor.name}`);
  assert.strictEqual(a.length, b.length, `${what}: length ${a.length} vs ${b.length}`);
  if (bytesOf(a).equals(bytesOf(b))) return;
  const i = a.findIndex((v, k) => !Object.is(v, b[k]));
  assert.fail(`${what}: first difference at [${i}]: ${a[i]} vs ${b[i]}`);
}
function sameNumbers(a, b, what) {
  if (a === null || b === null) return assert.strictEqual(a, b, `${what}: ${a} vs ${b}`);
  assert.strictEqual(a.length, b.length, `${what}: length`);
  for (let i = 0; i < a.length; i++) assert.ok(Object.is(a[i], b[i]), `${what}[${i}]: ${a[i]} vs ${b[i]}`);
}
function samePoints(a, b, what) {
  assert.strictEqual(a.length, b.length, `${what}: length`);
  a.forEach((p, i) => assert.ok(Object.is(p.x, b[i].x) && Object.is(p.y, b[i].y),
    `${what}[${i}]: (${p.x}, ${p.y}) vs (${b[i].x}, ${b[i].y})`));
}
function sameTensor(a, b, what) {
  assert.strictEqual(a.type, b.type, `${what}: type`);
  assert.deepStrictEqual(Array.from(a.dims), Array.from(b.dims), `${what}: dims`);
  sameArray(a.data, b.data, `${what}: data`);
}

// ---- The tests ------------------------------------------------------------------

function testConstants() {
  const m = scanModel;
  for (const old of [OLD_CVSCAN.SHARPNESS_GATE, OLD_DETECTRESULT.SHARPNESS_GATE, OLD_SCANENGINE.SHARPNESS_GATE]) {
    assert.ok(Object.is(m.SHARPNESS_GATE, old), 'SHARPNESS_GATE');
  }
  for (const old of [OLD_CVSCAN.CORN_SIZE, OLD_DETECTWORKER.CORN_SIZE, OLD_SCANENGINE.CORN]) assert.strictEqual(m.CORN_SIZE, old);
  for (const old of [OLD_CVSCAN.EMBED_SIZE, OLD_CATALOG.SIZE, OLD_SCANENGINE.EMBED]) assert.strictEqual(m.EMBED_SIZE, old);
  // cvScan wrote its 1200 inline; device mode named it SOURCE_MAX.
  assert.strictEqual(m.DEWARP_SOURCE_WIDTH, OLD_SCANENGINE.SOURCE_MAX);
  assert.strictEqual(m.DEWARP_SOURCE_WIDTH, 1200);
  // Every other number the paths compute from comes from MEAN and STD.
  for (const old of [OLD_CVSCAN, OLD_CATALOG, OLD_SCANTENSOR, OLD_DETECTWORKER]) {
    sameNumbers(m.MEAN, old.MEAN, 'MEAN');
    sameNumbers(m.STD, old.STD, 'STD');
  }
  assert.ok(Object.isFrozen(m.MEAN) && Object.isFrozen(m.STD), 'one copy, so nobody may change it under the others');
}

// MODEL_DIR was spelled out in cvScan, catalog and modelAssets; the first two
// read modelAssets' now.
function testModelDir() {
  assert.strictEqual(modelAssets.MODEL_DIR, OLD_CVSCAN.MODEL_DIR);
  assert.strictEqual(modelAssets.MODEL_DIR, OLD_CATALOG.MODEL_DIR);
  assert.strictEqual(modelAssets.MODEL_DIR, OLD_MODELASSETS_DIR);
  for (const [game, lang] of [['mtg'], ['mtg', 'English'], ['pokemon', 'Japanese'], ['lorcana', 'German']]) {
    assert.strictEqual(catalog.binPath(game, lang), OLD_CATALOG.binPath(game, lang));
    assert.strictEqual(catalog.metaPath(game, lang), OLD_CATALOG.metaPath(game, lang));
  }
  // Without CV_MODEL_DIR the three wrote the default from different directories.
  assert.strictEqual(path.join(SRC, '..', 'data', 'models'), path.join(SRC, 'utils', '..', '..', 'data', 'models'));
  // cvScan looks for the models and catalogs in that same directory.
  fs.mkdirSync(modelAssets.MODEL_DIR, { recursive: true });
  assert.strictEqual(cvScan.isBuilt('mtg'), false);
  for (const f of ['cornelius.onnx', 'milo.onnx', 'milo-mtg.npz']) fs.writeFileSync(path.join(modelAssets.MODEL_DIR, f), '');
  assert.strictEqual(cvScan.isBuilt('mtg'), true, 'cvScan reads CV_MODEL_DIR through modelAssets');
}

function testOrderQuad() {
  const sets = pointSets();
  for (const pts of sets) {
    const now = imgproc.orderQuad(pts);
    for (const old of [OLD_CVSCAN.orderQuad, OLD_IMGPROC.orderQuad, OLD_DETECTRESULT.orderQuad]) {
      const was = old(pts);
      assert.strictEqual(now.length, was.length);
      // The same point objects in the same order, not just equal values.
      now.forEach((p, i) => assert.strictEqual(p, was[i], `orderQuad of ${JSON.stringify(pts)}`));
    }
  }
  const p = { x: 1, y: 2 };
  for (const odd of [null, undefined, [], [p], [p, p, p], [p, p, p, p, p]]) {
    assert.strictEqual(imgproc.orderQuad(odd), OLD_CVSCAN.orderQuad(odd));
    assert.strictEqual(imgproc.orderQuad(odd), OLD_IMGPROC.orderQuad(odd));
  }
  return sets.length;
}

function testHomography() {
  const n = 447;
  const square = [{ x: 0, y: 0 }, { x: n, y: 0 }, { x: n, y: n }, { x: 0, y: n }];
  const card = [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 700 }, { x: 0, y: 700 }];
  let nulls = 0;
  for (const src of pointSets()) {
    for (const dst of [square, card]) {
      sameNumbers(imgproc.getPerspectiveTransform(src, dst), OLD_IMGPROC.getPerspectiveTransform(src, dst), 'default');
      const was = OLD_CVSCAN.perspectiveTransform(src, dst);
      if (was === null) nulls++;
      sameNumbers(imgproc.getPerspectiveTransform(src, dst, { nullIfSingular: true }), was, 'nullIfSingular');
    }
  }
  assert.ok(nulls > 0, 'some quads must have reached the singular branch');
}

// Corners to homography, as the server's dewarp and device mode's each did it.
function testDewarpTransform() {
  let nulls = 0, cases = 0;
  for (const c of cornerSets()) {
    for (const [w, h] of FRAMES) {
      cases++;
      // cvScan
      const pts = [];
      for (let k = 0; k < 4; k++) pts.push({ x: c[k * 2] * w, y: c[k * 2 + 1] * h });
      const src = OLD_CVSCAN.orderQuad(pts);
      const dst = [
        { x: 0, y: 0 }, { x: OLD_CVSCAN.EMBED_SIZE - 1, y: 0 },
        { x: OLD_CVSCAN.EMBED_SIZE - 1, y: OLD_CVSCAN.EMBED_SIZE - 1 }, { x: 0, y: OLD_CVSCAN.EMBED_SIZE - 1 },
      ];
      const M = OLD_CVSCAN.perspectiveTransform(src, dst);
      if (M === null) nulls++;
      const server = scanModel.dewarpTransform(c, w, h, { nullIfSingular: true });
      samePoints(server.quad, src, 'server quad');
      sameNumbers(server.M, M, 'server M');
      // device mode
      const was = OLD_SCANENGINE.transform(c, w, h);
      const device = scanModel.dewarpTransform(c, w, h);
      samePoints(device.quad, was.src, 'device quad');
      sameNumbers(device.M, was.M, 'device M');
    }
  }
  assert.ok(nulls > 0 && nulls < cases, 'both branches must have been taken');
}

// Homographies like the dewarps produce, onto the sizes they produce.
function homographies(w, h, dw, dh) {
  const dst = [{ x: 0, y: 0 }, { x: dw - 1, y: 0 }, { x: dw - 1, y: dh - 1 }, { x: 0, y: dh - 1 }];
  const out = [];
  for (const c of [
    cardCorners({}), cardCorners({ angle: 90 }), cardCorners({ angle: 33, persp: 0.3 }), cardCorners({ angle: 200, scale: 0.9 }),
    cardCorners({ scale: 1.4, angle: 10 }),            // samples outside the frame
    Float32Array.of(0, 0, 1, 0, 1, 1, 0, 1),           // the whole frame
  ]) {
    out.push(OLD_IMGPROC.getPerspectiveTransform(OLD_IMGPROC.orderQuad([0, 1, 2, 3].map(k => ({ x: c[k * 2] * w, y: c[k * 2 + 1] * h }))), dst));
  }
  // The default path's answer to a single point: what device mode warps through.
  out.push(OLD_IMGPROC.getPerspectiveTransform([0, 1, 2, 3].map(() => ({ x: w / 2, y: h / 2 })), dst));
  out.push([1, 0, 0, 0, 1, 0, 0, 0]);                  // identity
  out.push([NaN, 0, 0, 0, 1, 0, 0, 0]);                // NaN source coordinates
  return out;
}

function testWarps() {
  // RGBA: device mode's dewarp source (1200 wide), the browser's guide-box crop,
  // the contour detector (384 -> 500x700), and frames small enough to clamp.
  for (const [w, h, dw, dh] of [[1200, 1600, 448, 448], [720, 1008, 448, 448], [1200, 675, 448, 448],
    [384, 384, 500, 700], [1, 1, 4, 4], [3, 2, 5, 5]]) {
    const rgba = noise(w * h * 4, Uint8ClampedArray);
    for (const M of homographies(w, h, dw, dh)) {
      sameArray(imgproc.warpPerspective(rgba, w, h, M, dw, dh), OLD_IMGPROC.warpPerspective(rgba, w, h, M, dw, dh),
        `warpPerspective ${w}x${h} -> ${dw}x${dh}`);
    }
  }
  // RGB: the server's dewarp source as sharp decodes it (1200 wide, or smaller).
  for (const [w, h] of [[1200, 900], [1200, 1600], [1200, 675], [1080, 1920], [800, 600], [1, 1], [2, 3]]) {
    const rgb = noise(w * h * 3);
    for (const M of homographies(w, h, 448, 448)) {
      sameArray(imgproc.warpPerspectiveRgb(rgb, w, h, M, 448, 448), OLD_CVSCAN.warpRgb(rgb, w, h, M, 448),
        `warpPerspectiveRgb ${w}x${h}`);
    }
  }
}

// The full float32 tensors both models take.
function testTensors() {
  for (const size of [384, 448]) {
    const plane = size * size;
    const rgbs = [noise(plane * 3), Buffer.from(noise(plane * 3)), everyValue(size, 3), new Uint8Array(plane * 3),
      new Uint8Array(plane * 3).fill(255)];
    for (const rgb of rgbs) {
      // The server's scan, both models.
      sameTensor(cvScan.toTensor(rgb, size), OLD_CVSCAN.toTensor(rgb, size), `cvScan.toTensor ${size}`);
      // The catalog build, which embeds through cvScan.toTensor at 448 now.
      if (size === 448) sameTensor(cvScan.toTensor(rgb, scanModel.EMBED_SIZE), OLD_CATALOG.toTensor(rgb), 'catalog toTensor');
    }
    const rgbas = [noise(plane * 4, Uint8ClampedArray), everyValue(size, 4, Uint8ClampedArray), new Uint8ClampedArray(plane * 4)];
    for (const rgba of rgbas) {
      // Device mode's scan (scanTensor.rgbaToChw).
      sameArray(scanModel.imagenetChw(rgba, size, 4), OLD_SCANENGINE.rgbaToChw(rgba, size), `rgbaToChw ${size}`);
    }
  }
  // The detect worker's 384 path: its own affine table then, the shared one now,
  // into one buffer reused across frames.
  const reused = new Float32Array(3 * 384 * 384).fill(NaN);
  for (const rgba of [everyValue(384, 4, Uint8ClampedArray), noise(384 * 384 * 4, Uint8ClampedArray), new Uint8ClampedArray(384 * 384 * 4).fill(255)]) {
    const was = OLD_DETECTWORKER.toTensor(rgba, 384, 384).data;
    assert.strictEqual(scanModel.imagenetChw(rgba, scanModel.CORN_SIZE, 4, reused), reused);
    sameArray(reused, was, 'detectWorker 384 path');
  }
  // Anything but bytes takes the arithmetic, which is the old formula exactly:
  // fractional and out-of-range values, and values that normalise to about zero,
  // where a change far below one float32 step at 1 still shows.
  const nearZero = OLD_CVSCAN.MEAN.map(m => m * 255);
  const odd = (channels) => {
    const a = [];
    for (let p = 0; p < 64; p++) {
      for (let c = 0; c < channels; c++) {
        a.push(p < 8 ? (nearZero[c] ?? 255) + (p - 4) * 1e-6 : [0, 255, 127.5, -3.25, 300, 1e-9, 0.5, 254.5][p % 8] + (p % 7) / 3);
      }
    }
    return a;
  };
  sameTensor(cvScan.toTensor(odd(3), 8), OLD_CVSCAN.toTensor(odd(3), 8), 'plain array');
  sameTensor(cvScan.toTensor(Float32Array.from(odd(3)), 8), OLD_CVSCAN.toTensor(Float32Array.from(odd(3)), 8), 'Float32Array');
  sameArray(scanModel.imagenetChw(odd(4), 8, 4), OLD_SCANTENSOR.rgbaToChw(odd(4), 8), 'plain RGBA array');
  // A short buffer: the missing pixels are NaN either way.
  const short = noise(100);
  sameTensor(cvScan.toTensor(short, 8), OLD_CVSCAN.toTensor(short, 8), 'short buffer');
  const shortRgba = noise(30, Uint8ClampedArray);
  sameArray(scanModel.imagenetChw(shortRgba, 4, 4), OLD_SCANTENSOR.rgbaToChw(shortRgba, 4), 'short RGBA');
}

// The server's whole dewarp, decode to crop, against the one it replaced: real
// photo sizes through sharp, a stand-in cornelius answering each corner set.
async function testServerDewarp() {
  const session = (corners, sharpness) => {
    const seen = [];
    return {
      seen,
      run: async ({ image }) => {
        seen.push(image);
        return { corners: { data: corners }, ...(sharpness === undefined ? {} : { sharpness: { data: Float32Array.of(sharpness) } }) };
      },
    };
  };
  const all = cornerSets();
  const few = [all[0], all[13], all[40], all[all.length - 8], all[all.length - 1]];
  const branches = { detected: 0, gate: 0, singular: 0 };
  for (const [w, h, format, sets] of [
    [4032, 3024, 'jpeg', few], [3024, 4032, 'jpeg', few], [1920, 1080, 'png', few], [1080, 1920, 'jpeg', all],
    [1200, 1600, 'jpeg', few], [800, 600, 'png', few], [384, 384, 'jpeg', few],
  ]) {
    const photo = await sharp({ create: { width: w, height: h, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } })
      .toFormat(format).toBuffer();
    for (const corners of sets) {
      for (const sharpness of [0.9, undefined, scanModel.SHARPNESS_GATE, 0.001, NaN]) {
        if (sharpness !== 0.9 && corners !== sets[0]) continue;   // the gate needs one corner set, not all
        const a = session(corners, sharpness), b = session(corners, sharpness);
        const was = await OLD_CVSCAN.detectAndDewarp(a, photo);
        const now = await cvScan.detectAndDewarp(b, photo);
        const what = `${w}x${h} ${format}, corners ${Array.from(corners).map(v => +v.toFixed(3))}, sharpness ${sharpness}`;
        sameTensor(b.seen[0], a.seen[0], `cornelius input, ${what}`);
        assert.deepStrictEqual(Object.keys(now), Object.keys(was), what);
        sameArray(now.rgb, was.rgb, `crop, ${what}`);
        assert.strictEqual(now.detected, was.detected, what);
        assert.ok(Object.is(now.sharpness, was.sharpness), what);
        if (was.corners) samePoints(now.corners, was.corners, `corners, ${what}`);
        if (was.detected) branches.detected++;
        else if (!(was.sharpness > OLD_CVSCAN.SHARPNESS_GATE)) branches.gate++;
        else branches.singular++;
      }
    }
  }
  for (const [branch, n] of Object.entries(branches)) assert.ok(n > 0, `the ${branch} branch was never taken`);
  return branches;
}

// The frontend modules hand out the shared functions themselves.
async function testFrontendExports() {
  const detectResult = await import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'detectResult.js')).href);
  assert.strictEqual(detectResult.orderQuad, imgproc.orderQuad);
  assert.strictEqual(detectResult.SHARPNESS_GATE, scanModel.SHARPNESS_GATE);
}

async function cleanup() {
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

(async () => {
  try {
    testConstants();
    testModelDir();
    const quads = testOrderQuad();
    testHomography();
    testDewarpTransform();
    testWarps();
    testTensors();
    const branches = await testServerDewarp();
    await testFrontendExports();
    console.log(`scanshared.test.js: OK (${quads} quads; server dewarps ${JSON.stringify(branches)})`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();
