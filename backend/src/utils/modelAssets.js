// The scan engine's downloadable pieces, and the one place that describes them.
//
// Three different things get called "the scan data", they are not
// interchangeable, and the difference decides what a user should press:
//
//   MODELS (cornelius + milo, ~9.6 MB) — the detector and the embedder. Nothing
//   scans without them, and they are the same two files for every install. NOT in
//   this repository and NOT baked into the container image: both are AGPL-3.0
//   while Bindarr is MIT, so shipping them inside an MIT artifact is a licensing
//   decision this project declines to make for its operators. Fetching them into
//   your own install is your call, which is why this is a button and not a
//   background task.
//
//   PUBLISHED CATALOGS (~70 MB) — precomputed embeddings for a whole game,
//   published by the model's author. Instant, but a dated snapshot: they are keyed
//   by PROVIDER ids (Scryfall ids, TCGplayer product ids) rather than this
//   install's card_cache ids, so a hit still has to be mapped back to a card the
//   install knows — and for Pokemon only ~24% of those product ids map to a cached
//   card. They also cannot be updated: a card printed after the snapshot date is
//   simply not in them, and never will be.
//
//   LOCAL BUILDS (catalog.js) — embeddings computed here from card_cache. Slower
//   to create (minutes per set, hours for a whole game) but keyed by card_cache
//   id, so every hit resolves; scopeable to just the sets you own; countable per
//   set, which is what the scan filter's "only sets I can scan" reads; and
//   updatable, so a set released tomorrow is one more short build away.
//
// A local build always wins over a published catalog when both exist — see
// cvScan.hasLocal.
const fs = require('fs');
const path = require('path');

const MODEL_DIR = process.env.CV_MODEL_DIR || path.join(__dirname, '..', '..', 'data', 'models');
const HF = 'https://huggingface.co';

// Sizes are asserted, not assumed. A truncated ONNX file fails at session
// creation with a protobuf error that says nothing about the download, and a
// truncated catalog loads as garbage that quietly scores every card wrong.
//
// And pinned: each file is fetched from one Hugging Face commit (`revision`) and
// must hash to the SHA-256 that commit's LFS pointer records, or it is refused.
// They used to come from `resolve/main`, a moving target, checked by size alone,
// and went straight into native ONNX and npz parsing. Both values were read from
// the Hugging Face API (/api/models/<repo>/revision/main, then /tree/<revision>)
// on 2026-11-15; moving to a newer file means updating all three fields here.
const MODEL_REVISION = '2ef37ff78ee80ad4c3558e4a15341e447ff8a1be';   // HanClinto/ccgdetector-fastweb-single
const MILO_REVISION = '9bcc5e809e936b8c5630d1e7101aae1de1e76621';    // HanClinto/milo
// Which embedding space a catalog's vectors live in: catalogs built here and the
// ones Bindarr publishes (catalogReleases.js) record it, and one built for another
// model is rebuilt or refused, never mixed. Bumped only if milo itself is replaced.
const MODEL_ID = 'milo1';
const MODELS = [
  {
    name: 'cornelius.onnx', repo: 'HanClinto/ccgdetector-fastweb-single', revision: MODEL_REVISION,
    file: 'fastweb-single-1.39.onnx', bytes: 3185226,
    sha256: '05d2b90b928a5a3bf0f49aa90aa86211b2103d9c347c238fd18b4f544b3cb8ca',
  },
  {
    name: 'milo.onnx', repo: 'HanClinto/milo', revision: MILO_REVISION,
    file: 'model.onnx', bytes: 5191100,
    sha256: 'bd13d8d60383c69da04dce261f32e93fdaeaa8fd618fbc991e7385f71b3d45df',
  },
];

// Every catalog the author publishes for a game Bindarr knows (catalogs/
// manifest.json in HanClinto/milo). Magic's is keyed by Scryfall id; the rest by
// TCGplayer product id, which for the TCGplayer-catalogue games IS the card id
// (`yugioh-<productId>`, scan.publishedIds "cardId" in shared/games.json) and for
// Lorcana resolves through the card's tcgplayer_product_id (scanCandidates). The
// TCGplayer snapshots are all from 2026-05-07: a card printed since is not in
// them. Bindarr's own weekly catalogs (catalogReleases.js) are what installs use
// first; these are the fallback when that release cannot be reached.
const CATALOGS = [
  {
    name: 'milo-mtg.npz', repo: 'HanClinto/milo', revision: MILO_REVISION, game: 'mtg',
    file: 'catalogs/milo1-scryfall-mtg-2026-07-09.npz', bytes: 56252182, snapshot: '2026-07-09',
    sha256: 'c5cb0dc150eb9f5b183396dd25aecaa9efc5ce3d001dd8bef282fcc73ee778be',
  },
  {
    name: 'milo-pokemon.npz', repo: 'HanClinto/milo', revision: MILO_REVISION, game: 'pokemon',
    file: 'catalogs/milo1-tcgplayer-pokemon-2026-05-07.npz', bytes: 13236761, snapshot: '2026-05-07',
    sha256: '84fecd5b9f1ddc4973fbb276bc9b0d253ac100e35d57ef00c5cfd6432aaa9dff',
  },
  {
    name: 'milo-lorcana.npz', repo: 'HanClinto/milo', revision: MILO_REVISION, game: 'lorcana',
    file: 'catalogs/milo1-tcgplayer-lorcana-2026-05-07.npz', bytes: 1325444, snapshot: '2026-05-07',
    sha256: '3b08de5639a4a7da4115e439c7872e62498ddfecead8c140d5566663829b657c',
  },
  {
    name: 'milo-yugioh.npz', repo: 'HanClinto/milo', revision: MILO_REVISION, game: 'yugioh',
    file: 'catalogs/milo1-tcgplayer-yugioh-2026-05-07.npz', bytes: 20897555, snapshot: '2026-05-07',
    sha256: 'c30e6977b7d2e10242e38bae056439df33c6ec10dc95240cbb8d1097a03c5f34',
  },
  {
    name: 'milo-onepiece.npz', repo: 'HanClinto/milo', revision: MILO_REVISION, game: 'onepiece',
    file: 'catalogs/milo1-tcgplayer-onepiece-2026-05-07.npz', bytes: 2969546, snapshot: '2026-05-07',
    sha256: 'cd1c30a76aff40cc3474b067f4c580caff8ad5e3425e3c75e93994bbe8b70b84',
  },
  {
    name: 'milo-digimon.npz', repo: 'HanClinto/milo', revision: MILO_REVISION, game: 'digimon',
    file: 'catalogs/milo1-tcgplayer-digimon-2026-05-07.npz', bytes: 3928146, snapshot: '2026-05-07',
    sha256: '944ae395cbb81b5e954f3b0970bf8be369caed83a4525a408dd8afb70178d38c',
  },
  {
    name: 'milo-fab.npz', repo: 'HanClinto/milo', revision: MILO_REVISION, game: 'fab',
    file: 'catalogs/milo1-tcgplayer-fab-2026-05-07.npz', bytes: 4278376, snapshot: '2026-05-07',
    sha256: 'ec5ad27791347430d43f7fc1c60ca4f9d1f0ccaa91450802dfc77c2d50d35b95',
  },
  {
    name: 'milo-swu.npz', repo: 'HanClinto/milo', revision: MILO_REVISION, game: 'swu',
    file: 'catalogs/milo1-tcgplayer-swu-2026-05-07.npz', bytes: 3167209, snapshot: '2026-05-07',
    sha256: 'e768734a746372a6eadb4518acdfa1a4c434b2c30c62e1cce9c529721e710471',
  },
];

// Where an asset is fetched from: its pinned commit, never a branch.
const assetUrl = (a) => `${HF}/${a.repo}/resolve/${a.revision}/${a.file}`;

const LICENSE = {
  spdx: 'MIT / AGPL-3.0',
  urls: ['https://huggingface.co/HanClinto/ccgdetector-fastweb-single', 'https://huggingface.co/HanClinto/milo'],
};

const assetPath = (a) => path.join(MODEL_DIR, a.name);
// Earlier releases' files that still work but have been superseded. The original
// cornelius (4.41 MB) is a valid corner model, so an install that has it scans —
// but fastweb-single replaced it in 1.8.3 for a ~4x faster live outline, and
// accepting the old size as simply "present" meant no install that downloaded
// before then was ever offered the faster one.
const LEGACY_BYTES = { 'cornelius.onnx': [4407545] };
const sizeOf = (a) => { try { return fs.statSync(assetPath(a)).size; } catch { return -1; } };
// Present means present AND a known size. A half-written file from a killed
// container reads as installed otherwise, and then fails at inference time.
const isCurrent = (a) => sizeOf(a) === a.bytes;
const isOutdated = (a) => (LEGACY_BYTES[a.name] || []).includes(sizeOf(a));
const isPresent = (a) => isCurrent(a) || isOutdated(a);

// One download at a time, mirroring catalog.js: these are tens of megabytes from
// someone else's free CDN, and two at once helps nobody.
let current = null;
const state = () => (current ? { ...current } : null);
let last = null;
const lastResult = () => last;

function status() {
  return {
    dir: MODEL_DIR,
    license: LICENSE,
    models: MODELS.map(a => ({ name: a.name, bytes: a.bytes, present: isPresent(a), outdated: isOutdated(a) })),
    catalogs: CATALOGS.map(a => ({
      name: a.name, game: a.game, bytes: a.bytes, snapshot: a.snapshot, present: isPresent(a),
    })),
    progress: state(),
    last,
  };
}

// Stream to a temp file and rename, so an interrupted download cannot leave a
// half file that the size check above would have to catch later.
// `fetchImpl` is a seam for tests, which must never reach Hugging Face.
async function fetchAsset(a, onProgress, { fetchImpl = fetch } = {}) {
  const dest = assetPath(a);
  // Current, not merely present: an outdated file is replaced. The rename below
  // swaps it atomically, so scanning keeps the old model until the new one lands.
  if (isCurrent(a)) return 'present';
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  const res = await fetchImpl(assetUrl(a), {
    // Bindarr's own name (utils/providerClient), not a browser's.
    headers: { 'User-Agent': require('./providerClient').USER_AGENT },
    redirect: 'follow', signal: AbortSignal.timeout(900000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${a.name}`);
  const tmp = `${dest}.tmp`;
  const out = fs.createWriteStream(tmp);
  const hash = require('crypto').createHash('sha256');
  let got = 0;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
      onProgress?.(got);
    }
    await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
  } catch (e) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  if (got !== a.bytes) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`${a.name} came back ${got} bytes, expected ${a.bytes} — refusing to install it`);
  }
  // Right size, wrong bytes is a different file: never handed to the ONNX or npz
  // parser, which are native code reading whatever they are given.
  const digest = hash.digest('hex');
  if (digest !== a.sha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`${a.name} has SHA-256 ${digest}, expected ${a.sha256} — refusing to install it`);
  }
  fs.renameSync(tmp, dest);
  return 'fetched';
}

// `what`: 'models' | 'catalog:<game>'. Returns the progress record; the caller
// polls status() rather than waiting, because this is a multi-minute download.
function start(what) {
  if (current) throw new Error('a download is already running');
  const wanted = what === 'models'
    ? MODELS
    : CATALOGS.filter(c => `catalog:${c.game}` === what);
  if (!wanted.length) throw new Error(`nothing to download for "${what}"`);

  const job = {
    what, name: wanted[0].name, done: 0,
    total: wanted.reduce((n, a) => n + a.bytes, 0),
    phase: 'downloading', message: '',
  };
  current = job;
  (async () => {
    let base = 0, fetched = 0;
    try {
      for (const a of wanted) {
        job.name = a.name;
        const result = await fetchAsset(a, (got) => { job.done = base + got; });
        if (result === 'fetched') fetched++;
        base += a.bytes;
        job.done = base;
      }
      job.phase = 'done';
      job.message = `${fetched} file(s) downloaded, ${wanted.length - fetched} already present`;
      // A newly installed catalog or model has to be picked up without a restart.
      try {
        const cvScan = require('../cvScan');
        for (const game of require('./games').withFeature('scan')) cvScan.reload(game);
        if (what === 'models' && fetched) cvScan.reloadModels();
      } catch { /* nothing loaded yet is fine — the next scan loads it */ }
      // The published Pokémon catalog is keyed by TCGplayer product id, and a
      // product id names no card without the product map. Downloading one without
      // the other is a scanner that matches and then says nothing, so the download
      // pulls its own second half rather than leaving it as a step to discover.
      if (what === 'catalog:pokemon') {
        try { require('../tcgplayerCatalog').start(); }
        catch (e) { console.warn(`product map not started: ${e.message}`); }
      }
    } catch (e) {
      job.phase = 'error';
      job.message = e.message;
      console.error(`model download failed (${what}):`, e.message);
    } finally {
      last = { ...job, finishedAt: Date.now() };
      current = null;
    }
  })();
  return state();
}

module.exports = { MODELS, CATALOGS, LICENSE, MODEL_DIR, MODEL_ID, status, start, state, lastResult, isPresent, isOutdated, fetchAsset, assetUrl };
