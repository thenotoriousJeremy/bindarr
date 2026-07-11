/*
 * Precompute ORB features per card for geometric-verification matching.
 *
 * For each card: download image, extract up to CAP ORB keypoints+descriptors.
 * Output (server-side):
 *   backend/data/{game}-orb-desc.bin   Uint8, concatenated 32-byte descriptors
 *   backend/data/{game}-orb-kp.bin     Float32, concatenated [x,y] per descriptor
 *   backend/data/{game}-orb-meta.json  { cap, cards: [[name,set,number,offset,count]] }
 * offset/count index into the desc (rows) and kp (rows) arrays.
 *
 * Keyed at query time by (set|number), so it need not align with the CLIP DB.
 * Heavy, one-time. Checkpoints every 2000; rerun with --resume to continue.
 *
 *   node scripts/build-card-orb.mjs --game mtg
 *   node scripts/build-card-orb.mjs --game pokemon --resume
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import sharp from 'sharp';
import pkg from 'opencv-wasm';
import { makeHttp, gatherMtg, gatherPokemon, sleep } from './cardSources.js';

const { cv } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const DATA_DIR = path.join(__dirname, '..', 'data');
const CAP = 500;          // max descriptors kept per card
const REF_WIDTH = 500;    // resize reference images to this width (match query side)
const DESC_BYTES = 32;    // ORB descriptor size

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const hasFlag = (f) => process.argv.includes(f);

function ready() {
  return new Promise((res) => {
    if (cv && cv.Mat) return res();
    cv.onRuntimeInitialized = () => res();
  });
}

// ORB descriptors + keypoint coords for an image buffer. Returns { desc: Uint8Array
// (count*32), kp: Float32Array (count*2), count }.
function extractOrb(orb, rgbaData, w, h) {
  const rgba = cv.matFromImageData({ data: rgbaData, width: w, height: h });
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  const kpv = new cv.KeyPointVector();
  const desc = new cv.Mat();
  orb.detectAndCompute(gray, new cv.Mat(), kpv, desc);
  const n = Math.min(desc.rows, CAP);
  const out = { desc: new Uint8Array(n * DESC_BYTES), kp: new Float32Array(n * 2), count: n };
  if (n > 0) {
    out.desc.set(desc.data.subarray(0, n * DESC_BYTES));
    for (let i = 0; i < n; i++) { const p = kpv.get(i).pt; out.kp[i * 2] = p.x; out.kp[i * 2 + 1] = p.y; }
  }
  rgba.delete(); gray.delete(); kpv.delete(); desc.delete();
  return out;
}

async function main() {
  const game = arg('--game', 'mtg');
  if (game !== 'mtg' && game !== 'pokemon') { console.error('Use --game mtg|pokemon'); process.exit(1); }
  const limit = parseInt(arg('--limit', '0'), 10) || 0;
  const delay = parseInt(arg('--delay', '60'), 10);
  const resume = hasFlag('--resume');
  await ready();

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const descPath = path.join(DATA_DIR, `${game}-orb-desc.bin`);
  const kpPath = path.join(DATA_DIR, `${game}-orb-kp.bin`);
  const metaPath = path.join(DATA_DIR, `${game}-orb-meta.json`);

  const http = makeHttp();
  let cards = game === 'pokemon' ? await gatherPokemon(http, delay, limit) : await gatherMtg(http);
  if (limit) cards = cards.slice(0, limit);

  let meta = [];
  let done = 0;
  let descOffset = 0; // in descriptors (rows)
  const descFd = fs.openSync(descPath, resume && fs.existsSync(descPath) ? 'r+' : 'w');
  const kpFd = fs.openSync(kpPath, resume && fs.existsSync(kpPath) ? 'r+' : 'w');
  if (resume && fs.existsSync(metaPath)) {
    meta = JSON.parse(fs.readFileSync(metaPath)).cards || [];
    done = meta.length;
    if (done) { const last = meta[done - 1]; descOffset = last[3] + last[4]; }
    // Truncate bins to the consistent written length.
    fs.ftruncateSync(descFd, descOffset * DESC_BYTES);
    fs.ftruncateSync(kpFd, descOffset * 2 * 4);
    console.log(`Resuming: ${done} cards, ${descOffset} descriptors.`);
  }

  const orb = new cv.ORB(CAP);
  const flushMeta = () => fs.writeFileSync(metaPath, JSON.stringify({ cap: CAP, refWidth: REF_WIDTH, cards: meta }));

  console.log(`Extracting ORB for ${cards.length - done} of ${cards.length} ${game} cards...`);
  let fail = 0;
  for (let i = done; i < cards.length; i++) {
    const c = cards[i];
    try {
      const buf = Buffer.from((await http.get(c.img, { responseType: 'arraybuffer', timeout: 30000 })).data);
      const { data, info } = await sharp(buf).resize({ width: REF_WIDTH, withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const f = extractOrb(orb, new Uint8ClampedArray(data), info.width, info.height);
      fs.writeSync(descFd, Buffer.from(f.desc.buffer, 0, f.desc.length), 0, f.desc.length, descOffset * DESC_BYTES);
      fs.writeSync(kpFd, Buffer.from(f.kp.buffer, 0, f.kp.byteLength), 0, f.kp.byteLength, descOffset * 2 * 4);
      meta.push([c.name, c.set, c.number, descOffset, f.count]);
      descOffset += f.count;
    } catch (e) {
      fail++;
    }
    if ((i + 1) % 250 === 0) console.log(`  ${i + 1}/${cards.length} (fail ${fail}, ${descOffset} desc)`);
    if ((i + 1) % 2000 === 0) flushMeta();
    await sleep(delay);
  }
  flushMeta();
  fs.closeSync(descFd); fs.closeSync(kpFd);
  console.log(`Done. ${meta.length} cards, ${descOffset} descriptors (${fail} failed).`);
  console.log(`  ${descPath} (${(fs.statSync(descPath).size / 1e6).toFixed(0)} MB)`);
}
main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
