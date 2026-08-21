const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ort = require('onnxruntime-node');

const MODEL_DIR = path.join(__dirname, '..', 'data', 'models');
const CORN = 384, EMBED = 448;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

async function main() {
  const modelFile = path.join(MODEL_DIR, 'cornelius.onnx');
  if (!fs.existsSync(modelFile)) {
    console.log('fastdetector.test.js: no model present — skipped');
    return;
  }

  const session = await ort.InferenceSession.create(modelFile, { intraOpNumThreads: 1, interOpNumThreads: 1 });
  assert.ok(session.inputNames.includes('image'), 'Model must have "image" input');
  assert.ok(session.outputNames.includes('corners'), 'Model must have "corners" output');
  assert.ok(session.outputNames.includes('sharpness'), 'Model must have "sharpness" output');

  // Synthetic card test
  const svg = `<svg width="384" height="384">
    <rect width="384" height="384" fill="#202020"/>
    <rect x="80" y="60" width="224" height="264" rx="10" ry="10" fill="#ffffff" stroke="#000000" stroke-width="4"/>
    <text x="100" y="100" font-size="20" fill="#000000">CARD</text>
  </svg>`;

  const { data } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const f = new Float32Array(3 * CORN * CORN);
  for (let i = 0; i < CORN * CORN; i++) {
    for (let c = 0; c < 3; c++) f[c * CORN * CORN + i] = (data[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  }

  const t0 = performance.now();
  const out = await session.run({ image: new ort.Tensor('float32', f, [1, 3, CORN, CORN]) });
  const latency = performance.now() - t0;
  console.log(`fastdetector.test.js: single-pass inference in ${latency.toFixed(2)} ms`);

  const c = out.corners.data;
  assert.strictEqual(c.length, 8, 'Corners must contain 8 floats (4 x,y pairs)');

  const isFast = fs.statSync(modelFile).size < 4000000;
  const order = isFast ? [0, 2, 1, 3] : [2, 3, 1, 0];
  const quad = order.map(i => ({ x: c[i * 2], y: c[i * 2 + 1] }));

  assert.strictEqual(quad.length, 4, 'Quad must have 4 points');
  for (const pt of quad) {
    assert.ok(pt.x >= 0 && pt.x <= 1, 'Point x must be in [0, 1]');
    assert.ok(pt.y >= 0 && pt.y <= 1, 'Point y must be in [0, 1]');
  }
  console.log('fastdetector.test.js: OK');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
