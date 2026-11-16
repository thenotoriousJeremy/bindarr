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
// A swatch's name is shown as t(`deck.accentName.${key}`).
export const DECK_ACCENT_COLORS = [
  { key: 'gold', hex: '#eab308' },
  { key: 'red', hex: '#ef4444' },
  { key: 'blue', hex: '#3b82f6' },
  { key: 'green', hex: '#10b981' },
  { key: 'purple', hex: '#a855f7' },
  { key: 'slate', hex: '#64748b' },
  { key: 'pink', hex: '#ec4899' },
  { key: 'orange', hex: '#f97316' },
];

// A deck's category is stored as the English name above and shown translated. A
// category not in the list (an older build's, or set through the API) keeps its
// stored text rather than being mislabelled.
export const deckCategoryLabel = (t, category) => (DECK_CATEGORIES.includes(category)
  ? t(`deck.categoryName.${category.toLowerCase()}`)
  : category);

// The heading a group of deck cards is listed under. Groups are the English card
// types the grouping matches on (cardGroup, groupOrder, plus the command zone);
// only the heading is translated. 'Other' is keyed 'misc': a key ending in a
// plural category is read as a counted phrase.
const GROUP_KEYS = {
  Commander: 'commander',
  'Pokémon': 'pokemon', Trainer: 'trainer', Energy: 'energy',
  Creature: 'creature', Planeswalker: 'planeswalker', Instant: 'instant', Sorcery: 'sorcery',
  Enchantment: 'enchantment', Artifact: 'artifact', Battle: 'battle', Land: 'land',
  Character: 'character', Action: 'action', Item: 'item', Location: 'location',
  Legend: 'legend', Champion: 'champion', Unit: 'unit', Spell: 'spell', Gear: 'gear', Rune: 'rune', Battlefield: 'battlefield',
  Other: 'misc',
};
export const deckGroupLabel = (t, group) => (GROUP_KEYS[group] ? t(`deck.group.${GROUP_KEYS[group]}`) : group);

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
// The games served from TCGplayer's catalogue: a card's group is read off its
// TCGplayer card type (card.supertype), which each game words its own way
// ('Effect Monster', 'Spell Card'...), so the match is by word, in this order.
const TCGPLAYER_GROUPS = {
  yugioh: [['Monster', /monster/i], ['Spell', /spell/i], ['Trap', /trap/i]],
  onepiece: [['Leader', /leader/i], ['Character', /character/i], ['Event', /event/i], ['Stage', /stage/i]],
  digimon: [['Digi-Egg', /egg/i], ['Digimon', /digimon/i], ['Tamer', /tamer/i], ['Option', /option/i]],
  fab: [['Hero', /hero/i], ['Equipment', /equipment|weapon/i], ['Attack', /attack/i], ['Defense', /defen[cs]e/i],
    ['Action', /action/i], ['Instant', /instant/i]],
  swu: [['Leader', /leader/i], ['Base', /\bbase\b/i], ['Unit', /unit/i], ['Upgrade', /upgrade/i], ['Event', /event/i]],
};
const tcgplayerGroup = (deckGame, card) => {
  const type = `${card.supertype || ''} ${(card.subtypes || []).join(' ')}`;
  const hit = TCGPLAYER_GROUPS[deckGame].find(([, re]) => re.test(type));
  return hit ? hit[0] : 'Other';
};

// The group a card is listed (and charted) under in a deck of the given game.
export const cardGroup = (deckGame, card) => {
  if (deckGame === 'riftbound') return riftboundGroup(card);
  if (deckGame === 'mtg') return mtgCardType(card);
  if (deckGame === 'lorcana') return lorcanaCardType(card);
  if (TCGPLAYER_GROUPS[deckGame]) return tcgplayerGroup(deckGame, card);
  let type = card.supertype || 'Pokémon';
  if (type === 'Pokemon') type = 'Pokémon';
  return ['Pokémon', 'Trainer', 'Energy'].includes(type) ? type : 'Pokémon';
};

// Groups order based on game
export const groupOrder = (deckGame) => (TCGPLAYER_GROUPS[deckGame]
  ? [...TCGPLAYER_GROUPS[deckGame].map(([name]) => name), 'Other']
  : deckGame === 'riftbound' ? RIFTBOUND_GROUPS : deckGame === 'mtg'
  ? ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Battle', 'Land', 'Other']
  : (deckGame === 'lorcana'
    ? ['Character', 'Action', 'Item', 'Location', 'Other']
    : ['Pokémon', 'Trainer', 'Energy', 'Other']));
