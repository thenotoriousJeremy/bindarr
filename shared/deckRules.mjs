// Deck construction rules for every game and format — ONE implementation, server
// and browser alike.
//
// The server enforces the copy limit with it (backend/src/utils/deckRules.js, which
// reaches this ES module through import() because the backend is CommonJS) and the
// deck builder uses it for the same limit, its format lists and the warnings in
// Deck Health. Both used to keep their own copy of isBasicEnergyOrLand, and the
// copies had the same bug: any land with a basic land TYPE counted as basic, so
// Breeding Pool ("Land — Forest Island") skipped the copy limit entirely.
//
// Pure: cards in, answers out. A card is a card_cache row as either side holds it —
// `subtypes` and `color_identity` may be JSON strings or already-parsed arrays.

const parseList = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) {
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }
  return [];
};

// scryfallApi.normalizeCard keeps a Magic card's whole type line, split into words,
// in `subtypes` — so the supertypes (Basic, Legendary) are in there too.
const typeWords = (card) => parseList(card && card.subtypes);

// One spelling of a name for comparisons. Nazgûl and Nazgul are the same card; which
// one a cache row holds is not something the user can see or control.
const foldName = (name) => String(name || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

const SNOW_BASICS = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes'].map(n => `Snow-Covered ${n}`);
const BASIC_LAND_NAMES = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes', ...SNOW_BASICS]);

// Basic is a supertype, printed only on basic lands ("Basic Land — Forest",
// "Basic Snow Land — Island"). A basic land TYPE is not enough: Breeding Pool and
// Tropical Island are both "Land — Forest Island", and both are four-ofs.
export function isBasicLand(card) {
  if (!card) return false;
  const words = typeWords(card);
  if (words.length) return words.includes('Basic') && (words.includes('Land') || card.supertype === 'Land');
  // A row cached without its type line: only the basics' own names can say.
  return BASIC_LAND_NAMES.has(String(card.name || ''));
}

// Pokémon: Energy that is not Special.
export function isBasicEnergy(card) {
  return !!card && card.supertype === 'Energy' && !typeWords(card).includes('Special');
}

// Cards whose own text overrides the copy limit. Read from oracle_text when the row
// has it, so a card printed next year is covered without an edit here; this list is
// for rows cached before oracle_text was (they gain it on their next re-cache, which
// the daily price sweep does for every owned and decked card).
const PRINTED_LIMITS = {
  'relentless rats': Infinity,
  'shadowborn apostle': Infinity,
  'rat colony': Infinity,
  'persistent petitioners': Infinity,
  "dragon's approach": Infinity,
  'slime against humanity': Infinity,
  'templar knight': Infinity,
  'hare apparent': Infinity,
  'tempest hawk': Infinity,
  'cid, timeless artificer': Infinity,
  'seven dwarves': 7,
  'nazgul': 9,
};
const COUNT_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// "A deck can have any number of cards named Relentless Rats." / "A deck can have up
// to seven cards named Seven Dwarves." Returns Infinity, a number, or null for a
// card that sets no limit of its own.
export function printedCopyLimit(card) {
  const text = String((card && card.oracle_text) || '');
  if (/\bA deck can have any number of cards named\b/i.test(text)) return Infinity;
  const upTo = /\bA deck can have up to (\w+) cards named\b/i.exec(text);
  if (upTo) {
    const n = COUNT_WORDS[upTo[1].toLowerCase()] || parseInt(upTo[1], 10);
    if (n > 0) return n;
  }
  const listed = PRINTED_LIMITS[foldName(card && card.name)];
  return listed === undefined ? null : listed;
}

// Two printings are the same card for a deck that accepts any printing when their
// oracle ids match. A row cached before oracle_id existed has none until its next
// re-cache; Magic's English name is unique per oracle card, so the name stands in
// until then rather than calling every older row a different card.
const sameOracleCard = (a, b) => (a.oracle_id && b.oracle_id
  ? a.oracle_id === b.oracle_id
  : foldName(a.name) === foldName(b.name));

// A Lorcana card's full name is its name plus version ("Mickey Mouse - Brave Little
// Tailor"), and lorcastApi.normalizeCard stores exactly that as `name` — the same
// string its reprints and enchanted printings carry, and the one the copy limit is
// counted by.
const sameFullName = (a, b) => foldName(a.name) === foldName(b.name);

// The table. One entry per game, one row per format: adding either is one entry.
//
//   rules        what every format of the game uses unless its row says otherwise —
//                size ({ exact } | { min, max }) and copies (per card name).
//   formats      what the deck builder offers, in order; the first is the default.
//                `match` catches free-text names stored before the lists existed.
//   commander    a command zone: { max } commanders, every card inside their
//                combined colour identity. `planeswalkers` lets any legendary
//                planeswalker lead, as Brawl does.
//   unlimited    cards exempt from the copy limit (basic lands, basic Energy).
//   printedLimit cards that set their own limit in their text.
//   sameCard     what "any printing" means for the game. A game without one is
//                always matched by exact printing: Pokémon reprints differ in
//                legality, and its players expect exact.
//   anyPrinting  whether a new deck accepts any printing by default.
export const DECK_GAMES = {
  pokemon: {
    rules: { size: { exact: 60 }, copies: 4 },
    unlimited: isBasicEnergy,
    formats: [
      { name: 'Standard' },
      { name: 'Expanded' },
      { name: 'GLC (Gym Leader Challenge)' },
      { name: 'Unlimited' },
      { name: 'Retro' },
    ],
  },
  mtg: {
    rules: { size: { min: 60 }, copies: 4 },
    unlimited: isBasicLand,
    printedLimit: printedCopyLimit,
    sameCard: sameOracleCard,
    anyPrinting: true,
    formats: [
      { name: 'Commander / EDH', match: /commander|\bedh\b/i, size: { exact: 100 }, copies: 1, commander: { max: 2 } },
      { name: 'Brawl', size: { exact: 100 }, copies: 1, commander: { max: 2, planeswalkers: true } },
      { name: 'Standard' },
      { name: 'Modern' },
      { name: 'Pioneer' },
      { name: 'Legacy' },
      { name: 'Vintage' },
      { name: 'Pauper' },
    ],
  },
  lorcana: {
    rules: { size: { min: 60 }, copies: 4 },
    sameCard: sameFullName,
    anyPrinting: true,
    formats: [
      { name: 'Core (Constructed)' },
      { name: 'Casual' },
      { name: 'Draft / Sealed' },
    ],
  },
};

// A game this table does not know yet still gets the copy limit every game here
// shares, and no size rule it might not have.
const UNKNOWN_GAME = { rules: { size: {}, copies: 4 }, formats: [] };
const gameEntry = (game) => DECK_GAMES[game] || UNKNOWN_GAME;

function findFormat(entry, format) {
  const wanted = String(format || '').trim().toLowerCase();
  if (!wanted) return null;
  return entry.formats.find(f => f.name.toLowerCase() === wanted)
    || entry.formats.find(f => f.match && f.match.test(wanted))
    || null;
}

// The rules a deck is held to. An unrecognised format gets the game's own rules.
export function rulesFor(game, format) {
  const entry = gameEntry(game);
  const row = findFormat(entry, format);
  return {
    game,
    format: row ? row.name : (format || defaultFormat(game)),
    size: (row && row.size) || entry.rules.size || {},
    copies: row && row.copies != null ? row.copies : entry.rules.copies,
    commander: (row && row.commander) || null,
  };
}

export const formatNames = (game) => gameEntry(game).formats.map(f => f.name);
export const defaultFormat = (game) => formatNames(game)[0] || 'Standard';
export const supportsAnyPrinting = (game) => !!gameEntry(game).sameCard;
export const defaultAnyPrinting = (game) => supportsAnyPrinting(game) && !!gameEntry(game).anyPrinting;

// What a new deck's target size starts at: the format's own size, else 60.
export function defaultTargetSize(game, format) {
  const { size } = rulesFor(game, format);
  return size.exact || size.min || 60;
}

// Basic lands and basic Energy — exempt from the copy limit in every format.
export function isBasicEnergyOrLand(card, game) {
  const entry = gameEntry(game || (card && card.game));
  return !!(card && entry.unlimited && entry.unlimited(card));
}

// How many copies of this card (by name, across printings) a deck under `rules`
// may hold. Infinity for the exempt.
export function copyLimit(card, rules) {
  const entry = gameEntry(rules.game);
  if (isBasicEnergyOrLand(card, rules.game)) return Infinity;
  const printed = entry.printedLimit ? entry.printedLimit(card) : null;
  return printed != null ? printed : rules.copies;
}

// Does `copy` fill a deck slot listing `card`? The same printing always does; another
// printing only for a deck that accepts any, in a game that defines what that means.
export function sameCard(card, copy, game, anyPrinting) {
  if (!card || !copy) return false;
  const cardId = card.card_id || card.id;
  const copyId = copy.card_id || copy.id;
  if (cardId && cardId === copyId) return true;
  const entry = gameEntry(game);
  return !!(anyPrinting && entry.sameCard && entry.sameCard(card, copy));
}

// --- Commander -------------------------------------------------------------

const COLOR_CODES = { W: 'W', U: 'U', B: 'B', R: 'R', G: 'G', WHITE: 'W', BLUE: 'U', BLACK: 'B', RED: 'R', GREEN: 'G' };
const WUBRG = ['W', 'U', 'B', 'R', 'G'];

// A card's colour identity as letters. Scryfall rows store colour names (White,
// Blue); letters are accepted too, and anything else (Colorless) adds nothing.
export function colorIdentity(card) {
  const out = new Set();
  for (const c of parseList(card && card.color_identity)) {
    const code = COLOR_CODES[String(c).trim().toUpperCase()];
    if (code) out.add(code);
  }
  return out;
}
const inWubrg = (set) => WUBRG.filter(c => set.has(c));

// The keyword lines of a card's text, reminder text stripped.
const keywordLines = (card) => String((card && card.oracle_text) || '')
  .split('\n')
  .map(line => line.replace(/\([^)]*\)/g, '').trim())
  .filter(Boolean);

// The abilities that let a deck have a second commander (rule 702.124), read from
// the card's own text so a new variant of one does not need a release to be seen.
export function pairingAbilities(card) {
  const out = {};
  for (const line of keywordLines(card)) {
    let m;
    if ((m = /^partner with (.+)$/i.exec(line))) { out.partnerWith = m[1].trim(); continue; }
    if ((m = /^partner\s*[—–-]\s*(.+)$/i.exec(line))) { out.partnerGroup = m[1].trim().toLowerCase(); continue; }
    const keywords = line.split(',').map(k => k.trim().toLowerCase());
    if (keywords.includes('partner')) out.partner = true;
    if (keywords.includes('friends forever')) out.friendsForever = true;
    if (keywords.includes('choose a background')) out.chooseBackground = true;
    if (keywords.includes("doctor's companion")) out.doctorsCompanion = true;
  }
  const words = typeWords(card);
  out.background = words.includes('Background');
  out.doctor = words.includes('Time') && words.includes('Lord') && words.includes('Doctor');
  return out;
}

// May these two lead one deck together? Only judged from text the cache actually
// holds — see deckWarnings.
export function isLegalPair(a, b) {
  const pa = pairingAbilities(a);
  const pb = pairingAbilities(b);
  // "Partner with" names one card, and pairs with nothing else even though it says
  // Partner — so it is decided before the general rule could wave it through.
  if (pa.partnerWith || pb.partnerWith) {
    return (!!pa.partnerWith && foldName(pa.partnerWith) === foldName(b.name))
      || (!!pb.partnerWith && foldName(pb.partnerWith) === foldName(a.name));
  }
  if (pa.partner && pb.partner) return true;
  if (pa.partnerGroup && pa.partnerGroup === pb.partnerGroup) return true;
  if (pa.friendsForever && pb.friendsForever) return true;
  if ((pa.chooseBackground && pb.background) || (pb.chooseBackground && pa.background)) return true;
  if ((pa.doctorsCompanion && pb.doctor) || (pb.doctorsCompanion && pa.doctor)) return true;
  return false;
}

// Can this card lead a deck under `rules`? true, false, or null when the row is too
// thin to say — no type line, or a legendary noncreature whose text was never read.
export function canBeCommander(card, rules) {
  const words = typeWords(card);
  if (!words.length) return null;
  const legendary = words.includes('Legendary');
  if (legendary && words.includes('Creature')) return true;
  if (legendary && rules && rules.commander && rules.commander.planeswalkers && words.includes('Planeswalker')) return true;
  // A Background leads as the second half of a "Choose a Background" pair, which
  // the pairing check judges.
  if (words.includes('Background')) return true;
  if (/\bcan be your commander\b/i.test(String(card.oracle_text || ''))) return true;
  // Every commander is legendary, so that much is known without the text.
  if (!legendary) return false;
  return card.oracle_text ? false : null;
}

// Everything wrong with a deck under its format, as warnings: an unfinished deck is
// the normal state of one being built, so nothing here refuses a write. Each is
// { code, ...details } for the deck builder to put into words.
export function deckWarnings({ game, format, cards }) {
  const rules = rulesFor(game, format);
  const list = (cards || []).filter(c => c && Number(c.quantity) > 0);
  const warnings = [];

  const total = list.reduce((sum, c) => sum + Number(c.quantity), 0);
  const { exact, min, max } = rules.size;
  if (exact != null) {
    if (total !== exact) warnings.push({ code: 'size_exact', expected: exact, actual: total });
  } else {
    if (min != null && total < min) warnings.push({ code: 'size_min', min, actual: total });
    if (max != null && total > max) warnings.push({ code: 'size_max', max, actual: total });
  }

  // Copies are counted by name, across every printing of it.
  const byName = new Map();
  for (const c of list) {
    const key = foldName(c.name);
    const seen = byName.get(key);
    if (seen) seen.count += Number(c.quantity);
    else byName.set(key, { card: c, count: Number(c.quantity) });
  }
  for (const { card, count } of byName.values()) {
    const limit = copyLimit(card, rules);
    if (count > limit) warnings.push({ code: 'copy_limit', name: card.name, count, limit });
  }

  if (!rules.commander) return warnings;

  const commanders = list.filter(c => c.is_commander);
  if (!commanders.length) {
    warnings.push({ code: 'commander_missing' });
    return warnings;
  }
  if (commanders.length > rules.commander.max) {
    warnings.push({ code: 'commander_too_many', count: commanders.length, max: rules.commander.max });
  }
  for (const c of commanders) {
    // A Background only ever leads beside a commander that chooses one.
    const lonelyBackground = commanders.length === 1 && pairingAbilities(c).background && !typeWords(c).includes('Creature');
    if (canBeCommander(c, rules) === false || lonelyBackground) {
      warnings.push({ code: 'commander_not_legal', name: c.name });
    }
  }
  if (commanders.length === 2) {
    const [a, b] = commanders;
    // Pairing is read from the text, so a row without any cannot be judged — saying
    // nothing beats calling a legal partner pair illegal.
    if (a.oracle_text && b.oracle_text && !isLegalPair(a, b)) {
      warnings.push({ code: 'commander_pair', names: [a.name, b.name] });
    }
  }

  const identity = new Set();
  for (const c of commanders) for (const color of colorIdentity(c)) identity.add(color);
  const outside = [];
  for (const c of list) {
    if (c.is_commander) continue;
    const off = inWubrg(colorIdentity(c)).filter(color => !identity.has(color));
    if (off.length) outside.push({ name: c.name, colors: off });
  }
  if (outside.length) warnings.push({ code: 'color_identity', identity: inWubrg(identity), cards: outside });

  return warnings;
}
