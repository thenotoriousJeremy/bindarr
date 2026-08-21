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
const MODELS = [
  { name: 'cornelius.onnx', repo: 'HanClinto/ccgdetector-fastweb-single', file: 'fastweb-single-1.39.onnx', bytes: 3185226 },
  { name: 'milo.onnx', repo: 'HanClinto/milo', file: 'model.onnx', bytes: 5191100 },
];

const CATALOGS = [
  {
    name: 'milo-mtg.npz', repo: 'HanClinto/milo', game: 'mtg',
    file: 'catalogs/milo1-scryfall-mtg-2026-07-09.npz', bytes: 56252182, snapshot: '2026-07-09',
  },
  {
    name: 'milo-pokemon.npz', repo: 'HanClinto/milo', game: 'pokemon',
    file: 'catalogs/milo1-tcgplayer-pokemon-2026-05-07.npz', bytes: 13236761, snapshot: '2026-05-07',
  },
];

const LICENSE = {
  spdx: 'MIT / AGPL-3.0',
  urls: ['https://huggingface.co/HanClinto/ccgdetector-fastweb-single', 'https://huggingface.co/HanClinto/milo'],
};

const assetPath = (a) => path.join(MODEL_DIR, a.name);
// Present means present AND the right size. A half-written file from a killed
// container reads as installed otherwise, and then fails at inference time.
// Supports both new fastweb-single (3.19 MB) and previous cornelius (4.41 MB).
const isPresent = (a) => {
  try {
    const sz = fs.statSync(assetPath(a)).size;
    if (a.name === 'cornelius.onnx') return sz === a.bytes || sz === 4407545;
    return sz === a.bytes;
  } catch { return false; }
};

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
    models: MODELS.map(a => ({ name: a.name, bytes: a.bytes, present: isPresent(a) })),
    catalogs: CATALOGS.map(a => ({
      name: a.name, game: a.game, bytes: a.bytes, snapshot: a.snapshot, present: isPresent(a),
    })),
    progress: state(),
    last,
  };
}

// Stream to a temp file and rename, so an interrupted download cannot leave a
// half file that the size check above would have to catch later.
async function fetchAsset(a, onProgress) {
  const dest = assetPath(a);
  if (isPresent(a)) return 'present';
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  const res = await fetch(`${HF}/${a.repo}/resolve/main/${a.file}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    redirect: 'follow', signal: AbortSignal.timeout(900000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${a.name}`);
  const tmp = `${dest}.tmp`;
  const out = fs.createWriteStream(tmp);
  let got = 0;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
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
        for (const game of ['mtg', 'pokemon']) cvScan.reload(game);
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

module.exports = { MODELS, CATALOGS, LICENSE, MODEL_DIR, status, start, state, lastResult, isPresent };
