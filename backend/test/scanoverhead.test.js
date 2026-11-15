// Scan overheads trimmed (PROV-17).
//
// 1. Each server-side scan decoded the photo two or three times: once for the
//    dewarp source, once more for the corner model's input, and again for the
//    fallback when no card was found. It is decoded once now, and the other two
//    inputs are resampled from those pixels.
//
// The corner model is a stand-in and sharp's constructor is wrapped to count
// decodes (a call with an encoded image rather than raw pixels).
// Run: `node test/scanoverhead.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-scanoverhead-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

// Count decodes: sharp(input) with no `raw` option is a decode of an encoded image.
const realSharp = require('sharp');
let decodes = 0;
const countingSharp = Object.assign(function sharp(input, options) {
  if (Buffer.isBuffer(input) && !(options && options.raw)) decodes++;
  return realSharp(input, options);
}, realSharp);
require.cache[require.resolve('sharp')].exports = countingSharp;

const db = require('../src/db');
const cvScan = require('../src/cvScan');

async function main() {
  await db.initDb();

  // --- 1. One decode per scan, card found or not ------------------------------
  const photo = await realSharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 40, g: 90, b: 160 } } })
    .jpeg().toBuffer();
  const cornerModel = (sharpness) => ({
    run: async ({ image }) => {
      assert.deepStrictEqual(image.dims, [1, 3, 384, 384], 'the corner model still gets its 384px input');
      return { corners: { data: [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9] }, sharpness: { data: [sharpness] } };
    },
  });

  decodes = 0;
  const found = await cvScan.detectAndDewarp(cornerModel(0.5), photo);
  assert.strictEqual(found.detected, true);
  assert.strictEqual(found.rgb.length, 448 * 448 * 3, 'a 448px dewarp');
  assert.strictEqual(decodes, 1, `the photo is decoded once (saw ${decodes})`);

  decodes = 0;
  const missed = await cvScan.detectAndDewarp(cornerModel(0), photo);
  assert.strictEqual(missed.detected, false);
  assert.strictEqual(missed.rgb.length, 448 * 448 * 3, 'the fallback is the 448px frame');
  assert.strictEqual(decodes, 1, `once with no card found either (saw ${decodes})`);

  console.log('scanoverhead.test.js: all assertions passed');
}

main()
  .then(() => { process.exitCode = 0; })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    await new Promise(r => db.dbConnection.close(() => r()));
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* gone */ } }
  });
