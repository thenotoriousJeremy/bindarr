import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelTag, nativeDetectorAvailable } from './nativeDetector.js';

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
