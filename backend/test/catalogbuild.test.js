// A catalog build never leaves the catalog smaller than it found it (PROV-02),
// embeds Magic back faces (PROV-11), and records what it covers (PROV-03).
//
// Stopping a whole-game rebuild — or `docker stop`, since shutdown cancels a
// running build — wrote the part it had finished over the whole catalog: a
// 40-card catalog came back as 8, and every card the build had not reached yet
// silently stopped scanning. Previous vectors were merged back only for scoped
// builds. Now every card still in card_cache that the run did not embed keeps
// its previous vector; a card that has LEFT card_cache is still dropped by a
// whole-game build.
//
// The embedder (download + milo) is stubbed through start()'s `embedder` option,
// so this needs no model, no image and no network. Run: `node test/catalogbuild.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-catalogbuild-${process.pid}.db`);
const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-catalogbuild-models-'));
process.env.DB_PATH = tmpDb;
process.env.CV_MODEL_DIR = modelDir;

const db = require('../src/db');
const catalog = require('../src/catalog');

const DIM = 4;
const N = 40;
const ids = Array.from({ length: N }, (_, i) => `mtg-c${String(i).padStart(2, '0')}`);
const url = (id, v = 'new') => `https://img.test/${v}/${id}.jpg`;

// A catalog file as an earlier build wrote it, every vector marked by `tag`.
function writePrev(entries, tag, scope) {
  const bin = Buffer.alloc(entries.length * DIM * 4);
  entries.forEach(([, ], i) => { for (let d = 0; d < DIM; d++) bin.writeFloatLE(tag, (i * DIM + d) * 4); });
  fs.writeFileSync(catalog.binPath('mtg', 'English'), bin);
  fs.writeFileSync(catalog.metaPath('mtg', 'English'), JSON.stringify({
    dim: DIM, ids: entries.map(([id]) => id), srcs: Object.fromEntries(entries),
    game: 'mtg', lang: 'English', model: 'milo1', builtAt: new Date().toISOString(),
    ...(scope !== undefined ? { scope } : {}),
  }));
}
const readMeta = () => JSON.parse(fs.readFileSync(catalog.metaPath('mtg', 'English'), 'utf8'));

// Downloads `url` (counted), and on the `stopAfter`th download asks the build to stop.
function embedder({ stopAfter = Infinity, failing = new Set() } = {}) {
  const seen = [];
  return {
    seen,
    async fetch(u) {
      seen.push(u);
      if (seen.length === stopAfter) catalog.stop();
      await new Promise(r => setTimeout(r, 2));
      if (failing.has(u)) throw new Error('HTTP 503');
      return Buffer.from(u);
    },
    async embed() { return new Float32Array(DIM).fill(7); },
  };
}

async function build(opts) {
  catalog.start('mtg', 'English', { skipCache: true, ...opts });
  for (let i = 0; i < 2000 && catalog.state(); i++) await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(catalog.state(), null, 'the build finished');
  return catalog.lastResult();
}

async function main() {
  await db.initDb();
  for (const id of ids) {
    await db.run(
      `INSERT INTO card_cache (id, name, set_id, number, game, language, image_url, image_url_back)
       VALUES (?, ?, 'tst', ?, 'mtg', 'English', ?, ?)`,
      [id, id, id.slice(5), url(id), id === 'mtg-c00' ? url(`${id}-back`) : null]
    );
  }
  const quiet = { log: console.log };
  console.log = () => {};
  try {
    // --- 1. A stopped whole-game rebuild keeps every card it did not reach. ---------
    // Every stored url is stale, so every card needs re-embedding; the build is
    // stopped after 8 downloads.
    writePrev(ids.map(id => [id, url(id, 'old')]), 1);
    const stopped = embedder({ stopAfter: 8 });
    const r1 = await build({ embedder: stopped });
    assert.strictEqual(r1.phase, 'cancelled');
    const after = readMeta();
    assert.ok(stopped.seen.length < N, 'the build really was stopped part-way');
    for (const id of ids) assert.ok(after.ids.includes(id), `${id} is still in the catalog after a stopped build`);
    // The ones not reached keep their OLD url, so the next build embeds them again.
    const notReached = ids.filter(id => !stopped.seen.includes(url(id)));
    assert.ok(notReached.length > 0);
    for (const id of notReached) assert.strictEqual(after.srcs[id], url(id, 'old'), `${id} keeps its old source`);

    // --- 2. A complete rebuild: a failed download keeps its vector, a card that left
    //        card_cache is dropped, and a back face is embedded as `{id}_back`. ---------
    await db.run(`DELETE FROM card_cache WHERE id = 'mtg-c39'`);
    const full = embedder({ failing: new Set([url('mtg-c05')]) });
    const r2 = await build({ embedder: full });
    assert.strictEqual(r2.phase, 'done');
    const done = readMeta();
    assert.ok(!done.ids.includes('mtg-c39'), 'a card no longer in card_cache leaves a whole-game build');
    assert.ok(done.ids.includes('mtg-c05'), 'a card whose image failed to download keeps its previous vector');
    assert.ok(done.ids.includes('mtg-c00_back'), "a double-faced card's back is embedded");
    assert.strictEqual(done.srcs['mtg-c00_back'], url('mtg-c00-back'));
    assert.ok([...stopped.seen, ...full.seen].includes(url('mtg-c00-back')), 'the back image was downloaded');
    assert.strictEqual(done.scope, null, 'a whole-game build records no scope');

    // --- 3. Scope is recorded, and widens with each scoped build added. ---------------
    fs.rmSync(catalog.metaPath('mtg', 'English'));
    fs.rmSync(catalog.binPath('mtg', 'English'));
    await db.run(`INSERT INTO card_cache (id, name, set_id, number, game, language, image_url)
      VALUES ('mtg-x1', 'x', 'xyz', '1', 'mtg', 'English', ?)`, [url('mtg-x1')]);
    await build({ embedder: embedder(), sets: ['TST'] });
    assert.deepStrictEqual(readMeta().scope, ['tst'], 'a scoped build records its sets');
    await build({ embedder: embedder(), sets: ['xyz'] });
    assert.deepStrictEqual(readMeta().scope, ['tst', 'xyz'], 'and a later one adds to them');
    assert.ok(readMeta().ids.includes('mtg-c01'), 'without dropping the first scope');
    await build({ embedder: embedder() });
    assert.strictEqual(readMeta().scope, null, 'a whole-game build makes it whole-game');
    await build({ embedder: embedder(), sets: ['tst'] });
    assert.strictEqual(readMeta().scope, null, 'and a scoped build on top of it does not shrink that');

    // --- 4. list() reports it; a legacy catalog with no scope is whole-game. ----------
    writePrev([['mtg-c01', url('mtg-c01')]], 1);
    const entry = (await catalog.list()).find(c => c.game === 'mtg' && c.lang === 'English');
    assert.strictEqual(entry.built.scope, null);
  } finally {
    console.log = quiet.log;
  }
  console.log('catalogbuild.test.js: all assertions passed');
}

main()
  .then(() => { process.exitCode = 0; })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    await new Promise(r => db.dbConnection.close(() => r()));
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* gone */ } }
    fs.rmSync(modelDir, { recursive: true, force: true });
  });
