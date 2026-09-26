import assert from 'node:assert';
import { zoomRange, initialZoom } from './cameraZoom.js';

// --- which cameras get a slider ----------------------------------------------
assert.deepStrictEqual(zoomRange({ min: 1, max: 8, step: 0.1 }), { min: 1, max: 8, step: 0.1 }, 'phone ratio range');
assert.deepStrictEqual(zoomRange({ min: 0, max: 60, step: 1 }), { min: 0, max: 60, step: 1 }, 'webcam range starting at 0');
assert.strictEqual(zoomRange({ min: 1, max: 4 }).step, 0.1, 'missing step gets a default');
assert.strictEqual(zoomRange(undefined), null, 'no zoom capability');
assert.strictEqual(zoomRange({ min: 1, max: 1 }), null, 'fixed zoom is not a slider');
assert.strictEqual(zoomRange({ min: '1', max: '8' }), null, 'malformed capability');

// --- where the slider starts -------------------------------------------------
const phone = { min: 1, max: 8, step: 0.1 };
assert.deepStrictEqual(initialZoom(phone, '3.5', 1), { zoom: 3.5, restore: true }, 'saved level restored');
assert.deepStrictEqual(initialZoom(phone, '1', 2), { zoom: 1, restore: true }, 'saved level at the range edge');
assert.deepStrictEqual(initialZoom(phone, null, 2), { zoom: 2, restore: false }, 'nothing saved: camera current');
assert.deepStrictEqual(initialZoom(phone, 'junk', undefined), { zoom: 1, restore: false }, 'junk saved, no current: minimum');
assert.deepStrictEqual(initialZoom({ min: 0, max: 60, step: 1 }, '80', 26), { zoom: 26, restore: false }, 'level from another camera is out of range');
assert.deepStrictEqual(initialZoom(phone, '0', 1), { zoom: 1, restore: false }, 'below range');

console.log('cameraZoom ok');
