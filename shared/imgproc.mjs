// The image-processing primitives the card detector needs, in plain JavaScript.
//
// This exists so detection can run in the BROWSER. Every prebuilt OpenCV.js is
// 11-22 MB because it carries the whole library; phones could not instantiate it
// at all, which made local detection impossible and forced a server round trip
// per preview frame. The detector needs perhaps a dozen operations out of that
// library, and they are all small.
//
// Everything here works on plain typed arrays and allocates its own output, so
// there is no handle to free and nothing to leak — which also removes the class
// of bug the wasm version kept producing (a Mat left undeleted killing scanning
// after N cards).
//
// These are faithful to OpenCV's behaviour where it matters for the detector,
// and deliberately not general: single-channel 8-bit only, rectangular kernels
// only, no borders beyond replicate/zero. backend/test/clientcrop.test.js runs the
// detector these back through the same crop the browser produces.

// Scratch buffers, reused across calls.
//
// Every stage here produces a full-frame array, and the detector runs four
// segmentations per frame several times a second. Allocating them fresh each time
// hands the collector megabytes per second of garbage — enough that the live
// preview visibly degraded and then stopped. Keyed by size so a changed frame
// size simply allocates a new set.
const scratch = new Map();
function buf(kind, len, Type) {
  const key = `${kind}:${len}`;
  let b = scratch.get(key);
  if (!b) { b = new Type(len); scratch.set(key, b); }
  return b;
}
// Callers that hand a buffer onward (masks kept for the whole detect pass) ask
// for an owned one instead.
function owned(len, Type) { return new Type(len); }

// RGBA -> single channel luma, matching cv.COLOR_RGBA2GRAY (BT.601 weights,
// which is what OpenCV uses despite the name).
export function rgbaToGray(rgba, w, h) {
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    // OpenCV rounds rather than truncates; the half-LSB matters at threshold
    // boundaries, where a whole contour can appear or vanish.
    out[p] = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114 + 0.5) | 0;
  }
  return out;
}

// Separable 5x5 Gaussian, sigma derived the way cv.GaussianBlur does for a
// zero sigma: sigma = 0.3*((ksize-1)*0.5 - 1) + 0.8, which for k=5 is 1.1.
// Border handling is replicate, matching OpenCV's default.
export function gaussianBlur5(src, w, h) {
  const K = [0.0625, 0.25, 0.375, 0.25, 0.0625];   // normalised [1,4,6,4,1]/16
  const tmp = buf('f32', w * h, Float32Array);
  const out = owned(w * h, Uint8ClampedArray);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) s += src[row + clamp(x + i, 0, w - 1)] * K[i + 2];
      tmp[row + x] = s;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) s += tmp[clamp(y + i, 0, h - 1) * w + x] * K[i + 2];
      out[y * w + x] = (s + 0.5) | 0;
    }
  }
  return out;
}

// Otsu's threshold value: the level maximising between-class variance.
export function otsuLevel(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = t; }
  }
  return best;
}

// Binary threshold at Otsu's level. `invert` gives THRESH_BINARY_INV.
export function otsuThreshold(gray, invert) {
  const level = otsuLevel(gray);
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const on = gray[i] > level;
    out[i] = (invert ? !on : on) ? 255 : 0;
  }
  return out;
}

// Rectangular dilate/erode via the van Herk / Gil-Werman running extremum:
// THREE comparisons per pixel per axis regardless of kernel size, instead of one
// per kernel element. The detector closes with a kernel around 15px on a 384px
// frame, so the naive form costs ~30 comparisons per pixel per pass — which is
// most of why the first pure-JS attempt ran 15x slower than OpenCV.
//
// The trick: split each row into windows of k, precompute a forward running
// extremum within each window and a backward one, then any k-length span is the
// combination of one value from each.
function morph1d(src, dst, len, stride, count, k, isDilate) {
  const pick = isDilate ? Math.max : Math.min;
  const pad = isDilate ? 0 : 255;
  const r = k >> 1;
  const pre = new Uint8Array(len);
  const suf = new Uint8Array(len);
  for (let c = 0; c < count; c++) {
    const base = c * (stride === 1 ? len : 1);
    const idx = (i) => base + i * stride;
    for (let i = 0; i < len; i++) {
      pre[i] = (i % k === 0) ? src[idx(i)] : pick(pre[i - 1], src[idx(i)]);
    }
    for (let i = len - 1; i >= 0; i--) {
      suf[i] = (i === len - 1 || (i + 1) % k === 0) ? src[idx(i)] : pick(suf[i + 1], src[idx(i)]);
    }
    for (let i = 0; i < len; i++) {
      const lo = i - r, hi = i + r;
      const a = lo >= 0 ? suf[lo] : pad;
      const b = hi < len ? pre[hi] : pad;
      dst[idx(i)] = pick(a, b);
    }
  }
}

function morph(src, w, h, kw, kh, isDilate) {
  const tmp = buf('m8', w * h, Uint8Array);
  const out = owned(w * h, Uint8Array);
  morph1d(src, tmp, w, 1, h, kw, isDilate);      // rows
  morph1d(tmp, out, h, w, w, kh, isDilate);      // columns
  return out;
}

export const dilate = (src, w, h, kw, kh) => morph(src, w, h, kw, kh, true);
export const erode = (src, w, h, kw, kh) => morph(src, w, h, kw, kh, false);
// MORPH_CLOSE: dilate then erode. Fills gaps smaller than the kernel.
export const morphClose = (src, w, h, kw, kh) => erode(dilate(src, w, h, kw, kh), w, h, kw, kh);

// Canny edges: Sobel gradients, non-maximum suppression, hysteresis.
//
// L2gradient is false to match the detector's existing call (OpenCV's default),
// so magnitude is |gx| + |gy| rather than the true norm.
export function canny(gray, w, h, loThresh, hiThresh) {
  const gx = buf('gx', w * h, Int32Array);
  const gy = buf('gy', w * h, Int32Array);
  const at = (x, y) => gray[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      gx[i] = -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)
            + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      gy[i] = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)
            + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
    }
  }
  const mag = buf('mag', w * h, Int32Array);
  for (let i = 0; i < mag.length; i++) mag[i] = Math.abs(gx[i]) + Math.abs(gy[i]);

  // Non-maximum suppression along the gradient direction, quantised to the four
  // discrete orientations OpenCV uses.
  const keep = buf('keep', w * h, Uint8Array); keep.fill(0);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < loThresh) continue;
      const ax = Math.abs(gx[i]), ay = Math.abs(gy[i]);
      let a, b;
      if (ax > ay * 2.414214) { a = mag[i - 1]; b = mag[i + 1]; }                    // ~horizontal
      else if (ay > ax * 2.414214) { a = mag[i - w]; b = mag[i + w]; }               // ~vertical
      else if ((gx[i] ^ gy[i]) >= 0) { a = mag[i - w - 1]; b = mag[i + w + 1]; }     // diagonal
      else { a = mag[i - w + 1]; b = mag[i + w - 1]; }
      if (m >= a && m >= b) keep[i] = m >= hiThresh ? 2 : 1;                          // 2 = strong
    }
  }

  // Hysteresis: strong edges seed, weak edges survive only if reachable.
  const out = owned(w * h, Uint8Array);
  const stack = [];
  for (let i = 0; i < keep.length; i++) if (keep[i] === 2) { out[i] = 255; stack.push(i); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (keep[n] === 1 && !out[n]) { out[n] = 255; stack.push(n); }
      }
    }
  }
  return out;
}

// Connected regions of a binary image, as { area, boundary } — what the card
// detector actually consumes.
//
// NOT an ordered contour trace. Reproducing OpenCV's border following turned out
// to be both slow and only ~70% faithful, and it was unnecessary: the detector
// takes each contour straight to convexHull() and works from that. A hull needs a
// point SET, not an ordered loop, so labelling regions and keeping their boundary
// pixels gives the same answer far more cheaply and with nothing to get subtly
// wrong about traversal order.
//
// Two-pass union-find labelling with 8-connectivity, matching the connectivity
// OpenCV uses for foreground in findContours.
//
// Holes matter as much as blobs: photographed on a playmat or binder page the
// whole surface is one region and the CARD is a hole inside it. So background
// regions that do not touch the frame border are returned too — that case is
// what RETR_LIST was chosen for in the first place.
// Fill enclosed background so a region's pixel count matches the area OpenCV
// reports for its outer contour, which is a POLYGON area and therefore counts
// holes as part of the region. `fill` in the detector's score is area divided by
// quad area, so getting this wrong silently changes which region wins.
//
// Flood from the border on the background: whatever is not reached is enclosed.
function fillHoles(bin, w, h) {
  const out = Uint8Array.from(bin);
  const seen = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    const i = y * w + x;
    if (seen[i] || bin[i]) return;
    seen[i] = 1; stack.push(i);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  for (let i = 0; i < out.length; i++) if (!bin[i] && !seen[i]) out[i] = 255;
  return out;
}

export function connectedRegions(bin, w, h, minArea) {
  const n = w * h;
  const labels = buf('lbl', n, Int32Array);
  const parent = [0];
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };

  const out = [];
  // Foreground is labelled on the HOLE-FILLED mask so each region's area counts
  // its holes, as OpenCV's contourArea does. Background is labelled on the
  // ORIGINAL mask, which is what surfaces the holes themselves as candidates —
  // the card-on-a-playmat case.
  const filled = fillHoles(bin, w, h);
  for (const wantFg of [true, false]) {
    const srcMask = wantFg ? filled : bin;
    labels.fill(0);
    parent.length = 1;
    let next = 1;
    const is = (i) => (wantFg ? srcMask[i] > 0 : srcMask[i] === 0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!is(i)) continue;
        let lbl = 0;
        // Previously-visited 8-neighbours: W, NW, N, NE.
        for (const [dx, dy] of [[-1, 0], [-1, -1], [0, -1], [1, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w) continue;
          const nl = labels[ny * w + nx];
          if (!nl) continue;
          if (!lbl) lbl = nl; else union(lbl, nl);
        }
        if (!lbl) { lbl = next++; parent[lbl] = lbl; }
        labels[i] = lbl;
      }
    }
    // Accumulate per label: area, border contact, and an INCREMENTAL convex hull.
    //
    // The hull is built as pixels arrive rather than by collecting every boundary
    // point and hulling afterwards. A single mask can have thousands of boundary
    // pixels, and materialising them as {x,y} objects for four masks several times
    // a second produced tens of thousands of short-lived objects per frame — GC
    // churn heavy enough that the preview degraded and eventually stalled.
    //
    // Callers only ever want the hull (minAreaRect and the quad approximation both
    // start by taking it), so the points never need to exist outside this loop.
    const acc = new Map();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!labels[i]) continue;
        const root = find(labels[i]);
        let a = acc.get(root);
        if (!a) { a = { area: 0, pts: [], touchesBorder: false }; acc.set(root, a); }
        a.area++;
        const onFrame = x === 0 || y === 0 || x === w - 1 || y === h - 1;
        if (onFrame) a.touchesBorder = true;
        // A boundary pixel has at least one 4-neighbour outside the region; the
        // hull of a region equals the hull of its boundary.
        if (onFrame || !is(i - 1) || !is(i + 1) || !is(i - w) || !is(i + w)) {
          a.pts.push(x, y);          // packed, no per-point object
        }
      }
    }
    for (const a of acc.values()) {
      if (a.area < minArea) continue;
      // A background region touching the frame edge is just the background, not a
      // hole — and the frame itself is never the card.
      if (!wantFg && a.touchesBorder) continue;
      out.push({ area: a.area, hull: convexHullPacked(a.pts) });
    }
  }
  return out;
}

// Perimeter of a closed polygon, matching cv.arcLength(closed=true).
export function arcLength(pts) {
  let L = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    L += Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
  }
  return L;
}

// Convex hull of points packed as a flat [x0,y0,x1,y1,...] number array.
//
// Same monotone chain as convexHull, but it sorts an index array rather than
// building point objects — the packed form exists precisely so a region's
// thousands of boundary pixels never become objects.
export function convexHullPacked(flat) {
  const n = flat.length >> 1;
  if (n < 3) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ x: flat[i * 2], y: flat[i * 2 + 1] });
    return out;
  }
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const X = (i) => flat[i * 2], Y = (i) => flat[i * 2 + 1];
  const order = Array.prototype.sort.call(idx, (a, b) => (X(a) - X(b)) || (Y(a) - Y(b)));
  const cross = (o, a, b) => (X(a) - X(o)) * (Y(b) - Y(o)) - (Y(a) - Y(o)) * (X(b) - X(o));
  const lower = [];
  for (let k = 0; k < n; k++) {
    const q = order[k];
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let k = n - 1; k >= 0; k--) {
    const q = order[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper).map((i) => ({ x: X(i), y: Y(i) }));
}

// Convex hull, counter-clockwise, via Andrew's monotone chain.
export function convexHull(pts) {
  if (pts.length < 3) return pts.slice();
  const p = pts.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// Douglas-Peucker simplification of a closed polygon, matching cv.approxPolyDP.
export function approxPolyDP(pts, epsilon) {
  if (pts.length < 3) return pts.slice();
  // For a closed curve OpenCV splits at the two extreme points first.
  let iFar = 0, dFar = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i].x - pts[0].x) ** 2 + (pts[i].y - pts[0].y) ** 2;
    if (d > dFar) { dFar = d; iFar = i; }
  }
  const simplify = (start, end, out) => {
    const a = pts[start], b = pts[end];
    let idx = -1, max = 0;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    for (let i = start + 1; i < end; i++) {
      const d = Math.abs((pts[i].x - a.x) * dy - (pts[i].y - a.y) * dx) / len;
      if (d > max) { max = d; idx = i; }
    }
    if (max > epsilon && idx > 0) {
      simplify(start, idx, out);
      out.push(pts[idx]);
      simplify(idx, end, out);
    }
  };
  const res = [pts[0]];
  simplify(0, iFar, res);
  res.push(pts[iFar]);
  simplify(iFar, pts.length - 1, res);
  return res;
}

// Is a polygon convex? Matches cv.isContourConvex — all cross products agree.
export function isContourConvex(pts) {
  if (pts.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], c = pts[(i + 2) % pts.length];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cr !== 0) {
      const s = cr > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

// Minimum-area enclosing rectangle, via rotating calipers over the hull.
// Returns { center:{x,y}, size:{width,height}, points:[4] } like cv.minAreaRect
// plus the corner points, since every caller here wants those.
export function minAreaRect(pts) {
  const hull = convexHull(pts);
  if (hull.length < 3) {
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    return {
      center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
      size: { width: x1 - x0, height: y1 - y0 },
      points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
    };
  }
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ex = b.x - a.x, ey = b.y - a.y;
    const len = Math.hypot(ex, ey) || 1;
    const ux = ex / len, uy = ey / len;      // edge direction
    const vx = -uy, vy = ux;                 // its normal
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const pu = p.x * ux + p.y * uy;
      const pv = p.x * vx + p.y * vy;
      if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) best = { area, ux, uy, vx, vy, minU, maxU, minV, maxV };
  }
  const { ux, uy, vx, vy, minU, maxU, minV, maxV } = best;
  const corner = (u, v) => ({ x: u * ux + v * vx, y: u * uy + v * vy });
  const points = [corner(minU, minV), corner(maxU, minV), corner(maxU, maxV), corner(minU, maxV)];
  const cu = (minU + maxU) / 2, cv2 = (minV + maxV) / 2;
  return {
    center: corner(cu, cv2),
    size: { width: maxU - minU, height: maxV - minV },
    points,
  };
}

// Perspective transform from 4 source points to 4 destination points, returned
// as the 8 coefficients of the 3x3 homography (h22 fixed at 1).
export function getPerspectiveTransform(src, dst) {
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
export function warpPerspective(rgba, w, h, coeffs, dstW, dstH) {
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
export function orderQuad(pts) {
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
