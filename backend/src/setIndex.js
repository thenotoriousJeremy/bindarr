// Per-set ORB index for set-scoped card identification.
//
// When the user tells the scanner which set they're feeding (MTG set code), we
// don't need to recall one card out of 53k — just identify it among that set's
// ~300 printings. This builds (lazily, then caches to disk) an ORB index for a
// single set from Scryfall and matches a query against only those cards, so the
// hard global-recall problem disappears. The exact printing wins on inliers.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { cv } = require('opencv-wasm');

const SETS_DIR = path.join(__dirname, '..', 'data', 'sets');
const DESC_BYTES = 32, CAP = 500, REF_WIDTH = 500, RATIO = 0.75, RANSAC_PX = 5.0;
const MATCH_N = 175; // descriptors used per side when matching (speed vs the full 500)

const http = axios.create({ timeout: 30000, headers: { 'User-Agent': 'CardDexrr/1.0', 'Accept': 'application/json' } });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const cache = {};        // "game|set" -> { meta, desc:Buffer, kp:Buffer } (loaded)
const building = {};     // "game|set" -> Promise (in-flight build)

const norm = (set) => (set || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const paths = (game, set) => {
  const base = path.join(SETS_DIR, `${game}-${norm(set)}-orb`);
  return { desc: `${base}-desc.bin`, kp: `${base}-kp.bin`, meta: `${base}-meta.json` };
};

function orbExtract(orb, rgba, w, h) {
  const src = cv.matFromImageData({ data: rgba, width: w, height: h });
  const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const kpv = new cv.KeyPointVector(); const desc = new cv.Mat();
  orb.detectAndCompute(gray, new cv.Mat(), kpv, desc);
  const n = Math.min(desc.rows, CAP);
  const out = { desc: new Uint8Array(n * DESC_BYTES), kp: new Float32Array(n * 2), count: n };
  if (n > 0) {
    out.desc.set(desc.data.subarray(0, n * DESC_BYTES));
    for (let i = 0; i < n; i++) { const p = kpv.get(i).pt; out.kp[i * 2] = p.x; out.kp[i * 2 + 1] = p.y; }
  }
  src.delete(); gray.delete(); kpv.delete(); desc.delete();
  return out;
}

// Fetch every printing in a set from Scryfall, ORB-index each, persist.
async function buildSet(game, set) {
  if (game !== 'mtg') throw new Error('set index only supports mtg');
  fs.mkdirSync(SETS_DIR, { recursive: true });
  console.log(`setIndex: building ${set}...`);
  let url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(`set:${set} unique:prints`)}&order=set`;
  const cards = [];
  while (url) {
    const r = await http.get(url);
    for (const c of r.data.data || []) {
      const img = c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal;
      if (img) cards.push({ name: c.name || '', set: c.set || set, number: c.collector_number || '', img });
    }
    url = r.data.has_more ? r.data.next_page : null;
    await sleep(120);
  }
  if (cards.length === 0) throw new Error(`no cards for set ${set}`);

  const p = paths(game, set);
  const descFd = fs.openSync(p.desc, 'w'), kpFd = fs.openSync(p.kp, 'w');
  const orb = new cv.ORB(CAP);
  const meta = [];
  let offset = 0;
  for (const c of cards) {
    try {
      const buf = Buffer.from((await http.get(c.img, { responseType: 'arraybuffer', timeout: 30000 })).data);
      const { data, info } = await sharp(buf).resize({ width: REF_WIDTH, withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const f = orbExtract(orb, new Uint8ClampedArray(data), info.width, info.height);
      fs.writeSync(descFd, Buffer.from(f.desc.buffer, 0, f.desc.length), 0, f.desc.length, offset * DESC_BYTES);
      fs.writeSync(kpFd, Buffer.from(f.kp.buffer, 0, f.kp.byteLength), 0, f.kp.byteLength, offset * 2 * 4);
      meta.push([c.name, c.set, c.number, offset, f.count]);
      offset += f.count;
    } catch (e) { /* skip a bad image */ }
    await sleep(60);
  }
  orb.delete();
  fs.closeSync(descFd); fs.closeSync(kpFd);
  fs.writeFileSync(p.meta, JSON.stringify({ set, cards: meta }));
  console.log(`setIndex: ${set} indexed ${meta.length} cards`);
}

function loadSet(game, set) {
  const k = `${game}|${norm(set)}`;
  if (cache[k]) return cache[k];
  const p = paths(game, set);
  if (!fs.existsSync(p.meta)) return null;
  cache[k] = { meta: JSON.parse(fs.readFileSync(p.meta)).cards, desc: fs.readFileSync(p.desc), kp: fs.readFileSync(p.kp) };
  return cache[k];
}

// Build (if needed) + load a set index. Concurrent callers share one build.
async function ensureSet(game, set) {
  const k = `${game}|${norm(set)}`;
  if (loadSet(game, set)) return true;
  if (!building[k]) {
    building[k] = buildSet(game, set).then(() => { loadSet(game, set); }).catch(e => { console.error('setIndex build failed:', e.message); throw e; }).finally(() => { delete building[k]; });
  }
  try { await building[k]; return !!cache[k]; } catch { return false; }
}

function isReady(game, set) { return !!loadSet(game, set); }

// Inlier count between query features and a stored card's features.
function inliers(bf, qDescFull, qKp, refDesc, refKp, count) {
  if (count < 4 || qDescFull.rows < 4) return 0;
  // Cap both sides to MATCH_N descriptors to keep knnMatch fast over a whole set.
  const nRef = Math.min(count, MATCH_N);
  const qDesc = qDescFull.rows > MATCH_N ? qDescFull.rowRange(0, MATCH_N) : qDescFull;
  const cand = new cv.Mat(nRef, DESC_BYTES, cv.CV_8U);
  cand.data.set(refDesc.subarray(0, nRef * DESC_BYTES));
  const knn = new cv.DMatchVectorVector();
  bf.knnMatch(qDesc, cand, knn, 2);
  const src = [], dst = [];
  for (let i = 0; i < knn.size(); i++) {
    const m = knn.get(i);
    if (m.size() < 2) continue;
    const a = m.get(0), b = m.get(1);
    if (a.distance < RATIO * b.distance) {
      src.push(qKp[a.queryIdx * 2], qKp[a.queryIdx * 2 + 1]);
      dst.push(refKp[a.trainIdx * 2], refKp[a.trainIdx * 2 + 1]);
    }
  }
  knn.delete(); cand.delete();
  const good = src.length / 2;
  if (good < 4) return 0;
  const sM = cv.matFromArray(good, 1, cv.CV_32FC2, src);
  const dM = cv.matFromArray(good, 1, cv.CV_32FC2, dst);
  const mask = new cv.Mat();
  const H = cv.findHomography(sM, dM, cv.RANSAC, RANSAC_PX, mask);
  const inl = H.empty() ? 0 : cv.countNonZero(mask);
  sM.delete(); dM.delete(); mask.delete(); H.delete();
  return inl;
}

// Match query ORB features against every card in a set. q = { desc:Mat, kp:Float32Array }.
function matchSet(q, game, set, topK = 8) {
  const idx = loadSet(game, set);
  if (!idx) return null;
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const scored = [];
  try {
    for (const [name, s, number, offset, count] of idx.meta) {
      const refDesc = idx.desc.subarray(offset * DESC_BYTES, (offset + count) * DESC_BYTES);
      const refKp = new Float32Array(idx.kp.buffer, idx.kp.byteOffset + offset * 2 * 4, count * 2);
      const inl = inliers(bf, q.desc, q.kp, refDesc, refKp, count);
      scored.push({ name, set: s, number, inliers: inl, score: 0 });
    }
  } finally { bf.delete(); }
  scored.sort((a, b) => b.inliers - a.inliers);
  return scored.slice(0, topK);
}

module.exports = { ensureSet, isReady, matchSet };
