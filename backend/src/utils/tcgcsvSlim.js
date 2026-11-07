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
//             (numberOf, productId, name) -> productId, name, number
//   prices    tcgcsvApi.pricesByProduct -> productId, subTypeName, marketPrice,
//             midPrice
//
// Rows nothing can use are dropped too: a product with no collector number is
// sealed product (both readers skip it), and a price row whose finish has no column
// or that has neither a market nor a mid price is filtered by pricesByProduct.
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

function slimProduct(p) {
  const number = rawNumber(p);
  if (number == null || String(number).trim() === '') return null;
  return { productId: p.productId, name: p.name ?? '', number: String(number) };
}

function slimPrice(r) {
  if (!SUBTYPES_PRICED.has(r.subTypeName)) return null;
  const marketPrice = positive(r.marketPrice);
  const midPrice = positive(r.midPrice);
  if (marketPrice == null && midPrice == null) return null;
  return { productId: r.productId, subTypeName: r.subTypeName, marketPrice, midPrice };
}

// The slimmer for a cache path, or null for a path the cache does not know.
function slimmerFor(path) {
  if (/\/groups$/.test(path)) return slimGroup;
  if (/\/products$/.test(path)) return slimProduct;
  if (/\/prices$/.test(path)) return slimPrice;
  return null;
}

function slimResults(path, results) {
  const slim = slimmerFor(path);
  if (!slim) throw new Error(`no TCGCSV cache shape for ${path}`);
  return (results || []).filter(r => r && typeof r === 'object').map(slim).filter(Boolean);
}

module.exports = { slimResults, slimmerFor, SUBTYPES_PRICED };
