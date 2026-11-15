// Bindarr's own scan catalogs on an install (catalogReleases.js): installing one
// from the release, updating with only the new delta, moving to a new generation,
// refusing anything that does not match its manifest, and the scanner using the
// result. A local HTTP server stands in for the GitHub release
// (CATALOG_RELEASE_URL), so nothing here touches the network.
//
// No framework — plain node + assert. Run: `node test/catalogreleases.test.js`
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-catalogreleases-'));
const REL = path.join(ROOT, 'release');
const MODELS = path.join(ROOT, 'models');
fs.mkdirSync(REL, { recursive: true });
fs.mkdirSync(MODELS, { recursive: true });
process.env.CV_MODEL_DIR = MODELS;
process.env.DB_PATH = path.join(ROOT, 'test.db');
// cvScan.isBuilt only asks whether the model files exist.
fs.writeFileSync(path.join(MODELS, 'cornelius.onnx'), 'x');
fs.writeFileSync(path.join(MODELS, 'milo.onnx'), 'x');

const requests = [];
const streamed = new Set();   // files served chunked, with no Content-Length
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1));
  requests.push(name);
  const file = path.join(REL, name);
  if (!name || name.includes('/') || !fs.existsSync(file)) { res.writeHead(404); res.end('Not Found'); return; }
  const data = fs.readFileSync(file);
  if (streamed.has(name)) {
    res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
    res.write(data.subarray(0, data.length >> 1));
    res.end(data.subarray(data.length >> 1));
    return;
  }
  res.writeHead(200);
  res.end(data);
});

// The Pokémon provider, as catalogReleases.fitsInstall asks it.
const pokemonProvider = require('../src/utils/pokemonProvider');
let onTcgdex = true;
pokemonProvider.usesTcgdex = async () => onTcgdex;

const segments = require('../src/utils/catalogSegments');
const DIM = 8;
const vec = (seed) => {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed * 7.1 + i);
  const n = Math.hypot(...v);
  return v.map(x => x / n);
};
const rows = (ids) => {
  const out = new Float32Array(ids.length * DIM);
  ids.forEach((id, i) => out.set(vec(Number(id.replace(/\D/g, '')) || id.length), i * DIM));
  return out;
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Publish a catalog the way scripts/scan-catalogs/build.mjs does: segment files,
// then the manifest naming them, then the index.
function publish(key, generation, segs, { model = 'milo1', tamper = null, missing = null } = {}) {
  const [game] = key.split('-');
  const entries = segs.map(({ seq, base, ids, removes = [] }) => {
    const name = `${key}.g${generation}.${seq}.seg`;
    const bytes = segments.encodeSegment({ key, game, lang: 'English', model, dim: DIM, generation, seq, base, ids, vectors: rows(ids), removes });
    if (name !== missing) fs.writeFileSync(path.join(REL, name), bytes);
    return { name, seq, base, rows: ids.length, removes: removes.length, bytes: bytes.length, sha256: name === tamper ? 'f'.repeat(64) : sha(bytes) };
  });
  const applied = segments.applySegments(segs.map((s, i) => segments.decodeSegment(fs.existsSync(path.join(REL, entries[i].name))
    ? fs.readFileSync(path.join(REL, entries[i].name))
    : segments.encodeSegment({ key, game, lang: 'English', model, dim: DIM, generation, seq: s.seq, base: s.base, ids: s.ids, vectors: rows(s.ids), removes: s.removes || [] }))));
  const manifest = { format: 1, key, game, lang: 'English', model, dim: DIM, generation, rows: applied.rows, updatedAt: new Date().toISOString(), segments: entries };
  fs.writeFileSync(path.join(REL, `${key}.json`), JSON.stringify(manifest));
  const indexFile = path.join(REL, 'catalogs.json');
  let index = { format: 1, catalogs: [] };
  try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { /* the first catalog */ }
  index.catalogs = index.catalogs.filter(c => c.key !== key).concat({
    key, game, lang: 'English', model, dim: DIM, generation, rows: applied.rows, segments: entries.length,
    bytes: entries.reduce((n, e) => n + e.bytes, 0), updatedAt: manifest.updatedAt,
  });
  fs.writeFileSync(indexFile, JSON.stringify(index));
  return manifest;
}

async function run(releases, keys) {
  releases.start(keys);
  while (releases.state()) await new Promise(r => setTimeout(r, 10));
  return releases.lastResult();
}

async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.CATALOG_RELEASE_URL = `http://127.0.0.1:${server.address().port}/`;
  const releases = require('../src/catalogReleases');
  const cvScan = require('../src/cvScan');

  // Nothing published yet: the list says so instead of failing.
  let status = await releases.status({ fresh: true });
  assert.strictEqual(status.published, false);
  assert.deepStrictEqual(status.catalogs, []);
  assert.strictEqual(cvScan.isBuilt('lorcana'), false);

  // 1. A base of three cards.
  publish('lorcana-en', 1, [{ seq: 0, base: true, ids: ['lorcana-1', 'lorcana-2', 'lorcana-3'] }]);
  status = await releases.status({ fresh: true });
  assert.strictEqual(status.published, true);
  assert.strictEqual(status.catalogs.length, 1);
  assert.strictEqual(status.catalogs[0].installed, false);
  assert.strictEqual(status.catalogs[0].rows, 3);

  requests.length = 0;
  let last = await run(releases, ['lorcana-en']);
  assert.strictEqual(last.phase, 'done', last.message);
  assert.deepStrictEqual(requests, ['lorcana-en.json', 'lorcana-en.g1.0.seg']);
  assert.strictEqual(releases.isInstalled('lorcana', 'English'), true);
  assert.strictEqual(cvScan.isBuilt('lorcana', 'English'), true, 'a downloaded catalog makes the game scannable');
  assert.deepStrictEqual(cvScan.builtLangs('lorcana'), ['English']);
  let got = releases.load('lorcana', 'English');
  assert.deepStrictEqual(got.ids, ['lorcana-1', 'lorcana-2', 'lorcana-3']);
  const want = rows(['lorcana-2']);
  for (let d = 0; d < DIM; d++) assert.ok(Math.abs(got.cat[DIM + d] - want[d]) < 1e-3, 'vectors survive to float16 precision');
  status = await releases.status({ fresh: true });
  assert.strictEqual(status.catalogs[0].installed, true);
  assert.strictEqual(status.catalogs[0].upToDate, true);

  // 2. A delta: one card added, one removed. An update fetches the manifest and
  // that one segment, nothing else.
  publish('lorcana-en', 1, [
    { seq: 0, base: true, ids: ['lorcana-1', 'lorcana-2', 'lorcana-3'] },
    { seq: 1, base: false, ids: ['lorcana-4'], removes: ['lorcana-2'] },
  ]);
  status = await releases.status({ fresh: true });
  assert.strictEqual(status.catalogs[0].upToDate, false, 'a new delta shows as an update');
  requests.length = 0;
  last = await releases.updateInstalled();
  assert.strictEqual(last.phase, 'done', last.message);
  assert.deepStrictEqual(requests, ['lorcana-en.json', 'lorcana-en.g1.1.seg'], 'only the new delta is downloaded');
  got = releases.load('lorcana', 'English');
  assert.deepStrictEqual(got.ids, ['lorcana-1', 'lorcana-3', 'lorcana-4']);

  // Nothing new: one manifest request.
  requests.length = 0;
  await releases.updateInstalled();
  assert.deepStrictEqual(requests, ['lorcana-en.json']);

  // A segment the install lost since — cut short, or deleted — is downloaded
  // again, and only that one.
  const installedDir = path.join(releases.ROOT, 'lorcana-en');
  fs.writeFileSync(path.join(installedDir, 'lorcana-en.g1.0.seg'), 'cut short');
  requests.length = 0;
  last = await releases.updateInstalled();
  assert.strictEqual(last.phase, 'done', last.message);
  assert.deepStrictEqual(requests, ['lorcana-en.json', 'lorcana-en.g1.0.seg']);
  fs.rmSync(path.join(installedDir, 'lorcana-en.g1.1.seg'));
  requests.length = 0;
  last = await releases.updateInstalled();
  assert.deepStrictEqual(requests, ['lorcana-en.json', 'lorcana-en.g1.1.seg']);
  assert.deepStrictEqual(releases.load('lorcana', 'English').ids, ['lorcana-1', 'lorcana-3', 'lorcana-4']);

  // 3. A segment that does not match its manifest is refused, and the catalog
  // already installed keeps working.
  publish('lorcana-en', 1, [
    { seq: 0, base: true, ids: ['lorcana-1', 'lorcana-2', 'lorcana-3'] },
    { seq: 1, base: false, ids: ['lorcana-4'], removes: ['lorcana-2'] },
    { seq: 2, base: false, ids: ['lorcana-5'] },
  ], { tamper: 'lorcana-en.g1.2.seg' });
  last = await releases.updateInstalled();
  assert.strictEqual(last.phase, 'error');
  assert.match(last.message, /does not match its manifest/);
  assert.ok(!fs.existsSync(path.join(releases.ROOT, 'lorcana-en', 'lorcana-en.g1.2.seg')), 'a refused segment is not kept');
  assert.deepStrictEqual(releases.load('lorcana', 'English').ids, ['lorcana-1', 'lorcana-3', 'lorcana-4']);

  // A segment bigger than its manifest says is refused as it arrives, whether the
  // response declares its length or streams without one.
  const g12 = 'lorcana-en.g1.2.seg';
  publish('lorcana-en', 1, [
    { seq: 0, base: true, ids: ['lorcana-1', 'lorcana-2', 'lorcana-3'] },
    { seq: 1, base: false, ids: ['lorcana-4'], removes: ['lorcana-2'] },
    { seq: 2, base: false, ids: ['lorcana-5'] },
  ]);
  fs.appendFileSync(path.join(REL, g12), Buffer.alloc(4096));
  last = await releases.updateInstalled();
  assert.strictEqual(last.phase, 'error');
  assert.match(last.message, /larger than the \d+ bytes expected/);
  streamed.add(g12);
  last = await releases.updateInstalled();
  assert.strictEqual(last.phase, 'error');
  assert.match(last.message, /larger than the \d+ bytes expected/, 'without a Content-Length too');
  streamed.delete(g12);
  assert.ok(!fs.existsSync(path.join(installedDir, g12)), 'nothing of it is kept');
  assert.deepStrictEqual(releases.load('lorcana', 'English').ids, ['lorcana-1', 'lorcana-3', 'lorcana-4']);

  // 4. A catalog for another scan model is refused.
  publish('lorcana-en', 9, [{ seq: 0, base: true, ids: ['lorcana-9'] }], { model: 'milo2' });
  last = await releases.updateInstalled();
  assert.strictEqual(last.phase, 'error');
  assert.match(last.message, /scan model milo2/);
  assert.deepStrictEqual(releases.load('lorcana', 'English').ids, ['lorcana-1', 'lorcana-3', 'lorcana-4']);

  // 5. A new generation: the new base only, the old files go. What an earlier
  // failed attempt left beside it is not trusted, and not carried over.
  const nextDir = path.join(releases.ROOT, 'lorcana-en.next');
  fs.mkdirSync(nextDir, { recursive: true });
  fs.writeFileSync(path.join(nextDir, 'left-over.tmp'), 'from a crash');
  publish('lorcana-en', 2, [{ seq: 0, base: true, ids: ['lorcana-1', 'lorcana-3', 'lorcana-4', 'lorcana-5'] }]);
  requests.length = 0;
  last = await releases.updateInstalled();
  assert.strictEqual(last.phase, 'done', last.message);
  assert.deepStrictEqual(requests, ['lorcana-en.json', 'lorcana-en.g2.0.seg']);
  assert.deepStrictEqual(fs.readdirSync(path.join(releases.ROOT, 'lorcana-en')).sort(), ['lorcana-en.g2.0.seg', 'state.json']);
  got = releases.load('lorcana', 'English');
  assert.strictEqual(got.generation, 2);
  assert.deepStrictEqual(got.ids, ['lorcana-1', 'lorcana-3', 'lorcana-4', 'lorcana-5']);

  // 6. A new generation that fails half-way leaves the working one in place.
  publish('lorcana-en', 3, [
    { seq: 0, base: true, ids: ['lorcana-1'] },
    { seq: 1, base: false, ids: ['lorcana-6'] },
  ], { missing: 'lorcana-en.g3.1.seg' });
  last = await releases.updateInstalled();
  assert.strictEqual(last.phase, 'error');
  assert.strictEqual(releases.load('lorcana', 'English').generation, 2, 'the old generation still answers');
  assert.ok(!fs.existsSync(nextDir), 'and the half-downloaded one is not left on disk');

  // The scanner loads it as a catalog keyed by card ids.
  publish('lorcana-en', 4, [{ seq: 0, base: true, ids: ['lorcana-1', 'lorcana-2'] }]);
  await releases.updateInstalled();
  cvScan.reload('lorcana', 'English');

  // 7. Removing it takes it out of the scanner too.
  assert.strictEqual(releases.remove('lorcana-en'), true);
  assert.strictEqual(releases.isInstalled('lorcana', 'English'), false);
  assert.strictEqual(cvScan.isBuilt('lorcana'), false);
  assert.throws(() => releases.remove('../models'), /not a catalog/);
  assert.throws(() => releases.start(['../models']), /no catalog to download/);
  assert.strictEqual(releases.keyFor('pokemon', 'Japanese'), 'pokemon-ja');

  // 8. A Pokémon catalog names cards by TCGdex id: it is used only while TCGdex is
  // this install's Pokémon provider.
  publish('pokemon-en', 1, [{ seq: 0, base: true, ids: ['tcgdex-en-sv01-001', 'tcgdex-en-sv01-002'] }]);
  last = await run(releases, ['pokemon-en']);
  assert.strictEqual(last.phase, 'done', last.message);
  assert.strictEqual(releases.isInstalled('pokemon', 'English'), true);
  assert.strictEqual(cvScan.isBuilt('pokemon', 'English'), true);

  // The install moves to pokemontcg.io: the catalog is switched off — the scanner
  // stops using it and the weekly update skips it — but stays listed, to remove.
  onTcgdex = false;
  await releases.applyProvider();
  assert.strictEqual(releases.isInstalled('pokemon', 'English'), false);
  assert.strictEqual(releases.load('pokemon', 'English'), null);
  assert.strictEqual(cvScan.isBuilt('pokemon', 'English'), false, 'the scanner does not use it');
  status = await releases.status({ fresh: true });
  let pokemonRow = status.catalogs.find(c => c.key === 'pokemon-en');
  assert.ok(pokemonRow && pokemonRow.installed && pokemonRow.disabled, 'listed, as switched off');
  assert.strictEqual(pokemonRow.upToDate, false);
  requests.length = 0;
  assert.deepStrictEqual(await releases.updateInstalled(), { skipped: 'none installed' });
  assert.deepStrictEqual(requests, [], 'the weekly update leaves it alone');
  last = await run(releases, ['pokemon-en']);
  assert.strictEqual(last.phase, 'error', 'and it cannot be downloaded again');
  assert.match(last.message, /TCGdex/);

  // Back on TCGdex, it answers again, as it was.
  onTcgdex = true;
  await releases.applyProvider();
  assert.strictEqual(releases.isInstalled('pokemon', 'English'), true);
  assert.deepStrictEqual(releases.load('pokemon', 'English').ids, ['tcgdex-en-sv01-001', 'tcgdex-en-sv01-002']);

  // Removed while off TCGdex, it is not offered at all; on TCGdex, it is.
  onTcgdex = false;
  await releases.applyProvider();
  assert.strictEqual(releases.remove('pokemon-en'), true);
  status = await releases.status({ fresh: true });
  assert.ok(!status.catalogs.some(c => c.key === 'pokemon-en'), 'not offered to an install off TCGdex');
  onTcgdex = true;
  status = await releases.status({ fresh: true });
  pokemonRow = status.catalogs.find(c => c.key === 'pokemon-en');
  assert.ok(pokemonRow && !pokemonRow.installed && !pokemonRow.disabled, 'offered on TCGdex');
}

main().then(() => {
  console.log('catalogreleases.test.js: all assertions passed');
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(async () => {
  server.close();
  // pokemonProvider opened the database; closed first, or Windows keeps the file.
  try { await new Promise(ok => require('../src/db').dbConnection.close(ok)); } catch { /* already closed */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* a temp folder */ }
});
