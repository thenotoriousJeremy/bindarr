// The browser dewarps the card itself and uploads only the rectified square
// (CameraScanner.localDewarp -> cvScan.match with `cropped`). That is two
// implementations of one geometry — a JS warp in the page and sharp/warpRgb on
// the server — and if they ever disagree the failure is silent: milo still
// returns a card, just a slightly worse-framed one, and accuracy drifts with
// nothing pointing at the cause.
//
// So this replays the client path in Node and asserts both paths land on the
// same card with near-identical cosine. Needs the ONNX models and an MTG
// catalog; skips rather than fails when the install has neither.
//
// Run: node test/clientcrop.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ort = require('onnxruntime-node');

const MODEL_DIR = path.join(__dirname, '..', 'data', 'models');
const FRAME_DIR = path.join(__dirname, '..', 'data', 'scan-debug');
const CORN = 384, EMBED = 448;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

const cvScan = require('../src/cvScan');

function frames() {
  if (!fs.existsSync(FRAME_DIR)) return [];
  return fs.readdirSync(FRAME_DIR).filter(f => f.endsWith('-frame.jpg')).slice(0, 6);
}

async function corners(session, buf) {
  const { data } = await sharp(buf).resize(CORN, CORN, { fit: 'fill' }).removeAlpha()
    .raw().toBuffer({ resolveWithObject: true });
  const f = new Float32Array(3 * CORN * CORN);
  for (let i = 0; i < CORN * CORN; i++) {
    for (let c = 0; c < 3; c++) f[c * CORN * CORN + i] = (data[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  }
  const out = await session.run({ image: new ort.Tensor('float32', f, [1, 3, CORN, CORN]) });
  const c = out.corners.data;
  const isCorn = c[1] > c[5];
  const order = isCorn ? [2, 3, 1, 0] : [0, 2, 1, 3];
  return {
    sharpness: out.sharpness ? out.sharpness.data[0] : 1,
    quad: order.map(i => ({ x: c[i * 2], y: c[i * 2 + 1] })),
  };
}

// CameraScanner.localDewarp, in Node, over the same shared/imgproc the page uses.
async function clientCrop(buf, quad) {
  const { getPerspectiveTransform, warpPerspective } = await import('../../shared/imgproc.mjs');
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, N = EMBED - 1;
  const src = quad.map(p => ({ x: p.x * w, y: p.y * h }));
  const dst = [{ x: 0, y: 0 }, { x: N, y: 0 }, { x: N, y: N }, { x: 0, y: N }];
  const rgba = warpPerspective(new Uint8ClampedArray(data), w, h,
    getPerspectiveTransform(src, dst), EMBED, EMBED);
  return sharp(Buffer.from(rgba.buffer), { raw: { width: EMBED, height: EMBED, channels: 4 } })
    .jpeg({ quality: 90 }).toBuffer();
}

async function main() {
  const files = frames();
  if (!fs.existsSync(path.join(MODEL_DIR, 'cornelius.onnx')) || !cvScan.isBuilt('mtg') || !files.length) {
    console.log('clientcrop.test.js: no models/catalog/frames present — skipped');
    return;
  }
  const session = await ort.InferenceSession.create(path.join(MODEL_DIR, 'cornelius.onnx'),
    { intraOpNumThreads: 1, interOpNumThreads: 1 });

  let checked = 0;
  for (const f of files) {
    const buf = fs.readFileSync(path.join(FRAME_DIR, f));
    const { quad, sharpness } = await corners(session, buf);
    // Below the gate the browser uploads the whole frame instead, so there is no
    // client crop to compare.
    if (sharpness <= 0.02) continue;

    const viaServer = await cvScan.match(buf, 'mtg', 5);
    const viaClient = await cvScan.match(await clientCrop(buf, quad), 'mtg', 5, { cropped: true });
    const a = viaServer.candidates[0], b = viaClient.candidates[0];
    assert.ok(a && b, `${f}: both paths must return a candidate`);
    assert.strictEqual(b.cardId, a.cardId,
      `${f}: client crop picked ${b.cardId}, server crop picked ${a.cardId} — the two dewarps disagree`);
    // Same card is the requirement; near-identical cosine is what proves it is
    // the same CROP rather than a different one that happens to match anyway.
    assert.ok(Math.abs(a.score - b.score) < 0.02,
      `${f}: cosine ${a.score.toFixed(3)} vs ${b.score.toFixed(3)} — crops differ more than JPEG noise`);
    checked++;
  }
  assert.ok(checked > 0, 'every frame was below the sharpness gate — nothing was actually compared');
  console.log(`clientcrop.test.js: ${checked} frames, both dewarps agree`);
}

main().catch((e) => { console.error(e); process.exit(1); });
