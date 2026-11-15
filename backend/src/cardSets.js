// Set discovery and card-list caching: which sets a game has, and fetching a
// set's cards into card_cache.
//
// This file used to build per-set ORB feature indexes for set-scoped scanning.
// That pipeline is gone — scanning is CollectorVision embeddings now (cvScan +
// catalog) — and filling card_cache, which had only ever run as a SIDE EFFECT of
// indexing, is what survives as a job in its own right. Its ORB imports (opencv,
// sharp, fs) and tuning constants went with it; nothing here reads pixels.
const axios = require('axios');
const languages = require('./utils/languages');
const metrics = require('./utils/metrics');
// The one place that decides pokemontcg.io vs TCGdex. Every branch below asks it
// rather than re-deriving the answer from the language — see the note in that
// module for what re-deriving it cost.
const pokemonProvider = require('./utils/pokemonProvider');
const games = require('./utils/games');
// scryfallApi/tcgApi are lazy-required inside the build/preview paths only — they
// pull in the DB module, which verify-only worker threads must not load.

const httpOptions = { timeout: 30000, headers: { 'User-Agent': 'Bindarr/1.0', 'Accept': 'application/json' } };
const tcgdexHttp = axios.create(httpOptions);
metrics.instrumentAxiosClient(tcgdexHttp, 'tcgdex');
const pokemonTcgHttp = axios.create(httpOptions);
metrics.instrumentAxiosClient(pokemonTcgHttp, 'pokemontcg');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// "This set has no data in this language" — an expected gap, not a failure.
//
// The distinction decides whether a whole build is allowed to finish: per-language
// coverage is patchy enough that counting gaps as failures would abort every
// non-English catalog build partway through (catalog.js cachePhase reads the flag).
// It is a FLAG rather than a phrase in the message, because a correctness decision
// bound to the exact wording of a sentence written for a human breaks the moment
// someone rewords it — which is what the previous owner of this distinction did,
// and why builds started failing with nothing connecting the two.
function absent(message) {
  const e = new Error(message);
  e.absent = true;
  return e;
}

const norm = (set) => (set || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const langOf = (lang) => languages.toCode(lang);

// Scryfall's /sets list, memoised. These three were used below but never
// declared, so line one of getScryfallSets threw ReferenceError on EVERY call:
// the family lookups (getMtgChildSets, getMtgChildSetMap) propagated it, and
// mtgSetFamilyQuery/listAllSets swallowed it and quietly fell back to "no
// children" — which is why a set-scoped MTG build indexed the parent set only.
const SCRYFALL_SETS_TTL_MS = 6 * 60 * 60 * 1000;
let scryfallSetsCache = null;
let scryfallSetsCacheAt = 0;

async function getScryfallSets() {
  if (scryfallSetsCache && (Date.now() - scryfallSetsCacheAt < SCRYFALL_SETS_TTL_MS)) {
    return scryfallSetsCache;
  }
  const scryfallApi = require('./scryfallApi');
  try {
    const r = await scryfallApi.scryGetRetried('https://api.scryfall.com/sets');
    scryfallSetsCache = r.data.data || [];
    scryfallSetsCacheAt = Date.now();
  } catch {
    if (!scryfallSetsCache) scryfallSetsCache = [];
  }
  return scryfallSetsCache;
}

async function getScanExclusions() {
  const db = require('./db');
  try {
    // Deliberately does NOT return the provider. It used to, and callers then
    // made the pokemontcg.io-vs-TCGdex decision themselves from that field —
    // four of them wrongly. utils/pokemonProvider owns that question now, and
    // leaving a second way to ask it here is how the divergence started.
    const row = await db.get(`
      SELECT scan_exclude_tokens, scan_exclude_art_cards, scan_exclude_jumpstart, scan_exclude_promos,
             scan_exclude_digital
      FROM app_settings WHERE id = 1
    `);
    return {
      tokens: !!(row && row.scan_exclude_tokens),
      artCards: !!(row && row.scan_exclude_art_cards),
      jumpstart: !!(row && row.scan_exclude_jumpstart),
      promos: !!(row && row.scan_exclude_promos),
      // The only one that defaults ON — see the column comment in db.js. A
      // missing row must read as excluded, so this cannot use the !! form the
      // others do.
      digital: row ? !!row.scan_exclude_digital : true,
    };
  } catch {
    return { tokens: false, artCards: false, jumpstart: false, promos: false, digital: true };
  }
}

// TCGdex set ids belonging to a digital-only series (Pokémon TCG Pocket), which
// a camera can never be pointed at. See tcgdexApi.DIGITAL_SERIES.
//
// Fails OPEN — an unreachable series endpoint yields an empty set, so the build
// indexes a handful of digital sets it did not need rather than dropping every
// paper set from the catalogue. Getting this backwards would turn one bad request
// into an empty scan index.
async function digitalSetIds(lang) {
  try {
    const tcgdexApi = require('./tcgdexApi');
    const bySet = await tcgdexApi.listSeries(lang);
    const out = new Set();
    for (const [setId, serie] of bySet) {
      if (serie && serie.id === tcgdexApi.DIGITAL_SERIES) out.add(setId);
    }
    return out;
  } catch (e) {
    console.warn(`cardSets: could not list TCGdex series (${e.message}) — not excluding digital sets this time`);
    return new Set();
  }
}

// Does this child set survive the user's scan exclusions? One definition, shared
// by everything that folds children into their parent, so the family a build
// indexes and the family the UI lists can never drift apart.
function childAllowed(s, exclusions, excludeChildCodes = []) {
  if (exclusions.tokens && s.set_type === 'token') return false;
  if (exclusions.artCards && s.set_type === 'memorabilia') return false;
  if (exclusions.jumpstart && s.set_type === 'starter') return false;
  if (exclusions.promos && s.set_type === 'promo') return false;
  return !excludeChildCodes.includes(s.code);
}

const childBrief = (s) => ({
  code: s.code,
  name: s.name,
  cardCount: s.card_count || 0,
  type: s.set_type || 'subset',
});

// Every set's family ROOT: the top-level release it hangs under, however deep.
//
// Scryfall nests more than one level. 'ttdc' (Tarkir: Dragonstorm Commander
// Tokens) is a child of 'tdc' (the Commander decks), which is itself a child of
// 'tdm'. A family that only looked one level down never fetched 'ttdc' at all —
// 51 sets and ~1,000 paper cards (Commander tokens, art series, promos) that no
// local catalog could ever contain, while the weekly update counted them as
// "new" forever because no build could cache them.
//
// A set belongs to its root's family only if it AND every set between it and the
// root is paper and allowed by the scan exclusions: excluding promos drops a
// promo set's own children too. Returns code -> root code (roots map to
// themselves), or null for a set no family includes. Cycles and runaway chains
// stop at 8 hops; Scryfall's deepest real chain is 2.
function mtgRootIndex(sets, exclusions, excludeChildCodes = []) {
  const byCode = new Map(sets.filter(s => s.code).map(s => [norm(s.code), s]));
  const rootOf = new Map();
  const resolve = (code) => {
    if (rootOf.has(code)) return rootOf.get(code);
    let s = byCode.get(code);
    let root = null;
    for (let hops = 0; s && hops < 8; hops++) {
      if (s.digital) break;
      const parent = s.parent_set_code ? norm(s.parent_set_code) : null;
      if (!parent) { root = norm(s.code); break; }
      if (!childAllowed(s, exclusions, excludeChildCodes)) break;
      s = byCode.get(parent);
    }
    rootOf.set(code, root);
    return root;
  };
  for (const code of byCode.keys()) resolve(code);
  return { byCode, rootOf };
}

// Every root's descendants in ONE pass, as normalized-root-code -> children[].
//
// This replaced a per-parent lookup that cost a settings query plus a full scan
// of the ~900 entry Scryfall set list EACH TIME: a caller wanting children for
// every set in the catalogue paid that ~460 times per request. One query, one
// pass, same answer — and now the only shape of this question anything asks.
// Grandchildren are folded in under the root (see mtgRootIndex), so the set
// picker offers them and a scoped build that sends the family embeds them.
async function getMtgChildSetMap() {
  const [sets, exclusions] = await Promise.all([getScryfallSets(), getScanExclusions()]);
  const { byCode, rootOf } = mtgRootIndex(sets, exclusions);
  const map = new Map();
  for (const [code, root] of rootOf) {
    if (!root || root === code) continue;
    const s = byCode.get(code);
    const arr = map.get(root);
    if (arr) arr.push(childBrief(s)); else map.set(root, [childBrief(s)]);
  }
  return map;
}

// The set codes one MTG family covers: the root and every descendant the scan
// exclusions allow, lower-case. What a build of `set` fetches and embeds.
async function mtgFamilyCodes(set, { excludeChildCodes = [] } = {}) {
  const [sets, exclusions] = await Promise.all([getScryfallSets(), getScanExclusions()]);
  const { rootOf } = mtgRootIndex(sets, exclusions, excludeChildCodes.map(norm));
  const root = rootOf.get(norm(set)) || norm(set);
  const codes = [...rootOf].filter(([, r]) => r === root).map(([code]) => code);
  return codes.length ? codes : [root];
}

// The family root of each code, for collapsing a list of family codes (what the
// set picker sends) into the releases to fetch — each fetched once, not once per
// child. Unknown codes map to themselves.
async function mtgRoots(codes) {
  const [sets, exclusions] = await Promise.all([getScryfallSets(), getScanExclusions()]);
  const { rootOf } = mtgRootIndex(sets, exclusions);
  return [...new Set(codes.map(c => rootOf.get(norm(c)) || norm(c)))];
}

// A Scryfall release is split into a parent expansion plus child sets — tokens,
// promos, art series, Commander — each with its own set code (tecl, pecl, ...),
// linked by parent_set_code. Build a query spanning the whole family so "ecl"
// indexes tokens/art/etc., not just the 408 main-set prints. Digital-only sets
// (Alchemy) are skipped — no physical card to scan. include:extras stops Scryfall
// hiding tokens/emblems; -is:digital drops any stray digital print.
async function mtgSetFamilyQuery(set, lang, { excludeChildCodes = [] } = {}) {
  // Same function the set picker lists the family from (getMtgChildSetMap shares
  // mtgRootIndex), so a build indexes exactly what was shown. /sets unreachable
  // yields an empty index, and the family degrades to the set itself.
  let codes;
  try {
    codes = await mtgFamilyCodes(set, { excludeChildCodes });
  } catch {
    codes = [norm(set)];
  }
  return mtgCodesQuery(codes, lang);
}

// The search for a list of set codes, every print, extras included, paper only.
function mtgCodesQuery(codes, lang) {
  const sets = codes.map(c => `set:${norm(c)}`).join(' or ');
  // Language is a search keyword (and needs include_multilingual on the request,
  // added by mtgSearchUrl below) — Scryfall has no lang parameter.
  const scryLang = languages.resolve(lang).scryfall;
  const langTerm = scryLang === 'en' ? '' : ` lang:${scryLang}`;
  return `(${sets}) include:extras unique:prints -is:digital${langTerm}`;
}

// Search URL for a set family in one language. English omits
// include_multilingual so the query stays exactly what it was before languages.
function mtgSearchUrl(query, lang, extra = '') {
  const multilingual = languages.resolve(lang).scryfall === 'en' ? '' : '&include_multilingual=true';
  return `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}${extra}${multilingual}`;
}

// Every set worth building a global index from, as set codes in build order.
//
// MTG returns PARENT sets only. mtgSetFamilyQuery above already folds a set's
// children (tokens, art series, promos — anything linked by parent_set_code)
// into the parent's index, so enumerating the children as well would index the
// same printings twice: harmless for correctness (scanMatch treats repeated
// set|number rows as faces and keeps the best) but a straight waste of build
// time and disk. Digital-only sets are skipped — no physical card to scan.
//
// Memoised for an hour per (game, language, provider, exclusions): the weekly
// update and the Admin panel both ask, and for pokemontcg.io each ask was a live
// paged /sets walk.
const LIST_ALL_TTL_MS = 60 * 60 * 1000;
const listAllMemo = new Map();

async function listAllSets(game, lang) {
  const exclusions = await getScanExclusions();
  const provider = game === 'pokemon' ? await pokemonProvider.providerFor(langOf(lang)) : '';
  const key = JSON.stringify([game, langOf(lang), provider, exclusions]);
  const hit = listAllMemo.get(key);
  if (hit && Date.now() - hit.at < LIST_ALL_TTL_MS) return hit.sets;
  const sets = await listAllSetsUncached(game, lang);
  // An empty answer is usually an unreachable provider; do not pin it for an hour.
  if (sets.length) listAllMemo.set(key, { at: Date.now(), sets });
  return sets;
}

async function listAllSetsUncached(game, lang) {
  const code = langOf(lang);
  if (game === 'mtg') {
    // Roots only — each fetch pulls the root's whole family (mtgSetFamilyQuery),
    // so listing children too would fetch them twice. A root counts when its
    // FAMILY has cards, not only the root itself.
    const [sets, exclusions] = await Promise.all([getScryfallSets(), getScanExclusions()]);
    const { byCode, rootOf } = mtgRootIndex(sets, exclusions);
    const familyCards = new Map();
    for (const [c, root] of rootOf) {
      if (root) familyCards.set(root, (familyCards.get(root) || 0) + (byCode.get(c).card_count || 0));
    }
    return [...familyCards].filter(([, n]) => n > 0).map(([root]) => byCode.get(root).code);
  }
  if (games.get(game)?.provider === 'tcgcsv') return require('./tcgcsvGameApi').listSetCodes(game);
  if (game === 'lorcana') {
    const db = require('./db');
    let rows = await db.all("SELECT id, ptcgo_code FROM sets WHERE game = 'lorcana' ORDER BY release_date ASC");
    if (!rows.length) {
      const lorcastApi = require('./lorcastApi');
      await lorcastApi.fetchAndCacheSets(true);
      rows = await db.all("SELECT id, ptcgo_code FROM sets WHERE game = 'lorcana' ORDER BY release_date ASC");
    }
    return rows.map(r => r.ptcgo_code || r.id.replace(/^lorcana-/, ''));
  }
  // Riftbound's catalogue is cached whole (riftcodexApi), so its sets are read
  // from what is cached — fetching the catalogue first if nothing is.
  if (game === 'riftbound') return require('./riftcodexApi').listSetCodes();
  if (game === 'pokemon') {
    if (await pokemonProvider.providerFor(code) === pokemonProvider.POKEMONTCGAPI) {
      return (await require('./pokemontcgapi').listSets(code)).filter(s => s.total > 0).map(s => s.id);
    }
    const exclusions = await getScanExclusions();
    if (await pokemonProvider.usesTcgdex(code)) {
      const tcgdexApi = require('./tcgdexApi');
      const sets = await tcgdexApi.listSets(code);
      const digital = exclusions.digital ? await digitalSetIds(code) : new Set();
      return sets
        .filter(s => s.id && (s.total || s.printed_total || 0) > 0 && !digital.has(s.id))
        .map(s => s.id);
    }
  }
  // tcgApi.tcgClient, not the bare `http` above: api.pokemontcg.io answers 5xx
  // often enough that a single un-retried GET here would abort a whole multi-hour
  // global build before it indexed anything. That client already retries
  // transients and carries the API key.
  const { tcgClient } = require('./tcgApi');
  try {
    const out = [];
    for (let page = 1; ; page++) {
      const r = await tcgClient.get('/sets', { params: { page, pageSize: 250, select: 'id,total' } });
      const data = r.data.data || [];
      for (const s of data) if (s.id) out.push(s.id);
      if (data.length < 250) break;
    }
    return out;
  } catch (e) {
    console.warn(`cardSets: live pokemontcg.io /sets fetch failed (${e.message}); falling back to local database`);
    const db = require('./db');
    const rows = await db.all("SELECT id FROM sets WHERE game = 'pokemon' OR game IS NULL");
    return rows.map(r => r.id);
  }
}

// Scannable face image(s) for a Scryfall card. Single-image layouts (normal,
// split, flip, adventure, saga) carry one top-level image. Double-faced cards
// (transform, modal DFC, art series, reversible) have no top-level image and one
// distinct image per face — index every face so scanning either side matches.
// Returns [{ img, illustrationId }]. The id is carried for callers that want to
// group printings by artwork; each face of a double-faced card has its own
// illustration, so it is read per face.
function mtgCardImages(c) {
  if (c.image_uris?.normal) return [{ img: c.image_uris.normal, illustrationId: c.illustration_id || null }];
  return (c.card_faces || [])
    .filter(f => f.image_uris?.normal)
    .map(f => ({ img: f.image_uris.normal, illustrationId: f.illustration_id || c.illustration_id || null }));
}

// MTG: page Scryfall for a set family in one language. Returns
// [{ name, set, number, img, raw }], one entry per scannable face (double-faced
// cards yield two, same name/number). `name` is the localized (printed) name when
// there is one, because that is what the post-scan lookup searches Scryfall for —
// verified: `!"稲妻" lang:ja` with include_multilingual finds the card.
//
// `codes`: fetch exactly these set codes in one query instead of `set`'s whole
// family. A scoped build already knows its codes (the picker sends the family,
// the weekly update sends only the sets released since), and one query for all
// of them replaces one family query per code.
async function fetchMtgSet(set, lang, { excludeChildCodes = [], codes = null } = {}) {
  const scryfallApi = require('./scryfallApi');
  const query = codes && codes.length
    ? mtgCodesQuery(codes, lang)
    : await mtgSetFamilyQuery(set, lang, { excludeChildCodes });
  let url = mtgSearchUrl(query, lang, '&order=set');
  const cards = [];
  while (url) {
    const r = await scryfallApi.scryGetRetried(url);
    for (const c of r.data.data || []) {
      for (const { img, illustrationId } of mtgCardImages(c)) {
        cards.push({ name: c.printed_name || c.name || '', set: c.set || set, number: c.collector_number || '', img, illustrationId, raw: c });
      }
    }
    url = r.data.has_more ? r.data.next_page : null;
    await sleep(120);
  }
  return cards;
}

// Pokémon, non-English: TCGdex. One request returns the whole set's cards with
// localized names and art (pokemontcg.io has no non-English sets at all).
//
// TCGdex's coverage is uneven PER SET, in ways its own metadata hides, and a scan
// index needs card ART specifically. Three distinct dead ends, all of which used
// to surface as the same useless "no cards for set X":
//   1. the set does not exist in this language at all (codes differ by language)
//   2. the set is listed — even reporting a cardCount — but holds no card records
//      (Korean SV2a claims 165 cards and returns zero)
//   3. the cards exist but none carry an image (Korean SV4M has all 95 cards with
//      names and prices, and no art) — searchable, but impossible to scan
// Each says which one it is, because the user's next move differs every time.
async function fetchTcgdexSet(set, lang) {
  const tcgdexApi = require('./tcgdexApi');
  const code = languages.toCode(lang);
  const langName = languages.toName(code);
  let r;
  try {
    r = await tcgdexHttp.get(`https://api.tcgdex.net/v2/${code}/sets/${encodeURIComponent(set)}`);
  } catch (e) {
    if (e.response && e.response.status === 404) {
      throw absent(`TCGdex has no ${langName} set "${set}". Set codes differ by language — pick from the ${langName} set list.`);
    }
    throw e;
  }
  const setName = r.data.name || set;
  const all = r.data.cards || [];
  if (!all.length) {
    throw absent(`TCGdex lists "${setName}" (${set}) in ${langName} but has no cards for it yet, so there is nothing to index. Try another set or language.`);
  }
  if (!all.some(c => c.image)) {
    throw absent(`TCGdex has ${all.length} ${langName} cards for "${setName}" (${set}) but no card images, and scanning matches on the art. You can still search and add these cards by name; scanning this set needs another language.`);
  }
  const cards = [];
  for (const brief of all) {
    if (!brief.image) continue; // this card has no art yet; the rest of the set does
    cards.push({
      name: brief.name || '',
      set: r.data.id || set,
      number: brief.localId != null ? String(brief.localId) : '',
      // High res on purpose: the 245px art the card grids use is what milo would
      // otherwise be handed, and an upscaled blur embeds worse than the sharp 448
      // crop a camera produces. WebP: the same 600x825 image at about a quarter
      // of the PNG's bytes. See catalog.js embedUrl for the swap on the cached url.
      img: `${brief.image}/high.webp`,
      raw: { ...brief, set: { id: r.data.id || set, name: setName } },
      tcgdex: true,
    });
  }
  return cards;
}

// Pokémon: page pokemontcg.io by set id. Uses POKEMON_TCG_API_KEY if set.
async function fetchPokemonSet(set) {
  const key = process.env.POKEMON_TCG_API_KEY || '';
  const headers = key ? { 'X-Api-Key': key } : {};
  const cards = [];
  let page = 1, total = Infinity;
  while ((page - 1) * 250 < total) {
    // pokemontcg.io is slow/flaky under load — retry each page with backoff
    // (mirrors scripts/cardSources.js gatherPokemon).
    let data = null, count = 0;
    for (let attempt = 0; attempt < 5 && data === null; attempt++) {
      try {
        const r = await pokemonTcgHttp.get('https://api.pokemontcg.io/v2/cards', {
          params: { q: `set.id:${set}`, page, pageSize: 250, select: 'id,name,number,set,images,rarity,supertype,subtypes,types,tcgplayer,cardmarket' },
          headers,
        });
        count = r.data.totalCount || 0;
        data = r.data.data || [];
      } catch (e) {
        if (attempt === 4) throw e;
        console.warn(`cardSets: ${set} page ${page} attempt ${attempt + 1} failed (${e.message}); retrying...`);
        await sleep(2000 * Math.pow(2, attempt));
      }
    }
    total = count;
    if (data.length === 0) break;
    for (const c of data) {
      const img = c.images?.large || c.images?.small;
      if (img) cards.push({ name: c.name || '', set: c.set?.id || set, number: c.number || '', img, raw: c });
    }
    page++;
    await sleep(120);
  }
  return cards;
}

// Fetch a set from its provider and cache its cards. This was once half of a job
// that also built an ORB index for the set; the index half is gone and this half
// is what the catalog builder calls.
//
// card_cache was only ever a side effect of indexing, which is why Pokemon sits
// at ~35% of the real card pool: a set's cards arrive only if someone indexed,
// searched or browsed that set. Nothing ever walked the catalogue just to cache
// it. Returns the fetched cards so a caller can count them.
async function cacheSetCards(game, set, lang, { excludeChildCodes = [], codes = null } = {}) {
  const code = langOf(lang);
  if (!require('./utils/games').hasFeature(game, 'scan')) throw new Error(`no catalog source for game ${game}`);
  if (game === 'riftbound') {
    // Already in card_cache: the whole catalogue is cached in one fetch, which is
    // also what keeps collision ids stable (they depend on the whole set of
    // records sharing a code, never on one page of it).
    const cards = await require('./riftcodexApi').getCardsBySet(set);
    if (!cards.length) throw absent(`no cards for set ${set}`);
    return cards.map(c => ({ name: c.name, set: c.set_id, number: c.number, img: c.image_url, raw: c }));
  }
  // The TCGplayer-catalogue games: their whole catalogue is already in card_cache
  // (tcgcsvGameApi writes it from the TCGCSV sync), so a set is a read, not a fetch.
  if (games.get(game)?.provider === 'tcgcsv') {
    const cards = await require('./tcgcsvGameApi').getCardsBySet(game, set);
    if (!cards.length) throw absent(`no cards for set ${set}`);
    return cards.map(c => ({ name: c.name, set: c.set_id, number: c.number, img: c.image_url, raw: c }));
  }
  if (game === 'lorcana') {
    const lorcastApi = require('./lorcastApi');
    const cleanSet = String(set || '').replace(/^lorcana-/, '');
    const fetched = await lorcastApi.getCardsBySet(cleanSet, lang);
    if (!fetched.length) throw absent(`no cards for set ${set}`);
    return fetched.map(c => ({
      name: c.printed_name || c.name || '',
      set: c.set_id || set,
      number: c.number || '',
      img: c.image_url,
      raw: c,
    }));
  }
  // One decision, read once and reused by BOTH the fetch and the cache below.
  // They used to derive it separately and disagreed: the fetch asked the
  // provider, the cache asked the language.
  const provider = game === 'pokemon' ? await pokemonProvider.providerFor(code) : null;
  if (provider === pokemonProvider.POKEMONTCGAPI) {
    const cards = await require('./pokemontcgapi').getCardsBySet(set, code);
    if (!cards.length) throw absent(`no cards for set ${set}`);
    return cards.map(c => ({ name: c.printed_name || c.name, set: c.set_id, number: c.number, img: c.image_url, raw: c }));
  }
  const useTcgdex = provider === pokemonProvider.TCGDEX;
  const cards = game === 'mtg'
    ? await fetchMtgSet(set, code, { excludeChildCodes, codes })
    : (useTcgdex ? await fetchTcgdexSet(set, code) : await fetchPokemonSet(set));
  if (cards.length === 0) throw absent(`no cards for set ${set}`);
  await cacheFetchedCards(game, cards, code, useTcgdex);
  return cards;
}

// Cache full card data so the post-match /api/search is an instant local
// card_cache hit instead of a live (throttled) provider fetch per scan.
async function cacheFetchedCards(game, cards, code, useTcgdex) {
  try {
    if (game === 'mtg') {
      const scryfallApi = require('./scryfallApi');
      const seen = new Set();
      const rows = cards.filter(c => c.raw?.id && (seen.has(c.raw.id) ? false : seen.add(c.raw.id)));
      await scryfallApi.cacheCards(rows.map(c => scryfallApi.normalizeCard(c.raw, code)));
    } else if (!useTcgdex) {
      const tcgApi = require('./tcgApi');
      await tcgApi.cacheCards(cards.map(c => c.raw));
    } else {
        // Same `useTcgdex` the fetch used, so the rows are always normalized by
        // the provider that produced them. When this branched on the language
        // instead, TCGdex set briefs went through pokemontcg.io's normalizer,
        // which reads `c.images.large` and `c.number` — fields a TCGdex brief
        // does not have. Every row cached that way named the card correctly and
        // then had no image_url and no number, so a scan matched, added the card,
        // and displayed nothing. 21,828 rows before anyone saw a blank card.
        // TCGdex set briefs carry no rarity/types/prices, so these rows are thin
        // on purpose — enough for the scanner to name a card the instant it
        // matches, without 237 extra requests during a build. They are flagged
        // `incomplete` so they read as stale and get filled in when the card is
        // actually added (see the add route) or by the price sweep.
        const tcgdexApi = require('./tcgdexApi');
        await tcgdexApi.cacheCards(cards.map(c => tcgdexApi.normalizeCard(c.raw, code)), { incomplete: true });
      }
    } catch (e) { console.warn(`cardSets: caching cards failed: ${e.message}`); }
}

module.exports = {
  // Set discovery, and fetching a set's cards into card_cache.
  //
  // Everything ORB is gone: the per-set feature indexes, the whole-game rollups
  // built from them, and the matcher that read them. Scanning is CollectorVision
  // embeddings now. What survives is the half that was always independently
  // useful and only ever ran as a SIDE EFFECT of indexing — which is why the
  // Pokemon cache sat at ~35% of the real card pool. Filling card_cache is now a
  // job in its own right.
  listAllSets, cacheSetCards, getMtgChildSetMap, getScanExclusions,
  mtgFamilyCodes, mtgRoots, mtgRootIndex, getScryfallSets,
};
