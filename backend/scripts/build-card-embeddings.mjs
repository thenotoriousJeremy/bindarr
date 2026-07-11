/*
 * Precompute CLIP image embeddings for every card, for server-side scan matching.
 *
 * For each card: download its image, run it through the CLIP image encoder, and
 * store the 512-d unit vector. Output (server-side, NOT shipped to the client):
 *   backend/data/{game}-embed.bin        Float32, N * DIM
 *   backend/data/{game}-embed-meta.json  { model, dim, cards: [[name,set,number]] }
 * Row i of the .bin is card i of the meta.
 *
 * Heavy, one-time (per game): ~74k images downloaded + encoded on CPU, hours.
 * Checkpoints every 2000 cards; rerun with --resume to continue after a stop.
 *
 * Usage:
 *   node scripts/build-card-embeddings.mjs --game mtg
 *   node scripts/build-card-embeddings.mjs --game pokemon --resume
 *   node scripts/build-card-embeddings.mjs --game mtg --limit 20   (smoke test)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import sharp from 'sharp';
import { pipeline, RawImage } from '@huggingface/transformers';
import { makeHttp, gatherMtg, gatherPokemon, sleep } from './cardSources.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Keep in sync with backend/src/embedMatch.js — both sides must use the same
// model so the vectors are comparable.
export const MODEL = 'Xenova/clip-vit-base-patch32';
const DIM = 512;
const DATA_DIR = path.join(__dirname, '..', 'data');

function arg(flag, def) { const i = process.argv.indexOf(flag); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; }
const hasFlag = (f) => process.argv.includes(f);

// L2-normalized embedding from an image Buffer, shape-robust across models.
async function embedImage(extractor, buf) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
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

async function main() {
  const game = arg('--game', 'mtg');
  if (game !== 'mtg' && game !== 'pokemon') { console.error('Use --game mtg|pokemon'); process.exit(1); }
  const limit = parseInt(arg('--limit', '0'), 10) || 0;
  const delay = parseInt(arg('--delay', '100'), 10);
  const resume = hasFlag('--resume');

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const binPath = path.join(DATA_DIR, `${game}-embed.bin`);
  const metaPath = path.join(DATA_DIR, `${game}-embed-meta.json`);

  const http = makeHttp();
  let cards = game === 'pokemon' ? await gatherPokemon(http, delay, limit) : await gatherMtg(http);
  if (limit) cards = cards.slice(0, limit);

  // Resume: keep the rows already computed, continue from there.
  let meta = [];
  let done = 0;
  const hashes = Buffer.alloc(cards.length * DIM * 4);
  if (resume && fs.existsSync(metaPath) && fs.existsSync(binPath)) {
    meta = JSON.parse(fs.readFileSync(metaPath)).cards || [];
    const prev = fs.readFileSync(binPath);
    prev.copy(hashes, 0, 0, Math.min(prev.length, hashes.length));
    done = meta.length;
    console.log(`Resuming: ${done} already embedded.`);
  }

  console.log(`Loading model ${MODEL}...`);
  const extractor = await pipeline('image-feature-extraction', MODEL);

  const flush = () => {
    fs.writeFileSync(binPath, hashes.subarray(0, meta.length * DIM * 4));
    fs.writeFileSync(metaPath, JSON.stringify({ model: MODEL, dim: DIM, cards: meta }));
  };

  console.log(`Embedding ${cards.length - done} of ${cards.length} ${game} cards...`);
  let fail = 0;
  for (let i = done; i < cards.length; i++) {
    const c = cards[i];
    try {
      const buf = Buffer.from((await http.get(c.img, { responseType: 'arraybuffer', timeout: 30000 })).data);
      const emb = await embedImage(extractor, buf);
      Buffer.from(emb.buffer).copy(hashes, meta.length * DIM * 4);
      meta.push([c.name, c.set, c.number]);
    } catch (e) {
      fail++;
    }
    if ((i + 1) % 250 === 0) console.log(`  ${i + 1}/${cards.length} (fail ${fail})`);
    if ((i + 1) % 2000 === 0) flush();
    await sleep(delay);
  }
  flush();
  console.log(`Done. Wrote ${meta.length} embeddings (${fail} failed).`);
  console.log(`  ${binPath} (${(fs.statSync(binPath).size / 1e6).toFixed(1)} MB)`);
}
main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
