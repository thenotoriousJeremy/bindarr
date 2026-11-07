// Every card in a set, from the provider that owns it, cached.
//
// The set-completion view (routes/setCompletion.js) needs a set's FULL card list,
// and card_cache cannot answer that on its own: a set's rows only arrive there as
// a side effect of somebody searching, scanning or building it, so "the rows we
// happen to hold" is a fraction of the set that looks like all of it. A listing
// is fetched from the provider once, its cards are cached through that provider's
// own normalizer, and the ids are recorded in set_listings with the time. The
// next view is a database read, not another walk of somebody else's API.
//
// One function per game in LISTERS. Each takes (setId, lang), fetches the set,
// caches its cards through the provider module and returns
// { ids, set, source } — `set` being whatever metadata the response carried, or
// null when the provider has no such set. That is the whole contract: a fourth
// game is one more entry, and nothing else here needs to know about it.
const db = require('./db');
const languages = require('./utils/languages');
const pokemonProvider = require('./utils/pokemonProvider');
const { matcher } = require('./utils/setCatalogueMatch');
const { parseSqliteUtc } = require('./utils/priceHelpers');

// Long enough that browsing a set costs one provider walk every few days, short
// enough that a set still being revealed picks up its new cards, and that the
// prices of cards nobody owns (which no sweep refreshes) do not drift for weeks.
// Three days is what every provider module already treats as fresh.
const LISTING_TTL_MS = 3 * 24 * 60 * 60 * 1000;
// "Refresh" is a button, so it is bounded: a listing younger than this is served
// as is, because asking again cannot return anything a provider changed since.
const REFRESH_MIN_AGE_MS = 10 * 60 * 1000;

const sqliteNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const ageMs = (row) => Date.now() - parseSqliteUtc(row.fetched_at).getTime();

// Which ids are already in card_cache, in chunks small enough for SQLite's
// bound-parameter limit.
async function cachedIds(ids) {
  const have = new Set();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = await db.all(`SELECT id FROM card_cache WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk);
    for (const r of rows) have.add(r.id);
  }
  return have;
}

// --- Magic: Scryfall -------------------------------------------------------------

const mtgCode = (setId) => String(setId || '').trim().toLowerCase().replace(/^mtg-/, '');

// Every printing in ONE set code, not the family cardSets.mtgSetFamilyQuery folds
// together for scanning: tokens, promos and art series are sets of their own
// (tfdn, pfdn, afdn), and they are completed — or not — on their own. English
// only: collector numbers are the same in every language, so the owned side
// matches a Japanese copy against the English listing by number.
async function listMtg(setId) {
  const scryfallApi = require('./scryfallApi');
  const code = mtgCode(setId);
  const q = `set:${code} unique:prints include:extras -is:digital`;
  let url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&order=set`;
  const cards = [];
  while (url) {
    let r;
    try {
      r = await scryfallApi.scryGetRetried(url);
    } catch (e) {
      // Scryfall answers an empty search with a 404, which for a set code means
      // there is no such (paper) set.
      if (e.response && e.response.status === 404 && !cards.length) return null;
      throw e;
    }
    for (const raw of (r.data && r.data.data) || []) cards.push(scryfallApi.normalizeCard(raw));
    const next = r.data && r.data.has_more ? String(r.data.next_page || '') : '';
    // Only ever follow Scryfall's own paging link back to Scryfall.
    url = next.startsWith('https://api.scryfall.com/') ? next : null;
  }
  if (!cards.length) return null;
  await scryfallApi.cacheCards(cards);
  return { ids: cards.map(c => c.id), set: { id: code, name: cards[0].set_name || code }, source: 'scryfall' };
}

// --- Pokémon: whichever provider serves the language ------------------------------

// Rows that already exist are left alone. A TCGdex set brief carries only a name,
// number and image, so caching it over a hydrated row would wipe that row's
// rarity and prices; a pokemontcg.io page would wipe the TCGplayer product id the
// TCGCSV map wrote. New rows are what the listing is for.
async function cacheNew(cards, write) {
  const have = await cachedIds(cards.map(c => c.id));
  const fresh = cards.filter(c => !have.has(c.id));
  if (fresh.length) await write(fresh);
}

async function listTcgdex(setId, code) {
  const tcgdexApi = require('./tcgdexApi');
  let data;
  try {
    ({ data } = await tcgdexApi.client.get(`/${code}/sets/${encodeURIComponent(setId)}`));
  } catch (e) {
    if (e.response && e.response.status === 404) return null;
    throw e;
  }
  const set = { id: (data && data.id) || setId, name: (data && data.name) || setId };
  const cards = ((data && data.cards) || []).map(brief => tcgdexApi.normalizeCard({ ...brief, set }, code));
  if (!cards.length) return null;
  // Briefs are thin, so they are cached the way cardSets caches them: stamped
  // stale, which makes the add route hydrate a card before it is kept.
  await cacheNew(cards, rows => tcgdexApi.cacheCards(rows, { incomplete: true }));
  const asset = (u) => (u ? (/\.(png|webp|jpg)$/i.test(u) ? u : `${u}.png`) : '');
  return {
    ids: cards.map(c => c.id),
    set: {
      ...set,
      release_date: String(data.releaseDate || '').replace(/-/g, '/'),
      logo_url: asset(data.logo),
      symbol_url: asset(data.symbol),
      printed_total: (data.cardCount && data.cardCount.official) || null,
      total: (data.cardCount && data.cardCount.total) || null,
    },
    source: pokemonProvider.TCGDEX,
  };
}

async function listPokemontcg(setId) {
  const tcgApi = require('./tcgApi');
  const raw = [];
  for (let page = 1; page <= 10; page++) {
    const r = await tcgApi.tcgClient.get('/cards', {
      params: { q: `set.id:${setId}`, page, pageSize: 250, orderBy: 'number' },
      timeout: 30000, // full-set pages are large; the client's 6s default is not enough
    });
    const data = (r.data && r.data.data) || [];
    raw.push(...data);
    if (data.length < 250 || raw.length >= ((r.data && r.data.totalCount) || 0)) break;
  }
  if (!raw.length) return null;
  await cacheNew(raw, rows => tcgApi.cacheCards(rows));
  const s = raw[0].set || {};
  return {
    ids: raw.map(c => c.id),
    set: {
      id: s.id || setId, name: s.name || setId,
      release_date: s.releaseDate || '',
      logo_url: (s.images && s.images.logo) || '',
      symbol_url: (s.images && s.images.symbol) || '',
      printed_total: s.printedTotal || null, total: s.total || null,
    },
    source: pokemonProvider.POKEMONTCG,
  };
}

async function listPokemontcgapi(setId, code) {
  const api = require('./pokemontcgapi');
  // Its own listing already caches without clobbering stored prices, and its
  // response cache keeps a repeat inside a day from spending credits.
  const cards = await api.getCardsBySet(setId, code);
  if (!cards.length) return null;
  return {
    ids: cards.map(c => c.id),
    set: { id: setId, name: cards[0].set_name || setId },
    source: pokemonProvider.POKEMONTCGAPI,
  };
}

// The provider's own id for a set the caller may have named in the other
// numbering: a dashboard link built from pokemontcg.io rows says sv1 and sv3pt5
// where TCGdex says sv01 and sv03.5. Same three-key join the scan catalogue uses;
// an unreachable set list keeps the id as given.
async function pokemonSetId(setId, code, provider, name) {
  try {
    let sets;
    if (provider === pokemonProvider.TCGDEX) sets = await require('./tcgdexApi').listSets(code);
    else if (provider === pokemonProvider.POKEMONTCGAPI) sets = await require('./pokemontcgapi').listSets(code);
    else sets = await db.all(`SELECT id, name FROM sets WHERE game = 'pokemon'`);
    const hit = matcher(sets)(setId, name);
    return hit ? hit.id : setId;
  } catch {
    return setId;
  }
}

// TCGplayer prices and product ids for a just-listed set, from the local TCGCSV
// mirror. Reads only what the daily sync already stored, so it costs no request;
// with no completed sync it simply does nothing. Returns the matched group's
// abbreviation, which is the set code TCGplayer's Mass Entry understands.
async function priceFromTcgcsv(setId, setName, language) {
  const tcgcsvApi = require('./tcgcsvApi');
  try {
    const groups = {};
    for (const category of Object.values(tcgcsvApi.CATEGORY)) groups[category] = await tcgcsvApi.getGroups(category);
    const match = tcgcsvApi.buildGroupMatcher(groups);
    const hit = match(setId, setName, language);
    if (!hit) return null;
    await tcgcsvApi.priceSet({ set_id: setId, set_name: setName, language }, match);
    return hit.group.abbreviation || null;
  } catch (e) {
    if (!tcgcsvApi.isCacheMissError(e)) console.warn(`Set listing: TCGCSV pricing for ${setId} failed: ${e.message}`);
    return null;
  }
}

async function listPokemon(setId, lang, { name } = {}) {
  const code = languages.toCode(lang);
  const provider = await pokemonProvider.providerFor(code);
  const id = await pokemonSetId(setId, code, provider, name);
  let listed;
  if (provider === pokemonProvider.POKEMONTCGAPI) listed = await listPokemontcgapi(id, code);
  else if (provider === pokemonProvider.TCGDEX) listed = await listTcgdex(id, code);
  else listed = await listPokemontcg(id);
  if (!listed) return null;
  // pokemontcgapi.com rows carry their own source-aware prices; TCGCSV leaves
  // them alone (see tcgcsvApi.setsToPrice), so there is nothing to add for them.
  if (provider !== pokemonProvider.POKEMONTCGAPI) {
    listed.set.tcgplayer_set_code = await priceFromTcgcsv(listed.set.id, listed.set.name, languages.toName(code));
  }
  return listed;
}

// --- Lorcana: Lorcast -------------------------------------------------------------

const lorcanaId = (setId) => `lorcana-${String(setId || '').trim().toLowerCase().replace(/^lorcana-/, '')}`;

// English only. Lorcast ids are the same card in every language, so a listing in
// another language would re-label shared rows rather than add new ones.
async function listLorcana(setId) {
  const lorcastApi = require('./lorcastApi');
  const id = lorcanaId(setId);
  // getCardsBySet answers a failed request with [] too, so an empty result reads
  // as "nothing to list" and the caller keeps any listing it already had.
  const cards = await lorcastApi.getCardsBySet(id.replace(/^lorcana-/, ''), 'English');
  if (!cards.length) return null;
  return { ids: cards.map(c => c.id), set: { id, name: cards[0].set_name || id }, source: 'lorcast' };
}

// --- Registry ---------------------------------------------------------------------

const LISTERS = {
  mtg: listMtg,
  pokemon: listPokemon,
  lorcana: listLorcana,
};

// The key a listing is stored under: the set id as card_cache spells it for that
// game, and the language it was listed in. Only Pokémon sets differ by language
// (Japan has sets the West never sees); the other games list in English.
function listingKey(game, setId, lang) {
  if (game === 'mtg') return { setId: mtgCode(setId), lang: 'en' };
  if (game === 'lorcana') return { setId: lorcanaId(setId), lang: 'en' };
  return { setId: String(setId || '').trim(), lang: languages.toCode(lang) };
}

// Which source a fresh listing would come from now. A listing from another source
// (the admin switched the Pokémon provider) is a different numbering of the set,
// so it is stale whatever its age.
async function currentSource(game, lang) {
  if (game === 'mtg') return 'scryfall';
  if (game === 'lorcana') return 'lorcast';
  if (game === 'pokemon') return pokemonProvider.providerFor(lang);
  return game;
}

const pending = new Map();

function fromRow(row, extra = {}) {
  let ids = [];
  let set = {};
  try { ids = JSON.parse(row.card_ids) || []; } catch { ids = []; }
  try { set = JSON.parse(row.meta || '{}') || {}; } catch { set = {}; }
  return { ids, set: { ...set, id: set.id || row.set_id }, source: row.source, fetched_at: row.fetched_at, ...extra };
}

// The listing for one set: { ids, set, source, fetched_at, stale? }, or null when
// the provider has no such set. `name` helps resolve a Pokémon set named in the
// other provider's numbering.
async function getListing(game, setId, lang, { refresh = false, name = null } = {}) {
  const lister = LISTERS[game];
  if (!lister) throw new Error(`No set listing for game ${game}`);
  const key = listingKey(game, setId, lang);
  const source = await currentSource(game, key.lang);
  const row = await db.get(
    `SELECT * FROM set_listings WHERE game = ? AND language = ? AND set_id = ?`,
    [game, key.lang, key.setId]
  );
  const sameSource = row && row.source === source;
  if (sameSource) {
    // Written as "not younger than" so an unreadable timestamp re-lists rather
    // than pinning the listing as fresh forever.
    const age = ageMs(row);
    const wanted = refresh ? !(age < REFRESH_MIN_AGE_MS) : !(age < LISTING_TTL_MS);
    if (!wanted) return fromRow(row);
  }

  const pendingKey = `${game}|${key.lang}|${key.setId}`;
  if (pending.has(pendingKey)) return pending.get(pendingKey);
  const work = (async () => {
    let listed;
    try {
      listed = await lister(key.setId, key.lang, { name });
    } catch (e) {
      // A provider outage must not take away a listing that already works.
      if (sameSource) {
        console.warn(`Set listing: ${game} ${key.setId} refresh failed (${e.message}); serving the cached listing.`);
        return fromRow(row, { stale: true });
      }
      throw e;
    }
    if (!listed || !listed.ids.length) return sameSource ? fromRow(row, { stale: true }) : null;
    const meta = JSON.stringify(listed.set || {});
    const fetchedAt = sqliteNow();
    await db.run(
      `INSERT INTO set_listings (game, language, set_id, source, card_ids, meta, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(game, language, set_id) DO UPDATE SET
         source = excluded.source, card_ids = excluded.card_ids, meta = excluded.meta, fetched_at = excluded.fetched_at`,
      [game, key.lang, key.setId, listed.source || source, JSON.stringify(listed.ids), meta, fetchedAt]
    );
    // A Pokémon set named in the other numbering is also stored under the
    // provider's own id, so a link from either spelling finds it next time.
    const ownId = listed.set && listed.set.id;
    if (ownId && ownId !== key.setId) {
      await db.run(
        `INSERT INTO set_listings (game, language, set_id, source, card_ids, meta, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(game, language, set_id) DO UPDATE SET
           source = excluded.source, card_ids = excluded.card_ids, meta = excluded.meta, fetched_at = excluded.fetched_at`,
        [game, key.lang, ownId, listed.source || source, JSON.stringify(listed.ids), meta, fetchedAt]
      );
    }
    return { ids: listed.ids, set: { ...listed.set, id: ownId || key.setId }, source: listed.source || source, fetched_at: fetchedAt };
  })();
  pending.set(pendingKey, work);
  try { return await work; } finally { pending.delete(pendingKey); }
}

const supports = (game) => Object.prototype.hasOwnProperty.call(LISTERS, game);

module.exports = { LISTERS, getListing, listingKey, supports, LISTING_TTL_MS, REFRESH_MIN_AGE_MS };
