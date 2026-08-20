// Links to the marketplaces a card's price comes from.
//
// The rule: a "view this card" link resolves to THAT CARD or it does not exist.
// Only two things satisfy that — a TCGplayer product id, or a Cardmarket product
// id — so those are the only things these functions will build one from.
//
// What used to happen instead: when no id was available the link fell back to a
// name search, and the button still said "View on TCGplayer". Measured on the real
// cache, that was every single Pokémon card (TCGdex supplies no TCGplayer link at
// all) plus 6,109 MTG printings where Scryfall itself hands back a search. Worse
// for a Japanese card, where the search runs the localized name against a site that
// indexes English and returns nothing, every time.
//
// A search is still offered — see searchUrl — but as its own separately labelled
// action, so the reader knows which one they are getting.
function cardGame(card) {
  return card?.game || (card?.supertype === 'MTG' ? 'mtg' : 'pokemon');
}

// Does this name stand a chance in an English-language marketplace search?
// Both sites index English names, so a name with no Latin letters cannot match.
function searchable(card) {
  return /[a-z]/i.test(card?.name || '');
}

// True when the stored provider URL is a product page rather than a name search.
//
// Scryfall wraps both forms in the same affiliate redirect
// (partner.tcgplayer.com/c/...?u=<encoded>), so the only way to tell them apart is
// to look for the product path inside the encoded URL. '%2Fproduct%2F' is a product
// page; '%2Fsearch%2Fmagic%2Fproduct%3F' is a search — one character apart at the
// end, which is why this matches the trailing separator too.
const isProductUrl = (url) => /%2Fproduct%2F|\/product\//.test(String(url || ''));

// The card's page on TCGplayer, or null.
export function tcgplayerUrl(card) {
  // The id first. It exists only when the card is genuinely listed, and unlike a
  // stored URL it cannot quietly be a search. MTG gets it from Scryfall's
  // `tcgplayer_id`; Pokémon from the TCGCSV catalogue mapping.
  if (card?.tcgplayer_product_id) {
    return `https://www.tcgplayer.com/product/${card.tcgplayer_product_id}`;
  }
  // A stored URL is honoured only if it actually points at a product. This is what
  // covers rows cached before tcgplayer_product_id existed.
  if (isProductUrl(card?.tcgplayer_url)) return card.tcgplayer_url;
  return null;
}

// The card's page on Cardmarket, or null.
//
// Cardmarket has no public API and blocks automated requests, so there is no id to
// look up and no way to verify a URL from here — every shape below is one a provider
// handed us:
//   - Scryfall's `purchase_uris.cardmarket`, which is the '?idProduct=' form.
//   - TCGdex's `pricing.cardmarket.idProduct`, put into that same form in
//     tcgdexApi.normalizeCard.
// A search fallback is deliberately absent for the same reason as above.
export function cardmarketUrl(card) {
  const url = card?.cardmarket_url;
  return /idProduct=/.test(String(url || '')) ? url : null;
}

// A marketplace SEARCH for the card's name. Never presented as a link to the card —
// the caller labels it as a search, because that is what it is and it may well
// return nothing.
//
// Null for a name with no Latin letters: searching TCGplayer for ヒトカゲ returns
// zero results every time, and an action that cannot work is worse than none.
export function searchUrl(card) {
  if (!searchable(card)) return null;
  const line = cardGame(card) === 'mtg' ? 'magic' : 'pokemon';
  // Name only. Appending set name + number narrowed a lot of searches to zero
  // hits — Scryfall's own links search the bare name for the same reason.
  return `https://www.tcgplayer.com/search/${line}/product?q=${encodeURIComponent(card.name)}`;
}

const isForeignPokemon = (card) =>
  cardGame(card) === 'pokemon' && !!card?.language && card.language !== 'English';

// Which marketplace the displayed price came from, and in what currency.
//
// Read off the row now (card_cache.price_source / price_currency) rather than
// inferred. The old version guessed "Cardmarket EUR" from the card being a
// non-English Pokémon printing, which stopped being true the moment TCGCSV started
// pricing Japanese cards in TCGplayer USD — the label would have named the wrong
// marketplace and the wrong currency for exactly the cards it was written for.
const SOURCE_NAMES = {
  tcgcsv: 'TCGplayer',
  // TCGplayer sells Pokémon in English and Japanese only, so a German, French, Korean
  // or Chinese card is priced off the English product for the same set and number.
  // The qualifier travels with the name because it changes what the number means: it
  // is the closest available quote, not this printing's.
  'tcgcsv-en': 'TCGplayer (English printing)',
  scryfall: 'TCGplayer',
  pokemontcg: 'TCGplayer',
  tcgdex: 'Cardmarket',
};
export function priceSource(card) {
  // No price means no source to name. Labelling a $0.00 "via Cardmarket" asserts a
  // source that never answered — TCGdex has no Cardmarket entry for whole sets
  // (テラスタルフェスex is one).
  if (!(Number(card?.price_trend) > 0)) return null;
  const currency = card.price_currency || 'USD';
  // Scryfall quotes two marketplaces and the currency says which: `usd` is
  // TCGplayer's number, `eur` is Cardmarket's. A non-English printing is usually the
  // second one, so the table's default would name the wrong shop for exactly the
  // cards this label is worth showing on.
  const name = (card.price_source === 'scryfall' && currency === 'EUR')
    ? 'Cardmarket'
    : SOURCE_NAMES[card.price_source] || null;
  if (!name) return null;
  // USD is the app's own display currency, so naming it adds nothing for the
  // overwhelming majority of rows. The label exists for the ones that are NOT USD —
  // and for a price that is a stand-in from another printing, where the currency is
  // right but the card is not.
  const proxy = card.price_source === 'tcgcsv-en';
  if (currency === 'USD' && card.price_source !== 'tcgdex' && !proxy) return null;
  return { name, currency };
}

// Why there is no link to the card, when there isn't one. The causes need different
// words, because they call for different actions from the reader.
export function noLinkReason(card) {
  if (tcgplayerUrl(card) || cardmarketUrl(card)) return null;
  if (isForeignPokemon(card)) {
    return 'No marketplace product found for this printing — TCGplayer does not list it and TCGdex has no Cardmarket entry, which is also why there is no price.';
  }
  return 'No marketplace product found for this printing. It may not be sold individually, or its set may not be matched to a TCGplayer group yet.';
}
