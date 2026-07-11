// Hybrid card identification: CLIP embedding recall + ORB geometric verification.
//
// 1. Recall: embedMatch (CLIP) returns the top-RECALL_K visually-nearest cards.
// 2. Verify: for each, match ORB descriptors to the query and fit a RANSAC
//    homography; the inlier count is decisive (only the true card produces many
//    geometrically-consistent matches). Rank by inliers.
//
// Falls back to CLIP-only ranking if the ORB DB for a game isn't built yet.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { cv } = require('opencv-wasm');
const embedMatch = require('./embedMatch');
const setIndex = require('./setIndex');

const DATA_DIR = path.join(__dirname, '..', 'data');
const RECALL_K = 250;      // CLIP candidates to geometrically verify
const REF_WIDTH = 500;     // must match build-card-orb.mjs
const DESC_BYTES = 32;
const RATIO = 0.75;        // Lowe ratio test
const RANSAC_PX = 5.0;
const CARD_ASPECT = 2.5 / 3.5;
const WARP_W = 500, WARP_H = Math.round(500 / CARD_ASPECT); // rectified card size

// Order 4 quad points as [tl, tr, br, bl] using coordinate sums/diffs.
function orderQuad(pts) {
  const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]]; // tl, tr, br, bl
}

// Locate the card and return a rectified raw-RGBA image, or null if no card-like
// region is found. Two strategies, tried in order:
//   1. A clean 4-point convex quad -> perspective-warp flat (handles tilt/skew).
//   2. Else the largest card-aspect region's bounding box -> plain crop (slinger
//      cards sit flat and upright, so a crop is enough and works when the card is
//      small/far where a crisp quad isn't found).
// Both prefer the region nearest the frame center (the card the user aimed at).
// The area floor is low (4%) so distant cards are still detected instead of
// falling back to a background-dominated center crop.
function detectCard(rgbaData, w, h) {
  const src = cv.matFromImageData({ data: rgbaData, width: w, height: h });
  const gray = new cv.Mat(), edges = new cv.Mat();
  const contours = new cv.MatVector(), hier = new cv.Mat();
  let out = null;
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.Canny(gray, edges, 50, 150);
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    cv.dilate(edges, edges, k); k.delete();
    cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const imgArea = w * h, cx = w / 2, cy = h / 2, halfDiag = Math.hypot(w, h) / 2;
    // A whole card is a PORTRAIT rectangle at ~0.71 aspect. Requiring that reject
    // internal blocks (art window, type line, mana-symbol row) that otherwise win
    // as "large central rectangles". Score = size x aspect-fit x centrality.
    let best = null; // { score, isQuad, pts, br }
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area >= 0.04 * imgArea) {
        const br = cv.boundingRect(c);
        const ar = br.width / br.height; // portrait card ~0.71; internal blocks are wide (>1)
        if (ar >= 0.55 && ar <= 0.95) {
          const rcx = br.x + br.width / 2, rcy = br.y + br.height / 2;
          const centrality = 1 - Math.min(1, Math.hypot(rcx - cx, rcy - cy) / halfDiag);
          const aspectFit = 1 - Math.min(1, Math.abs(ar - CARD_ASPECT) / 0.25);
          const peri = cv.arcLength(c, true);
          const approx = new cv.Mat();
          cv.approxPolyDP(c, approx, 0.02 * peri, true);
          const isQuad = approx.rows === 4 && cv.isContourConvex(approx);
          const pts = isQuad ? Array.from({ length: 4 }, (_, j) => ({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] })) : null;
          // Quads get a small edge (clean outline -> deskew); require decent aspect.
          const score = (area / imgArea) * (0.4 + 0.6 * aspectFit) * (0.5 + 0.5 * centrality) * (isQuad ? 1.1 : 1);
          if (!best || score > best.score) best = { score, isQuad, pts, br };
          approx.delete();
        }
      }
      c.delete();
    }

    if (best && best.isQuad) {
      const [tl, tr, brc, bl] = orderQuad(best.pts);
      const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, brc.x, brc.y, bl.x, bl.y]);
      const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, WARP_W, 0, WARP_W, WARP_H, 0, WARP_H]);
      const M = cv.getPerspectiveTransform(srcTri, dstTri);
      const warped = new cv.Mat();
      cv.warpPerspective(src, warped, M, new cv.Size(WARP_W, WARP_H));
      out = { data: Buffer.from(warped.data), width: WARP_W, height: WARP_H, channels: 4 };
      srcTri.delete(); dstTri.delete(); M.delete(); warped.delete();
    } else if (best) {
      const b = best.br;
      const pad = Math.round(0.03 * Math.max(b.width, b.height));
      const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
      const rw = Math.min(w - x, b.width + 2 * pad), rh = Math.min(h - y, b.height + 2 * pad);
      const roi = src.roi(new cv.Rect(x, y, rw, rh)).clone();
      out = { data: Buffer.from(roi.data), width: rw, height: rh, channels: 4 };
      roi.delete();
    }
  } finally {
    src.delete(); gray.delete(); edges.delete(); contours.delete(); hier.delete();
  }
  return out;
}

// Produce the card image to match on: auto-cropped+deskewed if an outline is
// found, else a centered card-aspect crop of the frame (user aims the card in
// the guide box, so center is a safe fallback). Returns a PNG Buffer.
async function preprocessCard(imageBuffer) {
  try {
    const { data, info } = await sharp(imageBuffer).resize({ width: 1200, withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const card = detectCard(new Uint8ClampedArray(data), info.width, info.height);
    if (card) {
      return await sharp(card.data, { raw: { width: card.width, height: card.height, channels: 4 } }).png().toBuffer();
    }
  } catch (e) {
    console.warn('preprocessCard failed, using center crop:', e.message);
  }
  // Fallback: centered card-aspect crop.
  const meta = await sharp(imageBuffer).metadata();
  const ch = Math.round(Math.min(meta.height, meta.width / CARD_ASPECT) * 0.92);
  const cw = Math.round(ch * CARD_ASPECT);
  const left = Math.max(0, Math.round((meta.width - cw) / 2));
  const top = Math.max(0, Math.round((meta.height - ch) / 2));
  return sharp(imageBuffer).extract({ left, top, width: Math.min(cw, meta.width), height: Math.min(ch, meta.height) }).png().toBuffer();
}

const orbDbs = {};         // game -> { map: Map(key->{name,offset,count}), descFd, kpFd } | null

function key(set, number) { return `${set}|${number}`; }

// Load a game's ORB index (offsets in RAM; descriptors/keypoints read from disk
// per candidate). Returns null if not built.
function loadOrbDb(game) {
  if (game in orbDbs) return orbDbs[game];
  const descPath = path.join(DATA_DIR, `${game}-orb-desc.bin`);
  const kpPath = path.join(DATA_DIR, `${game}-orb-kp.bin`);
  const metaPath = path.join(DATA_DIR, `${game}-orb-meta.json`);
  if (!fs.existsSync(descPath) || !fs.existsSync(kpPath) || !fs.existsSync(metaPath)) { orbDbs[game] = null; return null; }
  const meta = JSON.parse(fs.readFileSync(metaPath));
  const map = new Map();
  for (const c of meta.cards) map.set(key(c[1], c[2]), { name: c[0], offset: c[3], count: c[4] });
  orbDbs[game] = { map, descFd: fs.openSync(descPath, 'r'), kpFd: fs.openSync(kpPath, 'r') };
  console.log(`scanMatch: loaded ${game} ORB DB (${meta.cards.length} cards)`);
  return orbDbs[game];
}

// Read one card's stored descriptors (cv.Mat CV_8U) + keypoints (Float32Array xy).
function readOrb(db, offset, count) {
  const descBuf = Buffer.alloc(count * DESC_BYTES);
  fs.readSync(db.descFd, descBuf, 0, descBuf.length, offset * DESC_BYTES);
  const kpBuf = Buffer.alloc(count * 2 * 4);
  fs.readSync(db.kpFd, kpBuf, 0, kpBuf.length, offset * 2 * 4);
  const desc = cv.matFromArray(count, DESC_BYTES, cv.CV_8U, Array.from(descBuf));
  const kp = new Float32Array(kpBuf.buffer, kpBuf.byteOffset, count * 2);
  return { desc, kp };
}

// Query ORB features from an image buffer (grayscale, resized like the build).
async function queryOrb(orb, imageBuffer) {
  const { data, info } = await sharp(imageBuffer).resize({ width: REF_WIDTH, withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = cv.matFromImageData({ data: new Uint8ClampedArray(data), width: info.width, height: info.height });
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  const kpv = new cv.KeyPointVector();
  const desc = new cv.Mat();
  orb.detectAndCompute(gray, new cv.Mat(), kpv, desc);
  const kp = new Float32Array(kpv.size() * 2);
  for (let i = 0; i < kpv.size(); i++) { const p = kpv.get(i).pt; kp[i * 2] = p.x; kp[i * 2 + 1] = p.y; }
  rgba.delete(); gray.delete(); kpv.delete();
  return { desc, kp }; // caller deletes desc
}

// RANSAC-homography inlier count between query and a candidate's ORB features.
function inlierCount(bf, qDesc, qKp, cand) {
  if (cand.count < 4 || qDesc.rows < 4) return 0;
  const knn = new cv.DMatchVectorVector();
  bf.knnMatch(qDesc, cand.desc, knn, 2);
  const src = [], dst = [];
  for (let i = 0; i < knn.size(); i++) {
    const m = knn.get(i);
    if (m.size() < 2) continue;
    const m0 = m.get(0), m1 = m.get(1);
    if (m0.distance < RATIO * m1.distance) {
      src.push(qKp[m0.queryIdx * 2], qKp[m0.queryIdx * 2 + 1]);
      dst.push(cand.kp[m0.trainIdx * 2], cand.kp[m0.trainIdx * 2 + 1]);
    }
  }
  knn.delete();
  const good = src.length / 2;
  if (good < 4) return 0;
  const srcM = cv.matFromArray(good, 1, cv.CV_32FC2, src);
  const dstM = cv.matFromArray(good, 1, cv.CV_32FC2, dst);
  const mask = new cv.Mat();
  const H = cv.findHomography(srcM, dstM, cv.RANSAC, RANSAC_PX, mask);
  const inl = H.empty() ? 0 : cv.countNonZero(mask);
  srcM.delete(); dstM.delete(); mask.delete(); H.delete();
  return inl;
}

const STRONG_INLIERS = 25; // enough to stop trying the other game

// Score one game: CLIP recall + ORB verify against the shared query features.
function verifyGame(cardBuf, game, q, bf, recall, topK) {
  const db = loadOrbDb(game);
  if (!db) return { verified: false, candidates: recall.slice(0, topK), top: 0 };
  const scored = [];
  for (const cand of recall) {
    const slice = db.map.get(key(cand.set, cand.number));
    let inliers = 0;
    if (slice) {
      const ref = readOrb(db, slice.offset, slice.count);
      inliers = inlierCount(bf, q.desc, q.kp, ref);
      ref.desc.delete();
    }
    scored.push({ name: cand.name, set: cand.set, number: cand.number, score: cand.score, inliers });
  }
  scored.sort((a, b) => (b.inliers - a.inliers) || (b.score - a.score));
  return { verified: true, candidates: scored.slice(0, topK), top: scored[0] ? scored[0].inliers : 0 };
}

// Identify a card image. Auto-detects the game: verifies the requested game
// first and, if the match is weak, also tries the other game and keeps whichever
// scores higher — so scanning in the wrong mode still works. Returns
// { game, verified, candidates:[{name,set,number,score,inliers}], crop }.
async function match(imageBuffer, requestedGame, topK = 8, setCode = '') {
  // Auto-crop + deskew the card once; everything matches on the rectified image.
  const cardBuf = await preprocessCard(imageBuffer);
  const crop = 'data:image/jpeg;base64,' + (await sharp(cardBuf).resize({ width: 220 }).jpeg({ quality: 70 }).toBuffer()).toString('base64');

  // Query ORB features are game-independent — extract once, reuse everywhere.
  const orb = new cv.ORB(500);
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const q = await queryOrb(orb, cardBuf);
  try {
    // Set-scoped fast path: if the user gave an MTG set code and that set's index
    // is built, match only within it (~300 cards) — accurate, no global recall.
    if (requestedGame === 'mtg' && setCode && setIndex.isReady('mtg', setCode)) {
      const candidates = setIndex.matchSet(q, 'mtg', setCode, topK);
      if (candidates) return { game: 'mtg', verified: true, candidates, crop, scoped: true };
    }

    const order = requestedGame === 'pokemon' ? ['pokemon', 'mtg'] : ['mtg', 'pokemon'];
    let best = null;
    for (const g of order) {
      const recall = await embedMatch.match(cardBuf, g, RECALL_K); // CLIP recall for this game
      if (recall.length === 0) continue;
      const r = verifyGame(cardBuf, g, q, bf, recall, topK);
      if (!best || r.top > best.top) best = { ...r, game: g };
      if (best.top >= STRONG_INLIERS) break; // confident — no need to try the other game
    }
    if (!best) return { game: requestedGame, verified: false, candidates: [], crop };
    return { game: best.game, verified: best.verified, candidates: best.candidates, crop };
  } finally {
    q.desc.delete(); bf.delete(); orb.delete();
  }
}

module.exports = { match };
