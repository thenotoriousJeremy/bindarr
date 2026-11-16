// How cards are ordered: the one comparator the filing engine
// (backend/src/utils/compartmentSort.js) and every view that draws cards in order
// (frontend/src/utils/cardSort.js) both use, so where a card is filed and where it
// is shown cannot drift apart. They were two copies for a long time and had: the
// backend had no case for added_at or entry_id, so a "newest first" container filed
// new cards last, and neither ranked Lorcana's or Riftbound's top rarities.
//
// No imports, on purpose. The backend loads this file with require(), which loads
// an ES module synchronously on the Node versions it supports (22.12 and later);
// the browser and the device bundle import it. The order tables
// (shared/cardOrder.json, shared/sortSchemes.json) are handed in by each side
// through cardSorter() below, because importing JSON from an ES module needs an
// import attribute that bare Node insists on and the frontend tests' loader cannot
// serve.

// Scarcity rank for the rarity sort: higher is rarer. Checked in this order, first
// match wins, so "Rare Secret" scores as secret rather than plain rare, "Super Rare"
// before "Rare", and "Uncommon" before "Common" (it contains the word). A rarity
// with none of these words scores 0, before Common on an ascending sort.
//
// Only the order matters. Pokémon's and Magic's tiers keep the order they always
// had; Lorcana's (Super Rare, Legendary, Epic, Enchanted, Iconic) and Riftbound's
// (Epic, Showcase) used to contain no word here at all, so a descending sort put
// Super Rare (read as plain Rare) first and Enchanted and Legendary after Common.
// The games served from TCGplayer's catalogue likewise: Yu-Gi-Oh!'s Starlight,
// Ghost, Ultimate and Collector's Rare, One Piece's Treasure Rare, Special Card and
// Leader, and Flesh and Blood's Fabled, Marvel and Majestic all read as plain Rare
// or as nothing.
export const RARITY_RANK = [
  ['classic collection', 160],
  ['hyper', 150],
  ['starlight', 145],
  ['special illustration', 140],
  ['fabled', 135],
  ['illustration', 130],
  ['ghost', 125],
  ['treasure', 125],
  ['secret', 120],
  ['ultimate', 115],
  ['marvel', 115],
  ['collector', 112],
  ['ultra', 110],
  ['radiant', 100],
  ['amazing', 90],
  ['shiny', 80],
  ['double rare', 70],
  ['special card', 65],
  ['iconic', 68],
  ['showcase', 67],
  ['enchanted', 66],
  ['epic', 64],
  ['legendary', 62],
  // Gundam's top tier above its Rare; "legendary" does not match it.
  ['legend rare', 62],
  ['mythic', 60],
  ['majestic', 56],
  ['rare holo', 50],
  ['holo rare', 50],
  ['promo', 40],
  ['super rare', 35],
  ['leader', 33],
  ['rare', 30],
  ['uncommon', 20],
  ['short print', 12],
  ['common', 10],
];

export function rarityRank(rarity) {
  const r = String(rarity || '').toLowerCase();
  for (const [keyword, rank] of RARITY_RANK) if (r.includes(keyword)) return rank;
  return 0;
}

// A list column as a row carries it: an array, or the JSON text of one straight
// from SQL. Anything else is no list.
function asList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.startsWith('[')) {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}

// `types` holds colours for a Magic card (the deck colour charts read it that
// way), so the card's type line, split into words in `subtypes`, is what a "type"
// sort reads instead. `supertype` is the fallback for rows selected without the
// game column.
export function isMtgCard(card) {
  return !!card && (card.game === 'mtg' || card.supertype === 'MTG');
}

// Pokémon energy types, Lorcana inks, Riftbound domains: one category per card,
// with every multi-type card in one bucket.
export function typeCategory(types) {
  const t = asList(types);
  if (t.length > 1) return 'Multicolor';
  return t[0] || 'Colorless';
}

const COLOR_NAMES = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

// Colour-identity bucket: one colour, Multicolor or Colorless. A Boros card is
// Multicolor, not Red. Letters (from older rows) map to colour names.
export function colorCategory(card) {
  if (!card) return 'Colorless';
  const raw = card.color_identity;
  let ci = [];
  if (typeof raw === 'string') {
    try { ci = JSON.parse(raw); } catch { if (raw) ci = [raw]; }
  } else if (Array.isArray(raw)) {
    ci = raw;
  }
  if (!ci || ci.length === 0) return 'Colorless';
  if (ci.length > 1) return 'Multicolor';
  return COLOR_NAMES[ci[0]] || ci[0] || 'Colorless';
}

// A timestamp as rows carry it. SQLite's CURRENT_TIMESTAMP is UTC written without
// a zone ("2026-11-15 12:00:00"), which Date would read as local time; read it as
// the UTC it is, so it orders correctly against an ISO string too.
function timeOf(value) {
  if (!value) return 0;
  const s = String(value);
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
  return Number.isNaN(t) ? 0 : t;
}

// A set's place in release order, from a list of sets oldest first (the sets
// table, or /api/sets). Sets missing from the list sort after every listed one,
// by name. An empty list ranks every set the same, which leaves sets in name order.
export function setRanker(sets) {
  if (!sets || sets.length === 0) return () => 0;
  const rank = new Map();
  sets.forEach((s, i) => { if (s && !rank.has(s.name)) rank.set(s.name, i); });
  return (name) => (rank.has(name) ? rank.get(name) : 999999);
}

// The functions that read the order tables, bound to them. Both sides call this
// once with shared/cardOrder.json and shared/sortSchemes.json.
export function cardSorter(cardOrder, sortSchemes) {
  // One card-type category per Magic card; see cardOrder.json for why the pick
  // order is what it is.
  function mtgTypeCategory(subtypes) {
    const words = new Set(asList(subtypes).map(w => String(w).toLowerCase()));
    return cardOrder.mtgCardTypePick.find(type => words.has(type.toLowerCase())) || 'Other';
  }

  // The category a card sorts and groups under for the 'type' field: card type
  // for Magic, the type, ink or domain list for everything else.
  function cardTypeCategory(card) {
    if (isMtgCard(card)) return mtgTypeCategory(card.subtypes);
    return typeCategory(card && card.types);
  }

  function typeRank(card) {
    const order = isMtgCard(card) ? cardOrder.mtgCardType : cardOrder.pokemonType;
    return order[cardTypeCategory(card)] || 50;
  }

  function printingRank(printing, foilSorting) {
    const order = foilSorting === 'foils_first' ? cardOrder.printingFoilsFirst : cardOrder.printingNormalsFirst;
    return order[printing] || 10;
  }

  // A container's or view's sort order as a list of { by, dir } criteria: a named
  // scheme from sortSchemes.json, the JSON of a custom list, or the list itself.
  // 'custom' and anything unreadable are no criteria at all.
  function sortCriteria(sortOrder) {
    let criteria = [];
    if (typeof sortOrder === 'string') {
      if (sortOrder.startsWith('[')) {
        try { criteria = JSON.parse(sortOrder); } catch { criteria = []; }
      } else {
        criteria = sortSchemes[sortOrder] || [];
      }
    } else if (Array.isArray(sortOrder)) {
      criteria = sortOrder;
    }
    return Array.isArray(criteria) ? criteria : [];
  }

  // A comparator for `criteria`. `foilSorting` orders printings; `setRank` places
  // a set name in release order (setRanker above).
  function comparator(criteria, { foilSorting, setRank = () => 0 } = {}) {
    return (a, b) => {
      for (const c of criteria) {
        const dirMult = c.dir === 'desc' ? -1 : 1;
        let cmp = 0;
        switch (c.by) {
          case 'favorite':
            cmp = (a.favorite ? 1 : 0) - (b.favorite ? 1 : 0);
            break;
          case 'added_at':
            cmp = timeOf(a.added_at) - timeOf(b.added_at);
            break;
          case 'entry_id':
            cmp = (a.entry_id || 0) - (b.entry_id || 0);
            break;
          case 'name':
            cmp = (a.name || '').localeCompare(b.name || '');
            break;
          case 'price':
            cmp = (a.price_trend || 0) - (b.price_trend || 0);
            break;
          case 'set': {
            // Set identity only. Ties (same set) fall through to the next criterion,
            // so a Set > Color > CMC scheme is not pre-empted by card number; a
            // 'number' criterion orders within a set.
            const chrono = setRank(a.set_name) - setRank(b.set_name);
            cmp = chrono !== 0 ? chrono : (a.set_name || '').localeCompare(b.set_name || '');
            break;
          }
          case 'number': {
            const nA = parseInt(a.number || '0', 10);
            const nB = parseInt(b.number || '0', 10);
            if (!Number.isNaN(nA) && !Number.isNaN(nB) && nA !== nB) { cmp = nA - nB; break; }
            cmp = (a.number || '').localeCompare(b.number || '');
            break;
          }
          case 'printing':
            cmp = printingRank(a.printing, foilSorting) - printingRank(b.printing, foilSorting);
            break;
          case 'type':
            cmp = typeRank(a) - typeRank(b);
            break;
          case 'language':
            cmp = (cardOrder.language[a.language] || 99) - (cardOrder.language[b.language] || 99);
            break;
          case 'cmc':
            cmp = (a.cmc || 0) - (b.cmc || 0);
            break;
          case 'color_identity':
          case 'color': {
            const catA = colorCategory(a);
            const catB = colorCategory(b);
            cmp = (cardOrder.wubrg[catA] || 99) - (cardOrder.wubrg[catB] || 99);
            if (cmp === 0) cmp = catA.localeCompare(catB);
            break;
          }
          case 'rarity':
            cmp = rarityRank(a.rarity) - rarityRank(b.rarity);
            break;
        }
        if (cmp !== 0) return cmp * dirMult;
      }
      return 0;
    };
  }

  return { mtgTypeCategory, cardTypeCategory, typeRank, printingRank, sortCriteria, comparator };
}
