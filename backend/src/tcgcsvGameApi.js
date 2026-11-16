// The games served entirely from TCGplayer's catalogue, through TCGCSV:
// Yu-Gi-Oh!, One Piece, Digimon, Flesh and Blood, Star Wars: Unlimited and the
// Gundam Card Game (`provider: "tcgcsv"` in shared/games.json).
//
// Why TCGplayer's catalogue rather than a community API per game: it is one
// source with one shape for every game, prices included, already mirrored for
// this project (tcgcsvApi, TCGCSV_BASE_URL), and its product ids are what the
// ready-made scan catalogs for these games are keyed by (utils/modelAssets). So a
// card's id here is `<game>-<TCGplayer product id>`, and a scan hit names a card
// directly — no mapping table, none of the misses the Pokémon product map has.
//
// Nothing here makes a request of its own. The game's TCGCSV category is synced
// by tcgcsvApi like every other (one bundle per kind from the mirror, see
// tcgcsvApi.syncFromBundles), and this module writes card_cache and the `sets`
// table from that cache:
//
//   · A game is ACTIVATED the first time anything on the install asks for it (a
//     search, a set list, a catalog build). Until then its category is not synced
//     at all, so an install that never opens Yu-Gi-Oh! pays nothing for it.
//   · After every TCGCSV version, a group's cards are rewritten only if its
//     products changed, and its prices only if its prices changed (hashes in
//     tcgcsv_catalogues). The daily cost is the price rows that moved.
//
// Ids: card `<game>-<productId>`; set `<game>-<code>`, where the code is
// TCGplayer's group abbreviation, or `g<groupId>` for a group with none (or one
// an older group already holds).
'use strict';

const crypto = require('crypto');
const db = require('./db');
const games = require('./utils/games');
const tcgcsv = require('./tcgcsvApi');
const { productImageUrl } = require('./utils/tcgcsvSlim');
const { cacheNormalizedCards } = require('./utils/cardCache');
const { parseCardRow, recordPrice, shouldSweepPrices, markPricesSwept } = require('./utils/priceHelpers');
const { parseSetList, setSqlFilter } = require('./utils/setQuery');
const cardSearchSql = require('./utils/cardSearchSql');

const isTcgcsvGame = (game) => games.get(game)?.provider === 'tcgcsv';
const tcgcsvGames = () => games.GAMES.filter(g => g.provider === 'tcgcsv').map(g => g.value);
const categoryOf = (game) => (games.get(game)?.tcgplayerCategories || [])[0] || null;
const cardIdFor = (game, productId) => `${game}-${productId}`;
const productIdOf = (id) => {
  const m = /-(\d+)$/.exec(String(id || ''));
  return m ? Number(m[1]) : null;
};

// --- shapes ------------------------------------------------------------------

// A stable short code per group. TCGplayer's abbreviation when it is one, else
// g<groupId>. Assigned oldest group first, so a later group reusing an
// abbreviation (promo groups do) never takes it from the set that had it.
function setCodes(groups) {
  const taken = new Set();
  const out = new Map();
  for (const g of [...groups].sort((a, b) => a.groupId - b.groupId)) {
    const abbr = String(g.abbreviation || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (abbr && !taken.has(abbr) && !/^g\d+$/.test(abbr)) {
      taken.add(abbr);
      out.set(g.groupId, abbr);
    } else {
      out.set(g.groupId, `g${g.groupId}`);
    }
  }
  return out;
}

// TCGplayer writes '004/165' and 'LOB-EN001'; the app shows the number before
// any slash, leading zeros off a plain number.
function displayNumber(raw) {
  const head = String(raw == null ? '' : raw).split('/')[0].trim();
  return /^\d+$/.test(head) ? head.replace(/^0+(?=\d)/, '') : head;
}

// TCGplayer's finish names per game, folded onto the three price columns the app
// reads: Normal/Unlimited/Limited -> normal, 1st Edition -> first edition (only
// Yu-Gi-Oh! prints one), any foil (Foil, Holofoil, Rainbow Foil, Cold Foil) ->
// holofoil, which every two-finish game labels "Foil".
function finishOf(subTypeName) {
  const s = String(subTypeName || '').toLowerCase();
  if (s.includes('1st edition')) return 'first';
  if (s.includes('foil')) return 'foil';
  return 'normal';
}
const priceOf = (row) => (row.marketPrice > 0 ? row.marketPrice : (row.midPrice > 0 ? row.midPrice : null));

function quotesByProduct(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const price = priceOf(r);
    if (price == null) continue;
    const id = Number(r.productId);
    if (!Number.isFinite(id)) continue;
    const q = out.get(id) || { normal: null, foil: null, first: null };
    const f = finishOf(r.subTypeName);
    // The first quote of a finish wins: TCGCSV lists the plain printing first.
    if (q[f] == null) q[f] = price;
    out.set(id, q);
  }
  return out;
}

const priceColumns = (q) => ({
  price_normal: q ? q.normal : null,
  price_holofoil: q ? q.foil : null,
  price_1st_edition: q ? q.first : null,
  // The headline price: the plain printing, else whatever the card is sold as.
  price_trend: q ? (q.normal ?? q.first ?? q.foil ?? null) : null,
});

// extendedData field names differ per game; these are the ones that say what a
// card IS, matched with case and punctuation ignored.
const pick = (ext, names) => {
  for (const [k, v] of Object.entries(ext || {})) {
    if (names.includes(k.toLowerCase().replace(/[^a-z]/g, ''))) return v;
  }
  return null;
};
const words = (v) => (v ? String(v).split(/\s*[;,/|]\s*/).map(s => s.trim()).filter(Boolean) : []);

// `opts.idFor` and `opts.language` let the Pokémon fallback (pokemonTcgplayer.js)
// share this: its ids are tcgplayer-<productId> and its Japanese cards are Japanese.
function normalizeProduct(game, product, setId, setName, opts = {}) {
  const ext = product.ext || {};
  const image = 'imageUrl' in product ? product.imageUrl : productImageUrl(product.productId);
  return {
    id: (opts.idFor || ((pid) => cardIdFor(game, pid)))(product.productId),
    name: product.name || '',
    supertype: pick(ext, ['cardtype', 'type', 'cardcategory', 'category']) || '',
    subtypes: words(pick(ext, ['subtypes', 'subtype', 'monstertype', 'traits', 'trait', 'talent', 'digitype', 'tag', 'tags', 'form'])),
    types: words(pick(ext, ['color', 'colors', 'colour', 'attribute', 'aspect', 'aspects', 'class', 'element', 'domain'])),
    rarity: product.rarity || '',
    set_id: setId,
    set_name: setName,
    number: displayNumber(product.number),
    image_url: image || '',
    tcgplayer_product_id: product.productId,
    tcgplayer_url: `https://www.tcgplayer.com/product/${product.productId}`,
    attributes: Object.keys(ext).length ? ext : null,
    language: opts.language || 'English',
    price_source: 'tcgcsv',
    price_currency: 'USD',
  };
}

const hashOf = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);

// One group's prices onto its card rows, 50 rows a statement: one UPDATE with a
// CASE per column. Not UPDATE ... FROM, which the SQLite in older Android plugins
// lacks, and not an upsert, which could create a row — card_cache rows are
// created only by cacheNormalizedCards (test/invariants.test.js). Tens of
// thousands of single-row UPDATEs a day would be a bridge call each on a phone.
// 50 rows keeps a statement at 450 parameters, under the 999 older SQLite allows.
const PRICE_CHUNK = 50;
const PRICE_FIELDS = ['price_trend', 'price_normal', 'price_holofoil', 'price_1st_edition'];
async function writePrices(game, products, quotes, idFor = (pid) => cardIdFor(game, pid)) {
  for (let i = 0; i < products.length; i += PRICE_CHUNK) {
    const chunk = products.slice(i, i + PRICE_CHUNK).map(p => ({
      id: idFor(p.productId), cols: priceColumns(quotes.get(p.productId)),
    }));
    const params = [];
    const sets = PRICE_FIELDS.map((field) => {
      const whens = chunk.map(({ id, cols }) => { params.push(id, cols[field]); return 'WHEN ? THEN ?'; }).join(' ');
      return `${field} = CASE id ${whens} ELSE ${field} END`;
    });
    params.push(...chunk.map(c => c.id));
    await db.run(
      `UPDATE card_cache SET ${sets.join(', ')}, price_source = 'tcgcsv', price_currency = 'USD'
        WHERE id IN (${chunk.map(() => '?').join(', ')})`,
      params
    );
  }
}

// --- the catalogue -----------------------------------------------------------

async function readState(game) {
  const row = await db.get(`SELECT * FROM tcgcsv_catalogues WHERE game = ?`, [game]);
  if (!row) return null;
  const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
  return { ...row, product_hashes: parse(row.product_hashes), price_hashes: parse(row.price_hashes) };
}

async function activated() {
  const rows = await db.all(`SELECT game FROM tcgcsv_catalogues`).catch(() => []);
  return rows.map(r => r.game).filter(isTcgcsvGame);
}

// Write card_cache and `sets` for one game from the TCGCSV cache, touching only
// the groups whose products or prices changed since the last write. Returns
// { version, cards, prices } — or { missing: true } when the category is not in
// the cache yet. `force` rewrites every group.
async function refreshCatalogue(game, { force = false } = {}) {
  const category = categoryOf(game);
  const version = await tcgcsv.currentVersion();
  if (!category || !version) return { version: null, missing: true, cards: 0, prices: 0 };
  const state = await readState(game);
  if (!force && state && state.catalogue_version === version) return { version, cards: 0, prices: 0, unchanged: true };

  let groups;
  try {
    groups = await tcgcsv.getGroups(category);
  } catch (e) {
    if (tcgcsv.isCacheMissError(e)) return { version, missing: true, cards: 0, prices: 0 };
    throw e;
  }
  const codes = setCodes(groups);
  const label = games.get(game).label;
  const productHashes = force || !state ? {} : { ...state.product_hashes };
  const priceHashes = force || !state ? {} : { ...state.price_hashes };
  let cards = 0, priced = 0;

  for (const g of groups) {
    let products, prices;
    try {
      products = await tcgcsv.getProducts(category, g.groupId);
      prices = await tcgcsv.getPrices(category, g.groupId);
    } catch (e) {
      if (tcgcsv.isCacheMissError(e)) continue;   // a group the cache does not hold: next version
      throw e;
    }
    const setId = `${game}-${codes.get(g.groupId)}`;
    const productHash = hashOf([products, g.name, codes.get(g.groupId)]);
    const priceHash = hashOf(prices);
    const productsChanged = productHashes[g.groupId] !== productHash;
    const pricesChanged = priceHashes[g.groupId] !== priceHash;
    if (!productsChanged && !pricesChanged) continue;

    const quotes = quotesByProduct(prices);
    await db.withTransaction(async () => {
      await db.run(
        `INSERT OR REPLACE INTO sets (id, name, series, printed_total, total, release_date, ptcgo_code, symbol_url, logo_url, game)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?)`,
        // ptcgo_code is the set's code everywhere a set is picked (the catalog
        // build picker sends it), so it must be the assigned code, never a shared
        // abbreviation another group owns.
        [setId, g.name || setId, label, products.length, products.length,
          String(g.publishedOn || '').slice(0, 10), codes.get(g.groupId).toUpperCase(), game]
      );
      if (productsChanged) {
        // Card rows carry this version's prices too, so a group is one pass.
        const rows = products.map(p => ({ ...normalizeProduct(game, p, setId, g.name || ''), ...priceColumns(quotes.get(p.productId)) }));
        await cacheNormalizedCards(rows, game);
        cards += rows.length;
      }
      // price_1st_edition is not one of the shared writer's columns (only TCGCSV
      // ever fills it), and a price-only change needs no card rewrite.
      await writePrices(game, products, quotes);
      priced += products.length;
    });
    productHashes[g.groupId] = productHash;
    priceHashes[g.groupId] = priceHash;
  }

  await db.run(
    `INSERT INTO tcgcsv_catalogues (game, catalogue_version, product_hashes, price_hashes) VALUES (?, ?, ?, ?)
     ON CONFLICT(game) DO UPDATE SET catalogue_version = excluded.catalogue_version,
       product_hashes = excluded.product_hashes, price_hashes = excluded.price_hashes`,
    [game, version, JSON.stringify(productHashes), JSON.stringify(priceHashes)]
  );
  if (cards || priced) {
    try { await require('./utils/compartmentSort').loadSetsCache(db); } catch { /* the weekly refresh reloads it */ }
    console.log(`${games.get(game).short}: ${cards} cards written, ${priced} prices refreshed from TCGCSV ${version}.`);
  }
  return { version, cards, prices: priced };
}

// The catalogue, present and current, before anything reads it. The first call
// for a game activates it, which brings its TCGCSV category into the sync and
// fetches it (from the mirror's bundles: a few requests). Concurrent callers share
// one run.
//
// The sync is replaceable: on a phone (embedded/index.js) the TCGCSV switch is off
// between its weekly syncs, so the plain one would do nothing and a game switched
// on would stay empty for up to a week.
//
// Riftbound's TCGplayer fallback (riftboundTcgplayer.js) fills its category in
// through the same one, for the same reason.
let firstUseSync = (context) => tcgcsv.syncIfUpdatedSafely(context);
const setFirstUseSync = (fn) => { firstUseSync = fn; };
const runFirstUseSync = (context) => firstUseSync(context);
const inflight = new Map();
function ensureCatalogue(game) {
  if (!isTcgcsvGame(game)) return Promise.resolve(null);
  if (inflight.has(game)) return inflight.get(game);
  const run = (async () => {
    await db.run(`INSERT OR IGNORE INTO tcgcsv_catalogues (game) VALUES (?)`, [game]);
    let result = await refreshCatalogue(game);
    if (result.missing) {
      await firstUseSync(`first use of ${games.get(game).short}`);
      result = await refreshCatalogue(game);
    }
    return result;
  })().finally(() => inflight.delete(game));
  inflight.set(game, run);
  return run;
}

// --- reading -----------------------------------------------------------------

function filterClauses(filters = {}) {
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const parts = [];
  const rarity = one(filters.rarity);
  const type = one(filters.type || filters.supertype);
  const color = one(filters.color || filters.colour || filters.domain);
  if (rarity) parts.push({ clause: `cc.rarity = ? COLLATE NOCASE`, params: [String(rarity)] });
  if (type) parts.push({ clause: `cc.supertype = ? COLLATE NOCASE`, params: [String(type)] });
  if (color) parts.push({ clause: `cc.types LIKE ?`, params: [`%${JSON.stringify(String(color))}%`] });
  return parts;
}

// Set tokens as typed ('LOB', 'lob') or as stored ('yugioh-lob').
const setTokens = (game, list) => list.flatMap(t => {
  const s = String(t).trim();
  return /^[a-z0-9]{1,12}$/i.test(s) ? [s, `${game}-${s.toLowerCase()}`] : [s];
});

async function searchCards(game, {
  name = '', number = '', set = '', scope = 'database', userId = null, page = 1, limit = 60, filters = {},
} = {}) {
  const offset = (Math.max(1, page) - 1) * limit;
  const cleanName = String(name || '').trim();
  const cleanNumber = String(number || '').trim().replace(/^#/, '');
  const setList = parseSetList(set);

  if (scope === 'collection') {
    if (!userId) return { cards: [], total: 0 };
    const { sql, params } = cardSearchSql.collectionQuery(game, {
      userId, name: cleanName, number: cleanNumber, setList: setTokens(game, setList), limit, offset,
    });
    return { cards: (await db.all(sql, params)).map(parseCardRow), total: null };
  }

  await ensureCatalogue(game).catch(e => console.warn(`${game}: catalogue unavailable: ${e.message}`));
  const where = ['cc.game = ?'];
  const params = [game];
  const parts = [
    cardSearchSql.nameClause('cc.', cleanName),
    cardSearchSql.numberClause('cc.number', cleanNumber),
    setList.length ? setSqlFilter(setTokens(game, setList), 'cc') : null,
    ...filterClauses(filters),
  ];
  for (const part of parts) {
    if (!part) continue;
    where.push(part.clause);
    params.push(...part.params);
  }
  const from = `FROM card_cache cc LEFT JOIN sets s ON s.id = cc.set_id WHERE ${where.join(' AND ')}`;
  const total = (await db.get(`SELECT COUNT(*) AS n ${from}`, params)).n;
  const rows = await db.all(
    `SELECT cc.* ${from}
      ORDER BY COALESCE(s.release_date, '') DESC, cc.set_id, CAST(cc.number AS INTEGER), cc.number
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { cards: rows.map(parseCardRow), total };
}

async function getCardById(id) {
  const game = games.gameOfId(id);
  if (!isTcgcsvGame(game) || productIdOf(id) == null) return null;
  const read = async () => {
    const row = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [id]);
    return row ? parseCardRow(row) : null;
  };
  const cached = await read();
  if (cached) return cached;
  // Not cached: the catalogue may not exist yet on this install, or the card is
  // newer than the last write. Either way ensureCatalogue settles it.
  await ensureCatalogue(game).catch(() => null);
  return read();
}

// Set codes in release order, for the catalog builder's walk.
async function listSetCodes(game) {
  await ensureCatalogue(game);
  const rows = await db.all(`SELECT id FROM sets WHERE game = ? ORDER BY release_date ASC`, [game]);
  return rows.map(r => String(r.id).slice(game.length + 1).toLowerCase());
}

// One set's cached cards, for the catalog builder.
async function getCardsBySet(game, setCode) {
  await ensureCatalogue(game);
  const sid = `${game}-${String(setCode || '').toLowerCase().replace(new RegExp(`^${game}-`), '')}`;
  const rows = await db.all(
    `SELECT * FROM card_cache WHERE game = ? AND LOWER(set_id) = ? ORDER BY CAST(number AS INTEGER), number`,
    [game, sid]
  );
  return rows.map(parseCardRow);
}

// The weekly set refresh: only for a game someone uses.
async function fetchAndCacheSets(game, force = false) {
  const state = await readState(game);
  if (!state) return;
  await refreshCatalogue(game, { force: false }).catch(e => console.warn(`${game}: set refresh failed: ${e.message}`));
  void force;
}

// The image the scanner matches against: TCGplayer's 200px thumbnail is a blur at
// milo's 448, `_in_600x600` (~430x600, ~45 KB) is not, and `_in_1000x1000` would
// be twice the bytes for nothing the model can use.
function embedImageUrl(url) {
  return String(url || '').replace(/_200w\.jpg$/, '_in_600x600.jpg');
}

// The daily price sweep for every activated game: bring the TCGCSV cache up to
// date (one bundle request per kind that changed), rewrite what moved, and record
// a history point for each owned or decked card.
async function updateCollectionPrices(force = false) {
  const active = await activated();
  // The Pokémon cards TCGdex lacks (pokemonTcgplayer.js) are TCGplayer catalogue
  // rows too, kept current by the same daily pass.
  const pokemonFallback = require('./pokemonTcgplayer');
  const fallbackLangs = await pokemonFallback.activeLanguages();
  if (!active.length && !fallbackLangs.length) return { priced: 0, skipped: 'no game activated' };
  if (!force && !(await shouldSweepPrices('tcgcsvgames'))) return { priced: 0, skipped: 'not due' };
  await tcgcsv.syncIfUpdatedSafely('TCGplayer-catalogue game prices');
  let priced = 0;
  if (fallbackLangs.length) {
    try {
      priced += (await pokemonFallback.refresh()).cards || 0;
      const owned = await db.all(
        `SELECT DISTINCT cc.id, cc.price_trend FROM card_cache cc
          WHERE cc.id LIKE 'tcgplayer-%' AND cc.price_trend > 0
            AND cc.id IN (SELECT card_id FROM collection UNION SELECT card_id FROM deck_cards)`
      );
      for (const c of owned) await recordPrice(c.id, c.price_trend);
    } catch (e) {
      console.warn(`Pokémon TCGplayer-only price refresh failed: ${e.message}`);
    }
  }
  for (const game of active) {
    try {
      const r = await refreshCatalogue(game);
      priced += r.prices || 0;
      const owned = await db.all(
        `SELECT DISTINCT cc.id, cc.price_trend FROM card_cache cc
          WHERE cc.game = ? AND cc.price_trend > 0
            AND cc.id IN (SELECT card_id FROM collection UNION SELECT card_id FROM deck_cards)`,
        [game]
      );
      for (const c of owned) await recordPrice(c.id, c.price_trend);
    } catch (e) {
      console.warn(`${game}: price refresh failed: ${e.message}`);
      require('./notify').emit({ type: 'price_sweep_failed', source: game, error: e.message });
    }
  }
  await markPricesSwept('tcgcsvgames');
  return { priced };
}

// What utils/cardApi.PROVIDERS hands out per game: the provider surface every
// other game's module has, bound to one game.
const bound = new Map();
function forGame(game) {
  if (!isTcgcsvGame(game)) return null;
  if (!bound.has(game)) {
    bound.set(game, {
      game,
      searchCards: (opts) => searchCards(game, opts),
      getCardById,
      getCardsBySet: (set) => getCardsBySet(game, set),
      getSetCards: (set) => getCardsBySet(game, set),
      listSetCodes: () => listSetCodes(game),
      fetchAndCacheSets: (force) => fetchAndCacheSets(game, force),
      ensureCatalogue: () => ensureCatalogue(game),
      embedImageUrl,
    });
  }
  return bound.get(game);
}

module.exports = {
  setFirstUseSync, runFirstUseSync,
  forGame, isTcgcsvGame, tcgcsvGames, categoryOf, activated, cardIdFor, productIdOf,
  setCodes, displayNumber, quotesByProduct, finishOf, normalizeProduct, priceColumns, writePrices, hashOf,
  refreshCatalogue, ensureCatalogue, searchCards, getCardById, listSetCodes, getCardsBySet,
  fetchAndCacheSets, embedImageUrl, updateCollectionPrices,
};
