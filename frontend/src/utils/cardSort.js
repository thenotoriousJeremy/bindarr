import { getRarityRank } from './cardRarity';

// Shared comparator logic for ordering collection cards. Previously copy-pasted
// across autoSortContainerCards, findNextRecommendedSlot, the sorting assistant
// queue, and the unsorted list view in LocationManager.jsx.
// Pokémon energy types first, then MTG colors (WUBRG), then Multicolor. Must
// stay aligned with POKEMON_TYPE_ORDER in backend/src/utils/compartmentSort.js.
export const POKEMON_TYPE_ORDER = {
  'Grass': 1,
  'Fire': 2,
  'Water': 3,
  'Lightning': 4,
  'Psychic': 5,
  'Fighting': 6,
  'Darkness': 7,
  'Metal': 8,
  'Fairy': 9,
  'Dragon': 10,
  'Colorless': 11,
  'White': 20,
  'Blue': 21,
  'Black': 22,
  'Red': 23,
  'Green': 24,
  'Multicolor': 25,
  'Unknown': 100
};

// Mirrors typeCategory in the backend: multi-color MTG cards bucket together.
export function typeCategory(types) {
  const t = Array.isArray(types) ? types : [];
  if (t.length > 1) return 'Multicolor';
  return t[0] || 'Colorless';
}

const PRINTING_ORDER_NORMALS_FIRST = {
  'Normal': 1,
  'Reverse Holofoil': 2,
  'Holofoil': 3,
  '1st Edition': 4,
  'Promo': 5
};

const PRINTING_ORDER_FOILS_FIRST = {
  'Reverse Holofoil': 1,
  'Holofoil': 2,
  'Normal': 3,
  '1st Edition': 4,
  'Promo': 5
};

export function getPrintingRank(printing, foilSorting) {
  const order = foilSorting === 'foils_first' ? PRINTING_ORDER_FOILS_FIRST : PRINTING_ORDER_NORMALS_FIRST;
  return order[printing] || 10;
}

// Filing order for the 'language' scheme. Mirrors LANGUAGE_ORDER in
// backend/src/utils/compartmentSort.js so display order matches placement.
export const LANGUAGE_ORDER = { 'English': 1, 'Japanese': 2, 'German': 3, 'French': 4, 'Spanish': 5, 'Italian': 6 };

// Sorts `cards` in place (and returns it) according to `sortOrder`. `foilSorting`
// only affects the 'set-number-printing' order. Unrecognized/'custom' orders are
// left untouched (stable no-op), matching each call site's original fallback.
// `setsList` (from /api/sets, release-date order) makes the set-based schemes
// sort chronologically, matching the backend's placement engine — without it
// the display order would disagree with where recommendSlot files cards.
export function sortCardsByOrder(cards, sortOrder, foilSorting, setsList = []) {
  const setRank = (name) => {
    if (!setsList || setsList.length === 0) return 0;
    const idx = setsList.findIndex(s => s.name === name);
    return idx >= 0 ? idx : 999999;
  };
  let criteria = [];
  if (typeof sortOrder === 'string') {
    if (sortOrder.startsWith('[')) {
      try { criteria = JSON.parse(sortOrder); } catch { /* ignore malformed sortOrder */ }
    } else {
      if (sortOrder === 'scanned-desc') criteria = [{by:'added_at', dir:'desc'}, {by:'entry_id', dir:'desc'}];
      else if (sortOrder === 'scanned-asc') criteria = [{by:'added_at', dir:'asc'}, {by:'entry_id', dir:'asc'}];
      else if (sortOrder === 'name-asc') criteria = [{by:'name', dir:'asc'}];
      else if (sortOrder === 'price-desc') criteria = [{by:'price', dir:'desc'}];
      else if (sortOrder === 'set-number') criteria = [{by:'set', dir:'asc'}];
      else if (sortOrder === 'set-number-printing') criteria = [{by:'set', dir:'asc'}, {by:'printing', dir:'asc'}];
      else if (sortOrder === 'type-name') criteria = [{by:'type', dir:'asc'}, {by:'name', dir:'asc'}];
      else if (sortOrder === 'language') criteria = [{by:'language', dir:'asc'}, {by:'name', dir:'asc'}];
    }
  } else if (Array.isArray(sortOrder)) {
    criteria = sortOrder;
  }

  if (!criteria || criteria.length === 0) return cards;

  cards.sort((a, b) => {
    for (const c of criteria) {
      const dirMult = c.dir === 'desc' ? -1 : 1;
      let cmp = 0;
      switch (c.by) {
        case 'added_at': {
          const timeA = a.added_at ? new Date(a.added_at).getTime() : 0;
          const timeB = b.added_at ? new Date(b.added_at).getTime() : 0;
          cmp = timeA - timeB;
          break;
        }
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
          // Set identity only. Ties (same set) fall through to the next
          // criterion so schemes like Set > Color > CMC aren't pre-empted by
          // card number. Add a separate 'number' rule to order within a set.
          const cmpChrono = setRank(a.set_name) - setRank(b.set_name);
          if (cmpChrono !== 0) { cmp = cmpChrono; break; }
          cmp = (a.set_name || '').localeCompare(b.set_name || '');
          break;
        }
        case 'number': {
          const numA = parseInt(a.number || '0', 10);
          const numB = parseInt(b.number || '0', 10);
          if (!isNaN(numA) && !isNaN(numB) && numA !== numB) { cmp = numA - numB; break; }
          cmp = (a.number || '').localeCompare(b.number || '');
          break;
        }
        case 'printing': {
          const printA = getPrintingRank(a.printing, foilSorting);
          const printB = getPrintingRank(b.printing, foilSorting);
          cmp = printA - printB;
          break;
        }
        case 'type': {
          const orderA = POKEMON_TYPE_ORDER[typeCategory(a.types)] || 50;
          const orderB = POKEMON_TYPE_ORDER[typeCategory(b.types)] || 50;
          cmp = orderA - orderB;
          break;
        }
        case 'language': {
          const la = LANGUAGE_ORDER[a.language] || 99;
          const lb = LANGUAGE_ORDER[b.language] || 99;
          cmp = la - lb;
          break;
        }
        case 'cmc':
          cmp = (a.cmc || 0) - (b.cmc || 0);
          break;
        case 'color_identity':
        case 'color': {
          let cA = 'Colorless';
          if (typeof a.color_identity === 'string') {
            try { const p = JSON.parse(a.color_identity); if (p.length > 0) cA = p[0]; } catch { /* ignore */ }
          } else if (Array.isArray(a.color_identity) && a.color_identity.length > 0) {
            cA = a.color_identity[0];
          }
          let cB = 'Colorless';
          if (typeof b.color_identity === 'string') {
            try { const p = JSON.parse(b.color_identity); if (p.length > 0) cB = p[0]; } catch { /* ignore */ }
          } else if (Array.isArray(b.color_identity) && b.color_identity.length > 0) {
            cB = b.color_identity[0];
          }
          const wubrg = { 'W': 1, 'White': 1, 'U': 2, 'Blue': 2, 'B': 3, 'Black': 3, 'R': 4, 'Red': 4, 'G': 5, 'Green': 5, 'Colorless': 6 };
          cmp = (wubrg[cA] || 99) - (wubrg[cB] || 99);
          if (cmp === 0) cmp = cA.localeCompare(cB);
          break;
        }
        case 'rarity':
          cmp = getRarityRank(a.rarity) - getRarityRank(b.rarity);
          break;
      }
      if (cmp !== 0) return cmp * dirMult;
    }
    return 0;
  });
  return cards;
}
