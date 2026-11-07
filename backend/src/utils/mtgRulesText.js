// The parts of a Magic card that Scryfall syntax searches but card_cache did not
// keep: the full type line, mana cost, power/toughness/loyalty and keyword
// abilities. (Oracle text is stored by normalizeCard itself, for deck rules.) Stored so the collection filter and the deck builder can
// answer t:, o:, m:, pow>=, kw: and friends from what you own
// (shared/scryfallQuery.mjs), without a Scryfall round trip per search.
//
// Multi-faced cards keep this per face (card_faces) and leave the top level
// empty. Scryfall matches a search against either face, so text and costs are
// joined across faces; power, toughness and loyalty are the front face's, which is
// the face that is cast and the one a collection shows.
const FACE_JOIN = ' // ';

function rulesTextFields(raw) {
  const faces = Array.isArray(raw.card_faces) ? raw.card_faces : [];
  const front = faces[0] || {};
  const joined = (field, sep = FACE_JOIN) => {
    if (raw[field] != null && raw[field] !== '') return String(raw[field]);
    const parts = faces.map(f => f[field]).filter(v => v != null && v !== '');
    if (parts.length) return parts.join(sep);
    // '' (a vanilla creature, a land's cost) is a known empty value; null means
    // Scryfall said nothing, which the filter must not read as "no text".
    return raw[field] === '' || faces.some(f => f[field] === '') ? '' : null;
  };
  const stat = (field) => {
    const v = raw[field] != null ? raw[field] : front[field];
    return v == null ? null : String(v);
  };
  return {
    type_line: joined('type_line'),
    mana_cost: joined('mana_cost'),
    power: stat('power'),
    toughness: stat('toughness'),
    loyalty: stat('loyalty'),
    keywords: Array.isArray(raw.keywords) ? raw.keywords : null,
  };
}

// card_cache columns, in the order cardCache.js writes them.
const RULES_TEXT_COLUMNS = ['type_line', 'mana_cost', 'power', 'toughness', 'loyalty', 'keywords'];

// Bound values for those columns. Every game writes through the same upsert, so a
// Pokémon or Lorcana row simply stores NULLs here.
function rulesTextParams(card) {
  const text = (v) => (v == null ? null : String(v));
  return [
    text(card.type_line), text(card.mana_cost),
    text(card.power), text(card.toughness), text(card.loyalty),
    Array.isArray(card.keywords) ? JSON.stringify(card.keywords) : null,
  ];
}

module.exports = { rulesTextFields, rulesTextParams, RULES_TEXT_COLUMNS };
