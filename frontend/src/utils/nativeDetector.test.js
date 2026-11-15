import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelTag, nativeDetectorAvailable, readPixelsIfDetected } from './nativeDetector.js';
import { SHARPNESS_GATE } from './detectResult.js';

test('a frame with no card in view skips the pixel readback', () => {
  let reads = 0;
  const canvas = {
    width: 384,
    height: 384,
    getContext: () => ({ getImageData: (x, y, w, h) => { reads++; return { data: new Uint8ClampedArray(w * h * 4) }; } }),
  };
  assert.equal(readPixelsIfDetected({ sharpness: SHARPNESS_GATE / 2 }, canvas), null);
  assert.equal(readPixelsIfDetected({ sharpness: 0 }, canvas), null);
  assert.equal(reads, 0, 'nothing read for an empty frame');
  assert.equal(readPixelsIfDetected({ sharpness: 0.5 }, canvas).length, 384 * 384 * 4);
  // A model with no confidence head reports none: trusted, as cornerResult trusts it.
  assert.ok(readPixelsIfDetected({}, canvas));
  assert.equal(reads, 2);
});

test('off the app, the native detector is not offered', () => {
  // The web and the PWA must keep the wasm worker.
  assert.equal(nativeDetectorAvailable(), false);
});

test('modelTag is stable and tells models and engine overrides apart', () => {
  const fast = new Uint8Array(3185226).map((_, i) => i % 251);
  const same = new Uint8Array(3185226).map((_, i) => i % 251);
  assert.equal(modelTag(fast), modelTag(same));
  // Same size, different bytes: a re-export must reload.
  const edited = same.slice();
  edited[0] ^= 0xff;
  assert.notEqual(modelTag(edited), modelTag(fast));
  // Different size.
  assert.notEqual(modelTag(new Uint8Array(4407545)), modelTag(fast));
  // An engine override reloads even when the model is unchanged.
  assert.notEqual(modelTag(fast, 'cpu'), modelTag(fast, 'auto'));
});
