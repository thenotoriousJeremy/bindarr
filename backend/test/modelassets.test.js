// An older release's detector model is installed, but it is not current.
//
// 1.8.3 replaced the original cornelius (4.41 MB) with fastweb-single (3.19 MB)
// under the same filename, and isPresent accepted either size, so an install that
// downloaded before 1.8.3 was never offered the ~4x faster model. Outdated must
// still read as present (scanning works), and must be offered as an update.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-modelassets-'));
process.env.CV_MODEL_DIR = dir;

const modelAssets = require('../src/utils/modelAssets');
const corn = modelAssets.MODELS.find(a => a.name === 'cornelius.onnx');
const file = path.join(dir, corn.name);
const writeSize = (n) => { fs.writeFileSync(file, ''); fs.truncateSync(file, n); };
const entry = () => modelAssets.status().models.find(m => m.name === corn.name);

try {
  assert.deepStrictEqual(
    { present: entry().present, outdated: entry().outdated }, { present: false, outdated: false },
    'no file: missing, not outdated');

  writeSize(4407545);
  assert.strictEqual(modelAssets.isPresent(corn), true, 'the original cornelius still scans');
  assert.strictEqual(modelAssets.isOutdated(corn), true, 'but is offered as an update');
  assert.strictEqual(entry().outdated, true, 'status() carries it to the admin panel');

  writeSize(corn.bytes);
  assert.strictEqual(modelAssets.isPresent(corn), true, 'fastweb-single is present');
  assert.strictEqual(modelAssets.isOutdated(corn), false, 'and current');

  writeSize(1234);
  assert.strictEqual(modelAssets.isPresent(corn), false, 'a truncated file is neither');
  assert.strictEqual(modelAssets.isOutdated(corn), false, 'a truncated file is not an old model');

  console.log('PASS: modelassets.test.js');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
