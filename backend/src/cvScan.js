// CollectorVision scan pipeline: cornelius (corners) -> dewarp -> milo (embed)
// -> cosine over a prebuilt catalog.
//
// This replaces the ORB/BoVW/dHash stack for MTG. Measured on the same 100-card
// noisy sample as scripts/eval-global-index.mjs:
//
//   hash 250 + BoVW 10 + ORB verify   78.0% exact / 88.0% right card / 1187 ms
//   cornelius + milo (this)           76.0% exact / 90.0% right card /  310 ms
//
// It also replaces ~2.6 GB of per-set ORB indexes and whole-game rollups with
// two ONNX files and one 56 MB catalog, so there is no index build at all.
//
// LICENSING: both models are AGPL-3.0 (https://huggingface.co/HanClinto/milo,
// https://huggingface.co/HanClinto/cornelius). Bindarr is MIT. Shipping this
// enabled is a licensing decision, not just a technical one — see docs.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ort = require('onnxruntime-node');
const { loadNpz } = require('./utils/npz');

const MODEL_DIR = process.env.CV_MODEL_DIR || path.join(__dirname, '..', 'data', 'models');
const CORN_SIZE = 384;     // cornelius input
const EMBED_SIZE = 448;    // milo input, and the dewarp target
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
// Below this the corner head's SimCC peaks are flat — it is not looking at a
// card. Matching the raw frame anyway is what the previous detector did on a
// miss, and it still recovers most of them.
const SHARPNESS_GATE = 0.02;
// Cosine at which a match is confident enough to auto-fill. Correct matches on
// the eval sample sat at 0.55-0.95; the one confident wrong answer sat at 0.88,
// so the margin below does the work this number cannot.
const STRONG_SIM = 0.55;
const STRONG_MARGIN = 0.04;
// "Nothing here is your card." A sweep always returns its nearest row, so a card
// the catalog has never heard of comes back looking exactly like one it has —
// which is how Japanese Pokemon scans returned wrong cards for sets TCGdex has no
// data for.
//
// The gate is how far the winner stands above its own neighbourhood (ranks 2-11),
// NOT its absolute cosine, because absolute cosine tracks photo quality and the
// gap does not. Measured by scripts/measure-scan-floor.js over 60 cards per
// catalog, each searched with its own row masked out so it IS a missing card:
//
//   strangers accepted        reference-quality input   blurred/tilted/dim input
//     absolute cosine >= 0.65   31-41 of 60               15-19 of 60
//     gap >= 0.10               12 of 60                  11-12 of 60
//
// One threshold, same behaviour on a good photo and a bad one, over both the 3,296
// row Japanese catalog and the 21,771 row English one — and no correct answer was
// rejected in any of the four runs (worst genuine gap 0.105, in English/harsh).
// The strangers that do pass are cards whose ARTWORK is reprinted elsewhere in the
// catalog: right art, wrong printing, which no similarity gate can separate and
// which the client's same-name check already routes to the picker.
//
// Erring low is deliberate. A rejected correct answer still shows its candidate
// list with the right card on top and only loses the auto-add; an accepted
// stranger files the wrong card.
const GAP_FLOOR = Number(process.env.CV_SCAN_GAP || 0.10);
// Ranks 2..GAP_K define "the neighbourhood". Wider than the 8 candidates a scan
// returns so the measure does not move when topK does.
const GAP_K = 11;
// Test-time augmentation used to live here: two extra dewarps of the same card
// at 0.92x/1.08x crop tightness, averaged as unit vectors. It bought 76 -> 81%
// exact printing on the 100-card sample (right-card was unmoved at 90%) and cost
// two extra milo forward passes — ~100 ms of a ~255 ms scan. Removed for latency;
// the git history has the implementation if that accuracy is wanted back.

// ORT spends more time in thread handoff than in a 1M-param graph, so a single
// intra-op thread is measurably faster here than the default fan-out.
const SESSION_OPTS = { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential' };

// The two models are game-independent — a card is a card to the corner detector
// and the embedder. Only the catalog differs, so sessions load once and catalogs
// load per game, on first use of that game.
let models = null;
const catalogs = {};   // game -> { cat, ids, n, dim } (or an in-flight promise)

// English keeps the bare filename so existing builds stay valid; other languages
// get their own catalog, because a language whose card text AND set structure
// differ (Japanese Pokemon) cannot be reached from the English one.
const suffix = (lang) => (!lang || lang === 'en' || lang === 'English' ? '' : `-${String(lang).toLowerCase()}`);
const localBin = (game, lang) => path.join(MODEL_DIR, `milo-${game}${suffix(lang)}-local.bin`);
const localMeta = (game, lang) => path.join(MODEL_DIR, `milo-${game}${suffix(lang)}-local.json`);

function catalogPath(game) {
  return path.join(MODEL_DIR, `milo-${game}.npz`);
}

// A locally built catalog wins when present. Its ids are card_cache primary keys,
// so every hit resolves by construction — which the published Pokemon catalog
// cannot promise, being keyed by TCGplayer product ids of which only ~24% map to
// a card this install has ever cached.
function hasLocal(game, lang) {
  return fs.existsSync(localBin(game, lang)) && fs.existsSync(localMeta(game, lang));
}

function isBuilt(game = 'mtg', lang) {
  if (!fs.existsSync(path.join(MODEL_DIR, 'cornelius.onnx'))
    || !fs.existsSync(path.join(MODEL_DIR, 'milo.onnx'))) return false;
  if (hasLocal(game, lang)) return true;
  // No catalog in that language. English can still answer WHICH card it is —
  // the artwork is the same in every language — so the caller may still want
  // this pipeline and re-express the answer afterwards. Only report unbuilt
  // when even English is missing.
  return hasLocal(game) || fs.existsSync(catalogPath(game));
}

// The languages this game has a catalog OF ITS OWN in.
//
// isBuilt() answers a different question — "can a scan work at all" — and it is
// true for every language, because English is the fallback for all of them. That
// is the right answer for the scan route and the wrong one for the language
// picker, which was offering fifteen languages with no hint that fourteen of them
// would be answered by the English catalog and filed as English printings.
function builtLangs(game = 'mtg') {
  const names = require('./utils/languages').LANGUAGES.map(l => l.name);
  const out = names.filter(l => hasLocal(game, l));
  // English also answers from a published .npz, which is not a local build.
  if (!out.includes('English') && fs.existsSync(catalogPath(game))) out.unshift('English');
  return out;
}

function loadModels() {
  if (!models) {
    const cornPath = path.join(MODEL_DIR, 'cornelius.onnx');
    const isFastWeb = fs.existsSync(cornPath) && fs.statSync(cornPath).size < 4000000;
    models = Promise.all([
      ort.InferenceSession.create(cornPath, SESSION_OPTS),
      ort.InferenceSession.create(path.join(MODEL_DIR, 'milo.onnx'), SESSION_OPTS),
    ]).then(([corn, milo]) => {
      corn.isFastWeb = isFastWeb;
      return { corn, milo };
    }).catch((err) => { models = null; throw err; });
  }
  return models;
}

// The catalog is a flat Float32Array; at 110k x 128 that is 56 MB resident and a
// brute-force sweep costs ~25 ms, so there is no ANN index here on purpose —
// building one would cost more than it saves.
async function load(game = 'mtg', lang) {
  // Fall back to the English catalog when the requested language has none: the
  // art is identical, so it still identifies the card, and the route re-expresses
  // the answer into the requested language by name.
  const useLang = hasLocal(game, lang) ? lang : undefined;
  const key = `${game}${suffix(useLang)}`;
  if (!catalogs[key]) {
    catalogs[key] = (async () => {
      const t0 = Date.now();
      const m = await loadModels();
      if (hasLocal(game, useLang)) {
        const meta = JSON.parse(fs.readFileSync(localMeta(game, useLang), 'utf8'));
        const buf = fs.readFileSync(localBin(game, useLang));
        const dim = meta.dim;
        const n = meta.ids.length;
        if (buf.length !== n * dim * 4) {
          throw new Error(`local ${game} catalog is ${buf.length} bytes, expected ${n * dim * 4}`);
        }
        const cat = new Float32Array(buf.buffer, buf.byteOffset, n * dim);
        console.log(`cvScan: ${key} LOCAL catalog ${n} x ${dim}d loaded in ${Date.now() - t0} ms`);
        return { ...m, cat, ids: meta.ids, n, dim, local: true, lang: useLang || "English" };
      }
      const npz = loadNpz(catalogPath(game));
      const [n, dim] = npz.embeddings.shape;
      console.log(`cvScan: ${key} catalog ${n} x ${dim}d loaded in ${Date.now() - t0} ms`);
      return { ...m, cat: npz.embeddings.data, ids: npz.card_ids.data, n, dim, local: false, lang: "English" };
    })().catch((err) => { delete catalogs[key]; throw err; });
  }
  return catalogs[key];
}

// Every catalog one scan should search, best language first.
//
// A non-English catalog is only ever as complete as its provider. TCGdex serves
// card records for 28 of the 177 Japanese Pokemon sets it LISTS, so a Japanese
// catalog holds ~3.3k of 20k+ cards — and a cosine sweep never returns nothing,
// so every one of the missing cards was answered with the nearest of the wrong
// 3.3k, often at a similarity high enough to auto-fill. That is the whole reason
// Japanese scans came back wrong.
//
// The artwork is identical across languages, so the English catalog holds a row
// for every card that also released in English, which is most of what the
// Japanese one is missing. Sweeping both turns those misses into the right card
// — sometimes in the wrong language, which the route re-expresses by set and
// number, and failing that shows as the English printing. The right card in the
// wrong language beats a wrong card in the right one.
async function loadAll(game, lang) {
  const native = await load(game, lang);
  // load() already falls back to English when the language has no catalog; there
  // is then nothing to add.
  if (native.lang === 'English') return [native];
  const english = await load(game).catch(() => null);
  return english ? [native, english] : [native];
}

// ImageNet-normalised NCHW float from raw interleaved RGB.
function toTensor(rgb, size) {
  const x = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let p = 0; p < plane; p++) {
    x[p] = (rgb[p * 3] / 255 - MEAN[0]) / STD[0];
    x[plane + p] = (rgb[p * 3 + 1] / 255 - MEAN[1]) / STD[1];
    x[2 * plane + p] = (rgb[p * 3 + 2] / 255 - MEAN[2]) / STD[2];
  }
  return new ort.Tensor('float32', x, [1, 3, size, size]);
}

// Perspective warp, RGB in / RGB out. The imgproc version works on RGBA and is
// shared with the browser; this stays local because the whole point is to keep
// the pixels as raw RGB from decode to embed with no PNG round trip. Encoding
// the dewarped card to PNG and decoding it again cost ~100 ms per scan.
function warpRgb(src, sw, sh, M, size) {
  const [a, b, c, d, e, f, g, i] = M;
  const det = a * (e - f * i) - b * (d - f * g) + c * (d * i - e * g);
  const inv = [
    (e - f * i) / det, (c * i - b) / det, (b * f - c * e) / det,
    (f * g - d) / det, (a - c * g) / det, (c * d - a * f) / det,
    (d * i - e * g) / det, (b * g - a * i) / det, (a * e - b * d) / det,
  ];
  const out = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const den = inv[6] * x + inv[7] * y + inv[8];
      const sx = (inv[0] * x + inv[1] * y + inv[2]) / den;
      const sy = (inv[3] * x + inv[4] * y + inv[5]) / den;
      const o = (y * size + x) * 3;
      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) continue;
      const x0 = sx | 0, y0 = sy | 0;
      const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
      const fx = sx - x0, fy = sy - y0;
      for (let ch = 0; ch < 3; ch++) {
        const p00 = src[(y0 * sw + x0) * 3 + ch], p01 = src[(y0 * sw + x1) * 3 + ch];
        const p10 = src[(y1 * sw + x0) * 3 + ch], p11 = src[(y1 * sw + x1) * 3 + ch];
        out[o + ch] = (p00 * (1 - fx) + p01 * fx) * (1 - fy) + (p10 * (1 - fx) + p11 * fx) * fy;
      }
    }
  }
  return out;
}

// Solve for the 8 homography coefficients mapping src quad -> dst quad.
function perspectiveTransform(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    A.push([src[i].x, src[i].y, 1, 0, 0, 0, -src[i].x * dst[i].x, -src[i].y * dst[i].x]); b.push(dst[i].x);
    A.push([0, 0, 0, src[i].x, src[i].y, 1, -src[i].x * dst[i].y, -src[i].y * dst[i].y]); b.push(dst[i].y);
  }
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    const p = A[col][col];
    if (!p) return null;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const factor = A[r][col] / p;
      for (let k = col; k < 8; k++) A[r][k] -= factor * A[col][k];
      b[r] -= factor * b[col];
    }
  }
  return A.map((row, r) => b[r] / row[r]);
}

function orderQuad(pts) {
  if (!pts || pts.length !== 4) return pts;
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let tlIdx = 0, minScore = Infinity;
  for (let i = 0; i < 4; i++) {
    const score = sorted[i].x + sorted[i].y;
    if (score < minScore) { minScore = score; tlIdx = i; }
  }
  const pTL = sorted[tlIdx];
  const pNext = sorted[(tlIdx + 1) % 4];
  const pPrev = sorted[(tlIdx + 3) % 4];
  if (pNext.x - pTL.x > pPrev.x - pTL.x || pPrev.y - pTL.y > pNext.y - pTL.y) {
    return [sorted[tlIdx], sorted[(tlIdx + 1) % 4], sorted[(tlIdx + 2) % 4], sorted[(tlIdx + 3) % 4]];
  } else {
    return [sorted[tlIdx], sorted[(tlIdx + 3) % 4], sorted[(tlIdx + 2) % 4], sorted[(tlIdx + 1) % 4]];
  }
}

// Detect the card and return a dewarped EMBED_SIZE square of raw RGB.
// An already-rectified crop from the browser. Resized rather than trusted to
// be exact: JPEG round-trips and older clients can hand over something a few
// pixels off, and milo's input dimensions are not negotiable.
async function useClientCrop(imageBuffer) {
  const { data } = await sharp(imageBuffer).resize(EMBED_SIZE, EMBED_SIZE, { fit: 'fill' })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgb: data, detected: true, sharpness: 1, clientCrop: true };
}

async function detectAndDewarp(session, imageBuffer) {
  // One decode, downscaled once. 1200px is plenty of source resolution for a
  // 448px dewarp and keeps the bilinear sample loop cheap.
  const { data: rgb, info } = await sharp(imageBuffer)
    .resize({ width: 1200, withoutEnlargement: true })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });

  const { data: small } = await sharp(imageBuffer)
    .resize(CORN_SIZE, CORN_SIZE, { fit: 'fill' })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });

  const out = await session.run({ image: toTensor(small, CORN_SIZE) });
  const corners = out.corners.data;
  const sharpness = out.sharpness ? out.sharpness.data[0] : 1;

  if (!(sharpness > SHARPNESS_GATE)) {
    const { data } = await sharp(imageBuffer).resize(EMBED_SIZE, EMBED_SIZE, { fit: 'fill' })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { rgb: data, detected: false, sharpness };
  }

  // Order points into [TL, TR, BR, BL] around centroid to guarantee non-crossing quad.
  const pts = [];
  for (let k = 0; k < 4; k++) {
    pts.push({ x: corners[k * 2] * info.width, y: corners[k * 2 + 1] * info.height });
  }
  const src = orderQuad(pts);
  const dst = [
    { x: 0, y: 0 }, { x: EMBED_SIZE - 1, y: 0 },
    { x: EMBED_SIZE - 1, y: EMBED_SIZE - 1 }, { x: 0, y: EMBED_SIZE - 1 },
  ];
  const M = perspectiveTransform(src, dst);
  if (!M) {
    const { data } = await sharp(imageBuffer).resize(EMBED_SIZE, EMBED_SIZE, { fit: 'fill' })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { rgb: data, detected: false, sharpness };
  }
  return {
    rgb: warpRgb(rgb, info.width, info.height, M, EMBED_SIZE),
    detected: true, sharpness, corners: src,
  };
}

// Which set each catalog row belongs to, aligned with `ids`.
//
// Built lazily and only when a set filter is first used: it is one pass over
// card_cache, and a user who never scopes a scan should not pay for it. Rows the
// cache does not know get null, which the filter treats as "not in your sets" —
// the user asked for specific sets, and an unknown set is not one of them.
async function rowSets(s, game) {
  if (s.setOf) return s.setOf;
  const db = require('./db');
  const rows = await db.all(`SELECT id, set_id FROM card_cache WHERE game = ?`, [game]);
  const byId = new Map(rows.map(r => [r.id, (r.set_id || '').toLowerCase()]));
  s.setOf = s.ids.map((raw) => {
    const id = String(raw).replace(/_back$/, '');
    return byId.get(s.local ? id : `${game}-${id}`) ?? null;
  });
  const known = s.setOf.filter(Boolean).length;
  console.log(`cvScan: ${game} set index built, ${known}/${s.n} rows have a known set`);
  return s.setOf;
}

// Brute-force cosine. Both sides are L2-normalised, so the dot product IS the
// cosine and there is nothing to divide.
//
// `allow` is an optional per-row predicate. Scoring a filtered-out row and then
// discarding it would be the obvious way to do this and is wrong: the whole point
// of scoping to a set is that the runner-up from an unwanted set can no longer
// outrank the right card.
function searchTopK(emb, cat, n, dim, k, allow) {
  const sims = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (allow && !allow(i)) { sims[i] = -Infinity; continue; }
    const off = i * dim;
    let s = 0;
    for (let d = 0; d < dim; d++) s += emb[d] * cat[off + d];
    sims[i] = s;
  }
  const top = [];
  for (let i = 0; i < n; i++) {
    if (top.length < k) {
      top.push(i);
      if (top.length === k) top.sort((a, b) => sims[b] - sims[a]);
      continue;
    }
    if (sims[i] <= sims[top[k - 1]]) continue;
    let j = k - 1;
    while (j > 0 && sims[top[j - 1]] < sims[i]) { top[j] = top[j - 1]; j--; }
    top[j] = i;
  }
  return top.map(i => ({ i, sim: sims[i] }));
}

// Identify a card. Same return shape as scanMatch.match so the route and the
// client are unchanged: { game, verified, candidates, crop, lang }.
// `inliers` carries a 0-100 confidence derived from cosine, because the client
// gates auto-fill on that field.
async function match(imageBuffer, game = 'mtg', topK = 8, opts = {}) {
  const cats = await loadAll(game, opts.lang);

  // Set scoping is a FILTER here, not a different pipeline. The ORB path needed a
  // per-set index built before it could scope a scan; a cosine sweep just skips
  // the rows that do not belong, which costs nothing and needs no build.
  //
  // Per catalog, because set ids do not survive a language: the Japanese set the
  // user picked (SV4a) names no row in the English catalog. A catalog with no rows
  // in scope is DROPPED from the sweep rather than searched unscoped — the user
  // narrowed the scan on purpose, and an unscoped sweep of the other language is
  // exactly the wrong-card answer the scope was meant to prevent.
  const wanted = (opts.sets || []).map(x => String(x).toLowerCase()).filter(Boolean);
  const want = new Set(wanted);
  let scoped = null;
  const search = [];
  for (const c of cats) {
    if (!wanted.length) { search.push({ c, allow: null }); continue; }
    const setOf = await rowSets(c, game);
    const rows = setOf.reduce((acc, v) => acc + (v && want.has(v) ? 1 : 0), 0);
    if (!rows) continue;
    search.push({ c, allow: (i) => setOf[i] && want.has(setOf[i]) });
    scoped = { sets: wanted, rows: (scoped ? scoped.rows : 0) + rows };
  }
  // Every catalog empty in scope: ignoring the filter beats returning nothing at
  // all, which reads to the user as "your card could not be identified".
  if (wanted.length && !search.length) {
    console.warn(`cvScan: no ${game} catalog rows in sets [${wanted}] — scanning unscoped`);
    for (const c of cats) search.push({ c, allow: null });
  }

  // The client can do the dewarp itself: it ran cornelius for the live outline
  // anyway, so re-detecting on a crop that IS already the card would only find
  // the same square again, at the cost of a decode and a forward pass.
  const det = opts.cropped
    ? await useClientCrop(imageBuffer)
    : await detectAndDewarp(cats[0].corn, imageBuffer);

  // One crop, one forward pass, reused by every catalog. milo's output is already
  // L2-normalised, so this vector goes straight into the cosine sweep.
  const out = await cats[0].milo.run({ image: toTensor(det.rgb, EMBED_SIZE) });
  const emb = out.embedding.data;

  // Cosines from different catalogs are directly comparable — same model, same
  // normalisation — so the merged list is just every sweep's hits sorted by score.
  // Measured: 60 ms for one catalog, 66 ms for two, so the second sweep of 21,775
  // rows costs ~6 ms. It is the catalog LOAD that is expensive, and that happens
  // once per process.
  const hits = [];
  // Per catalog, because the gap is measured inside the catalog that produced the
  // hit: the same card sits in both the Japanese and the English catalog, and its
  // own twin one rank down would flatten a merged neighbourhood and make every
  // correct answer look like a stranger.
  let winner = null;
  for (const { c, allow } of search) {
    const own = searchTopK(emb, c.cat, c.n, c.dim, Math.max(topK, GAP_K), allow)
      .filter(h => Number.isFinite(h.sim));
    if (!own.length) continue;
    const tail = own.slice(1, GAP_K);
    // Under three rows in scope there is no neighbourhood to speak of, so no gap
    // either: the user narrowed the scan to almost nothing and does not need to be
    // told their card might be missing from it.
    const gap = tail.length >= 2 ? own[0].sim - tail.reduce((a, h) => a + h.sim, 0) / tail.length : null;
    if (!winner || own[0].sim > winner.sim) winner = { sim: own[0].sim, gap };
    for (const h of own) hits.push({ ...h, c });
  }
  hits.sort((a, b) => b.sim - a.sim);

  // What the catalog is keyed by differs per game, and the caller has to know
  // which so it can hydrate: MTG's ids ARE card_cache's primary key (`mtg-<uuid>`),
  // while the published Pokemon catalog's are TCGplayer product ids that have to go
  // through the tcgplayer_product mapping table.
  //
  // A DFC's back is catalogued as `{id}_back`; both faces are the same printing.
  //
  // Deduped by id, which is per-language: the same card matched from both the
  // Japanese and the English catalog is two different PRINTINGS, and which one the
  // copy should be filed as is the user's call, not this function's.
  const seen = new Set();
  const candidates = [];
  for (const h of hits) {
    const id = String(h.c.ids[h.i]).replace(/_back$/, '');
    if (seen.has(id)) continue;
    seen.add(id);
    // A local catalog is already keyed by card_cache.id for either game; only the
    // published catalogs need their provider id translated.
    candidates.push(h.c.local ? { cardId: id, score: h.sim, catalogLang: h.c.lang }
      : game === 'pokemon' ? { productId: Number(id), score: h.sim, catalogLang: h.c.lang }
        : { cardId: `${game}-${id}`, score: h.sim, catalogLang: h.c.lang });
    if (candidates.length >= topK) break;
  }

  const top = candidates[0];
  const margin = candidates.length > 1 ? top.score - candidates[1].score : (top ? top.score : 0);

  const crop = 'data:image/jpeg;base64,' + (await sharp(Buffer.from(det.rgb), {
    raw: { width: EMBED_SIZE, height: EMBED_SIZE, channels: 3 },
  }).resize({ width: 220 }).jpeg({ quality: 70 }).toBuffer()).toString('base64');

  // The winner does not stand out from its own neighbourhood, so the list below is
  // the nearest strangers rather than a shortlist. Said out loud instead of
  // returning an empty list: the candidates are still the user's recovery path, and
  // one of them is the right card often enough to be worth the glance.
  const gap = winner ? winner.gap : null;
  const notInCatalog = !top || (gap !== null && gap < GAP_FLOOR);
  if (notInCatalog) {
    console.log(`cvScan: top ${game}/${cats.map(c => c.lang).join('+')} hit ${top ? top.score.toFixed(3) : 'n/a'}`
      + ` sits ${gap === null ? 'n/a' : gap.toFixed(3)} above its neighbours (floor ${GAP_FLOOR}) — not in catalog`);
  }

  // `verified: false` is the honest answer — no geometric verification ran. It
  // also routes the client to its cosine gate (SCAN_MATCH_MIN_SCORE = 0.55),
  // which is the right comparison for an L2-normalised embedding and happens to
  // be the threshold the eval sample supports. Reporting `true` here would send
  // it to the inlier gate instead and auto-fill on a field that no longer exists.
  return {
    game, verified: false, candidates, crop,
    ...(scoped ? { scoped: scoped.sets.join(','), scopedRows: scoped.rows } : {}),
    lang: 'en',
    catalogs: cats.map(c => c.lang),
    detected: det.detected,
    sharpness: det.sharpness,
    margin,
    gap,
    notInCatalog,
    engine: 'collectorvision',
  };
}

// Score a list of cards against an image embedding and sort them by visual similarity.
async function scoreCards(imageBuffer, game = 'mtg', cards = [], opts = {}) {
  if (!cards || cards.length <= 1 || !imageBuffer) return cards;
  if (!isBuilt(game, opts.lang)) return cards;

  try {
    const cats = await loadAll(game, opts.lang);
    if (!cats || !cats.length) return cards;

    const det = opts.cropped
      ? await useClientCrop(imageBuffer)
      : await detectAndDewarp(cats[0].corn, imageBuffer);

    const out = await cats[0].milo.run({ image: toTensor(det.rgb, EMBED_SIZE) });
    const emb = out.embedding.data;

    for (const c of cats) {
      if (!c.idMap) {
        const map = new Map();
        for (let i = 0; i < c.n; i++) {
          const raw = String(c.ids[i]).replace(/_back$/, '');
          if (!map.has(raw)) map.set(raw, i);
        }
        c.idMap = map;
      }
    }

    let prodMap = null;
    if (game === 'pokemon') {
      const db = require('./db');
      const cardIds = cards.map(c => c.id).filter(Boolean);
      if (cardIds.length) {
        const placeholders = cardIds.map(() => '?').join(',');
        const prodRows = await db.all(
          `SELECT card_id, product_id FROM tcgplayer_product WHERE card_id IN (${placeholders})`,
          cardIds
        ).catch(() => []);
        if (prodRows.length) {
          prodMap = new Map(prodRows.map(r => [r.card_id, String(r.product_id)]));
        }
      }
    }

    for (const card of cards) {
      let maxScore = null;
      const possibleIds = [];
      if (card.id) {
        possibleIds.push(String(card.id));
        possibleIds.push(String(card.id).replace(/^(mtg|pokemon)-/, ''));
      }
      if (card.scryfall_id) possibleIds.push(String(card.scryfall_id));
      if (card.tcgplayer_id) possibleIds.push(String(card.tcgplayer_id));
      if (card.tcgplayer_product_id) possibleIds.push(String(card.tcgplayer_product_id));
      if (prodMap && prodMap.has(card.id)) possibleIds.push(prodMap.get(card.id));

      for (const c of cats) {
        for (const pid of possibleIds) {
          const idx = c.idMap.get(pid);
          if (idx !== undefined) {
            const off = idx * c.dim;
            let dot = 0;
            for (let d = 0; d < c.dim; d++) {
              dot += emb[d] * c.cat[off + d];
            }
            if (maxScore === null || dot > maxScore) {
              maxScore = dot;
            }
          }
        }
      }

      if (maxScore !== null) {
        card.score = maxScore;
        card.__match = { score: maxScore };
      }
    }

    return [...cards].sort((a, b) => {
      const aScore = a.score !== undefined && a.score !== null ? a.score : -Infinity;
      const bScore = b.score !== undefined && b.score !== null ? b.score : -Infinity;
      if (aScore !== bScore) return bScore - aScore;
      return (b.image_url ? 1 : 0) - (a.image_url ? 1 : 0);
    });
  } catch (err) {
    console.warn('cvScan.scoreCards failed:', err.message);
    return cards;
  }
}

// Evict a cached catalog so a freshly built one takes effect without a restart.
// The models are untouched — only the embedding table changes on a rebuild.
function reload(game, lang) {
  const key = `${game}${suffix(hasLocal(game, lang) ? lang : undefined)}`;
  delete catalogs[key];
  // A build can turn a game that had no catalog at all into one that does, and
  // the key it would have been cached under differs from the key it now needs.
  delete catalogs[game];
}

module.exports = { match, load, loadAll, isBuilt, builtLangs, reload, scoreCards, STRONG_SIM, STRONG_MARGIN, GAP_FLOOR };

