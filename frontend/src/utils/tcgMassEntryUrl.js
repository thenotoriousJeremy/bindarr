// A TCGplayer Mass Entry link that arrives with the list already filled in.
//
// /massentry reads two query parameters. Both shapes below were read off the
// page's own bundle (its MassEntryExpressions and MassEntryQueryDelimiter), not
// guessed:
//
//   c            entries joined by a literal `||`, each one of
//                  ^qty name$   ^qty name [SET]$   ^qty name [SET] number$   ^qty-productId$
//                Each entry is encodeURIComponent'd on its own and the delimiter
//                stays raw — the form TCGplayer's "Create a Shareable Link" emits.
//   productline  matched by NAME, case-insensitively, against TCGplayer's product
//                lines (GET mpapi.tcgplayer.com/v2/massentry/productLines):
//                'Magic' (1), 'Pokemon' (3), 'Pokemon Japan' (85), 'Lorcana TCG' (71).
//                Japanese Pokémon is its own catalogue there, so it is its own line.
//
// A `qty-productId` entry names the exact product, which beats any name search:
// TCGplayer fills in the name, set and number itself. The page only resolves ids
// when the FIRST entry is one, and then rebuilds the list from the ids alone, so
// ids are used only when every entry has one; otherwise every entry is a name.
//
// Length: TCGplayer's front end answers 414 once the request line passes about
// 8,190 bytes (probed 2026-11-07: an 8,190-character URL loads, 8,300 does not).
// A link is only built under MAX_URL_LENGTH; past it, `url` is null and the caller
// falls back to `text`, which Mass Entry's text box accepts one entry per line.

export const MASS_ENTRY_URL = 'https://www.tcgplayer.com/massentry';
export const MAX_URL_LENGTH = 8000;

const PRODUCT_LINES = { mtg: 'Magic', pokemon: 'Pokemon', lorcana: 'Lorcana TCG' };

export function productLine(game, language) {
  const g = String(game || '').toLowerCase();
  if (g === 'pokemon' && /^(ja|japanese)$/i.test(String(language || '').trim())) return 'Pokemon Japan';
  return PRODUCT_LINES[g] || PRODUCT_LINES.mtg;
}

const quantityOf = (item) => Math.max(1, parseInt(item && item.quantity, 10) || 1);
// One line of text. `||` would split the entry and brackets would end the set
// code early, so neither survives into a field.
const clean = (s) => String(s == null ? '' : s).replace(/\|\|+/g, '|').replace(/\s+/g, ' ').trim();

// "2 Lightning Bolt", "1 Pikachu [SV01] 25". The set code (and with it the
// number) is only written when TCGplayer's own code for the set is known: a wrong
// code is worse than none, because the entry then names a set that does not exist.
export function massEntryLine(item) {
  const name = clean(item && item.name);
  if (!name) return '';
  const set = clean(item.setCode).replace(/[[\]]/g, '');
  const number = clean(item.number);
  const tail = set ? ` [${set}]${number ? ` ${number}` : ''}` : '';
  return `${quantityOf(item)} ${name}${tail}`;
}

// Merge entries for the same card (two missing finishes of one card are one
// product on TCGplayer, bought twice) and drop the ones nothing can identify.
function merge(items) {
  const byKey = new Map();
  for (const item of items || []) {
    if (!item) continue;
    const name = clean(item.name);
    const productId = Number(item.productId) > 0 ? Number(item.productId) : null;
    if (!name && !productId) continue;
    const key = productId ? `id:${productId}` : `n:${name.toLowerCase()}|${clean(item.setCode).toLowerCase()}|${clean(item.number).toLowerCase()}`;
    const prev = byKey.get(key);
    if (prev) prev.quantity += quantityOf(item);
    else byKey.set(key, { ...item, name, productId, quantity: quantityOf(item) });
  }
  return [...byKey.values()];
}

// items: [{ quantity, name, setCode?, number?, productId? }]
// Returns { url, text, count }: `url` is null when there is nothing to buy or the
// link would be too long, and `text` is always the paste-able list.
export function buildMassEntry(items, { game, language } = {}) {
  const wanted = merge(items);
  const text = wanted.map(massEntryLine).filter(Boolean).join('\n');
  if (!wanted.length) return { url: null, text: '', count: 0 };
  const byId = wanted.every(i => i.productId);
  const entries = byId ? wanted.map(i => `${i.quantity}-${i.productId}`) : text.split('\n');
  const url = `${MASS_ENTRY_URL}?productline=${encodeURIComponent(productLine(game, language))}`
    + `&c=${entries.map(e => encodeURIComponent(e)).join('||')}`;
  return { url: url.length <= MAX_URL_LENGTH ? url : null, text, count: wanted.length };
}

// The bare page for a product line, for the copy-and-paste fallback.
export const massEntryPage = (game, language) =>
  `${MASS_ENTRY_URL}?productline=${encodeURIComponent(productLine(game, language))}`;
