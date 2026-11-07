import assert from 'node:assert';
import { rgbaToChw } from './scanTensor.js';

// 2x2 RGBA: red, green, blue, white. Alpha is ignored.
const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 9, 0, 0, 255, 0, 255, 255, 255, 255]);
const x = rgbaToChw(rgba, 2);
const norm = (v, c) => (v / 255 - [0.485, 0.456, 0.406][c]) / [0.229, 0.224, 0.225][c];

assert.strictEqual(x.length, 12, 'three planes of size*size');
// Planar: all R values first, then G, then B — the server's toTensor layout.
assert.deepStrictEqual(Array.from(x.slice(0, 4)), [255, 0, 0, 255].map(v => Math.fround(norm(v, 0))));
assert.deepStrictEqual(Array.from(x.slice(4, 8)), [0, 255, 0, 255].map(v => Math.fround(norm(v, 1))));
assert.deepStrictEqual(Array.from(x.slice(8, 12)), [0, 0, 255, 255].map(v => Math.fround(norm(v, 2))));

console.log('scanTensor.test.js OK');
