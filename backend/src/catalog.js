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
const sharp = require('sharp');
const ort = require('onnxruntime-node');
const db = require('./db');
const cardSets = require('./cardSets');
const languages = require('./utils/languages');
const cvScan = require('./cvScan');
const pokemonProvider = require('./utils/pokemonProvider');

const MODEL_DIR = process.env.CV_MODEL_DIR || path.join(__dirname, '..', 'data', 'models');
const SIZE = 448;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const GAMES = ['mtg', 'pokemon'];

const suffix = (lang) => (!lang || lang === 'en' || lang === 'English' ? '' : `-${String(lang).toLowerCase()}`);
const binPath = (game, lang) => path.join(MODEL_DIR, `milo-${game}${suffix(lang)}-local.bin`);
const metaPath = (game, lang) => path.join(MODEL_DIR, `milo-${game}${suffix(lang)}-local.json`);

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
  if (!(await pokemonProvider.usesTcgdex(lang))) return null;
  try {
    const sets = await require('./tcgdexApi').listSets(lang);
    return sets.reduce((n, s) => n + (s.total || s.printed_total || 0), 0) || null;
  } catch {
    return null;
  }
}

// How many sets exist that this install has no cards for at all — a newly released
// set, in other words. The weekly refresh keeps the set list current (server.js
// calls fetchAndCacheSets with force), so a release surfaces here on its own.
//
// The comparison has to be done in the SAME id namespace as card_cache, and that
// differs per game, which is the whole reason this is not one query:
//
//   MTG — the `sets` table stores ids prefixed ("mtg-fdn") while card_cache stores
//   the bare Scryfall code ("fdn"). Comparing them raw reports every set as new;
//   the first version of this function did exactly that and claimed 1047 of 1047.
//
//   Pokemon — the `sets` table is pokemontcg.io's numbering (base1, gym1) while
//   card_cache holds whichever provider cached the card, usually TCGdex (A1,
//   me02.5). There is no reliable mapping between them, so the set table cannot
//   answer this at all: ask the provider that owns the ids instead.
async function newSetCount(game, lang = 'English') {
  try {
    // Sets a build already found to have no usable data upstream. Counting them as
    // "not built yet" told the user to build sets that cannot be built: measured on
    // a real install, ALL 46 uncached English Pokemon sets were of this kind
    // (Miscellaneous Promos, Jumbo cards, Sample, EX trainer kits...), so the number
    // could never drop and the weekly auto-update would have rebuilt forever.
    const gaps = new Set((await db.all(
      `SELECT set_id FROM set_data_gaps WHERE game = ? AND language = ?`, [game, lang]
    ).catch(() => [])).map(r => String(r.set_id).toLowerCase()));

    if (game === 'pokemon') {
      const provider = require('./tcgdexApi');
      const sets = await provider.listSets(lang);
      if (!sets.length) return null;
      const cached = new Set((await db.all(
        `SELECT DISTINCT LOWER(set_id) sid FROM card_cache WHERE game = 'pokemon' AND language = ?`,
        [lang]
      )).map(r => r.sid));
      return sets.filter(s => (s.total || s.printed_total || 0) > 0
        && !cached.has(String(s.id).toLowerCase())
        && !gaps.has(String(s.id).toLowerCase())).length;
    }
    // Scoped to the language, or a Spanish catalog would be measured against the
    // ENGLISH cache and report whatever English happens to be missing: measured
    // 98 for both mtg/English and mtg/Spanish while the Spanish cache held 1,205
    // cards against English's 103,656. Invisible today only because no local MTG
    // catalog exists to ask, which is exactly how it would have shipped.
    const row = await db.get(
      `SELECT COUNT(*) n FROM sets s
        WHERE s.game = ? AND COALESCE(s.total, 0) > 0
          AND LOWER(CASE WHEN s.id LIKE 'mtg-%' THEN SUBSTR(s.id, 5) ELSE s.id END) NOT IN (
            SELECT set_id FROM set_data_gaps WHERE game = s.game AND language = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM card_cache c
             WHERE c.game = s.game AND c.language = ?
               AND LOWER(c.set_id) = LOWER(CASE WHEN s.id LIKE 'mtg-%' THEN SUBSTR(s.id, 5) ELSE s.id END)
          )`,
      [game, lang, lang]
    );
    return row ? row.n : null;
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
        if (fs.existsSync(metaPath(game, lang))) {
          const meta = JSON.parse(fs.readFileSync(metaPath(game, lang), 'utf8'));
          built = {
            rows: meta.ids.length,
            builtAt: meta.builtAt,
            bytes: fs.statSync(binPath(game, lang)).size,
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
        newSets: built ? await newSetCount(game, lang) : null,
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
      sets = await require('./tcgdexApi').listSets(l.code);
    } catch { continue; }                        // provider unreachable: say nothing
    const claimed = sets.reduce((n, s) => n + (s.total || s.printed_total || 0), 0);
    if (!claimed) continue;                      // nothing published in this language
    const h = have.get(name) || { cached: 0, withArt: 0 };
    let built = null;
    try {
      if (fs.existsSync(metaPath(game, name))) {
        built = { rows: JSON.parse(fs.readFileSync(metaPath(game, name), 'utf8')).ids.length };
      }
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
    if (fs.existsSync(metaPath(game, lang))) {
      embedded = new Set(JSON.parse(fs.readFileSync(metaPath(game, lang), 'utf8')).ids);
    }
  } catch { embedded = null; }

  const sets = {};
  for (const r of rows) {
    const e = sets[r.sid] || (sets[r.sid] = { cached: 0, embedded: 0 });
    e.cached++;
    if (embedded && embedded.has(r.id)) e.embedded++;
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

// --- phase 2 -----------------------------------------------------------------
async function embedPhase(job) {
  // A scoped build embeds only the chosen sets' cards. The catalog it writes is
  // still the whole table, because the vectors for every OTHER set are MERGED back
  // in below — without that, "build Bloomburrow" would silently delete the
  // Foundations vectors built last week, since this phase writes exactly the rows
  // it embedded.
  const scoped = job.sets && job.sets.length;
  const rows = await db.all(
    `SELECT id, image_url FROM card_cache
      WHERE game = ? AND language = ? AND image_url IS NOT NULL AND image_url != ''
        ${scoped ? `AND LOWER(set_id) IN (${job.sets.map(() => '?').join(',')})` : ''}
      ORDER BY id`,
    scoped ? [job.game, job.lang, ...job.sets.map(s => String(s).toLowerCase())] : [job.game, job.lang]
  );
  job.phase = 'embed';
  job.total = rows.length;
  job.done = 0;
  if (!rows.length) return { built: 0, reused: 0, failed: 0, wrote: false };

  // Resume: keep every embedding whose source image has not changed.
  let prev = null;
  try {
    if (fs.existsSync(metaPath(job.game, job.lang))) {
      const meta = JSON.parse(fs.readFileSync(metaPath(job.game, job.lang), 'utf8'));
      const buf = fs.readFileSync(binPath(job.game, job.lang));
      const vecs = new Map();
      for (let i = 0; i < meta.ids.length; i++) {
        vecs.set(meta.ids[i], new Float32Array(buf.buffer, buf.byteOffset + i * meta.dim * 4, meta.dim));
      }
      prev = { vecs, srcs: new Map(Object.entries(meta.srcs || {})) };
    }
  } catch { prev = null; }

  const session = await ort.InferenceSession.create(path.join(MODEL_DIR, 'milo.onnx'), {
    intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential',
  });

  const ids = [], vecs = [], srcs = {};
  let built = 0, reused = 0, failed = 0;
  const queue = rows.slice();
  const inflight = new Map();
  const CONCURRENCY = 8;

  // The image the SCANNER should match against, which is not always the one the UI
  // displays. TCGdex's cached url is `/low.png` — 245x337, chosen so card grids do
  // not pull 312 KB per thumbnail — and this resizes to 448, so every TCGdex row was
  // embedded from an upscaled blur while the camera hands over a sharp 448 crop.
  // The same asset at `/high.png` is 600x825.
  //
  // Swapped here rather than in tcgdexApi.imageUrl on purpose: card_cache's url is
  // what the frontend renders, and making every grid thumbnail high-res would cost
  // the whole app bandwidth to fix one pipeline.
  const embedUrl = (row) => row.image_url.replace(/\/low\.png$/, '/high.png');

  // Scryfall's image CDN rejects a request with no User-Agent — 400, not 403, which
  // reads like a bad URL. Version comes from package.json rather than a literal: the
  // one in tcgcsvApi said 1.6.1 through two releases.
  const HEADERS = {
    'User-Agent': `Bindarr/${require('../package.json').version} (+https://github.com/thenotoriousJeremy/bindarr)`,
    Accept: 'image/*',
  };
  const fetchOne = async (row) => {
    const res = await fetch(embedUrl(row), {
      signal: AbortSignal.timeout(30000),
      headers: HEADERS,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  // Download ahead while the CPU embeds: the network is the slow half and the
  // model is single-threaded, so overlapping them is most of the wall clock.
  const pump = () => {
    while (inflight.size < CONCURRENCY && queue.length && !job.cancelled) {
      const row = queue.shift();
      // Resume compares the url that was EMBEDDED, not the one card_cache holds:
      // raising the resolution above has to invalidate every vector built from the
      // old one, and a row whose art was re-uploaded still has to rebuild.
      if (prev && prev.vecs.has(row.id) && prev.srcs.get(row.id) === embedUrl(row)) {
        ids.push(row.id); vecs.push(prev.vecs.get(row.id)); srcs[row.id] = embedUrl(row);
        reused++; job.done++;
        continue;
      }
      inflight.set(row.id, fetchOne(row).then(buf => ({ row, buf }), err => ({ row, err })));
    }
  };

  pump();
  while (inflight.size) {
    const settled = await Promise.race(inflight.values());
    inflight.delete(settled.row.id);
    if (settled.err) failed++;
    else {
      try {
        const { data } = await sharp(settled.buf).resize(SIZE, SIZE, { fit: 'fill' })
          .removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const out = await session.run({ image: toTensor(data) });
        vecs.push(out.embedding.data);
        ids.push(settled.row.id);
        srcs[settled.row.id] = embedUrl(settled.row);
        built++;
      } catch { failed++; }
    }
    job.done++;
    job.message = `${built + reused}/${rows.length}`;
    pump();
  }

  if (scoped && prev) {
    for (const { id, vec, src } of keptFromPrev(prev, ids)) {
      ids.push(id); vecs.push(vec);
      if (src) srcs[id] = src;
      reused++;
    }
  }

  // A cancelled build still writes what it has: the partial catalog is valid and
  // resuming later reuses all of it. Refusing to write would throw away the work.
  if (!vecs.length) return { built, reused, failed, wrote: false };
  const dim = vecs[0].length;
  const bin = Buffer.allocUnsafe(vecs.length * dim * 4);
  vecs.forEach((v, i) => Buffer.from(v.buffer, v.byteOffset, dim * 4).copy(bin, i * dim * 4));
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  // Write-then-rename: an interrupted write must not leave a truncated catalog
  // that loads as garbage.
  fs.writeFileSync(binPath(job.game, job.lang) + '.tmp', bin);
  fs.writeFileSync(metaPath(job.game, job.lang) + '.tmp', JSON.stringify({
    dim, ids, srcs, game: job.game, lang: job.lang,
    model: 'milo1', builtAt: new Date().toISOString(),
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

module.exports = { list, listLanguages, setCounts, keptFromPrev, start, stop, state, lastResult, binPath, metaPath };
