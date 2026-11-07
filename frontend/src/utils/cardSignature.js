// A coarse "what does the card in the quad look like" fingerprint.
//
// Auto-scan re-arms when the scene changes, and geometry alone cannot see the
// commonest change of all: the next card dropped on top of the last one, or swapped
// in faster than the detector can catch an empty frame. Both land in the same guide
// box, so the quad barely moves, and auto-scan sat on "Next card" with a new card
// right under it. Comparing what is INSIDE the quad catches that.
//
// Deliberately crude: a small grid of mean luminance, z-scored so auto-exposure
// shifting the whole frame brighter or darker does not count as a new card. It has
// to tell two different cards apart, not identify either of them.
//
// Pure, and runs in the detect worker where the pixels already are.

export const SIG_COLS = 10;
export const SIG_ROWS = 14;
// Inset from the quad's edges, so the detector's corner jitter and whatever is
// under the card do not leak into the outer cells.
const INSET = 0.08;
// Sub-samples per cell side, averaged, so one noisy pixel does not decide a cell.
const SUB = 3;

// `quad` is [TL, TR, BR, BL] in normalised 0..1 frame coordinates. Returns a
// Float32Array of SIG_COLS * SIG_ROWS z-scored values, or null when there is no
// usable signal (no quad, or a card so flat it has no contrast to compare).
export function quadSignature(rgba, w, h, quad) {
  if (!rgba || !quad || quad.length !== 4 || !w || !h) return null;
  const [tl, tr, br, bl] = quad;
  const n = SIG_COLS * SIG_ROWS;
  const out = new Float32Array(n);
  const span = 1 - 2 * INSET;
  for (let r = 0; r < SIG_ROWS; r++) {
    for (let c = 0; c < SIG_COLS; c++) {
      let sum = 0;
      for (let sy = 0; sy < SUB; sy++) {
        const v = INSET + span * (r + (sy + 0.5) / SUB) / SIG_ROWS;
        for (let sx = 0; sx < SUB; sx++) {
          const u = INSET + span * (c + (sx + 0.5) / SUB) / SIG_COLS;
          // Bilinear between the corners: close enough to the true perspective
          // map at this resolution, and needs no homography.
          const x = (1 - v) * ((1 - u) * tl.x + u * tr.x) + v * ((1 - u) * bl.x + u * br.x);
          const y = (1 - v) * ((1 - u) * tl.y + u * tr.y) + v * ((1 - u) * bl.y + u * br.y);
          const px = Math.min(w - 1, Math.max(0, Math.round(x * w - 0.5)));
          const py = Math.min(h - 1, Math.max(0, Math.round(y * h - 0.5)));
          const i = (py * w + px) << 2;
          sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
        }
      }
      out[r * SIG_COLS + c] = sum / (SUB * SUB);
    }
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i];
  mean /= n;
  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (out[i] - mean) ** 2;
  const std = Math.sqrt(varSum / n);
  if (std < 2) return null;
  for (let i = 0; i < n; i++) out[i] = (out[i] - mean) / std;
  return out;
}

// 1 - Pearson correlation of two signatures: 0 for the same picture, ~1 for
// unrelated ones, up to 2 for inverted. Infinity when either is missing, which
// callers read as "cannot tell", never as "changed".
export function signatureDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return 1 - dot / a.length;
}
