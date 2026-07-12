// Server-side card identification by CLIP image embedding.
//
// Loads the precomputed per-game embedding DB (backend/data/{game}-embed.bin +
// -meta.json, built by scripts/build-card-embeddings.mjs) and the CLIP encoder,
// then matches an uploaded card image against every card by cosine similarity.
//
// @huggingface/transformers is ESM-only, so it is imported lazily via dynamic
// import(). Model + DBs are cached singletons; the first match() pays the load.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DATA_DIR = path.join(__dirname, '..', 'data');

let tfPromise = null;      // resolves to { pipeline, RawImage }
let extractorPromise = null;
const dbs = {};            // game -> { vecs: Float32Array, cards, n, dim } | null

function loadTransformers() {
  if (!tfPromise) tfPromise = import('@huggingface/transformers');
  return tfPromise;
}

// Load a game's embedding DB from disk once. Returns null if not built yet.
function loadDb(game) {
  if (game in dbs) return dbs[game];
  const binPath = path.join(DATA_DIR, `${game}-embed.bin`);
  const metaPath = path.join(DATA_DIR, `${game}-embed-meta.json`);
  if (!fs.existsSync(binPath) || !fs.existsSync(metaPath)) { dbs[game] = null; return null; }
  const meta = JSON.parse(fs.readFileSync(metaPath));
  const buf = fs.readFileSync(binPath);
  // Copy into an aligned Float32Array (fs Buffer may not be 4-byte aligned).
  const vecs = new Float32Array(buf.length / 4);
  Buffer.from(vecs.buffer).set(buf);
  dbs[game] = { vecs, cards: meta.cards, n: meta.cards.length, dim: meta.dim, model: meta.model };
  console.log(`embedMatch: loaded ${game} DB (${meta.cards.length} cards, dim ${meta.dim})`);
  return dbs[game];
}

async function getExtractor(model) {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await loadTransformers();
      console.log(`embedMatch: loading model ${model}...`);
      return pipeline('image-feature-extraction', model);
    })();
  }
  return extractorPromise;
}

// L2-normalized embedding of an image Buffer (shape-robust; mirrors the build).
async function embedImage(imageBuffer, model) {
  const { RawImage } = await loadTransformers();
  const extractor = await getExtractor(model);
  const { data, info } = await sharp(imageBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const img = new RawImage(new Uint8ClampedArray(data), info.width, info.height, 3);
  const out = await extractor(img, { pooling: 'mean', normalize: true });
  let v = out.tolist();
  while (Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && Array.isArray(v[0][0])) v = v[0];
  if (Array.isArray(v) && v.length === 1) v = v[0];
  if (Array.isArray(v[0])) {
    const D = v[0].length, m = new Float32Array(D);
    for (const row of v) for (let i = 0; i < D; i++) m[i] += row[i] / v.length;
    v = Array.from(m);
  }
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  return Float32Array.from(v.map(x => x / n));
}

// Match an image against a game's DB. Returns up to topK
// [{ name, set, number, score }] sorted by descending cosine (1 = identical),
// or [] if the DB isn't built. Both query and DB vectors are unit-length, so
// cosine is a plain dot product.
async function match(imageBuffer, game, topK = 8) {
  const db = loadDb(game);
  if (!db) return [];
  const q = await embedImage(imageBuffer, db.model);
  if (q.length !== db.dim) throw new Error(`embedding dim mismatch: query ${q.length} vs db ${db.dim}`);

  const { vecs, cards, n, dim } = db;
  const best = []; // ascending by score, length <= topK
  for (let r = 0; r < n; r++) {
    const base = r * dim;
    let s = 0;
    for (let d = 0; d < dim; d++) s += q[d] * vecs[base + d];
    if (best.length < topK || s > best[0].score) {
      const row = cards[r];
      const cand = { name: row[0], set: row[1], number: row[2], score: s };
      let pos = 0;
      while (pos < best.length && best[pos].score < s) pos++;
      best.splice(pos, 0, cand);
      if (best.length > topK) best.shift();
    }
  }
  return best.reverse(); // descending: closest first
}

module.exports = { match };
