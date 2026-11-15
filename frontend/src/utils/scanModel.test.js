import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imagenetChw, SHARPNESS_GATE } from '../../../shared/scanModel.mjs';
import { orderQuad } from '../../../shared/imgproc.mjs';
import * as detectResult from './detectResult.js';

// The models' input as the scanner and device mode build it: shared/scanModel.mjs,
// the server's own preprocessing. backend/test/scanshared.test.js holds it bit for
// bit to the copies it replaced; this checks it against the formula, from here.
const norm = (v, c) => (v / 255 - [0.485, 0.456, 0.406][c]) / [0.229, 0.224, 0.225][c];

// 2x2 RGBA: red, green, blue, white. Alpha is ignored.
const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 9, 0, 0, 255, 0, 255, 255, 255, 255]);

test('canvas RGBA becomes planar, ImageNet-normalised float32', () => {
  const x = imagenetChw(rgba, 2, 4);
  assert.equal(x.length, 12, 'three planes of size*size');
  // Planar: all R values first, then G, then B — the server's toTensor layout.
  assert.deepEqual(Array.from(x.slice(0, 4)), [255, 0, 0, 255].map(v => Math.fround(norm(v, 0))));
  assert.deepEqual(Array.from(x.slice(4, 8)), [0, 255, 0, 255].map(v => Math.fround(norm(v, 1))));
  assert.deepEqual(Array.from(x.slice(8, 12)), [0, 0, 255, 255].map(v => Math.fround(norm(v, 2))));
});

test('raw RGB (the server\'s stride) lands on the same floats', () => {
  const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  assert.deepEqual(Array.from(imagenetChw(rgb, 2, 3)), Array.from(imagenetChw(rgba, 2, 4)));
});

test('the byte table is the formula, for every value in every channel', () => {
  const all = new Uint8ClampedArray(256 * 4);
  for (let v = 0; v < 256; v++) all.set([v, v, v, 255], v * 4);
  const x = imagenetChw(all, 16, 4);
  for (let c = 0; c < 3; c++) {
    for (let v = 0; v < 256; v++) assert.equal(x[c * 256 + v], Math.fround(norm(v, c)), `channel ${c}, value ${v}`);
  }
  // A plain array takes the arithmetic instead of the table, to the same result.
  assert.deepEqual(Array.from(imagenetChw(Array.from(all), 16, 4)), Array.from(x));
});

test('a reused output buffer is filled in place', () => {
  const out = new Float32Array(12).fill(7);
  assert.equal(imagenetChw(rgba, 2, 4, out), out);
  assert.deepEqual(Array.from(out), Array.from(imagenetChw(rgba, 2, 4)));
});

test('the detector\'s gate and corner order are the shared ones', () => {
  assert.equal(detectResult.SHARPNESS_GATE, SHARPNESS_GATE);
  assert.equal(SHARPNESS_GATE, 0.02);
  assert.equal(detectResult.orderQuad, orderQuad);
});
