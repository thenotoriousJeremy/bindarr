// Set completion: which cards of a set a user owns, and what the rest would cost.
//
// Pure on purpose. routes/setCompletion.js does the I/O — the set's listing from
// setListing.js, the user's copies from the collection — and hands both here, so
// the counting rules can be checked without a database or a provider.
//
// The rules:
//   · A card is owned when the user holds any copy with the same collector number
//     in the same set, whatever its language: a Japanese copy of FDN #1 is FDN #1.
//     Matching by number rather than card id is also what survives a provider
//     switch, where the same card has a different id (sv1-1 vs tcgdex-en-sv01-001).
//   · Wishlist rows do not count as owned.
//   · A price that is not known is not zero. Missing value is summed only over
//     cards with a price, per currency (Scryfall and TCGplayer quote USD, TCGdex
//     and Cardmarket EUR — adding the two would be a number in no currency), and
//     the cards without one are counted separately so the total can say "at least".
const { matcher } = require('./setCatalogueMatch');

// A collector number as every provider can agree on. TCGdex writes '001' where
// pokemontcg.io writes '1', some write 'TG01' where others write 'TG1', and
// TCGplayer appends the set size ('4/102'). So: the part before a slash,
// case-folded, with leading zeros dropped from every digit run. Letters and
// symbols survive — '1a' and '1★' are different cards from '1'.
function numberKey(number) {
  const head = String(number == null ? '' : number).split('/')[0].trim().toLowerCase();
  return head.replace(/(^|[^0-9])0+(?=\d)/g, '$1');
}

// Natural order for collector numbers: 2 before 10, 10 before 10a, and anything
// without a leading number ('TG01', 'SV001') after the plain run.
function compareNumbers(a, b) {
  const pa = /^(\d+)(.*)$/.exec(numberKey(a));
  const pb = /^(\d+)(.*)$/.exec(numberKey(b));
  if (pa && pb) return (Number(pa[1]) - Number(pb[1])) || pa[2].localeCompare(pb[2]);
  if (pa) return -1;
  if (pb) return 1;
  return numberKey(a).localeCompare(numberKey(b), undefined, { numeric: true });
}

const known = (p) => (Number(p) > 0 ? Number(p) : null);

// The finishes a card is known to come in, for games where the finish is part of
// what a collector completes. Read off which price columns were filled — but only
// by a source that prices each finish separately: TCGplayer does (pokemontcg.io
// passes its quotes through, TCGCSV writes one column per subtype) and so does
// pokemontcgapi.com, which labels every quote with its printing. A TCGdex row does
// not qualify: where TCGplayer has no quote it falls back to Cardmarket, whose
// "holo" price on a common is the REVERSE holo, so a priced holo column there is
// not a holo that exists (TCGdex's own variants for sv01-001 are normal + reverse,
// while the row carries a holo price). A card without such data — a TCGdex set
// brief, say — gets [] rather than a guess.
const VARIANTS = [
  { printing: 'Normal', column: 'price_normal' },
  { printing: 'Holofoil', column: 'price_holofoil' },
  { printing: 'Reverse Holofoil', column: 'price_reverse_holofoil' },
  { printing: '1st Edition', column: 'price_1st_edition' },
];
const VARIANT_GAMES = new Set(['pokemon']);
const FINISH_SOURCES = new Set(['tcgcsv', 'tcgcsv-en', 'pokemontcg', 'pokemontcgapi-tcgplayer', 'pokemontcgapi-cardmarket']);

function knownVariants(card) {
  if (!FINISH_SOURCES.has(card.price_source)) return [];
  return VARIANTS.filter(v => known(card[v.column]) != null)
    .map(v => ({ printing: v.printing, price: known(card[v.column]) }));
}

// The user's copies of this set, by collector number.
//
// `rows` are collection rows joined to card_cache (set_id, set_name, number,
// quantity, printing, list_type). A row belongs to the set when its set id or name
// matches it under the same three keys the scan catalogue joins providers with —
// only Pokémon gets the name key, because only Pokémon has two providers that
// number the same set differently (sv1 / sv01, sv3pt5 / sv03.5, where only the name
// "151" agrees). Magic and Lorcana set codes are the same everywhere.
function ownedByNumber(rows, set, game) {
  const match = matcher([{ id: set.id, name: game === 'pokemon' ? set.name : null }]);
  const out = new Map();
  for (const r of rows || []) {
    if (!match(r.set_id, game === 'pokemon' ? r.set_name : null)) continue;
    const key = numberKey(r.number);
    if (!key) continue;
    const entry = out.get(key) || { quantity: 0, printings: {}, wishlist: 0 };
    const qty = Math.max(1, parseInt(r.quantity, 10) || 1);
    if (r.list_type === 'wishlist') {
      entry.wishlist += qty;
    } else {
      entry.quantity += qty;
      const p = r.printing || 'Normal';
      entry.printings[p] = (entry.printings[p] || 0) + qty;
    }
    out.set(key, entry);
  }
  return out;
}

const round2 = (n) => Math.round(n * 100) / 100;

// One mode's numbers. `entries` are { owned, price, currency }.
function summarize(entries) {
  let owned = 0;
  let unpriced = 0;
  const value = {};
  for (const e of entries) {
    if (e.owned) { owned++; continue; }
    if (e.price == null) { unpriced++; continue; }
    value[e.currency] = (value[e.currency] || 0) + e.price;
  }
  const total = entries.length;
  return {
    total,
    owned,
    missing: total - owned,
    // Clamped, and rounded once here so every view shows the same figure.
    percent: total ? Math.min(100, Math.round((owned / total) * 1000) / 10) : 0,
    missing_value: Object.fromEntries(Object.entries(value).map(([c, v]) => [c, round2(v)])),
    unpriced_missing: unpriced,
  };
}

// The entries a card contributes in variant mode: each known finish, plus any
// finish the user owns that the price data did not list (a printing in hand is
// evidence it exists). A card with no finish data at all stays one entry.
function variantEntries(card) {
  return card.variants.length
    ? card.variants.map(v => ({ owned: v.owned > 0, price: v.price, currency: card.price_currency }))
    : [{ owned: card.owned > 0, price: card.price, currency: card.price_currency }];
}

// The whole answer for one set. `cards` are card_cache rows in listing order.
function buildCompletion({ game, set, cards, owned }) {
  const byNumber = ownedByNumber(owned, set, game);
  const withVariants = VARIANT_GAMES.has(game);
  let hasVariantData = false;

  const out = (cards || []).map(card => {
    const own = byNumber.get(numberKey(card.number)) || { quantity: 0, printings: {}, wishlist: 0 };
    let variants = [];
    if (withVariants) {
      const listed = knownVariants(card);
      if (listed.length) hasVariantData = true;
      const extra = VARIANTS
        .filter(v => own.printings[v.printing] && !listed.some(l => l.printing === v.printing))
        .map(v => ({ printing: v.printing, price: known(card[v.column]) }));
      variants = listed.length ? [...listed, ...extra].map(v => ({ ...v, owned: own.printings[v.printing] || 0 })) : [];
    }
    return {
      id: card.id,
      name: card.name,
      printed_name: card.printed_name || null,
      number: card.number || '',
      rarity: card.rarity || '',
      image_url: card.image_url || '',
      image_url_back: card.image_url_back || null,
      language: card.language || 'English',
      game,
      set_id: card.set_id,
      set_name: card.set_name,
      price: known(card.price_trend),
      price_currency: card.price_currency || 'USD',
      tcgplayer_product_id: card.tcgplayer_product_id || null,
      owned: own.quantity,
      owned_printings: own.printings,
      wishlisted: own.wishlist > 0,
      variants,
    };
  }).sort((a, b) => compareNumbers(a.number, b.number));

  return {
    cards: out,
    summary: {
      cards: summarize(out.map(c => ({ owned: c.owned > 0, price: c.price, currency: c.price_currency }))),
      // Null when nothing in the set carries finish data, so the UI can say the
      // variant view is unavailable instead of showing it equal to the card view.
      variants: hasVariantData ? summarize(out.flatMap(variantEntries)) : null,
    },
  };
}

module.exports = { numberKey, compareNumbers, knownVariants, ownedByNumber, summarize, buildCompletion, VARIANTS };
