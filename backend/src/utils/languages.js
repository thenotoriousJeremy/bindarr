// The card languages Bindarr can search, scan and store — one table, because
// three different providers each spell them their own way.
//
// `name` is the display name, and it is deliberately the same string
// collection.language has held since v1.0 ('English', 'Japanese', ...) so
// existing rows keep meaning what they always meant.
//
// Provider coverage:
//   scryfall - every language below (Magic is printed in all of them).
//   tcgdex   - every language below (Pokémon; row counts vary wildly, ru has 9
//              sets to en's 218 — an empty result is normal, not a bug).
//   pokemontcg.io is ENGLISH ONLY. Its 174 sets are the Western releases; JP
//   exclusives like sv2a (ポケモンカード151) are simply absent. That is why a
//   non-English Pokémon lookup routes to TCGdex instead (see tcgdexApi.js).
// The table itself lives in shared/languages.json, alongside shared/cardOrder.json,
// because the frontend needs the same code->name pairs and used to keep its own
// copy of them. Two lists meaning the same thing is one list that will disagree:
// adding a language meant editing both files, and only one of them is enforced by
// anything. Scryfall spells the Chinese variants zht/zhs where TCGdex uses
// zh-tw/zh-cn, which is why each row carries a per-provider code.
const LANGUAGES = require('../../../shared/languages.json');

const DEFAULT = LANGUAGES[0];

const byCode = new Map(LANGUAGES.map(l => [l.code, l]));
const byName = new Map(LANGUAGES.map(l => [l.name.toLowerCase(), l]));
// Provider codes resolve back too, so a stored 'zht' or a legacy caller passing
// Scryfall's own spelling still lands on the right language.
const byProvider = new Map(LANGUAGES.flatMap(l => [[l.scryfall, l], [l.tcgdex, l]]));

// Resolve anything that might name a language — canonical code, display name, or
// a provider's own code — to one entry. Unknown input falls back to English
// rather than throwing: a bad `lang` query param should degrade, not 500.
function resolve(input) {
  if (!input) return DEFAULT;
  const raw = String(input).trim();
  const lower = raw.toLowerCase();
  return byCode.get(lower) || byName.get(lower) || byProvider.get(lower) || DEFAULT;
}

// Canonical code ('ja'). Used for cache ids, index filenames and API params.
const toCode = (input) => resolve(input).code;

// Display name ('Japanese'). This is what goes in collection.language.
const toName = (input) => resolve(input).name;

// True for anything that means English (including empty/unknown input). The
// English paths are the existing pokemontcg.io/cached ones, so this is the test
// for "can we use what we already had".
const isEnglish = (input) => resolve(input).code === 'en';

// Which languages a game is printed in. No game means every language; an unknown
// game is printed in none. Each game lists its own languages in shared/games.json,
// rather than each language listing its games here.
function getLanguagesForGame(game) {
  if (!game) return LANGUAGES;
  const codes = require('./games').languagesFor(String(game).toLowerCase());
  return codes ? LANGUAGES.filter(l => codes.includes(l.code)) : [];
}

const getLanguageNamesForGame = (game) => getLanguagesForGame(game).map(l => l.name);

const isLanguageSupported = (game, lang) => {
  if (!game || !lang) return true;
  const code = toCode(lang);
  return getLanguagesForGame(game).some(l => l.code === code);
};

module.exports = {
  LANGUAGES, DEFAULT, resolve, toCode, toName, isEnglish,
  getLanguagesForGame, getLanguageNamesForGame, isLanguageSupported,
};
