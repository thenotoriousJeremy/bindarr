// Scryfall search syntax for Magic, shared by the frontend and the backend.
//
// One parser, two ways of answering:
//
//   · Search & Add hands the query to Scryfall intact, because Scryfall already
//     understands its own syntax (backend/src/scryfallApi.js runSyntaxSearch). This
//     module only decides that the box holds syntax rather than a card name, and
//     refuses a query that cannot parse, so a stray quote is named here instead of
//     coming back from Scryfall as "no results".
//   · The collection filter and the deck builder's "from my collection" search
//     answer the query from the cached card rows (compileFilter), because Scryfall
//     cannot see what you own. That covers the keywords those rows can answer;
//     anything else is a named "unsupported" error, never a silent empty result.
//
// ESM with no imports, so Vite serves it to the browser as-is (a CommonJS file is
// served verbatim in dev, where `require` does not exist) and the CommonJS backend
// loads it with import() (backend/src/utils/scryfallSyntax.js). The language table
// is passed in rather than imported for the same reason: each side already holds
// shared/languages in the form it can load.
//
// The grammar is Scryfall's (https://scryfall.com/docs/syntax): terms side by side
// must all match, `or` between terms, parentheses group, `-` negates a term or a
// group. A keyword term is keyword + comparator (: = != < <= > >=) + value, and the
// value is bare, "quoted" or a /regex/. A bare word or "phrase" searches the card
// name; !name and !"exact name" match it exactly.
//
// Every keyword Scryfall documents is known here. One that is not is an error, not
// a pass-through: Scryfall drops a term it does not understand with a warning that
// nobody sees, which turns a typo into a much broader search.

// ---------------------------------------------------------------- errors

// English text for each error. The frontend shows syntax.err.<code> from its locale
// files with the same placeholders, and falls back to this text; the backend sends
// this text in its 400s, so API callers get a readable reason too.
const MESSAGES = {
  empty: () => 'Type a card name or a Scryfall search.',
  unterminatedQuote: () => 'Unbalanced quotes: add the closing ".',
  unterminatedRegex: () => 'Unfinished regular expression: add the closing /.',
  unbalancedParens: () => 'Unbalanced parentheses: every ( needs a ).',
  emptyGroup: () => 'Empty parentheses: put a search term inside them.',
  danglingNegation: () => '"-" must be followed by a search term, like -t:land.',
  danglingOperator: (p) => `"${p.word}" needs a search term on both sides.`,
  emptyValue: (p) => `"${p.keyword}" needs a value after it.`,
  unknownKeyword: (p) => `Unsupported: "${p.keyword}" is not a Scryfall search keyword.`,
  unsupportedKeyword: (p) => `Unsupported: "${p.keyword}" works in card search, but not on your collection.`,
  unsupportedValue: (p) => `Unsupported: "${p.term}" can't filter your collection.`,
  regexUnsupported: () => 'Unsupported: regular expressions work in card search, but not on your collection.',
  unsupportedComparator: (p) => `"${p.keyword}" can't be used with "${p.comparator}".`,
  invalidNumber: (p) => `"${p.term}" needs a number.`,
  invalidColor: (p) => `"${p.value}" is not a color. Use letters like wu, c for colorless, m for multicolor, or a name like azorius.`,
  invalidRarity: (p) => `"${p.value}" is not a rarity. Use common, uncommon, rare, mythic, special or bonus.`,
  invalidMana: (p) => `"${p.value}" is not a mana cost, like 2GG or 3WU.`,
  invalidLanguage: (p) => `"${p.value}" is not a card language, like ja or japanese.`,
  // Raised by the backend when Scryfall itself refuses a query it was sent.
  upstreamRejected: (p) => `Scryfall couldn't run this search: ${p.detail}`,
};

export const ERROR_CODES = Object.keys(MESSAGES);

export class QuerySyntaxError extends Error {
  constructor(code, params = {}) {
    super(MESSAGES[code] ? MESSAGES[code](params) : code);
    this.name = 'QuerySyntaxError';
    this.code = code;
    this.params = params;
  }
}

const fail = (code, params) => { throw new QuerySyntaxError(code, params); };

// ---------------------------------------------------------------- keywords

// Canonical keyword -> the other spellings Scryfall accepts for it. Aliases are
// folded to the canonical name on the way into the tree, so the evaluator below
// reads one spelling; the typed one is kept on the node for messages.
const KEYWORDS = {
  name: [],
  type: ['t'],
  oracle: ['o'],
  fulloracle: ['fo'],
  keyword: ['kw'],
  mana: ['m'],
  manavalue: ['mv', 'cmc'],
  color: ['c', 'colour'],
  identity: ['id', 'ci', 'commander', 'cmd'],
  power: ['pow'],
  toughness: ['tou'],
  powtou: ['pt'],
  loyalty: ['loy'],
  defense: ['def'],
  rarity: ['r'],
  set: ['s', 'e', 'edition'],
  number: ['cn'],
  lang: ['language'],
  is: [],
  not: [],
  usd: [],
  eur: [],
  tix: [],
  // Scryfall answers these from data the card cache does not hold (tagger tags,
  // formats, artists, frames, reprint history...). Fine in card search only.
  has: [], devotion: [], produces: [],
  otag: ['oracletag', 'function'], atag: ['art', 'arttag'],
  block: ['b'], settype: ['st'], in: [], cube: [],
  format: ['f', 'legal'], banned: [], restricted: [],
  artist: ['a'], artists: [], flavor: ['ft'], watermark: ['wm'],
  border: [], frame: [], stamp: [], game: [], year: [], date: [], new: [],
  illustrations: [], prints: [], sets: [], papersets: ['paperprints'],
  lore: [], oracleid: [], illustrationid: [], layout: [],
  // Result-shape directives: they choose how results are shown, never which
  // cards match, so the collection filter accepts and ignores them.
  unique: [], order: [], direction: [], prefer: [], include: [], display: [], sort: [],
};

const CANONICAL = new Map();
for (const [name, aliases] of Object.entries(KEYWORDS)) {
  CANONICAL.set(name, name);
  for (const alias of aliases) CANONICAL.set(alias, name);
}

const DIRECTIVES = new Set(['unique', 'order', 'direction', 'prefer', 'include', 'display', 'sort']);

// Keywords whose value is a word, not a quantity: `<` on them means nothing.
const TEXT_KEYWORDS = new Set(['name', 'type', 'oracle', 'fulloracle', 'keyword', 'set', 'lang', 'is', 'not']);

// ---------------------------------------------------------------- detection

// Does the box hold Scryfall syntax rather than a card name? A plain name never
// has these shapes, so detection keeps every existing name search exactly as it
// was: "Fire // Ice", "Circle of Protection: Red" (a colon followed by a space)
// and "Fight or Flight" (a bare `or`) all stay names. A quote or a parenthesis
// does make a query syntax — the handful of names that contain one ("B.F.M. (Big
// Furry Monster)") still find themselves, since every word of them is in the name.
const SYNTAX_SIGNALS = [
  /(?:^|[\s(])-?[a-z_]+(?:!=|<=|>=|[:=<>])(?=[^\s)])/i, // keyword term with its value: t:creature, cmc<=3
  /["()]/,                                             // a "phrase" or a (group)
  /(?:^|\s)-(?=\S)/,                                   // a negated term: -t:land
  /(?:^|[\s(])!(?=[^\s=])/,                            // an exact name: !fire
  /(?:^|[\s(])\/(?=[^\s/])/,                           // a /regex/ name
];

export function looksLikeSyntax(text) {
  const s = String(text || '').trim();
  return !!s && SYNTAX_SIGNALS.some(re => re.test(s));
}

// ---------------------------------------------------------------- tokenizer

const KEYWORD_RE = /^([a-z_]+)(!=|<=|>=|:|=|<|>)/i;
const isSpace = (ch) => /\s/.test(ch);

// "..." starting at s[i]. \" is a literal quote inside one.
function readQuoted(s, i) {
  let value = '';
  let j = i + 1;
  while (j < s.length && s[j] !== '"') {
    if (s[j] === '\\' && s[j + 1] === '"') { value += '"'; j += 2; continue; }
    value += s[j];
    j += 1;
  }
  if (j >= s.length) fail('unterminatedQuote');
  return { value, end: j + 1 };
}

// /.../ starting at s[i]. Escapes are kept as typed: they belong to the regex.
function readRegex(s, i) {
  let value = '';
  let j = i + 1;
  while (j < s.length && s[j] !== '/') {
    if (s[j] === '\\' && j + 1 < s.length) { value += s[j] + s[j + 1]; j += 2; continue; }
    value += s[j];
    j += 1;
  }
  if (j >= s.length) fail('unterminatedRegex');
  return { value, end: j + 1 };
}

// A bare word: up to whitespace or a parenthesis. A quote inside one opens a
// quoted stretch that runs to the next quote, as in a shell, so quotes in a query
// always have to balance.
function readWord(s, i) {
  let value = '';
  let j = i;
  while (j < s.length && !isSpace(s[j]) && s[j] !== '(' && s[j] !== ')') {
    if (s[j] === '"') {
      const q = readQuoted(s, j);
      value += q.value;
      j = q.end;
      continue;
    }
    value += s[j];
    j += 1;
  }
  return { value, end: j };
}

// A slash opens a regex only when something other than a slash or a space follows
// it, so the split-card separator in "Fire // Ice" is just a word.
const opensRegex = (s, i) => s[i] === '/' && i + 1 < s.length && s[i + 1] !== '/' && !isSpace(s[i + 1]);

function tokenize(text) {
  const s = String(text);
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (isSpace(ch)) { i += 1; continue; }
    if (ch === '(') { tokens.push({ kind: 'open' }); i += 1; continue; }
    if (ch === ')') { tokens.push({ kind: 'close' }); i += 1; continue; }

    let negated = false;
    if (ch === '-') {
      const next = s[i + 1];
      if (next === undefined || isSpace(next) || next === ')') fail('danglingNegation');
      if (next === '(') { tokens.push({ kind: 'open', negated: true }); i += 2; continue; }
      negated = true;
      i += 1;
    }
    const term = (node, end) => { tokens.push({ kind: 'term', negated, node }); i = end; };

    // !fire, !"fire // ice": the name exactly.
    if (s[i] === '!' && i + 1 < s.length && s[i + 1] !== '=' && !isSpace(s[i + 1])) {
      const quoted = s[i + 1] === '"';
      const r = quoted ? readQuoted(s, i + 1) : readWord(s, i + 1);
      if (!r.value) fail('emptyValue', { keyword: '!' });
      term({ type: 'name', value: r.value, exact: true, quoted }, r.end);
      continue;
    }
    if (s[i] === '"') {
      const r = readQuoted(s, i);
      term({ type: 'name', value: r.value, quoted: true }, r.end);
      continue;
    }
    if (opensRegex(s, i)) {
      const r = readRegex(s, i);
      term({ type: 'name', value: r.value, regex: true }, r.end);
      continue;
    }

    const m = KEYWORD_RE.exec(s.slice(i));
    if (m) {
      const keyword = CANONICAL.get(m[1].toLowerCase());
      const at = i + m[0].length;
      const bare = at >= s.length || isSpace(s[at]) || s[at] === ')';
      if (keyword) {
        const kind = s[at] === '"' ? 'quoted' : (opensRegex(s, at) ? 'regex' : 'bare');
        const r = kind === 'quoted' ? readQuoted(s, at) : (kind === 'regex' ? readRegex(s, at) : readWord(s, at));
        if (bare || (kind === 'bare' && !r.value)) fail('emptyValue', { keyword: `${m[1].toLowerCase()}${m[2]}` });
        term({
          type: 'term', keyword, typed: m[1].toLowerCase(), cmp: m[2], value: r.value,
          quoted: kind === 'quoted', regex: kind === 'regex',
        }, r.end);
        continue;
      }
      // "Protection:" followed by a space is part of a name (Circle of Protection:
      // Red); "protection:red" is a keyword Scryfall does not have.
      if (!bare) fail('unknownKeyword', { keyword: `${m[1].toLowerCase()}${m[2]}` });
    }

    const r = readWord(s, i);
    // Only the bare words: "or" in quotes is a name to look for.
    if (!negated && /^(or|and)$/i.test(s.slice(i, r.end))) {
      tokens.push({ kind: r.value.toLowerCase() });
      i = r.end;
      continue;
    }
    term({ type: 'name', value: r.value }, r.end);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

// Precedence, loosest first: or, then and (explicit or side by side), then -.
function parseTokens(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const at = (...kinds) => !!peek() && kinds.includes(peek().kind);

  function parseOr() {
    const terms = [parseAnd()];
    while (at('or')) {
      pos += 1;
      if (!peek() || at('or', 'and', 'close')) fail('danglingOperator', { word: 'or' });
      terms.push(parseAnd());
    }
    return terms.length === 1 ? terms[0] : { type: 'or', terms };
  }

  function parseAnd() {
    const terms = [];
    while (peek() && !at('or', 'close')) {
      const tok = tokens[pos++];
      if (tok.kind === 'and') {
        if (!terms.length || !peek() || at('or', 'and', 'close')) fail('danglingOperator', { word: 'and' });
        continue;
      }
      terms.push(parseAtom(tok));
    }
    if (!terms.length) {
      if (at('or')) fail('danglingOperator', { word: 'or' });
      fail(at('close') ? 'unbalancedParens' : 'empty');
    }
    return terms.length === 1 ? terms[0] : { type: 'and', terms };
  }

  function parseAtom(tok) {
    if (tok.kind === 'open') {
      if (at('close')) fail('emptyGroup');
      const inner = parseOr();
      if (!at('close')) fail('unbalancedParens');
      pos += 1;
      return tok.negated ? { type: 'not', term: inner } : inner;
    }
    return tok.negated ? { type: 'not', term: tok.node } : tok.node;
  }

  if (!tokens.length) fail('empty');
  const ast = parseOr();
  if (pos < tokens.length) fail('unbalancedParens'); // a ) with no ( before it
  return ast;
}

// The query as a tree:
//   { type: 'and' | 'or', terms }      { type: 'not', term }
//   { type: 'name', value, exact?, quoted?, regex? }        a word, "phrase", !exact
//   { type: 'term', keyword, typed, cmp, value, quoted, regex }   t:creature
// Throws QuerySyntaxError when it cannot be read.
export function parseQuery(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) fail('empty');
  return parseTokens(tokenize(s));
}

// True when any term in the tree passes `test` — e.g. whether the user already
// chose a language, so a search does not add its own on top.
export function someTerm(ast, test) {
  if (!ast) return false;
  if (ast.type === 'and' || ast.type === 'or') return ast.terms.some(t => someTerm(t, test));
  if (ast.type === 'not') return someTerm(ast.term, test);
  return !!test(ast);
}

// ---------------------------------------------------------------- card fields

// Case- and accent-insensitive text: Scryfall finds "Lim-Dûl" from "lim-dul".
const fold = (v) => String(v == null ? '' : v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// List columns arrive as arrays from the API (parseCardRow) but as JSON text from
// a raw row; accept both.
function listOf(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.startsWith('[')) {
    try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}

// The full type line when the row has it. Rows cached before type_line existed
// only carry its words (card_cache.subtypes), which still answer t:elf and
// t:"legendary creature" once joined back up.
function typeLineOf(card) {
  if (typeof card.type_line === 'string' && card.type_line) return fold(card.type_line);
  return listOf(card.subtypes).map(fold).join(' ');
}

const hasTypeLine = (card) => !!typeLineOf(card);
// The type line names this type as a whole word ("land", not "Landfall").
const WORD_RES = new Map();
function typeWord(card, word) {
  if (!WORD_RES.has(word)) WORD_RES.set(word, new RegExp(`(^|[^a-z])${word}([^a-z]|$)`));
  return WORD_RES.get(word).test(typeLineOf(card));
}

const namesOf = (card) => [card.name, card.printed_name].filter(Boolean).map(fold);

// Power, toughness and loyalty are text: "3", "*", "1+*", "X". A star or X counts
// as 0, as it does everywhere off the battlefield.
function statNumber(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const m = /^[+-]?\d+(\.\d+)?/.exec(s);
  if (m) return parseFloat(m[0]);
  if (s === '∞') return Infinity;
  if (/^[*xX?]/.test(s)) return 0;
  return null;
}

// A field a stat may be compared against (pow>tou), by the names Scryfall uses.
const STAT_FIELDS = {
  pow: 'power', power: 'power', tou: 'toughness', toughness: 'toughness',
  loy: 'loyalty', loyalty: 'loyalty', pt: 'powtou', powtou: 'powtou',
  mv: 'cmc', cmc: 'cmc', manavalue: 'cmc',
};

function statOf(card, field) {
  if (field === 'cmc') return card.cmc == null || card.cmc === '' ? null : Number(card.cmc);
  if (field === 'powtou') {
    const p = statNumber(card.power);
    const t = statNumber(card.toughness);
    return p == null || t == null ? null : p + t;
  }
  return statNumber(card[field]);
}

function compare(a, cmp, b) {
  switch (cmp) {
    case ':': case '=': return a === b;
    case '!=': return a !== b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    default: return false;
  }
}

// ---------------------------------------------------------------- colors

const COLOR_BIT = { w: 1, u: 2, b: 4, r: 8, g: 16 };
// Stored rows carry colour names ('Red'); Scryfall's own rows carry letters.
const COLOR_NAME = { white: 'w', blue: 'u', black: 'b', red: 'r', green: 'g' };
const COLOR_WORDS = {
  white: 'w', blue: 'u', black: 'b', red: 'r', green: 'g',
  azorius: 'wu', dimir: 'ub', rakdos: 'br', gruul: 'rg', selesnya: 'gw',
  orzhov: 'wb', izzet: 'ur', golgari: 'bg', boros: 'rw', simic: 'gu',
  bant: 'gwu', esper: 'wub', grixis: 'ubr', jund: 'brg', naya: 'rgw',
  abzan: 'wbg', jeskai: 'urw', sultai: 'bgu', mardu: 'rwb', temur: 'gur',
  quandrix: 'gu', silverquill: 'wb', witherbloom: 'bg', lorehold: 'rw', prismari: 'ur',
  chaos: 'ubrg', aggression: 'wbrg', altruism: 'wurg', growth: 'wubg', artifice: 'wubr',
};

function colorMask(list) {
  let mask = 0;
  for (const entry of listOf(list)) {
    const v = fold(entry);
    const letter = COLOR_NAME[v] || (COLOR_BIT[v] ? v : null);
    if (letter) mask |= COLOR_BIT[letter];
  }
  return mask;
}

const popcount = (mask) => { let n = 0; for (let m = mask; m; m >>= 1) n += m & 1; return n; };

// A colour operand: { mask } for a set of colours (0 is colourless), { count } for
// c=2, { multi } for c:m.
function parseColor(value) {
  const v = fold(value).trim();
  if (/^\d+$/.test(v)) return { count: parseInt(v, 10) };
  if (v === 'm' || v === 'multicolor' || v === 'multicolored') return { multi: true };
  if (v === 'c' || v === 'colorless') return { mask: 0 };
  const letters = COLOR_WORDS[v] || v;
  if (!/^[wubrg]+$/.test(letters)) fail('invalidColor', { value });
  let mask = 0;
  for (const ch of letters) mask |= COLOR_BIT[ch];
  return { mask };
}

// `colon` is what `:` means: "includes" (>=) for colour, "fits within" (<=) for
// identity — c:wu is a card that is at least white and blue, id:wu one that can go
// in a white-blue deck.
function colorTest(cardMask, q, cmp, colon) {
  if (q.multi) return (cmp === '!=') !== (popcount(cardMask) >= 2);
  if (q.count != null) return compare(popcount(cardMask), cmp === ':' ? '=' : cmp, q.count);
  const op = cmp === ':' ? (q.mask === 0 ? '=' : colon) : cmp;
  const superset = (cardMask & q.mask) === q.mask;
  const subset = (cardMask | q.mask) === q.mask;
  switch (op) {
    case '=': return cardMask === q.mask;
    case '!=': return cardMask !== q.mask;
    case '>=': return superset;
    case '>': return superset && cardMask !== q.mask;
    case '<=': return subset;
    case '<': return subset && cardMask !== q.mask;
    default: return false;
  }
}

// ---------------------------------------------------------------- rarity

// Scryfall's order: r>rare is special, mythic and bonus.
const RARITIES = ['common', 'uncommon', 'rare', 'special', 'mythic', 'bonus'];
const RARITY_LETTERS = { c: 'common', u: 'uncommon', r: 'rare', s: 'special', m: 'mythic', b: 'bonus' };

// Stored rarities are display words ('Mythic'), sometimes two ('mythic rare'):
// the first word that names a rarity is the rank.
function storedRarity(stored) {
  for (const word of fold(stored).replace(/_/g, ' ').split(/\s+/)) {
    const rank = RARITIES.indexOf(word);
    if (rank >= 0) return rank;
  }
  return -1;
}

// ---------------------------------------------------------------- mana cost

// A mana cost as a bag of symbols plus its generic amount. Takes Scryfall's braced
// form ({2}{W}{W}, {W/U}, {G/P}) and the shorthand people type (2WW). Hybrid halves
// are sorted, so {U/W} and {W/U} are the same symbol. Null when it is not a cost.
function parseMana(text) {
  const s = String(text == null ? '' : text).replace(/\s+/g, '');
  const bag = { generic: 0, symbols: new Map() };
  const add = (sym) => {
    const up = sym.toUpperCase();
    if (/^\d+$/.test(up)) { bag.generic += parseInt(up, 10); return; }
    const key = up.includes('/') ? up.split('/').sort().join('/') : up;
    bag.symbols.set(key, (bag.symbols.get(key) || 0) + 1);
  };
  let i = 0;
  while (i < s.length) {
    if (s[i] === '{') {
      const end = s.indexOf('}', i);
      if (end < 0 || end === i + 1) return null;
      add(s.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    const digits = /^\d+/.exec(s.slice(i));
    if (digits) { bag.generic += parseInt(digits[0], 10); i += digits[0].length; continue; }
    if (/[wubrgcsx]/i.test(s[i])) { add(s[i]); i += 1; continue; }
    return null;
  }
  return bag;
}

// Does `outer` hold at least every symbol of `inner`?
function manaContains(outer, inner) {
  if (outer.generic < inner.generic) return false;
  for (const [sym, n] of inner.symbols) if ((outer.symbols.get(sym) || 0) < n) return false;
  return true;
}

const manaEquals = (a, b) => manaContains(a, b) && manaContains(b, a);

function manaTest(card, q, cmp) {
  if (card.mana_cost == null) return false; // cached before costs were stored
  // A split or double-faced card has one cost per face; any face may match.
  const faces = String(card.mana_cost).split('//').map(parseMana).filter(Boolean);
  if (!faces.length) faces.push(parseMana(''));
  if (cmp === '!=') return !faces.some(f => manaEquals(f, q));
  return faces.some((f) => {
    switch (cmp) {
      case ':': case '>=': return manaContains(f, q);
      case '>': return manaContains(f, q) && !manaEquals(f, q);
      case '=': return manaEquals(f, q);
      case '<=': return manaContains(q, f);
      case '<': return manaContains(q, f) && !manaEquals(f, q);
      default: return false;
    }
  });
}

// ---------------------------------------------------------------- is: / not:

// The printing values that mean foil (collection.printing; Magic stores its foil
// copies as 'Holofoil' and labels them Foil).
const isFoil = (card) => /foil/i.test(String(card.printing || ''));
const hasRulesText = (card) => typeof card.oracle_text === 'string';
const manaSymbols = (card) => String(card.mana_cost || '').match(/\{[^}]+\}/g) || [];

// What `is:` can answer from a stored row. In the collection, is:foil is about the
// copy you own; Scryfall's is:foil (a printing that comes in foil) still works in
// card search, where the query goes to Scryfall.
const IS_TESTS = {
  foil: isFoil,
  nonfoil: (card) => !isFoil(card),
  permanent: (card) => ['artifact', 'creature', 'enchantment', 'land', 'planeswalker', 'battle'].some(w => typeWord(card, w)),
  spell: (card) => hasTypeLine(card) && !typeWord(card, 'land'),
  historic: (card) => ['legendary', 'artifact', 'saga'].some(w => typeWord(card, w)),
  vanilla: (card) => typeWord(card, 'creature') && hasRulesText(card) && !card.oracle_text.trim(),
  bear: (card) => typeWord(card, 'creature') && Number(card.cmc) === 2
    && statNumber(card.power) === 2 && statNumber(card.toughness) === 2,
  hybrid: (card) => manaSymbols(card).some(sym => sym.slice(1, -1).split('/').filter(p => p.toUpperCase() !== 'P').length >= 2),
  phyrexian: (card) => manaSymbols(card).some(sym => /(^|\/)P(\/|$)/i.test(sym.slice(1, -1)) && sym.includes('/')),
  commander: (card) => (typeWord(card, 'legendary') && typeWord(card, 'creature'))
    || fold(card.oracle_text).includes('can be your commander'),
};

// ---------------------------------------------------------------- compiling

const termText = (node) => `${node.typed}${node.cmp}${node.value}`;

function numberValue(node) {
  const v = String(node.value).trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(v)) fail('invalidNumber', { term: termText(node) });
  return parseFloat(v);
}

function compileName(node) {
  if (node.regex) fail('regexUnsupported');
  const v = fold(node.value);
  if (node.exact) {
    return (card) => namesOf(card).some(n => n === v || n.split(' // ').includes(v));
  }
  return (card) => namesOf(card).some(n => n.includes(v));
}

// One builder per keyword the cached rows can answer: (node, ctx) -> (card) -> bool.
// Text keywords build the `:` test; `!=` negates it (see compileTerm).
const LOCAL = {
  name: (node) => compileName({ value: node.value }),
  type: (node) => {
    const v = fold(node.value);
    return (card) => typeLineOf(card).includes(v);
  },
  oracle: (node) => {
    const v = fold(node.value);
    // ~ stands for the card's own name, as on Scryfall: o:"~ deals 3 damage".
    return (card) => hasRulesText(card) && fold(card.oracle_text).includes(v.split('~').join(fold(card.name)));
  },
  keyword: (node) => {
    const v = fold(node.value);
    return (card) => listOf(card.keywords).some(k => fold(k) === v);
  },
  mana: (node) => {
    const q = parseMana(node.value);
    if (!q || (!q.generic && !q.symbols.size && !/^\{?0\}?$/.test(String(node.value).trim()))) {
      fail('invalidMana', { value: node.value });
    }
    return (card) => manaTest(card, q, node.cmp);
  },
  manavalue: (node) => {
    const v = fold(node.value).trim();
    if (v === 'even' || v === 'odd') {
      if (!['=', ':', '!='].includes(node.cmp)) fail('unsupportedComparator', { keyword: node.typed, comparator: node.cmp });
      return (card) => {
        const mv = statOf(card, 'cmc');
        if (mv == null || !Number.isInteger(mv)) return false;
        return (node.cmp === '!=') !== ((mv % 2 === 0) === (v === 'even'));
      };
    }
    return statTest(node, 'cmc');
  },
  color: (node) => {
    const q = parseColor(node.value);
    return (card) => colorTest(colorMask(card.colors != null ? card.colors : card.types), q, node.cmp, '>=');
  },
  identity: (node) => {
    const q = parseColor(node.value);
    return (card) => colorTest(colorMask(card.color_identity), q, node.cmp, '<=');
  },
  power: (node) => statTest(node, 'power'),
  toughness: (node) => statTest(node, 'toughness'),
  loyalty: (node) => statTest(node, 'loyalty'),
  powtou: (node) => statTest(node, 'powtou'),
  rarity: (node) => {
    const word = fold(node.value).trim();
    const rank = RARITIES.indexOf(RARITY_LETTERS[word] || word);
    if (rank < 0) fail('invalidRarity', { value: node.value });
    const cmp = node.cmp === ':' ? '=' : node.cmp;
    return (card) => {
      const have = storedRarity(card.rarity);
      return have >= 0 && compare(have, cmp, rank);
    };
  },
  set: (node) => {
    const v = fold(node.value).trim();
    return (card) => fold(card.set_id).replace(/^mtg-/, '') === v;
  },
  number: (node) => {
    const v = fold(node.value).trim();
    if (['=', ':', '!='].includes(node.cmp)) {
      return (card) => {
        const have = fold(card.number).trim();
        const same = have === v || (/^\d+$/.test(have) && /^\d+$/.test(v) && Number(have) === Number(v));
        return (node.cmp === '!=') !== same;
      };
    }
    const want = parseInt(v, 10);
    if (!Number.isFinite(want)) fail('invalidNumber', { term: termText(node) });
    // Compared by the number's leading digits, so 51a counts as 51.
    return (card) => {
      const have = parseInt(fold(card.number), 10);
      return Number.isFinite(have) && compare(have, node.cmp, want);
    };
  },
  lang: (node, ctx) => {
    const v = fold(node.value).trim();
    if (v === 'any') return () => true;
    const entry = (ctx.languages || []).find(l => [l.code, l.name, l.scryfall, l.tcgdex].some(x => x && fold(x) === v));
    if (!entry) fail('invalidLanguage', { value: node.value });
    const name = fold(entry.name);
    return (card) => fold(card.language || 'English') === name;
  },
  is: (node) => isTest(node),
  not: (node) => { const test = isTest(node); return (card) => !test(card); },
  usd: (node) => priceTest(node, 'USD'),
  eur: (node) => priceTest(node, 'EUR'),
};
LOCAL.fulloracle = LOCAL.oracle; // only the oracle text is cached, reminder text included

function isTest(node) {
  const test = IS_TESTS[fold(node.value).trim()];
  if (!test) fail('unsupportedValue', { term: `${node.typed}:${node.value}` });
  return test;
}

// pow>=4, tou<pow, loy=3, pt>=10, cmc<=3: against a number or another stat.
function statTest(node, field) {
  const ref = STAT_FIELDS[fold(node.value).trim()];
  const want = ref ? null : numberValue(node);
  const cmp = node.cmp === ':' ? '=' : node.cmp;
  return (card) => {
    const have = statOf(card, field);
    const other = ref ? statOf(card, ref) : want;
    return have != null && other != null && compare(have, cmp, other);
  };
}

// usd>5, eur<1: the copy's price, in that currency only. A row is priced in ONE
// currency (card_cache.price_currency) and nothing is converted, so a euro-priced
// card simply has no dollar price — as on Scryfall, an unpriced card never matches.
function priceTest(node, currency) {
  const want = numberValue(node);
  const cmp = node.cmp === ':' ? '=' : node.cmp;
  return (card) => {
    if (String(card.price_currency || 'USD').toUpperCase() !== currency) return false;
    const have = Number(card.price_trend);
    return have > 0 && compare(have, cmp, want);
  };
}

function compileTerm(node, ctx) {
  if (node.regex) fail('regexUnsupported');
  if (DIRECTIVES.has(node.keyword)) return () => true;
  const build = LOCAL[node.keyword];
  if (!build) fail('unsupportedKeyword', { keyword: `${node.typed}:` });
  const text = TEXT_KEYWORDS.has(node.keyword);
  if (text && !['=', ':', '!='].includes(node.cmp)) {
    fail('unsupportedComparator', { keyword: node.typed, comparator: node.cmp });
  }
  const test = build(node, ctx);
  return text && node.cmp === '!=' ? (card) => !test(card) : test;
}

function compileNode(node, ctx) {
  if (node.type === 'and' || node.type === 'or') {
    const parts = node.terms.map(t => compileNode(t, ctx));
    return node.type === 'and' ? (card) => parts.every(p => p(card)) : (card) => parts.some(p => p(card));
  }
  if (node.type === 'not') {
    const inner = compileNode(node.term, ctx);
    return (card) => !inner(card);
  }
  return node.type === 'name' ? compileName(node) : compileTerm(node, ctx);
}

// The query as a predicate over stored Magic rows: a collection entry (finish and
// language are the copy's) or a card_cache row. Every term is checked up front,
// so an unsupported one throws here — before any row is looked at — instead of
// quietly matching nothing.
//   options.languages: shared/languages rows, which lang: resolves against.
export function compileFilter(query, options = {}) {
  const ast = typeof query === 'string' ? parseQuery(query) : query;
  return compileNode(ast, { languages: options.languages || [] });
}
