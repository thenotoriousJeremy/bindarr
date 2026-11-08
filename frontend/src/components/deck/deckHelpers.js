// Pure pieces the deck views share: no state, no fetches, no JSX.
import { defaultFormat, defaultTargetSize, defaultAnyPrinting } from '../../utils/deckRules';
import { RIFTBOUND_GROUPS, riftboundGroup } from '../../utils/riftbound';

// Total copies of a card (matched by name) already in a deck's card list.
export const deckCountByName = (deckCards, name) =>
  (deckCards || []).filter(c => c.name === name).reduce((s, c) => s + c.quantity, 0);

// What a new deck starts as for a game: the first format the rules table lists for
// it, sized the way that format is (100 for Commander, 60 otherwise).
export const newDeckDefaults = (game) => {
  const format = defaultFormat(game);
  return { format, targetSize: defaultTargetSize(game, format), anyPrinting: defaultAnyPrinting(game) };
};

// Copies a deck has no copy for: what it holds when checked out, what checkout would
// take otherwise. A server older than the app (the mobile app can be) sends only
// owned/locked, so fall back to those.
export const missingCopies = (card) => (card.missing_qty !== undefined
  ? card.missing_qty
  : Math.max(0, card.quantity - ((card.owned_qty || 0) - (card.locked_qty || 0))));

export const formatCardLocations = (locations) => locations.map(({ take, location_name, compartment_display }) =>
  `${take > 1 ? `×${take} ` : ''}${location_name}${compartment_display ? ` · ${compartment_display}` : ''}`
).join(', ');

export const locationCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// Deck Creation Constants. The format lists come from the rules table
// (shared/deckRules.mjs), so a format added there is offered here too.
export const DECK_CATEGORIES = ['Competitive', 'Casual', 'Tournament', 'Theorycraft', 'Proxy', 'Trade'];
export const DECK_ACCENT_COLORS = [
  { name: 'Gold', hex: '#eab308' },
  { name: 'Red', hex: '#ef4444' },
  { name: 'Blue', hex: '#3b82f6' },
  { name: 'Green', hex: '#10b981' },
  { name: 'Purple', hex: '#a855f7' },
  { name: 'Slate', hex: '#64748b' },
  { name: 'Pink', hex: '#ec4899' },
  { name: 'Orange', hex: '#f97316' },
];

// MTG card-type buckets, read off the parsed type line stored in subtypes.
const MTG_MAIN_TYPES = ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Battle', 'Land'];
const mtgCardType = (card) => {
  const subs = card.subtypes || [];
  for (const t of MTG_MAIN_TYPES) if (subs.includes(t)) return t;
  return 'Other';
};
const LORCANA_MAIN_TYPES = ['Character', 'Action', 'Item', 'Location'];
const lorcanaCardType = (card) => {
  const supertype = card.supertype || 'Character';
  if (LORCANA_MAIN_TYPES.includes(supertype)) return supertype;
  const subs = card.subtypes || [];
  for (const t of LORCANA_MAIN_TYPES) if (subs.includes(t)) return t;
  return 'Character';
};
// The group a card is listed (and charted) under in a deck of the given game.
export const cardGroup = (deckGame, card) => {
  if (deckGame === 'riftbound') return riftboundGroup(card);
  if (deckGame === 'mtg') return mtgCardType(card);
  if (deckGame === 'lorcana') return lorcanaCardType(card);
  let type = card.supertype || 'Pokémon';
  if (type === 'Pokemon') type = 'Pokémon';
  return ['Pokémon', 'Trainer', 'Energy'].includes(type) ? type : 'Pokémon';
};

// Groups order based on game
export const groupOrder = (deckGame) => (deckGame === 'riftbound' ? RIFTBOUND_GROUPS : deckGame === 'mtg'
  ? ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Battle', 'Land', 'Other']
  : (deckGame === 'lorcana'
    ? ['Character', 'Action', 'Item', 'Location', 'Other']
    : ['Pokémon', 'Trainer', 'Energy', 'Other']));
