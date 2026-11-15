import cardOrder from '../../../shared/cardOrder.json';
import sortSchemes from '../../../shared/sortSchemes.json';
import { cardSorter, colorCategory, isMtgCard, setRanker, typeCategory } from '../../../shared/cardSort.mjs';

// Ordering collection cards for display: LocationManager, the collection list, the
// sorting assistant queue, shared views. The comparator and the categories are
// shared/cardSort.mjs, the one the backend files cards with
// (backend/src/utils/compartmentSort.js), so a container shows its cards in the
// order recommendSlot put them in. The order tables are shared/cardOrder.json and
// shared/sortSchemes.json, handed to it here.
const sorter = cardSorter(cardOrder, sortSchemes);

export const POKEMON_TYPE_ORDER = cardOrder.pokemonType;

export const MTG_CARD_TYPE_ORDER = cardOrder.mtgCardType;

// Multi-type cards bucket together: Multicolor.
export { typeCategory };

// `types` holds colours for an MTG card, so a "type" sort reads its type line.
export { isMtgCard };

// One card-type category per MTG card; see shared/cardOrder.json for the pick order.
export const { mtgTypeCategory } = sorter;

// The category a card sorts and groups under for the 'type' field: card type
// for Magic, the type/ink list for Pokémon and Lorcana.
export const { cardTypeCategory } = sorter;

// Colour-identity bucket: one colour, Multicolor or Colorless (WUBRG, then
// Multicolor, then Colorless), the way storage files by colour.
export { colorCategory };

export function getPrintingRank(printing, foilSorting) {
  return sorter.printingRank(printing, foilSorting);
}

export const LANGUAGE_ORDER = cardOrder.language;

// Sorts `cards` in place (and returns it) according to `sortOrder`. `foilSorting`
// orders printings. Unrecognized/'custom' orders are left untouched (stable no-op),
// matching each call site's original fallback. `setsList` (from /api/sets,
// release-date order) makes the set-based schemes sort chronologically, matching
// the backend's placement engine — without it sets sort by name.
export function sortCardsByOrder(cards, sortOrder, foilSorting, setsList = []) {
  const criteria = sorter.sortCriteria(sortOrder);
  if (criteria.length === 0) return cards;
  cards.sort(sorter.comparator(criteria, { foilSorting, setRank: setRanker(setsList) }));
  return cards;
}
