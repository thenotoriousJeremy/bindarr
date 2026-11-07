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
//             (numberOf, productId, name, imageUrl) -> productId, name, number,
//             plus imageUrl and groupId on sealed product
//   prices    tcgcsvApi.pricesByProduct, routes/sealed.js refresh-value
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
// earlier build that stored whole responses, and tcgcsvApi requires db.js.
const SUBTYPES_PRICED = new Set([
  'Normal', 'Unlimited', 'Holofoil', 'Unlimited Holofoil', 'Reverse Holofoil',
  '1st Edition', '1st Edition Normal', '1st Edition Holofoil',
]);

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
  return { productId: p.productId, name: p.name ?? '', number: String(rawNumber(p)) };
}

function slimPrice(r) {
  if (!SUBTYPES_PRICED.has(r.subTypeName)) return null;
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
    const sealedOnly = SEALED_ONLY_CATEGORIES.has(categoryOf(path));
    return (p) => slimProduct(p, { sealedOnly });
  }
  if (/\/prices$/.test(path)) return slimPrice;
  return null;
}

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
  slimResults, slimmerFor, isSealedProduct, SUBTYPES_PRICED, SEALED_ONLY_CATEGORY, SEALED_ONLY_CATEGORIES,
};
