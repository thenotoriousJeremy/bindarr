// Scan model downloads are pinned to a commit and checked by SHA-256 (PROV-15).
//
// They came from `resolve/main` — whatever the branch held that day — and were
// checked by size alone before going into native ONNX and npz parsing. Each asset
// now names a Hugging Face commit and the SHA-256 of its LFS object, and a
// download that does not hash to it is refused and left on no disk.
//
// fetch is stubbed: nothing here reaches Hugging Face. Run: `node test/modelpin.test.js`
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-modelpin-'));
process.env.CV_MODEL_DIR = dir;
const modelAssets = require('../src/utils/modelAssets');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const respond = (body) => async (url) => {
  respond.urls.push(url);
  return { ok: true, status: 200, body: (async function* () { yield Buffer.from(body.slice(0, 3)); yield Buffer.from(body.slice(3)); })() };
};
respond.urls = [];

(async () => {
  try {
    // Every shipped asset names a commit and a digest, and is fetched from that commit.
    for (const a of [...modelAssets.MODELS, ...modelAssets.CATALOGS]) {
      assert.match(a.revision, /^[0-9a-f]{40}$/, `${a.name} is pinned to a commit`);
      assert.match(a.sha256, /^[0-9a-f]{64}$/, `${a.name} carries its SHA-256`);
      const url = modelAssets.assetUrl(a);
      assert.ok(url.includes(`/resolve/${a.revision}/`), `${a.name} is fetched from its commit`);
      assert.ok(!url.includes('/resolve/main/'), `${a.name} is not fetched from a branch`);
    }

    const asset = { name: 'probe.onnx', repo: 'example/repo', revision: 'a'.repeat(40), file: 'probe.onnx', bytes: 11, sha256: sha256('hello world') };
    const dest = path.join(dir, asset.name);

    // The right size with the wrong bytes is refused and nothing is installed.
    await assert.rejects(
      modelAssets.fetchAsset(asset, null, { fetchImpl: respond('HELLO WORLD') }),
      /SHA-256 .* expected .* refusing to install it/);
    assert.ok(!fs.existsSync(dest), 'a refused download is not installed');
    assert.ok(!fs.existsSync(`${dest}.tmp`), 'nor left behind half-way');

    // The wrong size is still refused, as before.
    await assert.rejects(modelAssets.fetchAsset(asset, null, { fetchImpl: respond('hello') }), /came back 5 bytes/);

    // The pinned bytes are installed.
    assert.strictEqual(await modelAssets.fetchAsset(asset, null, { fetchImpl: respond('hello world') }), 'fetched');
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'hello world');
    assert.ok(respond.urls.every(u => u === `https://huggingface.co/example/repo/resolve/${'a'.repeat(40)}/probe.onnx`));

    console.log('modelpin.test.js: all assertions passed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
