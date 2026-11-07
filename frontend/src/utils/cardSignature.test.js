import assert from 'node:assert';
import { quadSignature, signatureDistance } from './cardSignature.js';
import { REARM_SIG_DIST, REARM_SIG_STABLE } from './autoCapture.js';

// Synthetic detect frames: a 384x384 RGBA buffer with a card drawn in a quad.
// The card is a shared "frame layout" (border, name bar, text box) around an art
// box of random blocks, so two seeds are two different cards of the same kind.
const W = 384, H = 384;
// A plain LCG, warmed up: its first outputs for neighbouring seeds are related.
const rng = (seed) => {
  const next = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let i = 0; i < 5; i++) next();
  return next;
};

function cardPixel(u, v, art) {
  if (u < 0.05 || u > 0.95 || v < 0.04 || v > 0.96) return 230;   // border
  if (v < 0.1) return 200;                                         // name bar
  if (v > 0.55) return 215 + ((v * 40) | 0) % 2 * 10;              // text box
  const ax = Math.min(7, (u * 8) | 0), ay = Math.min(7, (((v - 0.1) / 0.45) * 8) | 0);
  return art[ay * 8 + ax];                                         // art box
}

function frame({ seed, quad, gain = 1, bias = 0, noise = 0 }) {
  const r = rng(seed);
  const art = Array.from({ length: 64 }, () => 30 + r() * 180);
  const n = rng(seed * 7 + 1);
  const rgba = new Uint8ClampedArray(W * H * 4);
  const [tl, tr, , bl] = quad;   // axis-aligned in these tests
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = ((x + 0.5) / W - tl.x) / (tr.x - tl.x);
      const v = ((y + 0.5) / H - tl.y) / (bl.y - tl.y);
      const lum = u < 0 || u > 1 || v < 0 || v > 1 ? 60 : cardPixel(u, v, art);
      const val = lum * gain + bias + (n() - 0.5) * 2 * noise;
      const i = (y * W + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = val;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

const box = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const Q = box(0.12, 0.05, 0.88, 0.95);
const sigOf = (opts) => quadSignature(frame(opts), W, H, opts.quad);

const a = sigOf({ seed: 1, quad: Q });
assert.ok(a && a.length > 0, 'a card yields a signature');
assert.ok(Math.abs(signatureDistance(a, a)) < 1e-6, 'identical frames are distance 0');

// The same card, as the camera actually sees it between two detections: corners
// jittering by more than the ~0.012 seen on a card lying still, auto-exposure
// shifting the whole frame, and sensor noise.
const jitter = box(0.125, 0.045, 0.884, 0.955);
const same = sigOf({ seed: 1, quad: jitter, gain: 0.8, bias: 20, noise: 12 });
const dSame = signatureDistance(a, same);
assert.ok(dSame < REARM_SIG_STABLE, `same card under jitter/exposure/noise stays close (${dSame.toFixed(3)})`);

// Different cards of the same layout, laid in the same place: every pair of a
// small deck. A shared frame is what makes this hard — it correlates by itself.
const deck = Array.from({ length: 10 }, (_, i) => i + 1);
const placed = deck.map(seed => sigOf({ seed, quad: Q }));
const swapped = deck.map(seed => sigOf({ seed, quad: jitter, noise: 12 }));
for (let i = 0; i < deck.length; i++) {
  assert.ok(signatureDistance(placed[i], swapped[i]) < REARM_SIG_STABLE, `card ${deck[i]} stays the same card`);
  for (let j = 0; j < deck.length; j++) {
    if (i === j) continue;
    const d = signatureDistance(placed[i], swapped[j]);
    assert.ok(d > REARM_SIG_DIST, `card ${deck[j]} on top of card ${deck[i]} reads as changed (${d.toFixed(3)})`);
  }
}

// No contrast, nothing to compare: say so rather than call every flat frame equal.
const flat = new Uint8ClampedArray(W * H * 4).fill(128);
assert.strictEqual(quadSignature(flat, W, H, Q), null, 'a featureless quad has no signature');
assert.strictEqual(quadSignature(frame({ seed: 1, quad: Q }), W, H, null), null, 'no quad, no signature');
assert.strictEqual(signatureDistance(a, null), Infinity, 'a missing signature is "cannot tell"');

console.log('cardSignature tests passed');
