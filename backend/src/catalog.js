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
// every embedding whose artwork has not changed (artKey).
//
// What a build costs, measured 2026-11-15, is almost all phase 2: one image per
// card (Magic ~110k at ~130 KB, Pokémon ~22k). Phase 1 is a few hundred requests
// at most, and a whole-game English Magic build reads Scryfall's bulk file
// instead (scryfallBulk.js). The weekly update builds only the sets a catalog has
// yet to fetch (setsBehind), so after the first build the cost is the new cards
// alone.
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const db = require('./db');
const cardSets = require('./cardSets');
const languages = require('./utils/languages');
const cvScan = require('./cvScan');
const pokemonProvider = require('./utils/pokemonProvider');
const metrics = require('./utils/metrics');
const games = require('./utils/games');
// Where the models and catalogs live (CV_MODEL_DIR), and which embedding space a
// catalog's vectors are in: both defined once, in modelAssets.
const { MODEL_DIR, MODEL_ID } = require('./utils/modelAssets');
// Every game the registry marks scannable (shared/games.json).
const GAMES = games.withFeature('scan');
// Set ids as the build and the bookkeeping compare them. Lower case only: TCGdex
// ids carry punctuation ('sv03.5') that must survive.
const setKey = (id) => String(id == null ? '' : id).trim().toLowerCase();
// A new set with no upstream data yet (announced before its cards are published)
// is retried by this many builds — about a month of weekly updates — before it
// stops counting as new.
const GAP_GIVE_UP = 4;
// A set the catalog already has that keeps looking unfinished (see grownSets) is
// re-walked by this many weekly updates without anything changing, then left alone
// until something does: a provider that claims more cards than it serves must not
// cost a re-walk a week forever.
const GROWTH_GIVE_UP = 8;

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
// The running build's promise (never rejects), so the weekly update can run one
// catalog after another instead of starting the first and stopping there.
let currentRun = null;
const whenIdle = () => currentRun || Promise.resolve();

const state = () => (current ? {
  game: current.game, lang: current.lang, phase: current.phase,
  done: current.done, total: current.total, message: current.message,
  // So the panel can say WHICH sets are building rather than implying the whole game.
  sets: current.sets,
  // Sets the cache phase found no card data for (a release build reports them).
  skipped: current.skipped || [],
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

// Where a built catalog stands against its provider:
//
//   pending  the sets a build of it would walk that this install has no cards for
//            at all — a newly released set, in other words — which is what the
//            weekly update builds, scoped to exactly these. A set a build found
//            empty upstream stays pending for GAP_GIVE_UP builds: providers list a
//            new set before its cards are published, and dropping it at the first
//            empty answer left it unbuilt until someone rebuilt the whole game.
//   newSets  how many of those are buildable today (not seen empty at all): the
//            panel's "N sets not downloaded yet".
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
async function setsBehind(game, lang = 'English', { scope = null } = {}) {
  const universe = await setUniverse(game, lang);
  if (!universe.length) return null;
  // How many builds found each set empty upstream. A row from before builds
  // counted (tries NULL) is one already given up on.
  const gapTries = new Map();
  for (const r of await db.all(
    `SELECT set_id, tries FROM set_data_gaps WHERE game = ? AND language = ?`, [game, lang]
  ).catch(() => [])) {
    gapTries.set(String(r.set_id).toLowerCase(), r.tries == null ? GAP_GIVE_UP : Number(r.tries));
  }
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
  const pending = [];
  let newSets = 0;
  for (const s of universe) {
    if (inScope && !inScope.has(s) && !inScope.has(bare(s))) continue;
    if (cached.has(s) || cached.has(bare(s))) continue;
    const tries = gapTries.has(s) ? gapTries.get(s) : gapTries.get(bare(s));
    if (tries === undefined) { pending.push(s); newSets++; }
    else if (tries < GAP_GIVE_UP) pending.push(s);
  }
  return { pending, newSets };
}

// The panel's number: how many sets a build of this catalog would fetch that are
// not known to be empty upstream. Null when the provider's list cannot be had.
async function newSetCount(game, lang = 'English', { scope = null } = {}) {
  try {
    const behind = await setsBehind(game, lang, { scope });
    return behind ? behind.newSets : null;
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
        ...await (async () => {
          const behind = built ? await setsBehind(game, lang, { scope: built.scope }).catch(() => null) : null;
          // pending: the sets the weekly update would fetch (autoUpdates).
          return { newSets: behind ? behind.newSets : null, pending: behind ? behind.pending : null };
        })(),
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

// --- phase 1 -----------------------------------------------------------------
//
// What a build fetched, set by set: the set_data_gaps table the panel and the
// weekly update read, and the build's own report.
function newOutcome() {
  return { cards: 0, failed: 0, gaps: 0, stopped: false, ok: new Set(), gapIds: new Set(), failedIds: new Set() };
}

async function markOk(job, outcome, id) {
  outcome.ok.add(id);
  // Data appeared for a set previously recorded as empty: forget the gap so it
  // counts as a normal set again.
  await db.run(`DELETE FROM set_data_gaps WHERE game = ? AND language = ? AND set_id = ?`,
    [job.game, job.lang, id]).catch(() => {});
}

// A set with no cards in this language is an expected gap, not a failure —
// provider coverage is patchy per language and treating gaps as errors would
// abort every non-English build partway through. Remembered, so the panel stops
// telling the user to build a set the provider cannot serve, and counted, so the
// weekly update retries a new set (listed before its cards were published) a few
// times before giving up on it (setsBehind). A row from before builds counted is
// one already given up on, and stays so.
async function markGap(job, outcome, id, reason) {
  outcome.gapIds.add(id);
  outcome.gaps++;
  await db.run(
    `INSERT INTO set_data_gaps (game, language, set_id, reason, tries) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(game, language, set_id) DO UPDATE SET
       reason = excluded.reason,
       tries = MIN(COALESCE(set_data_gaps.tries, ${GAP_GIVE_UP}) + 1, ${GAP_GIVE_UP})`,
    [job.game, job.lang, id, String(reason || '').slice(0, 200)]
  ).catch(() => {});
}

// What phase 1 fetches, as units of work: { label, set, ids, opts }. One unit is
// one provider call (or one paged walk) and the set ids it accounts for.
//
// Magic is the game where this matters. A scoped build sends codes it already
// knows (the picker sends a release's whole family; the weekly update only what
// is new), and those go out in ONE search per twenty codes — it used to be a
// family search per code, so a family of six fetched its root six times. A
// whole-game build walks each release's family once.
async function buildUnits(job) {
  const scoped = job.sets.length > 0;
  if (job.game === 'mtg') {
    if (scoped) {
      const units = [];
      for (let i = 0; i < job.sets.length; i += 20) {
        const codes = job.sets.slice(i, i + 20);
        units.push({ label: codes.join(', '), set: codes[0], ids: codes, opts: { codes } });
      }
      return units;
    }
    const roots = await cardSets.listAllSets('mtg', job.lang);
    const units = [];
    for (const root of roots) {
      const codes = await cardSets.mtgFamilyCodes(root);
      units.push({ label: root, set: root, ids: codes.map(setKey), opts: { codes } });
    }
    return units;
  }
  const sets = scoped ? job.sets : await cardSets.listAllSets(job.game, job.lang);
  return sets.map(s => ({ label: String(s), set: s, ids: [setKey(s)], opts: {} }));
}

async function cachePhase(job) {
  const scoped = job.sets.length > 0;
  const outcome = newOutcome();
  job.phase = 'cache';
  job.done = 0;

  // A whole-game English Magic build: one bulk file instead of ~950 searches.
  if (job.game === 'mtg' && !scoped && languages.isEnglish(job.lang) && process.env.CATALOG_SCRYFALL_BULK !== '0') {
    try {
      await mtgBulkCache(job, outcome);
      return outcome;
    } catch (e) {
      if (job.cancelled) { outcome.stopped = true; return outcome; }
      console.warn(`catalog: Scryfall bulk data failed (${e.message}); falling back to searching set by set`);
      Object.assign(outcome, newOutcome());
    }
  }

  const units = await buildUnits(job);
  job.total = units.length;
  job.done = 0;
  for (const unit of units) {
    if (job.cancelled) { outcome.stopped = true; break; }
    job.message = unit.label;
    try {
      const got = await cardSets.cacheSetCards(job.game, unit.set, job.lang, unit.opts);
      outcome.cards += got.length;
      if (job.game === 'mtg') {
        // One query covers several codes; account for each one separately, so a
        // Commander token set with no cards in this language is a gap of its own
        // instead of hiding behind its release.
        const seen = new Set(got.map(c => setKey(c.set)));
        for (const id of unit.ids) {
          if (seen.has(id)) await markOk(job, outcome, id);
          else await markGap(job, outcome, id, `no ${job.lang} cards for set ${id}`);
        }
      } else {
        await markOk(job, outcome, unit.ids[0]);
      }
    } catch (e) {
      if (e.absent) {
        for (const id of unit.ids) await markGap(job, outcome, id, e.message);
      } else {
        outcome.failed++;
        for (const id of unit.ids) outcome.failedIds.add(id);
        console.warn(`catalog: ${job.game}/${job.lang} ${unit.label} failed: ${e.message}`);
      }
    }
    job.done++;
  }
  return outcome;
}

// Phase 1 for a whole English Magic catalog, from Scryfall's bulk file: every
// paper print in every reachable set (the same selection mtgCodesQuery searches
// for, `include:extras unique:prints -is:digital`), cached in batches as it
// streams past. Throws on any failure before the file is read, so the caller can
// fall back to searching set by set.
async function mtgBulkCache(job, outcome) {
  const scryfallApi = require('./scryfallApi');
  const [sets, exclusions] = await Promise.all([cardSets.getScryfallSets(), cardSets.getScanExclusions()]);
  if (!sets.length) throw new Error('Scryfall set list unavailable');
  const { byCode, rootOf } = cardSets.mtgRootIndex(sets, exclusions);
  const reachable = new Set([...rootOf].filter(([, root]) => root).map(([code]) => code));
  job.total = [...reachable].reduce((n, c) => n + (byCode.get(c).card_count || 0), 0);
  job.done = 0;
  job.message = 'Scryfall bulk data';

  const perSet = new Map();
  const seenIds = new Set();
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const rows = batch;
    batch = [];
    await scryfallApi.cacheCards(rows);
    job.done += rows.length;
  };
  await require('./scryfallBulk').streamCards('default_cards', async (card) => {
    if (job.cancelled) return false;
    if (!card || !card.id || card.digital || seenIds.has(card.id)) return true;
    const code = setKey(card.set);
    if (!reachable.has(code)) return true;
    seenIds.add(card.id);
    perSet.set(code, (perSet.get(code) || 0) + 1);
    batch.push(scryfallApi.normalizeCard(card, 'en'));
    if (batch.length >= 500) await flush();
    return true;
  });
  await flush();
  if (job.cancelled) { outcome.stopped = true; return; }

  outcome.cards = seenIds.size;
  for (const code of reachable) {
    if (!(byCode.get(code).card_count > 0)) continue;   // not a set anyone can build
    if (perSet.has(code)) await markOk(job, outcome, code);
    else await markGap(job, outcome, code, 'no English paper prints in Scryfall bulk data');
  }
  console.log(`catalog: mtg/${job.lang} cached ${seenIds.size} cards from Scryfall bulk data`);
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
// displays: grids want ~245px thumbnails, and milo wants a sharp 448 square, so
// embedding the thumbnail meant matching the camera's sharp crop against an
// upscaled blur.
//
// Swapped here rather than in the providers on purpose: card_cache's url is what
// the frontend renders, and making every grid thumbnail high-res would cost the
// whole app bandwidth to fix one pipeline.
function embedUrl(row) {
  let url = String(row.image_url || '');
  // TCGdex: `high` is 600x825 against `low`'s 245x337. WebP rather than PNG: the
  // same image measured 73 KB against 290 KB (four cards, 2026-11-15), so a whole
  // English Pokémon build downloads ~1.6 GB instead of ~6.3 GB.
  url = url.replace(/^(https:\/\/assets\.tcgdex\.net\/.+)\/(?:low|high)\.(?:png|webp|jpg)$/, '$1/high.webp');
  // pokemontcg.io: '{n}.png' is 245x342, '{n}_hires.png' 734x1024 — the same
  // upscaled-blur problem as TCGdex's `low`. Only installs still pinned to
  // pokemontcg.io have these rows (TCGdex is the default), until it shuts down.
  url = url.replace(/^(https:\/\/images\.pokemontcg\.io\/[^/]+\/[^/?#]+?)(?<!_hires)\.png$/, '$1_hires.png');
  if (url.includes('cards.lorcast.io/card/digital/')) {
    url = url.replace(/\/card\/digital\/(?:small|normal)\//, '/card/digital/large/');
  }
  // Riftbound rows store a 480px rendition of Riot's art; embed the full width.
  if (String(row.id).startsWith('riftbound-')) url = require('./riftcodexApi').embedImageUrl(url);
  // TCGplayer's 200px product thumbnail: the games served from TCGCSV, and the
  // Pokémon cards TCGdex lacks (pokemonTcgplayer.js). Matched by url, not game.
  if (url.startsWith('https://tcgplayer-cdn.tcgplayer.com/product/')) url = require('./tcgcsvGameApi').embedImageUrl(url);
  return url;
}

// Two urls with the same artKey are the same picture at the same resolution, so a
// vector embedded from one is still good for the other. TCGdex's PNG and WebP are
// that (the extension is only the encoding); anything else must match exactly —
// Scryfall's `?timestamp` changes when a card is rescanned, and a resolution
// change has to re-embed.
function artKey(url) {
  const u = String(url || '');
  const m = /^(https:\/\/assets\.tcgdex\.net\/.+\/(?:low|high))\.(?:png|webp|jpg)$/.exec(u);
  return m ? m[1] : u;
}

const imageProvider = (url) => {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return 'unknown'; }
  if (host === 'tcgdex.net' || host.endsWith('.tcgdex.net')) return 'tcgdex';
  if (host === 'pokemontcg.io' || host.endsWith('.pokemontcg.io')) return 'pokemontcg';
  if (host === 'pokemontcgapi.com' || host.endsWith('.pokemontcgapi.com')) return 'pokemontcgapi';
  if (host === 'scryfall.com' || host.endsWith('.scryfall.com') || host.endsWith('.scryfall.io')) return 'scryfall';
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
const IMAGE_HEADERS = {
  'User-Agent': require('./utils/providerClient').USER_AGENT,
  Accept: 'image/webp,image/avif,image/*;q=0.8',
};

async function fetchImageOnce(url) {
  const provider = imageProvider(url);
  const startedAt = performance.now();
  let status = 500;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: IMAGE_HEADERS });
    status = res.status;
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.retryAfter = Number(res.headers.get('retry-after')) || 0;
      throw err;
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    metrics.recordProviderCall(provider, startedAt, status, 'card_image');
  }
}

// Two retries for the failures that are worth one: a dropped connection, 429 and
// 5xx. TCGdex's asset server answered an occasional 503 under parallel load in
// testing (2026-11-15), and every failure here is a card the catalog cannot scan
// until the next build. A 404 is final.
async function fetchImage(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchImageOnce(url);
    } catch (err) {
      const transient = !err.status || err.status === 429 || err.status >= 500;
      if (!transient || attempt >= 2) throw err;
      const wait = Math.min(10000, err.retryAfter ? err.retryAfter * 1000 : 1000 * 3 ** attempt);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// --- phase 2 -----------------------------------------------------------------

// What turns an image URL into an embedding: a download (fetchImage, which
// retries what is worth retrying) and a milo forward pass on worker threads
// (embedPool.js: onnxruntime-node's run() blocks the thread that calls it, and
// milo takes one image at a time, so threads are how a build uses more than one
// core). `start(…, { embedder })` swaps it, which is how the tests drive a whole
// build without a model file or a network.
async function defaultEmbedder() {
  const pool = await require('./embedPool').createEmbedder(path.join(MODEL_DIR, 'milo.onnx'));
  return {
    fetch: fetchImage,
    embed: (buf) => pool.embed(buf),
    close: () => pool.close(),
    size: pool.size,
    workers: pool.workers,
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

  // Resume: keep every embedding whose source image has not changed. Compared by
  // artKey of the url that was EMBEDDED, not the one card_cache holds: raising the
  // resolution has to invalidate every vector built from the old one, and a row
  // whose art was re-uploaded still has to rebuild — while a change of encoding
  // alone (TCGdex PNG to WebP) does not re-download a catalog's worth of art.
  const prev = readPrev(job.game, job.lang);
  const ids = [], vecs = [], srcs = {};
  let built = 0, reused = 0, failed = 0;
  const queue = [];
  for (const task of tasks) {
    if (prev && prev.vecs.has(task.id) && artKey(prev.srcs.get(task.id)) === artKey(task.url)) {
      ids.push(task.id); vecs.push(prev.vecs.get(task.id)); srcs[task.id] = task.url;
      reused++; job.done++;
    } else {
      queue.push(task);
    }
  }

  // The embedder only when something needs embedding: a rebuild that finds nothing
  // new should not start a pool of ONNX sessions to do nothing.
  let embedder = job.embedder;
  let own = null;
  try {
    if (queue.length && !embedder) {
      own = await defaultEmbedder();
      embedder = own;
      console.log(`catalog: ${job.game}/${job.lang} embedding ${queue.length} image(s) on ${own.workers ? `${own.workers} worker thread(s)` : 'the server thread'}`);
    }
    // Downloads run ahead of the embedders: the network is the slow half, so a few
    // images per worker stay in flight.
    const concurrency = Math.max(8, ((embedder && embedder.size) || 1) * 4);
    const inflight = new Map();
    const pump = () => {
      while (inflight.size < concurrency && queue.length && !job.cancelled) {
        const task = queue.shift();
        inflight.set(task.id, Promise.resolve()
          .then(() => embedder.fetch(task.url))
          .then(buf => embedder.embed(buf))
          .then(vec => ({ task, vec }), err => ({ task, err })));
      }
    };
    pump();
    while (inflight.size) {
      const settled = await Promise.race(inflight.values());
      inflight.delete(settled.task.id);
      if (settled.err) failed++;
      else {
        ids.push(settled.task.id);
        vecs.push(settled.vec);
        srcs[settled.task.id] = settled.task.url;
        built++;
      }
      job.done++;
      job.message = `${built + reused}/${tasks.length}`;
      pump();
    }
  } finally {
    if (own) await own.close().catch(() => {});
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
  // `kept` counts what a whole-game build could not refresh (stopped, failed); a
  // scoped build's other sets are simply reused.
  let kept = 0;
  if (prev) {
    const listed = scoped ? null : new Set(rows.map(r => r.id));
    for (const { id, vec, src } of keptFromPrev(prev, ids)) {
      if (listed && !listed.has(String(id).replace(/_back$/, ''))) continue;
      ids.push(id); vecs.push(vec);
      if (src) srcs[id] = src;
      if (scoped) reused++; else kept++;
    }
  }

  // A cancelled build still writes what it has (and what it kept): the catalog is
  // valid and resuming later reuses all of it.
  if (!vecs.length) return { built, reused, failed, kept, wrote: false };
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
    model: MODEL_ID, builtAt: new Date().toISOString(), scope,
  }));
  fs.renameSync(binPath(job.game, job.lang) + '.tmp', binPath(job.game, job.lang));
  fs.renameSync(metaPath(job.game, job.lang) + '.tmp', metaPath(job.game, job.lang));
  cvScan.reload(job.game, job.lang);
  return { built, reused, failed, kept, wrote: true, rows: ids.length };
}

function start(game, lang = 'English', opts = {}) {
  if (current) throw new Error('a catalog build is already running');
  if (!GAMES.includes(game)) throw new Error(`unknown game ${game}`);
  const job = {
    game, lang: languages.toName(lang) || 'English',
    // Which sets this build covers, or empty for the whole game. Lowercased once
    // here so neither phase has to think about case: cachePhase passes them to the
    // provider and embedPhase matches them against LOWER(set_id).
    sets: [...new Set((opts.sets || []).map(setKey).filter(Boolean))],
    phase: 'starting', done: 0, total: 0, message: '',
    startedAt: Date.now(), cancelled: false,
    // Tests only: { fetch(url) -> Buffer, embed(Buffer) -> Float32Array }.
    embedder: opts.embedder || null,
  };
  current = job;
  currentRun = (async () => {
    try {
      const cached = opts.skipCache ? newOutcome() : await cachePhase(job);
      job.skipped = [...cached.gapIds];
      // cacheOnly: the release build (scripts/scan-catalogs/build.mjs) caches every
      // set first, adds rows of its own, then embeds with skipCache.
      const embedded = opts.cacheOnly || (job.cancelled && !opts.keepGoing) ? null : await embedPhase(job);
      job.phase = job.cancelled ? 'cancelled' : 'done';
      // A build that ran to the end: where each set it covered now stands, so the
      // weekly update can tell a set that grew from one that will not finish.
      if (!job.cancelled && embedded && embedded.wrote) {
        await recordSetChecks(job).catch(e => console.warn(`catalog: could not record set checks: ${e.message}`));
      }
      // Say what was skipped and why, or a build that could not touch 46 listed sets
      // reports success and leaves the user wondering why the coverage did not move.
      const skipped = cached.gaps ? `, ${cached.gaps} set(s) skipped — no card data upstream` : '';
      const keptNote = embedded && embedded.kept ? `, ${embedded.kept} kept from the previous build` : '';
      job.message = embedded
        ? `${embedded.rows || 0} cards embedded (${embedded.built} new, ${embedded.reused} reused, ${embedded.failed} failed${keptNote})${skipped}`
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

// The weekly update's work (server.js), from list(): every built catalog with sets
// to fetch, the one built longest ago first. Taking only the first behind one meant
// Pokémon every week — it is first in the registry, and its count never settled —
// so Magic, Lorcana and Riftbound were never updated at all. Oldest-built-first
// rotates through them, and across restarts too, since a rebuild moves its catalog
// to the back of the line; and every one behind is built in turn, not one a week.
//
// Each is built as exactly the sets it is missing (`pending`). Rebuilding the
// whole game to fetch one new set is what made the update cost hours, and a scoped
// catalog's pending sets are its own: rebuilt whole, a few sets the user chose
// became the whole game.
function autoUpdates(catalogs) {
  return (catalogs || [])
    .filter(c => c.built && Array.isArray(c.pending) && c.pending.length)
    .sort((a, b) => String(a.built.builtAt || '').localeCompare(String(b.built.builtAt || '')))
    .map(c => ({ game: c.game, lang: c.lang, newSets: c.newSets, sets: c.pending }));
}

// Sets a built catalog already covers that have grown since. setsBehind counts a
// set as fetched once any card of it is cached, and a set is often not finished
// then: TCGdex publishes a set in parts over weeks, Scryfall's promo sets keep
// growing, and cards reach card_cache by other roads (a search, the TCGCSV
// catalogue refresh, Pokémon's TCGplayer-only cards) without reaching the catalog.
// So a set is grown when cards cached here with art are not in the catalog yet, or
// when its provider claims more cards than are cached (English: the sets table,
// refreshed daily). Re-walking one costs that set's list and only the new art.
//
// Each set's state after its last build is kept (catalog_set_checks): a set that
// still looks unfinished with nothing changed, GROWTH_GIVE_UP builds in a row, is
// left alone until something about it moves. Run by the weekly update only — it
// reads every cached card of the game, which list() cannot afford on every poll.
async function setSignatures(game, lang) {
  const meta = readMeta(game, lang);
  const inCatalog = new Set((meta ? meta.ids : []).map(id => String(id).replace(/_back$/, '')));
  const per = new Map();   // bare set id -> { cached, art, embedded, claimed }
  for (const r of await db.all(
    `SELECT id, LOWER(set_id) sid, CASE WHEN image_url IS NOT NULL AND image_url != '' THEN 1 ELSE 0 END art
       FROM card_cache WHERE game = ? AND language = ? AND set_id IS NOT NULL AND set_id != ''`, [game, lang]
  )) {
    const sid = games.bareSetId(r.sid);
    const e = per.get(sid) || { cached: 0, art: 0, embedded: 0, claimed: null };
    e.cached++;
    if (r.art) { e.art++; if (inCatalog.has(r.id)) e.embedded++; }
    per.set(sid, e);
  }
  if (languages.isEnglish(lang)) {
    for (const r of await db.all(`SELECT id, total FROM sets WHERE game = ?`, [game])) {
      const e = per.get(games.bareSetId(String(r.id).toLowerCase()));
      if (e && r.total > 0) e.claimed = r.total;
    }
  }
  return per;
}
const signature = (e) => `${e.claimed ?? ''}|${e.cached}|${e.art}|${e.embedded}`;
const unfinished = (e) => e.art > e.embedded || (e.claimed != null && e.claimed > e.cached);

async function grownSets(game, lang, { scope = null } = {}) {
  const per = await setSignatures(game, lang);
  const checks = new Map((await db.all(
    `SELECT set_id, sig, tries FROM catalog_set_checks WHERE game = ? AND language = ?`, [game, lang]
  ).catch(() => [])).map(r => [r.set_id, r]));
  const inScope = scope ? new Set(scope.map(s => games.bareSetId(String(s).toLowerCase()))) : null;
  const out = [];
  for (const [sid, e] of per) {
    if (inScope && !inScope.has(sid)) continue;
    if (!unfinished(e)) continue;
    const c = checks.get(sid);
    if (c && c.sig === signature(e) && c.tries >= GROWTH_GIVE_UP) continue;
    out.push(sid);
  }
  return out;
}

// After a build that ran to the end: each set it covered, as it now stands. A set
// that still looks unfinished with the same signature as after its previous build
// made no progress; anything else starts the count again.
async function recordSetChecks(job) {
  const per = await setSignatures(job.game, job.lang);
  const built = job.sets.length ? new Set(job.sets.map(s => games.bareSetId(s))) : null;
  const before = new Map((await db.all(
    `SELECT set_id, sig, tries FROM catalog_set_checks WHERE game = ? AND language = ?`, [job.game, job.lang]
  )).map(r => [r.set_id, r]));
  await db.withTransaction(async () => {
    for (const [sid, e] of per) {
      if (built && !built.has(sid)) continue;
      const sig = signature(e);
      const prev = before.get(sid);
      const tries = !unfinished(e) ? 0 : prev && prev.sig === sig ? prev.tries + 1 : 1;
      await db.run(
        `INSERT INTO catalog_set_checks (game, language, set_id, sig, tries) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(game, language, set_id) DO UPDATE SET sig = excluded.sig, tries = excluded.tries`,
        [job.game, job.lang, sid, sig, tries]
      );
    }
  });
}

// autoUpdates over the live list, with each catalog's grown sets added to what it
// is missing. A new Magic release is listed by its root code (setUniverse); its
// tokens, promos and art cards are their own codes beneath it, so the build is sent
// the whole family.
async function behindCatalogs() {
  const rows = await list();
  for (const c of rows) {
    if (!c.built) continue;
    const grown = await grownSets(c.game, c.lang, { scope: c.built.scope }).catch(() => []);
    if (grown.length) c.pending = [...new Set([...(c.pending || []), ...grown])];
  }
  const out = autoUpdates(rows);
  for (const c of out) {
    if (c.game !== 'mtg') continue;
    const codes = new Set();
    for (const root of c.sets) for (const code of await cardSets.mtgFamilyCodes(root)) codes.add(setKey(code));
    c.sets = [...codes];
  }
  return out;
}

module.exports = {
  list, listLanguages, setCounts, newSetCount, setsBehind, autoUpdates, grownSets, behindCatalogs, keptFromPrev, embedUrl, artKey,
  start, stop, state, whenIdle, lastResult, binPath, metaPath, GAMES,
};
