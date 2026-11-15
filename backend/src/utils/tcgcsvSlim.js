// What the TCGCSV cache keeps of each response.
//
// The raw responses carry far more than Bindarr reads (extendedData blocks, image
// and product URLs, low/high/direct prices, timestamps), and the cache lives in the
// main SQLite file: two versions coexist during a sync, a DELETE never shrinks the
// file, and every backup copies it. So only the fields something actually reads are
// stored. Readers, checked when this was written:
//
//   groups    tcgcsvApi.buildGroupMatcher, tcgplayerCatalog.groupToSet/start
//             -> groupId, name, abbreviation
//   products  tcgcsvApi.priceSet (numberOf, productId), tcgplayerCatalog.start
//             (numberOf, productId, name, imageUrl), pokemonTcgplayer (rarity,
//             whether there is an image) -> productId, name, number, rarity,
//             imageUrl only when absent or non-standard; imageUrl and groupId
//             on sealed product
//   prices    tcgcsvApi.pricesByProduct, routes/sealed.js refresh-value,
//             riftboundPrices.quotesByProduct
//             -> productId, subTypeName, marketPrice, midPrice
//
// Cards and sealed product are told apart by the collector number: a product with
// no number is sealed product (a box, pack, ETB, ...). Both are kept for Pokémon —
// cards feed the price sweep and the scan product map, sealed product feeds the
// sealed inventory's catalog search and market value — and the two card readers
// skip rows without a number. For the SEALED-ONLY categories (Magic, Lorcana)
// nothing reads a card, and Magic alone is ~100k of them, so only sealed product
// and its prices are kept there.
//
// A price row whose finish has no column, or that has neither a market nor a mid
// price, is dropped: pricesByProduct filters it, and sealed product prices under
// 'Normal', which is kept.
//
// Adding a reader of a new field means adding it here; already-cached versions
// will not have it until the next sync.
//
// CommonJS and dependency-free on purpose: db.js uses it to slim rows left by an
// earlier build that stored whole responses, and tcgcsvApi requires db.js. The
// mirror job (scripts/tcgcsv-mirror/sync.mjs) uses it too, to publish per-category
// bundles already in this shape (see SLIM_VERSION).

// The version of every shape below. The mirror stamps it on the bundles and the
// index it publishes, and an instance only takes a bundle stamped with its own
// version (tcgcsvApi.syncFromBundles), falling back to the per-group files
// otherwise. Bump it whenever a slim shape changes.
const SLIM_VERSION = 3;

// Games served entirely from TCGCSV (`provider: "tcgcsv"` in shared/games.json):
// their cards are the catalogue itself (tcgcsvGameApi.js), so their products keep
// what a card needs rather than just what a price sweep needs, and every finish
// TCGplayer quotes is kept. categoryId -> game.
const CATALOGUE_CATEGORY = new Map();
for (const g of require('../../../shared/games.json')) {
  if (g.provider !== 'tcgcsv') continue;
  for (const c of g.tcgplayerCategories || []) CATALOGUE_CATEGORY.set(c, g.value);
}

const SUBTYPES_PRICED = new Set([
  'Normal', 'Unlimited', 'Holofoil', 'Unlimited Holofoil', 'Reverse Holofoil',
  '1st Edition', '1st Edition Normal', '1st Edition Holofoil',
]);

// Riftbound (category 89) quotes 'Normal' and 'Foil' (riftboundPrices.FINISH_COLUMN).
// Foil is kept for that category only: Pokémon has no column for it.
const RIFTBOUND_CATEGORY = 89;
const RIFTBOUND_SUBTYPES = new Set(['Normal', 'Foil']);

// TCGplayer categories synced for their sealed product only (tcgcsvApi adds these
// to the sync). Confirmed against the live catalogue: Magic is 1, Lorcana 71.
const SEALED_ONLY_CATEGORY = { mtg: 1, lorcana: 71 };
const SEALED_ONLY_CATEGORIES = new Set(Object.values(SEALED_ONLY_CATEGORY));

const positive = (v) => (typeof v === 'number' && v > 0 ? v : null);

function slimGroup(g) {
  return { groupId: g.groupId, name: g.name ?? null, abbreviation: g.abbreviation ?? null };
}

function rawNumber(p) {
  if (p.number != null) return p.number;
  const ext = Array.isArray(p.extendedData) ? p.extendedData : [];
  const f = ext.find(e => e && String(e.name).toLowerCase() === 'number');
  return f ? f.value : null;
}

const isSealedProduct = (p) => {
  const number = rawNumber(p);
  return number == null || String(number).trim() === '';
};

function slimProduct(p, { sealedOnly = false } = {}) {
  if (isSealedProduct(p)) {
    return {
      productId: p.productId, name: p.name ?? '', number: null,
      imageUrl: p.imageUrl ?? null, groupId: p.groupId ?? null,
    };
  }
  if (sealedOnly) return null;
  // Rarity too: the Pokémon cards TCGdex does not have are served from these rows
  // (pokemonTcgplayer.js), and a card with no rarity reads as Common.
  const rarity = rarityOf(p);
  const out = { productId: p.productId, name: p.name ?? '', number: String(rawNumber(p)), ...(rarity ? { rarity } : {}) };
  // And whether TCGplayer has a picture, recorded as the catalogue games do:
  // absent is the standard CDN url, null is none (the CDN answers 403 then, not a
  // placeholder, so a row given the standard url would show a broken image).
  if (!p.imageUrl || p.imageCount === 0) out.imageUrl = null;
  else if (p.imageUrl !== productImageUrl(p.productId)) out.imageUrl = p.imageUrl;
  return out;
}

function rarityOf(p) {
  const ext = Array.isArray(p.extendedData) ? p.extendedData : [];
  const f = ext.find(e => e && String(e.name).toLowerCase() === 'rarity');
  return f && f.value != null && String(f.value).trim() ? String(f.value).trim() : null;
}

// TCGplayer's own thumbnail path for a product. A catalogue product whose image
// is exactly this leaves it out (tcgcsvGameApi rebuilds it from the id), which
// is ~60 bytes off each of tens of thousands of rows.
const productImageUrl = (productId) => `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_200w.jpg`;

// extendedData worth keeping on a catalogue card: the short descriptive fields
// (card type, colour, cost, attribute...), never the rules text, which is most of
// each product's bytes and nothing here displays. Field names differ per game, so
// this keeps by size rather than by a list nobody can verify per category.
const CATALOGUE_EXT_SKIP = new Set(['number', 'rarity', 'description', 'flavortext', 'oracletext', 'cardtext', 'text']);
const CATALOGUE_EXT_MAX_LENGTH = 80;
const CATALOGUE_EXT_MAX_FIELDS = 12;

function catalogueProduct(p) {
  // Nothing reads sealed product for these games (routes/sealed.js serves the
  // three original games only), so only cards are kept.
  if (isSealedProduct(p)) return null;
  let rarity = null;
  const ext = {};
  let fields = 0;
  for (const e of Array.isArray(p.extendedData) ? p.extendedData : []) {
    if (!e || e.value == null) continue;
    const key = String(e.displayName || e.name || '').trim();
    const flat = key.toLowerCase().replace(/[^a-z]/g, '');
    if (flat === 'rarity') { rarity = String(e.value).trim() || null; continue; }
    if (!key || CATALOGUE_EXT_SKIP.has(flat) || fields >= CATALOGUE_EXT_MAX_FIELDS) continue;
    const value = String(e.value).replace(/<[^>]*>/g, '').trim();
    if (!value || value.length > CATALOGUE_EXT_MAX_LENGTH) continue;
    ext[key] = value;
    fields++;
  }
  const out = {
    productId: p.productId, name: p.name ?? '', number: String(rawNumber(p)), groupId: p.groupId ?? null, rarity,
  };
  if (fields) out.ext = ext;
  if (!p.imageUrl || p.imageCount === 0) out.imageUrl = null;
  else if (p.imageUrl !== productImageUrl(p.productId)) out.imageUrl = p.imageUrl;
  return out;
}

// `finishes` null keeps every finish that has a price (catalogue categories:
// Yu-Gi-Oh!'s 1st Edition, Flesh and Blood's Rainbow and Cold Foil, ...).
function slimPrice(r, finishes = SUBTYPES_PRICED) {
  if (finishes && !finishes.has(r.subTypeName)) return null;
  if (!r.subTypeName) return null;
  const marketPrice = positive(r.marketPrice);
  const midPrice = positive(r.midPrice);
  if (marketPrice == null && midPrice == null) return null;
  return { productId: r.productId, subTypeName: r.subTypeName, marketPrice, midPrice };
}

const categoryOf = (path) => {
  const m = /^\/tcgplayer\/(\d+)\//.exec(path);
  return m ? Number(m[1]) : null;
};

// The slimmer for a cache path, or null for a path the cache does not know.
function slimmerFor(path) {
  if (/\/groups$/.test(path)) return slimGroup;
  if (/\/products$/.test(path)) {
    if (CATALOGUE_CATEGORY.has(categoryOf(path))) return catalogueProduct;
    const sealedOnly = SEALED_ONLY_CATEGORIES.has(categoryOf(path));
    return (p) => slimProduct(p, { sealedOnly });
  }
  if (/\/prices$/.test(path)) {
    const category = categoryOf(path);
    const finishes = CATALOGUE_CATEGORY.has(category) ? null
      : category === RIFTBOUND_CATEGORY ? RIFTBOUND_SUBTYPES : SUBTYPES_PRICED;
    return (r) => slimPrice(r, finishes);
  }
  return null;
}

// Where the mirror publishes a category's bundles: one file per kind holding the
// whole category, already slim, so an instance syncs a category in three requests
// instead of one groups list plus two files per group. Versioned by SLIM_VERSION,
// because a bundle is only usable by code that expects its shape.
const BUNDLE_KINDS = ['groups', 'products', 'prices'];
const bundlePath = (categoryId, kind) => `/bindarr/v${SLIM_VERSION}/${categoryId}/${kind}`;
// Every published file and its content hash, plus the TCGCSV version it was built
// from: what lets an instance skip anything it already holds.
const INDEX_PATH = '/bindarr/index.json';

// `keepProductIds`: for a sealed-only category's prices, the ids of the products
// that group kept — its card prices are dropped with its cards. A prices path in
// a sealed-only category with no such set keeps nothing, never every card.
function slimResults(path, results, { keepProductIds = null } = {}) {
  const slim = slimmerFor(path);
  if (!slim) throw new Error(`no TCGCSV cache shape for ${path}`);
  let rows = (results || []).filter(r => r && typeof r === 'object').map(slim).filter(Boolean);
  if (/\/prices$/.test(path) && SEALED_ONLY_CATEGORIES.has(categoryOf(path))) {
    const keep = keepProductIds || new Set();
    rows = rows.filter(r => keep.has(r.productId));
  }
  return rows;
}

module.exports = {
  slimResults, slimmerFor, isSealedProduct, SUBTYPES_PRICED, RIFTBOUND_SUBTYPES, SEALED_ONLY_CATEGORY, SEALED_ONLY_CATEGORIES,
  SLIM_VERSION, CATALOGUE_CATEGORY, BUNDLE_KINDS, bundlePath, INDEX_PATH, productImageUrl,
};
