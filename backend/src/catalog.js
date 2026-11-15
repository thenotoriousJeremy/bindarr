// Catalog builds: the one job that makes scanning work.
//
// A catalog is one (game, language) pair. Building it has two phases, and the
// first is the one that was missing for years:
//
//   1. CACHE — walk every set the provider lists and pull its cards into
//      card_cache. This used to happen only as a side effect of building an ORB
//      scan index, so a set nobody indexed, searched or browsed simply was not
//      there. Measured before this existed: Pokemon held 7,118 of 20,460 English
//      cards (35%), with 104 of 174 sets holding a handful each — the ones the
//      user happened to own.
//   2. EMBED — run every cached card's artwork through milo and write the
//      embedding table the scanner searches.
//
// Phase 2 can only ever be as complete as phase 1, which is why they are one job
// rather than two buttons. Both resume: phase 1 is idempotent, and phase 2 keeps
// every embedding whose image_url has not changed.
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const sharp = require('sharp');
const ort = require('onnxruntime-node');
const db = require('./db');
const cardSets = require('./cardSets');
const languages = require('./utils/languages');
const cvScan = require('./cvScan');
const pokemonProvider = require('./utils/pokemonProvider');
const metrics = require('./utils/metrics');
const games = require('./utils/games');

const MODEL_DIR = process.env.CV_MODEL_DIR || path.join(__dirname, '..', 'data', 'models');
const SIZE = 448;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
// Every game the registry marks scannable (shared/games.json).
const GAMES = games.withFeature('scan');

const suffix = (lang) => (!lang || lang === 'en' || lang === 'English' ? '' : `-${String(lang).toLowerCase()}`);
const binPath = (game, lang) => path.join(MODEL_DIR, `milo-${game}${suffix(lang)}-local.bin`);
const metaPath = (game, lang) => path.join(MODEL_DIR, `milo-${game}${suffix(lang)}-local.json`);

// A catalog's meta file, parsed once per version of the file. list() reads it for
// every catalog on every poll (the panel polls each second during a build) and
// setCounts on every scanner open; the Magic one is several megabytes of ids and
// took ~100 ms to parse each time. Keyed by size and mtime, which a rebuild's
// rename changes, so a new catalog is read the moment it lands. Null when there
// is no such catalog or it cannot be read.
const metaCache = new Map();   // path -> { mtimeMs, size, meta }
function readMeta(game, lang) {
  const file = metaPath(game, lang);
  let stat;
  try { stat = fs.statSync(file); } catch { metaCache.delete(file); return null; }
  const hit = metaCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.meta;
  try {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    metaCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
    return meta;
  } catch {
    metaCache.delete(file);
    return null;
  }
}

// What a catalog was built from: the set ids of a scoped build (lowercased, the
// union of every scoped build added to it), or null for the whole game. A catalog
// written before builds recorded this has no `scope`, and is taken as whole-game,
// which is how it was treated then.
const scopeOf = (meta) => (meta && Array.isArray(meta.scope) && meta.scope.length ? meta.scope : null);

// One build at a time. Two concurrent builds would fight over the same provider
// rate limits and the same single-threaded ONNX session, and finish later than
// running them in sequence.
let current = null;

const state = () => (current ? {
  game: current.game, lang: current.lang, phase: current.phase,
  done: current.done, total: current.total, message: current.message,
  // So the panel can say WHICH sets are building rather than implying the whole game.
  sets: current.sets,
  startedAt: current.startedAt, cancelled: current.cancelled,
} : null);

function stop() {
  if (!current) return false;
  current.cancelled = true;
  current.message = 'stopping…';
  return true;
}

// What exists, and how complete it is. The counts come from card_cache and the
// set catalogue, so the UI can say "9,604 of 20,460 cards" rather than only
// "built" — a catalog can be perfectly built and still cover a third of the game.
// How many cards exist to cache for one (game, language) — the denominator behind
// "21,844 of N cards downloaded".
//
// It has to come from whichever source actually FILLS card_cache, or the fraction
// compares two different universes. Pokemon English read the `sets` table and
// reported "21,844 of 20,460 known cards downloaded": that table is
// pokemontcg.io's 174 sets while the cards came from TCGdex's 218, so the panel
// claimed 107% coverage while also warning that 46 sets had no cards at all.
//
// Null when it cannot be asked — a missing number reads better than a wrong one.
async function claimedFor(game, lang) {
  if (game !== 'pokemon') return null;
  // Which provider owns the ids in card_cache for this language. Asking the other
  // one is exactly the mistake above.
  const selected = await pokemonProvider.providerFor(lang);
  if (selected === pokemonProvider.POKEMONTCG) return null;
  try {
    const sets = await (await pokemonProvider.apiFor(lang)).listSets(lang);
    return sets.reduce((n, s) => n + (s.total || s.printed_total || 0), 0) || null;
  } catch {
    return null;
  }
}

// The sets a whole-game build of (game, lang) walks: cardSets.listAllSets, the
// build's own list, with its exclusions (MTG's digital and child sets, Pokémon
// Pocket) and in the provider's own id scheme. Cached briefly, because list() asks
// for every built catalog on every poll and a pokemontcg.io install answers this
// with a live request. An empty answer (provider unreachable) is not cached.
const UNIVERSE_TTL_MS = 30 * 60 * 1000;
const universeCache = new Map();   // `${game}|${lang}` -> { at, sets }
async function setUniverse(game, lang) {
  const key = `${game}|${lang}`;
  const hit = universeCache.get(key);
  if (hit && Date.now() - hit.at < UNIVERSE_TTL_MS) return hit.sets;
  const sets = (await cardSets.listAllSets(game, lang)).map(s => String(s).toLowerCase()).filter(Boolean);
  if (sets.length) universeCache.set(key, { at: Date.now(), sets });
  return sets;
}

// How many sets a build of this catalog would walk that this install has no cards
// for at all — a newly released set, in other words. The weekly refresh keeps the
// set lists current (server.js), so a release surfaces here on its own.
//
// The denominator is the build's own set list (setUniverse above). It used to be
// the `sets` table, or for Pokémon whatever TCGdex or pokemontcgapi listed, and
// both counted sets a build skips on purpose: ~100 digital Magic sets, Magic's
// child sets (folded into their parents), Pokémon Pocket — and on a pokemontcg.io
// install TCGdex's ids (sv01) against cached pokemontcg.io ones (sv1). So the
// number never reached 0, and the weekly auto-update rebuilt a game every week.
//
// `scope`: a scoped catalog (scopeOf) is behind only on the sets it was built
// from. A set released since is not one of them, and an auto-update of a scoped
// catalog must not grow it into a whole-game build.
//
// Compared in JS against one pass over card_cache, in the same id scheme: the set
// list is the provider's, card_cache is too, and a prefixed id ("lorcana-1",
// "riftbound-ogn") meets its bare code. A correlated query here once re-scanned
// card_cache per set and took 28 s on the single connection (#49).
async function newSetCount(game, lang = 'English', { scope = null } = {}) {
  try {
    const universe = await setUniverse(game, lang);
    if (!universe.length) return null;
    // Sets a build already found to have no usable data upstream. Counting them as
    // "not built yet" told the user to build sets that cannot be built: measured on
    // a real install, ALL 46 uncached English Pokemon sets were of this kind
    // (Miscellaneous Promos, Jumbo cards, Sample, EX trainer kits...), so the number
    // could never drop and the weekly auto-update would have rebuilt forever.
    const gaps = new Set((await db.all(
      `SELECT set_id FROM set_data_gaps WHERE game = ? AND language = ?`, [game, lang]
    ).catch(() => [])).map(r => String(r.set_id).toLowerCase()));
    // Scoped to the language, or a Spanish catalog would be measured against the
    // ENGLISH cache and report whatever English happens to be missing.
    const cached = new Set();
    for (const r of await db.all(
      `SELECT DISTINCT LOWER(set_id) sid FROM card_cache WHERE game = ? AND language = ?`, [game, lang]
    )) {
      if (!r.sid) continue;
      cached.add(r.sid);
      cached.add(games.bareSetId(r.sid));
    }
    const bare = (id) => games.bareSetId(id);
    const inScope = scope ? new Set(scope.flatMap(s => [String(s).toLowerCase(), bare(String(s).toLowerCase())])) : null;
    return universe.filter(s =>
      (!inScope || inScope.has(s) || inScope.has(bare(s)))
      && !gaps.has(s) && !gaps.has(bare(s))
      && !cached.has(s) && !cached.has(bare(s))).length;
  } catch {
    return null;
  }
}

async function list() {
  const out = [];
  for (const game of GAMES) {
    const langs = await db.all(
      `SELECT language, COUNT(*) cached,
              SUM(CASE WHEN image_url IS NOT NULL AND image_url != '' THEN 1 ELSE 0 END) withArt
         FROM card_cache WHERE game = ? GROUP BY language`,
      [game]
    );
    // Always offer English even with an empty cache — that is exactly the state a
    // fresh install is in, and it is the case the build button exists for.
    if (!langs.some(l => l.language === 'English')) langs.unshift({ language: 'English', cached: 0, withArt: 0 });
    const claimed = await db.get(`SELECT SUM(total) t FROM sets WHERE game = ?`, [game]);
    for (const l of langs) {
      const lang = l.language || 'English';
      let built = null;
      try {
        const meta = readMeta(game, lang);
        if (meta) {
          built = {
            rows: meta.ids.length,
            builtAt: meta.builtAt,
            bytes: fs.statSync(binPath(game, lang)).size,
            // The sets a scoped catalog covers, or null for the whole game: what
            // the auto-update rebuilds (server.js autoUpdateCatalogs).
            scope: scopeOf(meta),
          };
        }
      } catch { built = null; }
      out.push({
        game, lang,
        cached: l.cached, withArt: l.withArt,
        // A denominator, because "built, 3,297 cards" reads as complete and is not:
        // TCGdex serves card data for 28 of the 177 Japanese Pokemon sets it lists,
        // so the Japanese catalog covers ~3.3k of ~20k cards and every card outside
        // it used to come back as the nearest wrong one. The `sets` table is a
        // single English catalogue, so a non-English total has to come from the
        // provider's own set list for that language.
        // Provider-owned denominator first (Pokemon via TCGdex), falling back to the
        // `sets` table, which is Scryfall-derived for MTG and so does match card_cache.
        claimed: (await claimedFor(game, lang)) ?? (lang === 'English' ? (claimed?.t || 0) : null),
        built,
        // Sets that exist and have NOTHING cached — which is what a newly released
        // set looks like. The panel's other warning compares cached against
        // embedded, so it stays silent for exactly this case: a new set is not in
        // card_cache at all yet, and until someone rebuilds, scanning one of its
        // cards returns the nearest wrong card at a confident-looking score.
        //
        // Only for a catalog that EXISTS: a language with nothing built has nothing
        // to have fallen behind, and asking anyway cost a provider round-trip per
        // language on a list() the panel polls every second during a build — which
        // made this function take longer than its own 120s test harness allowed.
        newSets: built ? await newSetCount(game, lang, { scope: built.scope }) : null,
        // The published fallback still answers when nothing local is built.
        published: !built && cvScan.isBuilt(game, lang),
      });
    }
  }
  return out;
}

// Which non-English catalogs can actually be built, and the numbers that decide
// whether one is worth the hours.
//
// Pokémon only, deliberately. Magic is printed in every language this app knows
// (see utils/languages) and Scryfall serves all of them — but a non-English MTG
// catalog would be a copy of the English one. Localized Magic printings are the
// SAME sets with the SAME artwork, and the scanner matches artwork, so the English
// catalog already identifies a Japanese card; the route re-expresses the hit by set
// and number afterwards (cvScan.loadAll). Japanese Pokémon is the opposite case:
// whole sets that never released in English, which nothing in the English catalog
// can match.
//
// `claimed` counts every card the provider LISTS for that language, which is not
// the same as what it will serve — TCGdex lists 177 Japanese sets and has card
// records for 28 — so it is a ceiling, not a target. `withArt` is the honest
// numerator: a card with no artwork can never be embedded.
async function listLanguages(game = 'pokemon') {
  if (game !== 'pokemon') return [];
  const rows = await db.all(
    `SELECT language, COUNT(*) cached,
            SUM(CASE WHEN image_url IS NOT NULL AND image_url != '' THEN 1 ELSE 0 END) withArt
       FROM card_cache WHERE game = 'pokemon' GROUP BY language`
  );
  const have = new Map(rows.map(r => [r.language || 'English', r]));
  const out = [];
  for (const l of languages.LANGUAGES) {
    if (languages.isEnglish(l.code)) continue;   // English is a row of its own
    const name = languages.toName(l.code);
    let sets = [];
    try {
      // The same policy the build follows: when pokemontcgapi.com is selected it
      // serves Japanese and Simplified Chinese, and its catalogue is not
      // TCGdex's, so estimating from TCGdex here would misstate the set and card
      // totals (and the credit cost) of the build the admin is about to start.
      sets = await (await pokemonProvider.apiFor(l.code)).listSets(l.code);
    } catch { continue; }                        // provider unreachable: say nothing
    const claimed = sets.reduce((n, s) => n + (s.total || s.printed_total || 0), 0);
    if (!claimed) continue;                      // nothing published in this language
    const h = have.get(name) || { cached: 0, withArt: 0 };
    let built = null;
    try {
      const meta = readMeta(game, name);
      if (meta) built = { rows: meta.ids.length };
    } catch { built = null; }
    out.push({ game, lang: name, code: l.code, sets: sets.length, claimed, cached: h.cached, withArt: h.withArt, built });
  }
  return out;
}

// Per-set counts for one (game, language): how many cards are cached, and how many
// of those are actually IN the catalog the scanner searches.
//
// This exists because "which sets can I scan?" had no answer anywhere. Two
// consequences, both silent before:
//
//   · The set filter lists the `sets` table, which for Pokemon is pokemontcg.io's
//     numbering (base1, gym1) while card_cache holds TCGdex's (A1, me02.5, sv02) —
//     51 of 172 cached set ids are not in that table at all. Picking one of those
//     matched zero catalog rows, and cvScan fails OPEN, so the user got a
//     full unscoped scan with no indication the filter had done nothing.
//   · A set can be cached but not embedded (a build stopped, or a set released
//     since), and scanning it returns the nearest wrong card rather than nothing.
//
// Keyed by lowercased set_id, which is what the scan filter matches on.
async function setCounts(game, lang = 'English') {
  const rows = await db.all(
    `SELECT id, LOWER(set_id) sid FROM card_cache
      WHERE game = ? AND language = ? AND set_id IS NOT NULL AND set_id != ''
        AND image_url IS NOT NULL AND image_url != ''`,
    [game, lang]
  );
  let embedded = null;
  try {
    const meta = readMeta(game, lang);
    if (meta) embedded = new Set(meta.ids);
  } catch { embedded = null; }

  const sets = {};
  for (const r of rows) {
    const sid = r.sid;
    const bare = games.bareSetId(sid);
    const e = sets[sid] || (sets[sid] = { cached: 0, embedded: 0 });
    e.cached++;
    if (embedded && embedded.has(r.id)) e.embedded++;
    if (bare !== sid) {
      const eBare = sets[bare] || (sets[bare] = { cached: 0, embedded: 0 });
      eBare.cached++;
      if (embedded && embedded.has(r.id)) eBare.embedded++;
    }
  }
  return {
    game, lang, sets,
    // Whether `embedded` means anything. A published .npz catalog is keyed by
    // provider ids rather than card_cache ids, so it cannot be counted per set —
    // say so instead of reporting zeros that read as "nothing is built".
    local: !!embedded,
    published: !embedded && cvScan.isBuilt(game, lang),
  };
}

function toTensor(rgb) {
  const plane = SIZE * SIZE;
  const x = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    x[p] = (rgb[p * 3] / 255 - MEAN[0]) / STD[0];
    x[plane + p] = (rgb[p * 3 + 1] / 255 - MEAN[1]) / STD[1];
    x[2 * plane + p] = (rgb[p * 3 + 2] / 255 - MEAN[2]) / STD[2];
  }
  return new ort.Tensor('float32', x, [1, 3, SIZE, SIZE]);
}

// --- phase 1 -----------------------------------------------------------------
async function cachePhase(job) {
  // A scoped build walks only the sets asked for. Everything else about the job is
  // identical — same fetch, same cache writes — so "the sets in front of me" and
  // "the whole game" are one code path with a different list, not two builders.
  const sets = job.sets && job.sets.length
    ? job.sets
    : await cardSets.listAllSets(job.game, job.lang);
  job.phase = 'cache';
  job.total = sets.length;
  job.done = 0;
  let cards = 0, failed = 0, gaps = 0;
  for (const set of sets) {
    if (job.cancelled) return { cards, failed, gaps, stopped: true };
    job.message = `${set}`;
    try {
      const got = await cardSets.cacheSetCards(job.game, set, job.lang);
      cards += got.length;
      // Data appeared for a set previously recorded as empty: forget the gap so it
      // counts as a normal set again.
      await db.run(`DELETE FROM set_data_gaps WHERE game = ? AND language = ? AND set_id = ?`,
        [job.game, job.lang, String(set).toLowerCase()]).catch(() => {});
    } catch (e) {
      // A set with no cards in this language is an expected gap, not a failure —
      // provider coverage is patchy per language and treating gaps as errors
      // would abort every non-English build partway through.
      if (!e.absent) failed++;
      else {
        gaps++;
        // Remember it, so the panel stops telling the user to build a set the
        // provider cannot serve and the auto-update stops chasing it.
        await db.run(
          `INSERT OR REPLACE INTO set_data_gaps (game, language, set_id, reason) VALUES (?, ?, ?, ?)`,
          [job.game, job.lang, String(set).toLowerCase(), e.message.slice(0, 200)]
        ).catch(() => {});
      }
    }
    job.done++;
  }
  return { cards, failed, gaps, stopped: false };
}

// Which of the previous catalog's cards a SCOPED build must carry forward: every
// one it did not just re-embed.
//
// This is what makes per-set builds additive. embedPhase writes exactly the rows
// it embedded, so without this, building Bloomburrow would delete the Foundations
// vectors built last week — the catalog is one file per (game, language), not one
// per set.
//
// Deliberately NOT applied to an unscoped build: that walks every row for the
// language, so a card in `prev` and absent from `embeddedIds` is one that left
// card_cache. Keeping it would leave a vector that can win a scan and then resolve
// to no card at all.
function keptFromPrev(prev, embeddedIds) {
  const embedded = new Set(embeddedIds);
  const out = [];
  for (const [id, vec] of prev.vecs) {
    if (embedded.has(id)) continue;
    out.push({ id, vec, src: prev.srcs.get(id) });
  }
  return out;
}

// The image the SCANNER should match against, which is not always the one the UI
// displays. TCGdex's cached url is `/low.png` — 245x337, chosen so card grids do
// not pull 312 KB per thumbnail — and this resizes to 448, so every TCGdex row was
// embedded from an upscaled blur while the camera hands over a sharp 448 crop.
// The same asset at `/high.png` is 600x825.
//
// Swapped here rather than in tcgdexApi.imageUrl on purpose: card_cache's url is
// what the frontend renders, and making every grid thumbnail high-res would cost
// the whole app bandwidth to fix one pipeline.
function embedUrl(row) {
  let url = row.image_url.replace(/\/low\.png$/, '/high.png');
  if (url.includes('cards.lorcast.io/card/digital/')) {
    url = url.replace(/\/card\/digital\/(?:small|normal)\//, '/card/digital/large/');
  }
  // Riftbound rows store a 480px rendition of Riot's art; embed the full width.
  if (String(row.id).startsWith('riftbound-')) url = require('./riftcodexApi').embedImageUrl(url);
  return url;
}

// --- phase 2 -----------------------------------------------------------------

// What turns an image URL into an embedding: a download and a milo forward pass.
// `start(…, { embedder })` swaps it, which is how the tests drive a whole build
// without a model file or a network.
async function defaultEmbedder() {
  const session = await ort.InferenceSession.create(path.join(MODEL_DIR, 'milo.onnx'), {
    intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential',
  });

  const imageProvider = (url) => {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'tcgdex.net' || host.endsWith('.tcgdex.net')) return 'tcgdex';
    if (host === 'pokemontcg.io' || host.endsWith('.pokemontcg.io')) return 'pokemontcg';
    if (host === 'pokemontcgapi.com' || host.endsWith('.pokemontcgapi.com')) return 'pokemontcgapi';
    if (host === 'scryfall.com' || host.endsWith('.scryfall.com')) return 'scryfall';
    if (host === 'lorcast.io' || host.endsWith('.lorcast.io')) return 'lorcast';
    if (host === 'rarebit.app' || host.endsWith('.rarebit.app')) return 'rarebit';
    if (host === 'tcgcsv.com' || host.endsWith('.tcgcsv.com')) return 'tcgcsv';
    if (host === 'tcgplayer.com' || host.endsWith('.tcgplayer.com')) return 'tcgplayer';
    if (host === 'psacard.com' || host.endsWith('.psacard.com')) return 'psa';
    if (host === 'pokemonpricetracker.com' || host.endsWith('.pokemonpricetracker.com')) return 'graded-prices';
    return host;
  };

  // Scryfall's image CDN rejects a request with no User-Agent — 400, not 403, which
  // reads like a bad URL. The shared one (utils/providerClient), whose version comes
  // from package.json rather than a literal.
  const HEADERS = {
    'User-Agent': require('./utils/providerClient').USER_AGENT,
    Accept: 'image/*',
  };
  return {
    async fetch(url) {
      const provider = imageProvider(url);
      const startedAt = performance.now();
      let status = 500;
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(30000),
          headers: HEADERS,
        });
        status = res.status;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      } finally {
        metrics.recordProviderCall(provider, startedAt, status, 'card_image');
      }
    },
    async embed(buf) {
      const { data } = await sharp(buf).resize(SIZE, SIZE, { fit: 'fill' })
        .removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const out = await session.run({ image: toTensor(data) });
      return out.embedding.data;
    },
  };
}

// The previous catalog for this (game, language), as id -> vector and id -> the
// url each was embedded from, plus the scope it recorded; null when there is none.
function readPrev(game, lang) {
  try {
    const meta = readMeta(game, lang);
    if (!meta) return null;
    const buf = fs.readFileSync(binPath(game, lang));
    const vecs = new Map();
    for (let i = 0; i < meta.ids.length; i++) {
      vecs.set(meta.ids[i], new Float32Array(buf.buffer, buf.byteOffset + i * meta.dim * 4, meta.dim));
    }
    return { vecs, srcs: new Map(Object.entries(meta.srcs || {})), scope: scopeOf(meta) };
  } catch {
    return null;
  }
}

async function embedPhase(job) {
  // A scoped build embeds only the chosen sets' cards. The catalog it writes is
  // still the whole table, because the vectors for every OTHER set are MERGED back
  // in below — without that, "build Bloomburrow" would silently delete the
  // Foundations vectors built last week, since this phase writes exactly the rows
  // it embedded.
  const scoped = job.sets && job.sets.length;
  const setFilter = scoped ? job.sets.flatMap(s => {
    const bare = games.bareSetId(s);
    return [bare, `${job.game}-${bare}`];
  }) : [];
  const rows = await db.all(
    `SELECT id, image_url, image_url_back FROM card_cache
      WHERE game = ? AND language = ? AND image_url IS NOT NULL AND image_url != ''
        ${scoped ? `AND LOWER(set_id) IN (${setFilter.map(() => '?').join(',')})` : ''}
      ORDER BY id`,
    scoped ? [job.game, job.lang, ...setFilter.map(s => String(s).toLowerCase())] : [job.game, job.lang]
  );
  // One task per face to embed. A double-faced Magic card's back is its own row,
  // `{id}_back`, the shape the published catalog uses and cvScan already folds
  // back onto the card: only the front was embedded here, so a back photographed
  // with a locally built catalog matched nothing.
  const tasks = [];
  for (const row of rows) {
    tasks.push({ id: row.id, url: embedUrl(row) });
    if (row.image_url_back) tasks.push({ id: `${row.id}_back`, url: embedUrl({ ...row, image_url: row.image_url_back }) });
  }
  job.phase = 'embed';
  job.total = tasks.length;
  job.done = 0;
  if (!tasks.length) return { built: 0, reused: 0, failed: 0, wrote: false };

  // Resume: keep every embedding whose source image has not changed.
  const prev = readPrev(job.game, job.lang);

  const embedder = job.embedder || await defaultEmbedder();

  const ids = [], vecs = [], srcs = {};
  let built = 0, reused = 0, failed = 0;
  const queue = tasks.slice();
  const inflight = new Map();
  const CONCURRENCY = 8;

  // Download ahead while the CPU embeds: the network is the slow half and the
  // model is single-threaded, so overlapping them is most of the wall clock.
  const pump = () => {
    while (inflight.size < CONCURRENCY && queue.length && !job.cancelled) {
      const task = queue.shift();
      // Resume compares the url that was EMBEDDED, not the one card_cache holds:
      // raising the resolution above has to invalidate every vector built from the
      // old one, and a row whose art was re-uploaded still has to rebuild.
      if (prev && prev.vecs.has(task.id) && prev.srcs.get(task.id) === task.url) {
        ids.push(task.id); vecs.push(prev.vecs.get(task.id)); srcs[task.id] = task.url;
        reused++; job.done++;
        continue;
      }
      inflight.set(task.id, embedder.fetch(task.url).then(buf => ({ task, buf }), err => ({ task, err })));
    }
  };

  pump();
  while (inflight.size) {
    const settled = await Promise.race(inflight.values());
    inflight.delete(settled.task.id);
    if (settled.err) failed++;
    else {
      try {
        vecs.push(await embedder.embed(settled.buf));
        ids.push(settled.task.id);
        srcs[settled.task.id] = settled.task.url;
        built++;
      } catch { failed++; }
    }
    job.done++;
    job.message = `${built + reused}/${tasks.length}`;
    pump();
  }

  // What the previous catalog had and this run did not embed: carried forward,
  // so no build ever leaves the catalog smaller than it found it.
  //
  //   · A scoped build carries every other set's vectors (keptFromPrev).
  //   · Any build carries the vector of a card it did not reach — stopped, or shut
  //     down mid-build (shutdown cancels a running build), or an image download
  //     that failed. This used to happen for scoped builds only, so stopping a
  //     whole-game rebuild wrote the part it had done over the whole catalog: a
  //     40-card catalog came back as 8, and every card not yet reached silently
  //     stopped scanning. Its stored url is the old one, so the next build sees it
  //     as changed and embeds it again.
  //   · An unscoped build does NOT carry a card that has left card_cache: it walked
  //     every row for the language, and a vector with no card behind it can win a
  //     scan and then resolve to nothing.
  if (prev) {
    const listed = scoped ? null : new Set(rows.map(r => r.id));
    for (const { id, vec, src } of keptFromPrev(prev, ids)) {
      if (listed && !listed.has(String(id).replace(/_back$/, ''))) continue;
      ids.push(id); vecs.push(vec);
      if (src) srcs[id] = src;
      reused++;
    }
  }

  // A cancelled build still writes what it has (and what it kept): the catalog is
  // valid and resuming later reuses all of it.
  if (!vecs.length) return { built, reused, failed, wrote: false };
  // What this catalog covers, for list() and the auto-update: the union of every
  // scoped build added to it, or null once it is (or was) a whole-game build.
  let scope = null;
  if (scoped) {
    if (!prev) scope = [...job.sets].sort();
    else if (prev.scope) scope = [...new Set([...prev.scope, ...job.sets])].sort();
  }
  const dim = vecs[0].length;
  const bin = Buffer.allocUnsafe(vecs.length * dim * 4);
  vecs.forEach((v, i) => Buffer.from(v.buffer, v.byteOffset, dim * 4).copy(bin, i * dim * 4));
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  // Write-then-rename: an interrupted write must not leave a truncated catalog
  // that loads as garbage.
  fs.writeFileSync(binPath(job.game, job.lang) + '.tmp', bin);
  fs.writeFileSync(metaPath(job.game, job.lang) + '.tmp', JSON.stringify({
    dim, ids, srcs, game: job.game, lang: job.lang,
    model: 'milo1', builtAt: new Date().toISOString(), scope,
  }));
  fs.renameSync(binPath(job.game, job.lang) + '.tmp', binPath(job.game, job.lang));
  fs.renameSync(metaPath(job.game, job.lang) + '.tmp', metaPath(job.game, job.lang));
  cvScan.reload(job.game, job.lang);
  return { built, reused, failed, wrote: true, rows: ids.length };
}

function start(game, lang = 'English', opts = {}) {
  if (current) throw new Error('a catalog build is already running');
  if (!GAMES.includes(game)) throw new Error(`unknown game ${game}`);
  const job = {
    game, lang: languages.toName(lang) || 'English',
    // Which sets this build covers, or empty for the whole game. Lowercased once
    // here so neither phase has to think about case: cachePhase passes them to the
    // provider and embedPhase matches them against LOWER(set_id).
    sets: (opts.sets || []).map(s => String(s).trim().toLowerCase()).filter(Boolean),
    phase: 'starting', done: 0, total: 0, message: '',
    startedAt: Date.now(), cancelled: false,
    // Tests only: { fetch(url) -> Buffer, embed(Buffer) -> Float32Array }.
    embedder: opts.embedder || null,
  };
  current = job;
  (async () => {
    try {
      const cached = opts.skipCache ? { cards: 0, failed: 0 } : await cachePhase(job);
      const embedded = job.cancelled && !opts.keepGoing ? null : await embedPhase(job);
      job.phase = job.cancelled ? 'cancelled' : 'done';
      // Say what was skipped and why, or a build that could not touch 46 listed sets
      // reports success and leaves the user wondering why the coverage did not move.
      const skipped = cached.gaps ? `, ${cached.gaps} set(s) skipped — no card data upstream` : '';
      job.message = embedded
        ? `${embedded.rows || 0} cards embedded (${embedded.built} new, ${embedded.reused} reused, ${embedded.failed} failed)${skipped}`
        : `cached ${cached.cards} cards${skipped}`;
      console.log(`catalog: ${job.game}/${job.lang} ${job.phase} — ${job.message}`);
    } catch (e) {
      job.phase = 'error';
      job.message = e.message;
      console.error(`catalog: ${job.game}/${job.lang} failed:`, e.message);
      require('./notify').emit({ type: 'catalog_build_failed', game: job.game, lang: job.lang, error: e.message });
    } finally {
      job.finishedAt = Date.now();
      last = state();
      current = null;
    }
  })();
  return state();
}

let last = null;
const lastResult = () => last;

// Which catalog the auto-update (server.js) rebuilds now, from list(), or null.
//
// One at a time, and of those behind, the one built longest ago. Taking the first
// behind one meant Pokémon every week — it is first in the registry, and its count
// never settled — so Magic, Lorcana and Riftbound were never updated at all.
// Oldest-built-first rotates through them, and across restarts too, since a
// rebuild moves its catalog to the back of the line. A scoped catalog is rebuilt
// as its scope: rebuilt whole, a few sets the user chose became the whole game.
function nextAutoUpdate(catalogs) {
  const behind = (catalogs || [])
    .filter(c => c.built && c.newSets > 0)
    .sort((a, b) => String(a.built.builtAt || '').localeCompare(String(b.built.builtAt || '')));
  const c = behind[0];
  if (!c) return null;
  return { game: c.game, lang: c.lang, newSets: c.newSets, sets: c.built.scope || null };
}

module.exports = { list, listLanguages, setCounts, newSetCount, nextAutoUpdate, keptFromPrev, embedUrl, start, stop, state, lastResult, binPath, metaPath, GAMES };
