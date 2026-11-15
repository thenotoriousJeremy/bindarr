// device/wasmSupport.js, tested here because the test runner reads src/utils.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wasmSimdSupported } from '../device/wasmSupport.js';

test('the SIMD probe is a valid module where SIMD exists (Node has it)', () => {
  assert.equal(wasmSimdSupported(), true);
});

test('a WebView without SIMD, or without WebAssembly, is told no', () => {
  assert.equal(wasmSimdSupported({ validate: () => false }), false);
  assert.equal(wasmSimdSupported(null), false);
  assert.equal(wasmSimdSupported({ validate: () => { throw new Error('old engine'); } }), false);
});
