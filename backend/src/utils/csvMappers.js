const languages = require('./languages');

const CONDITION_MAP = {
  'near mint': 'Near Mint', 'nm': 'Near Mint', 'near_mint': 'Near Mint',
  'lightly played': 'Lightly Played', 'lp': 'Lightly Played', 'lightly_played': 'Lightly Played',
  'moderately played': 'Moderately Played', 'mp': 'Moderately Played',
  'heavily played': 'Heavily Played', 'hp': 'Heavily Played',
  'damaged': 'Damaged', 'dmg': 'Damaged', 'poor': 'Damaged',
  // Cardmarket's grades, which ManaBox ("light_played") and Dragon Shield
  // ("LightPlayed") write. That scale runs a step stricter than TCGplayer's, so a
  // grade lands one below its namesake, as the DragonShield-to-Moxfield converter
  // maps them. Near Mint is the best grade a copy can have here.
  'mint': 'Near Mint', 'excellent': 'Near Mint', 'good': 'Lightly Played',
  'light played': 'Moderately Played', 'played': 'Heavily Played'
};

// Header text varies by exporter and by export version ("Card number",
// "Collector number", "Collector Number", "card_number"), and so do values
// ("NearMint", "near_mint", "Near Mint"). Both are compared case-, space- and
// punctuation-blind, accents dropped so "Pokémon" reads as "pokemon". A UTF-8 BOM
// on the first header disappears the same way.
const squash = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');

// Longest first, so "lightlyplayed" is not read as "lp" plus leftovers.
const CONDITIONS = Object.entries(CONDITION_MAP)
  .map(([text, condition]) => [squash(text), condition])
  .sort((a, b) => b[0].length - a[0].length);

// A finish cell, in collection.printing's vocabulary, or null when unreadable.
// The column has a CHECK constraint, so the raw "Foil" TCGplayer and Dragon
// Shield write used to fail the whole import. Magic and Lorcana keep their foil
// under 'Holofoil' (see cardOptions.getPrintings). Etched has no value of its
// own; it is a foil, never a nonfoil.
function printingFrom(value) {
  if (value === true) return 'Holofoil';
  const v = squash(value);
  if (['', 'normal', 'nonfoil', 'regular', 'false', '0', 'no', 'none', 'unlimited'].includes(v)) return 'Normal';
  if (v.startsWith('reverse')) return 'Reverse Holofoil';
  if (v.startsWith('1stedition') || v.startsWith('firstedition')) return '1st Edition';
  if (v === 'promo') return 'Promo';
  if (['true', '1', 'yes', 'holo', 'premium'].includes(v) || v.endsWith('foil') || v.endsWith('etched')) return 'Holofoil';
  return null;
}

// TCGplayer's seller export puts the finish in the condition cell ("Near Mint
// Foil", "Lightly Played Reverse Holofoil"), so whatever follows the grade is
// read as a printing. Anything unrecognised is Near Mint, as it always was.
function conditionFrom(value) {
  const v = squash(value);
  const hit = CONDITIONS.find(([text]) => v.startsWith(text));
  const rest = hit ? v.slice(hit[0].length) : '';
  const printing = rest ? printingFrom(rest) : null;
  if (!hit || (rest && !printing)) return { condition: 'Near Mint', printing: null };
  return { condition: hit[1], printing };
}

function gameFrom(value) {
  const v = squash(value);
  if (!v) return null;
  if (v === 'mtg' || v.includes('magic')) return 'mtg';
  if (v.includes('lorcana')) return 'lorcana';
  if (v.includes('pokemon')) return 'pokemon';
  return null;
}

// Bindarr's own ids carry their game (see utils/cardApi).
function gameOfId(id) {
  const raw = String(id || '').toLowerCase();
  if (raw.startsWith('mtg-')) return 'mtg';
  if (raw.startsWith('lorcana-')) return 'lorcana';
  if (raw.startsWith('tcgdex-') || raw.startsWith('pokemontcgapi-')) return 'pokemon';
  return null;
}

// Columns only Magic tools write: a file that has one is a Magic file, whichever
// app made it. Scryfall is Magic-only; "Tradelist Count" is Moxfield's and
// Deckbox's; "Trade Quantity" is Dragon Shield's.
const MTG_ONLY_COLUMNS = ['scryfallid', 'manaboxid', 'oracleid', 'tradelistcount', 'tradequantity'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// How many copies a row says. Absent or blank means one: a file without a
// quantity column lists a copy per row. A stated number is kept as stated, zero
// included, and an unreadable one is NaN. The route skips both rather than
// inventing a copy; `parseInt(x, 10) || 1` used to turn "0" into one.
function parseQuantity(raw) {
  if (raw == null || String(raw).trim() === '') return 1;
  return parseInt(String(raw).trim(), 10);
}

// "$1.50", "1,50", "" -> a number. Whichever of comma and dot comes last is the
// decimal mark, so a European "1,50" is not read as 150.
function parsePrice(raw) {
  let s = String(raw ?? '').replace(/[^0-9.,-]/g, '');
  s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Look a column up by any of its spellings: the first non-blank one wins.
function columns(row) {
  const byKey = new Map();
  for (const [header, value] of Object.entries(row || {})) {
    const key = squash(header);
    if (key && !byKey.has(key)) byKey.set(key, value);
  }
  return (...names) => {
    for (const name of names) {
      const value = byKey.get(name);
      if (value != null && String(value).trim() !== '') return String(value).trim();
    }
    return undefined;
  };
}

// One CSV row -> an import item. Every strategy reads the same columns. They only
// differ in the game a row is assumed to be when nothing in the file says so.
function mapRow(row, { defaultGame = 'pokemon', mtgFile = false } = {}) {
  const col = columns(row);
  // The Scryfall id is the most exact identity a row can carry: card_cache's own
  // primary key for that printing, language and variant included, where a set and
  // a number only narrow it down.
  const scryfallId = col('scryfallid', 'scryfalluuid');
  const cardId = col('cardid') || (scryfallId && UUID.test(scryfallId) ? `mtg-${scryfallId.toLowerCase()}` : undefined);
  const finish = col('printing', 'finish', 'foil', 'isfoil', 'premium');
  const graded = conditionFrom(col('condition'));
  const setCode = col('setcode', 'setid', 'editioncode', 'set', 'edition');
  return {
    // TCGplayer's "Name" carries the variant ("Pikachu ex - 063/198"); its
    // "Simple Name" is the card's.
    name: col('simplename', 'name', 'cardname', 'productname', 'card'),
    set_code: setCode,
    // With a code column beside it, TCGplayer's "Set" holds the set's name.
    set_name: col('setname', 'editionname') || (col('setcode', 'setid') ? col('set') : undefined),
    collector_number: col('collectornumber', 'cardnumber', 'number', 'cardno', 'collectorno', 'cn'),
    card_id: cardId,
    quantity: parseQuantity(col('quantity', 'qty', 'count', 'amount')),
    condition: graded.condition,
    printing: (finish !== undefined && printingFrom(finish)) || graded.printing || 'Normal',
    language: languages.toName(col('language', 'lang')),
    purchase_price: parsePrice(col('purchaseprice', 'pricebought', 'pricepaid')),
    game: gameFrom(col('game', 'productline')) || gameOfId(cardId) || (mtgFile ? 'mtg' : null) || defaultGame
  };
}

const STRATEGIES = {
  // Every .csv the Settings page uploads lands here (it sends format 'csv'), so
  // the column names other apps use are read too: without a set and a number
  // the row cannot be resolved to a card at all (#75).
  internal: (row, ctx) => mapRow(row, { ...ctx, defaultGame: 'pokemon' }),
  // TCGplayer sells every game, and its collection export names none of them.
  tcgplayer: (row, ctx) => mapRow(row, { ...ctx, defaultGame: 'pokemon' }),
  // Both are Magic collection apps: their exports are Magic whatever they hold.
  dragonshield: (row, ctx) => mapRow(row, { ...ctx, defaultGame: 'mtg' }),
  manabox: (row, ctx) => mapRow(row, { ...ctx, defaultGame: 'mtg' })
};

function parseThirdPartyCSV(rows, formatType = 'tcgplayer') {
  const formatKey = (formatType || 'internal').toLowerCase();
  const strategy = STRATEGIES[formatKey] || STRATEGIES.internal;
  const headers = new Set(Object.keys((rows && rows[0]) || {}).map(squash));
  const mtgFile = MTG_ONLY_COLUMNS.some(column => headers.has(column));
  return (rows || []).map(row => strategy(row, { mtgFile }))
    // A row naming no card at all is padding, not an unmatched card: Dragon
    // Shield ends every export with one.
    .filter(item => item.name || item.card_id || item.set_code || item.collector_number);
}

// One decklist line -> { quantity, name, set_code, collector_number, foil }, or
// null for a line that is not a card (a heading, a comment, a blank).
//
// The printing forms exporters write, all of which used to leave their tokens
// stuck to the name ("Master Transmuter CON-31" matches no card):
//   2 Lightning Bolt (2X2) 117          MTG Arena, Moxfield, ManaBox, Archidekt
//   1 Sol Ring (C21) 263 *F*            with a foil (*F*) or etched (*E*) marker
//   1 Master Transmuter (PLST) CON-31   The List: a set-prefixed collector number
//   1 Blaze (POR) 118†                  Scryfall's own variant marks (†, ★)
//   4 [M10:146] Lightning Bolt          XMage, before or after the name
//   4 Pikachu ex SVI 63                 Pokémon TCG Live
// The front-end twin is frontend/src/utils/deckText.js parseDeckLine.
//
// A collector number is whatever follows the set code up to the next space, as
// long as it has a digit: "263", "12a", "CON-31", "339★". The † and ★ stay on
// it, because they are Scryfall's: POR 118† is a different printing from POR 118.
const NUMBER = String.raw`[^\s*()[\]]*\d[^\s*()[\]]*`;
const XMAGE = new RegExp(String.raw`\[([A-Za-z0-9]{2,6}):(${NUMBER})\]`);
// Lazy name, end-anchored: the LAST "(SET) NUM" is the printing, so a name with
// parentheses of its own ("B.F.M. (Big Furry Monster) (UGL) 28") survives. A bare
// "foil" or "etched" only counts after a printing: Foil is also a card (Prophecy).
const PAREN = new RegExp(String.raw`^(.*?)\s*\(([A-Za-z0-9]{2,6})\)(?:\s+#?(${NUMBER}))?(?:\s+(foil|etched))?$`, 'i');
// Anchored on both ends so it never eats a name that ends in an uppercase word
// ("Pikachu V", "Mewtwo GX").
const PTCGL = /^(.+?)\s+([A-Z]{2,4})\s+(\d+[a-zA-Z]?)$/;

function parseDecklistLine(line) {
  // The longest card name is under 150 characters. Bounding the line bounds the
  // backtracking of the patterns above on a pasted wall of text.
  if (String(line ?? '').length > 500) return null;
  const match = String(line ?? '').match(/^\s*(\d+)x?\s+(.+?)\s*$/i);
  if (!match) return null;
  let rest = match[2];
  let set_code;
  let collector_number;

  let foil = /\*(?:F|E|foil|etched)\*/i.test(rest);
  rest = rest.replace(/\*[^*\s]*\*/g, ' ');

  const xmage = rest.match(XMAGE);
  if (xmage) {
    [, set_code, collector_number] = xmage;
    rest = rest.replace(xmage[0], ' ');
  }
  // Archidekt's [Category] and ^Label^ tags name nothing about the card.
  rest = rest.replace(/\[[^\]]*\]|\^[^^]*\^/g, ' ').replace(/\s+/g, ' ').trim();

  if (!set_code) {
    const paren = rest.match(PAREN);
    const ptcgl = !paren && rest.match(PTCGL);
    if (paren) {
      [, rest, set_code, collector_number] = paren;
      foil = foil || !!paren[4];
    } else if (ptcgl) {
      [, rest, set_code, collector_number] = ptcgl;
    }
  }

  const name = rest
    .replace(/\s*#\d+[a-zA-Z]?$/, '')       // "#63"
    .replace(/\s+\d+[a-zA-Z]?$/, '')        // a bare trailing collector number
    .trim();
  if (!name) return null;
  return { quantity: parseInt(match[1], 10), name, set_code, collector_number, foil };
}

// ManaBox's plain-text export is a decklist: `2 Card Name (SET) 123`, with `*F*`
// for foil copies. Only lines naming a printing count, since the collection import
// files exact printings; the rest are headings ("// COMMANDER"). Duplicate lines
// are grouped because an export may list one printing in several sections, and a
// printing whose lines add up to no copies is dropped.
function parseManaboxText(data) {
  if (typeof data !== 'string') return [];
  const items = new Map();

  for (const line of data.split(/\r?\n/)) {
    const parsed = parseDecklistLine(line);
    if (!parsed || !parsed.set_code || !parsed.collector_number) continue;

    const { name, set_code, collector_number } = parsed;
    // A ★ number is only ever printed in foil (Seventh Edition's black-bordered
    // foils), which is why this used to read the star as a foil marker.
    const printing = parsed.foil || collector_number.includes('★') ? 'Holofoil' : 'Normal';
    const key = `${set_code.toLowerCase()}|${collector_number.toLowerCase()}|${printing}`;
    const item = items.get(key) || {
      name,
      set_code,
      collector_number,
      quantity: 0,
      condition: 'Near Mint',
      printing,
      game: 'mtg'
    };
    item.quantity += parsed.quantity;
    items.set(key, item);
  }

  return [...items.values()].filter(item => item.quantity > 0);
}

module.exports = {
  CONDITION_MAP,
  STRATEGIES,
  parseQuantity,
  parsePrice,
  parseThirdPartyCSV,
  parseDecklistLine,
  parseManaboxText
};
