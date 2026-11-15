// The Pokémon cards TCGdex does not have, served from TCGplayer's catalogue.
//
// TCGdex stays the Pokémon source: it carries every language, and every
// collection is keyed by its ids. But measured on 2026-11-15 it serves cards for
// 28 of the 204 Japanese sets it lists (3,297 cards, where TCGplayer lists 27,995),
// none of 39 English groups TCGplayer sells (World Championship decks, Prize Pack,
// League, Battle Academy, Base Set Shadowless, trainer kits, jumbo cards: 5,963
// cards), and no art at all for some sets it does serve (Shining Legends, both Shiny
// Vaults, the Mega Evolution promos). So:
//
//   · a TCGplayer group no TCGdex set with cards covers is served from TCGplayer:
//     cards `tcgplayer-<productId>`, sets `tcgp-<lang>-<code>`, TCGplayer prices;
//   · a TCGdex card with no art borrows the TCGplayer product's image.
//
// Which groups are covered is decided ONCE A WEEK by the scan-catalogs workflow,
// which walks every TCGdex set anyway, and published beside the catalogs as
// pokemon-tcgplayer.<lang>.json (computeCoverage). An install downloads that small
// file instead of walking TCGdex itself, and writes the rows from the TCGCSV cache
// it already keeps for Pokémon prices. Nothing here asks a provider for anything.
//
// Only on installs where TCGdex is the Pokémon provider for the language: the
// coverage is measured against TCGdex, and an install pinned to pokemontcg.io or
// on pokemontcgapi.com numbers its cards differently.
'use strict';

const db = require('./db');
const languages = require('./utils/languages');
const tcgcsv = require('./tcgcsvApi');
const pokemonProvider = require('./utils/pokemonProvider');
const tcgcsvGames = require('./tcgcsvGameApi');
const releaseAssets = require('./utils/releaseAssets');
const { cacheNormalizedCards } = require('./utils/cardCache');
const { parseCardRow } = require('./utils/priceHelpers');

const PREFIX = 'tcgplayer-';
const isFallbackId = (id) => String(id || '').startsWith(PREFIX);
const idFor = (productId) => `${PREFIX}${productId}`;
const productIdOf = (id) => {
  const m = /^tcgplayer-(\d+)$/.exec(String(id || ''));
  return m ? Number(m[1]) : null;
};

// TCGplayer sells two Pokémon catalogues: the Western releases (category 3) and the
// Japanese ones (85). Other languages have no TCGplayer catalogue at all.
const LANGS = {
  English: { code: 'en', categoryId: tcgcsv.CATEGORY.english },
  Japanese: { code: 'ja', categoryId: tcgcsv.CATEGORY.japanese },
};
const langMeta = (lang) => {
  const name = languages.toName(lang);
  return LANGS[name] ? { name, ...LANGS[name] } : null;
};
const setIdFor = (code, setCode) => `tcgp-${code}-${setCode}`;
const coverageAsset = (code) => `pokemon-tcgplayer.${code}.json`;
const stateKey = (code) => `pokemon-fallback-${code}`;

// TCGplayer's Pokémon finishes onto the app's price columns.
function finishOf(subTypeName) {
  const s = String(subTypeName || '').toLowerCase();
  if (s.includes('1st edition')) return 'first';
  if (s.includes('reverse')) return 'reverse';
  if (s.includes('holo')) return 'holo';
  return 'normal';
}
function quotesByProduct(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const price = r.marketPrice > 0 ? r.marketPrice : (r.midPrice > 0 ? r.midPrice : null);
    if (price == null) continue;
    const q = out.get(r.productId) || { normal: null, holo: null, reverse: null, first: null };
    const f = finishOf(r.subTypeName);
    if (q[f] == null) q[f] = price;
    out.set(r.productId, q);
  }
  return out;
}
const priceColumns = (q) => ({
  price_normal: q ? q.normal : null,
  price_holofoil: q ? q.holo : null,
  price_reverse_holofoil: q ? q.reverse : null,
  price_trend: q ? (q.normal ?? q.holo ?? q.reverse ?? q.first ?? null) : null,
});

// --- coverage: built by the scan-catalogs workflow -------------------------------

// After a full TCGdex walk of `lang` (catalog cachePhase), with the TCGCSV cache
// synced: which TCGplayer groups TCGdex covers, which it does not, and which TCGdex
// cards have no art that TCGplayer has.
async function computeCoverage(lang) {
  const meta = langMeta(lang);
  if (!meta) return null;
  const tcgdexApi = require('./tcgdexApi');
  const groups = await tcgcsv.getGroups(meta.categoryId);
  const sets = await tcgdexApi.listSets(meta.code);
  const served = new Set((await db.all(
    `SELECT DISTINCT LOWER(set_id) AS sid FROM card_cache WHERE id LIKE ?`, [`tcgdex-${meta.code}-%`]
  )).map(r => r.sid));
  const match = tcgcsv.buildGroupMatcher({ [meta.categoryId]: groups });
  const covered = new Map();   // groupId -> TCGdex set id
  for (const s of sets) {
    if (!served.has(String(s.id).toLowerCase())) continue;
    const hit = match(s.id, s.name, meta.name);
    if (hit && hit.categoryId === meta.categoryId && !covered.has(hit.group.groupId)) covered.set(hit.group.groupId, s.id);
  }
  const fallbackGroups = [];
  const artFill = {};
  for (const g of groups) {
    let products;
    try { products = await tcgcsv.getProducts(meta.categoryId, g.groupId); } catch { continue; }
    const cards = products.filter(p => p.number);
    if (!cards.length) continue;
    const setId = covered.get(g.groupId);
    if (!setId) { fallbackGroups.push(g.groupId); continue; }
    const bare = await db.all(
      `SELECT id, number FROM card_cache WHERE id LIKE ? AND LOWER(set_id) = ? AND (image_url IS NULL OR image_url = '')`,
      [`tcgdex-${meta.code}-%`, String(setId).toLowerCase()]
    );
    if (!bare.length) continue;
    const byNumber = new Map();
    for (const p of cards) {
      const k = tcgcsv.normNumber(p.number);
      if (!byNumber.has(k)) byNumber.set(k, p);
    }
    for (const card of bare) {
      const p = byNumber.get(tcgcsv.normNumber(card.number));
      if (p && p.imageUrl !== null) artFill[card.id] = p.productId;
    }
  }
  return {
    format: 1, language: meta.name, categoryId: meta.categoryId, generatedAt: new Date().toISOString(),
    fallbackGroups: fallbackGroups.sort((a, b) => a - b), artFill,
  };
}

// --- on an install ---------------------------------------------------------------

const COVERAGE_TTL_MS = 24 * 60 * 60 * 1000;
const coverageCache = new Map();   // code -> { at, coverage }

// The published coverage for a language, at most a day old; the last good copy is
// kept in the database so a restart or an offline day does not lose it.
async function loadCoverage(meta) {
  const hit = coverageCache.get(meta.code);
  if (hit && Date.now() - hit.at < COVERAGE_TTL_MS) return hit.coverage;
  let coverage = null;
  try {
    coverage = await releaseAssets.fetchJson(coverageAsset(meta.code));
  } catch (e) {
    console.warn(`Pokémon TCGplayer coverage (${meta.code}) unavailable: ${e.message}`);
  }
  const key = `${stateKey(meta.code)}-coverage`;
  if (coverage && coverage.format === 1 && Array.isArray(coverage.fallbackGroups)) {
    await db.run(
      `INSERT INTO tcgcsv_catalogues (game, product_hashes) VALUES (?, ?)
       ON CONFLICT(game) DO UPDATE SET product_hashes = excluded.product_hashes`,
      [key, JSON.stringify(coverage)]
    );
  } else {
    const row = await db.get(`SELECT product_hashes FROM tcgcsv_catalogues WHERE game = ?`, [key]).catch(() => null);
    try { coverage = row ? JSON.parse(row.product_hashes) : null; } catch { coverage = null; }
    if (!coverage || !Array.isArray(coverage.fallbackGroups)) coverage = null;
  }
  coverageCache.set(meta.code, { at: Date.now(), coverage });
  return coverage;
}

// Write the fallback cards and the borrowed art for one language from the TCGCSV
// cache. Only the groups whose products or prices changed are rewritten.
async function materialize(lang, coverage, { force = false } = {}) {
  const meta = langMeta(lang);
  if (!meta || !coverage) return { skipped: true };
  const version = await tcgcsv.currentVersion();
  if (!version) return { missing: true };
  const coverageHash = tcgcsvGames.hashOf([coverage.fallbackGroups, coverage.artFill]);
  const stamp = `${version}|${coverageHash}`;
  const state = await db.get(`SELECT * FROM tcgcsv_catalogues WHERE game = ?`, [stateKey(meta.code)]);
  if (!force && state && state.catalogue_version === stamp) return { unchanged: true };

  let groups;
  try {
    groups = await tcgcsv.getGroups(meta.categoryId);
  } catch (e) {
    if (tcgcsv.isCacheMissError(e)) return { missing: true };
    throw e;
  }
  const wanted = new Set(coverage.fallbackGroups);
  const fallback = groups.filter(g => wanted.has(g.groupId));
  const codes = tcgcsvGames.setCodes(fallback);
  const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
  const hashes = force || !state ? {} : parse(state.price_hashes);
  let cards = 0;

  for (const g of fallback) {
    let products, prices;
    try {
      products = (await tcgcsv.getProducts(meta.categoryId, g.groupId)).filter(p => p.number);
      prices = await tcgcsv.getPrices(meta.categoryId, g.groupId);
    } catch (e) {
      if (tcgcsv.isCacheMissError(e)) continue;
      throw e;
    }
    const setId = setIdFor(meta.code, codes.get(g.groupId));
    const hash = tcgcsvGames.hashOf([products, prices, g.name, setId]);
    if (hashes[g.groupId] === hash) continue;
    const quotes = quotesByProduct(prices);
    const rows = products.map(p => ({
      ...tcgcsvGames.normalizeProduct('pokemon', p, setId, g.name || '', { idFor, language: meta.name }),
      ...priceColumns(quotes.get(p.productId)),
    }));
    await db.withTransaction(async () => {
      // English sets live in the `sets` table with TCGdex's; other languages'
      // set lists come from the provider plus fallbackSets() below.
      if (meta.name === 'English') {
        await db.run(
          `INSERT OR REPLACE INTO sets (id, name, series, printed_total, total, release_date, ptcgo_code, symbol_url, logo_url, game)
           VALUES (?, ?, 'TCGplayer', ?, ?, ?, ?, '', '', 'pokemon')`,
          [setId, g.name || setId, rows.length, rows.length, String(g.publishedOn || '').slice(0, 10), codes.get(g.groupId).toUpperCase()]
        );
      }
      await cacheNormalizedCards(rows, 'pokemon');
      // 1st Edition has a column of its own that the shared writer does not carry.
      for (const p of products) {
        const q = quotes.get(p.productId);
        if (q && q.first != null) {
          await db.run(`UPDATE card_cache SET price_1st_edition = ? WHERE id = ?`, [q.first, idFor(p.productId)]);
        }
      }
    });
    hashes[g.groupId] = hash;
    cards += rows.length;
  }

  // Art for TCGdex cards that have none: the TCGplayer product's image. Never
  // replaces art TCGdex does have.
  let art = 0;
  for (const [tcgdexId, productId] of Object.entries(coverage.artFill || {})) {
    const r = await db.run(
      `UPDATE card_cache SET image_url = ? WHERE id = ? AND (image_url IS NULL OR image_url = '')`,
      [require('./utils/tcgcsvSlim').productImageUrl(productId), tcgdexId]
    );
    art += (r && r.changes) || 0;
  }

  await db.run(
    `INSERT INTO tcgcsv_catalogues (game, catalogue_version, price_hashes) VALUES (?, ?, ?)
     ON CONFLICT(game) DO UPDATE SET catalogue_version = excluded.catalogue_version, price_hashes = excluded.price_hashes`,
    [stateKey(meta.code), stamp, JSON.stringify(hashes)]
  );
  if (cards || art) console.log(`Pokémon (${meta.name}): ${cards} TCGplayer-only cards written, ${art} TCGdex cards given TCGplayer art.`);
  return { cards, art };
}

// Called before a Pokémon search or lookup reads the cache. Cheap once current: one
// in-memory check. The first call for a language downloads the coverage and, if the
// TCGCSV cache lacks Pokémon, syncs it (from the mirror's bundles: a few requests).
const inflight = new Map();
const ready = new Map();   // code -> time of the last completed check
const RECHECK_MS = 60 * 60 * 1000;
function ensure(lang) {
  const meta = langMeta(lang);
  if (!meta) return Promise.resolve(null);
  const at = ready.get(meta.code);
  if (at && Date.now() - at < RECHECK_MS) return Promise.resolve(null);
  if (inflight.has(meta.code)) return inflight.get(meta.code);
  const run = (async () => {
    if (await pokemonProvider.providerFor(meta.code) !== pokemonProvider.TCGDEX) return null;
    const coverage = await loadCoverage(meta);
    if (!coverage) return null;
    let result = await materialize(meta.name, coverage);
    if (result.missing) {
      await tcgcsv.syncIfUpdatedSafely(`TCGplayer-only Pokémon cards (${meta.name})`, { explicit: true });
      result = await materialize(meta.name, coverage);
    }
    ready.set(meta.code, Date.now());
    return result;
  })().catch((e) => {
    console.warn(`Pokémon TCGplayer fallback (${meta.code}) failed: ${e.message}`);
    return null;
  }).finally(() => inflight.delete(meta.code));
  inflight.set(meta.code, run);
  return run;
}

// The languages an install has fallback rows for (what the daily price refresh keeps current).
async function activeLanguages() {
  const rows = await db.all(`SELECT game FROM tcgcsv_catalogues WHERE game LIKE 'pokemon-fallback-%' AND catalogue_version IS NOT NULL`)
    .catch(() => []);
  const codes = new Set(rows.map(r => r.game.replace('pokemon-fallback-', '')));
  return Object.keys(LANGS).filter(name => codes.has(LANGS[name].code));
}

// Refresh the rows (prices included) after a TCGCSV sync. Part of the daily sweep.
async function refresh() {
  let cards = 0;
  for (const name of await activeLanguages()) {
    ready.delete(LANGS[name].code);
    const coverage = await loadCoverage({ name, ...LANGS[name] });
    if (coverage) cards += (await materialize(name, coverage)).cards || 0;
  }
  return { cards };
}

async function getCardById(id) {
  if (!isFallbackId(id) || productIdOf(id) == null) return null;
  const read = async () => {
    const row = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [id]);
    return row ? parseCardRow(row) : null;
  };
  const cached = await read();
  if (cached) return cached;
  // Not written yet on this install: a scan of a card this install has never seen.
  for (const name of Object.keys(LANGS)) {
    await ensure(name);
    const card = await read();
    if (card) return card;
  }
  return null;
}

// Set-list entries for the fallback sets of a non-English language (English ones
// are in the `sets` table), shaped like tcgdexApi.listSets rows.
async function fallbackSets(lang) {
  const meta = langMeta(lang);
  if (!meta || meta.name === 'English') return [];
  const rows = await db.all(
    `SELECT set_id, MAX(set_name) AS name, COUNT(*) AS n FROM card_cache
      WHERE game = 'pokemon' AND id LIKE 'tcgplayer-%' AND language = ? GROUP BY set_id ORDER BY set_id`,
    [meta.name]
  );
  return rows.map(r => ({ id: r.set_id, name: r.name, total: r.n, printed_total: r.n, series: 'TCGplayer', game: 'pokemon' }));
}

module.exports = {
  isFallbackId, idFor, productIdOf, setIdFor, coverageAsset, finishOf, quotesByProduct,
  computeCoverage, loadCoverage, materialize, ensure, refresh, getCardById, fallbackSets, activeLanguages, LANGS,
};
