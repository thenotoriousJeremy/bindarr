// Shared <select> option lists for collection entry fields, previously
// copy-pasted across LocationManager, CollectionList, CardSearch, and
// CameraScanner's quick-add/edit forms.
import { LANGUAGE_NAMES } from './languages';

export const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
export const PRINTINGS = ['Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', 'Promo'];
// Re-exported from the language registry so the entry forms, the search language
// picker and the backend can never drift out of sync.
export const LANGUAGES = LANGUAGE_NAMES;

// MTG cards are only Nonfoil or Foil, never the Pokémon finishes. The foil
// price is stored under the 'Holofoil' value (scryfall usd_foil), so we keep
// that stored value (also what the DB CHECK allows) and just relabel it "Foil".
const MTG_PRINTINGS = [{ value: 'Normal', label: 'Nonfoil' }, { value: 'Holofoil', label: 'Foil' }];

// Printing/finish {value,label} options for a card's game. Value stays within
// the collection.printing CHECK constraint; only the label is game-specific.
export function getPrintings(game) {
  if (String(game).toLowerCase() === 'mtg') return MTG_PRINTINGS;
  return PRINTINGS.map(p => ({ value: p, label: p }));
}

// Grading companies, mirroring the collection.grader CHECK constraint in
// backend/src/db.js. 'Raw' is the default and means ungraded — not unknown, so it
// is a real option in the picker rather than an empty one.
export const GRADERS = ['Raw', 'PSA', 'BGS', 'CGC', 'SGC', 'TAG'];

// Grades a slab can carry, highest first because that is the order a collector
// reads them in. PSA issues whole numbers plus 10; BGS and CGC add half grades, so
// the list is the union and the picker is shared.
export const GRADES = [10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5, 5, 4, 3, 2, 1];

// A binder-family container lays out fixed pockets (Pages); other container
// types (boxes, deck boxes) are continuous (Rows). Kept here so the several
// UI spots that branch on it share one definition.
export const isBinderType = (type) => type === 'Binder' || type === 'Toploader Binder';

// Which two pages face each other on the desktop spread holding a given page.
// A binder opens on page 1 alone against the inside cover, so pages pair up 2-3,
// 4-5 and so on — and a binder with an even page count ends on a page sitting
// alone on the left. leftIdx is -1 on the opening spread: nothing faces page 1.
export function binderSpread(pageIndex) {
  const spread = Math.floor((Math.max(0, pageIndex) + 1) / 2);
  return { spread, leftIdx: spread * 2 - 1, rightIdx: spread * 2 };
}

// Container type labels are translated, but the type itself is the English string
// stored in the database, so the two are paired here rather than in each screen
// that renders one. The label is t(`container.type.${containerTypeKey(type)}`);
// 'misc' is keyed that way and not 'other' because a key ending in a plural
// category is read as a counted phrase by check-locales.mjs.
const CONTAINER_TYPE_KEYS = {
  'Binder': 'binder',
  'Toploader Binder': 'toploaderBinder',
  'Box': 'box',
  'Toploader Box': 'toploaderBox',
  'Graded Slab Box': 'gradedSlabBox',
  'Display Shelf / Stand': 'displayShelf',
  'Deck Box': 'deckBox',
  'Tin / Case': 'tinCase',
  'Other': 'misc',
};

// A type from an older install (or a hand-edited row) has no key; callers fall
// back to showing the stored English rather than mislabelling it "Other".
export const containerTypeKey = (type) => CONTAINER_TYPE_KEYS[type] || null;
