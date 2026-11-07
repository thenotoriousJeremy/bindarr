import assert from 'node:assert';
import { modelUrl, MODEL_PATH } from './detectorModel.js';

// --- where the model is fetched from (issue #80) -----------------------------
assert.ok(MODEL_PATH.startsWith('/models/cornelius.onnx'), 'the one model route the server exposes');
assert.strictEqual(modelUrl(false, ''), MODEL_PATH, 'web: same origin as the page');
assert.strictEqual(modelUrl(false, 'https://cards.example'), MODEL_PATH, 'web ignores a stale stored server');
assert.strictEqual(modelUrl(true, 'https://cards.example'), `https://cards.example${MODEL_PATH}`, 'native: the configured server, not the bundled assets');
assert.strictEqual(modelUrl(true, 'http://192.168.1.20:3001'), `http://192.168.1.20:3001${MODEL_PATH}`, 'native: LAN server with a port');

console.log('detectorModel tests passed');
