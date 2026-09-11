// Which provider owns a card ID, and how to fetch it.
//
// The ID itself is the answer — it was minted by whichever provider supplied the
// card, and only that provider can resolve it:
//
//   mtg-<uuid>          Scryfall
//   tcgdex-<lang>-<id>  TCGdex
//   pokemontcgapi-<id>  pokemontcgapi.com
//   <anything else>     pokemontcg.io
//
// NOT the same question as utils/pokemonProvider. That one decides which provider
// should SERVE a language when searching or building — a policy that follows a
// setting. This is a fact about an ID that already exists, and no setting changes
// it: a 'tcgdex-en-sv01-001' row belongs to TCGdex whatever the provider is set
// to today. Conflating the two would reintroduce the bug that pokemonProvider
// exists to prevent, from the other direction.
//
// This lives in one place because the dispatch was written out in routes/
// collection.js and simply omitted in routes/decks.js, which therefore asked
// pokemontcg.io for every uncached card. tcgApi.getCardById short-circuits on the
// two foreign prefixes and returns only what is cached, so an uncached TCGdex or
// MTG card came back null and the route answered "Card not found on Pokémon TCG
// API" — a failure and a misleading message, for a card that exists.
const scryfallApi = require('../scryfallApi');
const tcgApi = require('../tcgApi');
const tcgdexApi = require('../tcgdexApi');
const lorcastApi = require('../lorcastApi');
const languages = require('./languages');

const isMtgId = (id) => String(id || '').startsWith('mtg-');
const isTcgdexId = (id) => String(id || '').startsWith('tcgdex-');
const isPokemontcgapiId = id => String(id || '').startsWith('pokemontcgapi-');
const isLorcanaId = (id) => String(id || '').startsWith('lorcana-');

// The game an ID implies. `game` from the request wins when explicit; otherwise inferred from prefix.
function gameOf(id, requestedGame) {
  if (requestedGame === 'mtg' || isMtgId(id)) return 'mtg';
  if (requestedGame === 'lorcana' || isLorcanaId(id)) return 'lorcana';
  return 'pokemon';
}

// Fill in a row that was cached from a partial source before it is relied on.
// Only TCGdex has thin rows (set briefs carry name/number/image and nothing
// else); the others always cache complete cards. Never throws — hydration is an
// improvement, and failing it must not block adding a card.
async function hydrate(id) {
  // pokemontcgapi.com rows are thin in a different way: listing pages are asked
  // without prices because prices are what its credits pay for, so the price is
  // fetched here, once, for the card actually entering the collection.
  if (isPokemontcgapiId(id)) {
    try { await require('../pokemontcgapi').hydrateCard(id); }
    catch (e) { console.warn(`Could not hydrate ${id}: ${e.message}`); }
    return;
  }
  if (!isTcgdexId(id)) return;
  try { await tcgdexApi.hydrateCard(id); }
  catch (e) { console.warn(`Could not hydrate ${id}: ${e.message}`); }
}

// Fetch a card from whichever provider minted its ID. Returns null when that
// provider does not have it.
async function getCardById(id, { game, tcgApiKey = '' } = {}) {
  const g = gameOf(id, game);
  if (g === 'mtg') return await scryfallApi.getCardById(id);
  if (g === 'lorcana') return await lorcastApi.getCardById(id);
  if (isPokemontcgapiId(id)) return await require('../pokemontcgapi').getCardById(id);
  if (isTcgdexId(id)) return await tcgdexApi.getCardById(id);
  return await tcgApi.getCardById(id, tcgApiKey);
}

// The same card as printed in `language`, or null when there is no such printing.
//
// A copy's language is not always the printing that was picked. Quick Add lets the
// language be changed after a card is chosen, and a camera scan is answered by
// whichever catalog exists (English, on most installs) whatever language is being
// scanned. Both leave the collection row pointing at the ENGLISH printing, so a card
// filed as Japanese still shows its English name everywhere: printed_name belongs to
// the printing, not to the copy.
//
// Null means keep the card you had. That covers a card never printed in the language
// asked for (Japanese has no Alpha) and a pokemontcg.io id, which is English-only and
// carries no TCGdex id to swap to — callers must degrade, not fail, because the
// language the user picked is still what they own.
async function printingInLanguage(card, language) {
  if (!card) return null;
  if (languages.toName(card.language) === languages.toName(language)) return null;
  const g = gameOf(card.id, card.game);
  if (g === 'mtg') {
    const set = String(card.set_id || '').replace(/^mtg-/, '');
    return await scryfallApi.getPrintingInLang(set, card.number, language).catch(() => null);
  }
  if (g === 'pokemon') {
    // Regional set numbering cannot be translated by swapping a language code.
    if (isPokemontcgapiId(card.id)) return null;
    if (isTcgdexId(card.id)) {
      const match = await tcgdexApi.getPrintingInLang(card.id, language).catch(() => null);
      if (match) return match;
    }
    // Fallback for pokemontcg.io or unmatched IDs: query TCGdex by set + number
    if (card.set_id && card.number) {
      const langCode = languages.toCode(language);
      const res = await tcgdexApi.searchCards({ set: card.set_id, number: card.number, lang: langCode }).catch(() => null);
      if (res && res.cards && res.cards.length) {
        const found = res.cards.find(c => {
          const a = String(c.number || '').replace(/^0+/, '');
          const b = String(card.number || '').replace(/^0+/, '');
          return a === b || c.number === card.number;
        });
        if (found) return found;
      }
    }
    if (card.name) {
      const { getCardDisplayName } = require('./langHelper');
      const targetName = languages.toName(language);
      const translated = getCardDisplayName(card.name, language, card.printed_name, 'pokemon');
      if (translated && translated !== card.name) {
        return {
          ...card,
          language: targetName,
          printed_name: translated,
        };
      }
    }
    return null;
  }
  if (g === 'lorcana') {
    const { translateLorcanaName } = require('./lorcanaHelper');
    const targetName = languages.toName(language);
    const translated = translateLorcanaName(card.name, language);
    return {
      ...card,
      language: targetName,
      printed_name: translated,
    };
  }
  return null;
}

module.exports = { isPokemontcgapiId, isMtgId, isTcgdexId, isLorcanaId, gameOf, hydrate, getCardById, printingInLanguage };
