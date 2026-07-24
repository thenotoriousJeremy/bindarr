// Shared <select> option lists for collection entry fields, previously
// copy-pasted across LocationManager, CollectionList, CardSearch, and
// CameraScanner's quick-add/edit forms.
export const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
export const PRINTINGS = ['Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', 'Promo'];
export const LANGUAGES = ['English', 'Japanese', 'German', 'French', 'Spanish', 'Italian'];

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

// A binder-family container lays out fixed pockets (Pages); other container
// types (boxes, deck boxes) are continuous (Rows). Kept here so the several
// UI spots that branch on it share one definition.
export const isBinderType = (type) => type === 'Binder' || type === 'Toploader Binder';
