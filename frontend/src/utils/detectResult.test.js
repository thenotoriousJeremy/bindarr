import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cornerResult, orderQuad, quadArea, SHARPNESS_GATE } from './detectResult.js';

const W = 40, H = 40;
// A bright card on a dark mat, so the signature has contrast to work with.
function frame() {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const v = x > 8 && x < 32 && y > 4 && y < 36 ? 60 + ((x * 7 + y * 13) % 180) : 10;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

test('orderQuad puts any corner order into TL, TR, BR, BL', () => {
  const tl = { x: 0.2, y: 0.1 }, tr = { x: 0.8, y: 0.12 }, br = { x: 0.82, y: 0.9 }, bl = { x: 0.18, y: 0.88 };
  // Cornelius itself emits BL, BR, TL, TR — not its documented order.
  for (const pts of [[bl, br, tl, tr], [tr, bl, tl, br], [tl, tr, br, bl]]) {
    assert.deepEqual(orderQuad(pts), [tl, tr, br, bl]);
  }
});

test('quadArea is the covered fraction, whatever the winding', () => {
  const q = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0.5 }, { x: 0, y: 0.5 }];
  assert.equal(quadArea(q), 0.25);
  assert.equal(quadArea([...q].reverse()), 0.25);
});

test('cornerResult declines below the confidence gate', () => {
  const r = cornerResult({ seq: 3, engine: 'native-cpu', runMs: 9, corners: new Array(8).fill(0.5), score: SHARPNESS_GATE / 2, rgba: frame(), w: W, h: H });
  assert.equal(r.detected, false);
  assert.equal(r.seq, 3);
  assert.equal(r.engine, 'native-cpu');
  assert.equal(r.corners, SHARPNESS_GATE / 2);
});

test('cornerResult builds the same shape from a plain array or a Float32Array', () => {
  // BL, BR, TL, TR, as the model emits them.
  const raw = [0.2, 0.9, 0.8, 0.9, 0.2, 0.1, 0.8, 0.1];
  const args = { seq: 1, engine: 'e', runMs: 5, score: 0.5, rgba: frame(), w: W, h: H };
  const a = cornerResult({ ...args, corners: raw });
  const b = cornerResult({ ...args, corners: Float32Array.from(raw) });
  assert.equal(a.detected, true);
  assert.deepEqual(a.quad.map(p => [p.x, p.y]), [[0.2, 0.1], [0.8, 0.1], [0.8, 0.9], [0.2, 0.9]]);
  assert.ok(Math.abs(a.pick.fill - 0.48) < 1e-9);
  assert.equal(a.corners, 0.5);
  assert.ok(a.sharp > 0);
  assert.ok(a.sig instanceof Float32Array);
  assert.deepEqual(b.quad.map(p => [+p.x.toFixed(6), +p.y.toFixed(6)]), a.quad.map(p => [p.x, p.y]));
});

test('a model without a confidence head is trusted', () => {
  const r = cornerResult({ seq: 1, engine: 'e', runMs: 5, corners: [0.2, 0.9, 0.8, 0.9, 0.2, 0.1, 0.8, 0.1], rgba: frame(), w: W, h: H });
  assert.equal(r.detected, true);
  assert.equal(r.corners, 1);
});
