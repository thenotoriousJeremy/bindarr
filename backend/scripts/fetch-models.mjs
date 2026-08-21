// Fetch the CollectorVision models (and, optionally, the published fallback
// catalogs) into CV_MODEL_DIR.
//
// The models are not in this repository and not baked into the container image,
// which is a licensing decision rather than an oversight: both are AGPL-3.0 while
// Bindarr is MIT, so the operator fetches them deliberately instead of receiving
// them inside an MIT-licensed artifact. Nothing runs this automatically.
//
//   node scripts/fetch-models.mjs                 # the two models (~9.6 MB)
//   node scripts/fetch-models.mjs --catalogs      # ...plus MTG + Pokemon fallbacks (~70 MB)
//   node scripts/fetch-models.mjs --catalogs-only
//
// In a container:  docker exec bindarr node scripts/fetch-models.mjs
//
// Sizes are asserted, not assumed. A truncated ONNX file fails at session
// creation with a protobuf error that says nothing about the download, and a
// truncated catalog loads as garbage and quietly scores every card wrong.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const MODEL_DIR = process.env.CV_MODEL_DIR
  || path.join(import.meta.dirname, '..', 'data', 'models');

import { createRequire } from 'node:module';

// One descriptor table, shared with the admin panel's download button
// (backend/src/utils/modelAssets.js). Two copies of a byte size is two chances to
// assert the wrong one.
const { MODELS, CATALOGS, LICENSE } = createRequire(import.meta.url)('../src/utils/modelAssets.js');
const HF = 'https://huggingface.co';

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function fetchOne({ name, repo, file, bytes }) {
  const dest = path.join(MODEL_DIR, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size === bytes) {
    console.log(`  ${name}: already present (${mb(bytes)})`);
    return 'present';
  }
  const url = `${HF}/${repo}/resolve/main/${file}`;
  process.stdout.write(`  ${name}: downloading ${mb(bytes)} from ${repo}... `);
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow', signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== bytes) {
    throw new Error(`${name} came back ${buf.length} bytes, expected ${bytes} — refusing to write it`);
  }
  // Write-then-rename, so an interrupted run cannot leave a half file that looks
  // finished to the next one.
  fs.writeFileSync(`${dest}.tmp`, buf);
  fs.renameSync(`${dest}.tmp`, dest);
  console.log('ok');
  return 'fetched';
}

const args = new Set(process.argv.slice(2));
const wanted = [
  ...(args.has('--catalogs-only') ? [] : MODELS),
  ...(args.has('--catalogs') || args.has('--catalogs-only') ? CATALOGS : []),
];

console.log(`Target: ${MODEL_DIR}`);
console.log(`cornelius and milo are ${LICENSE.spdx} (${LICENSE.urls.join(', ')}).`);
console.log('Bindarr is MIT. Running them in your own install is your call to make;');
console.log('shipping them onward is a licensing decision.');

fs.mkdirSync(MODEL_DIR, { recursive: true });
let fetched = 0;
for (const item of wanted) {
  if ((await fetchOne(item)) === 'fetched') fetched++;
}
console.log(`${fetched} file(s) downloaded, ${wanted.length - fetched} already present.`);
if (!args.has('--catalogs') && !args.has('--catalogs-only')) {
  console.log('Scanning needs a catalog as well as the models: build one from Admin → Catalogs,');
  console.log('or pass --catalogs to also fetch the published MTG and Pokemon fallbacks.');
}
