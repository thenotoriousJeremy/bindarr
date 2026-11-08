// Card languages the UI can search, scan and record. The table is shared with the
// backend (shared/languages.json) rather than mirrored here — the display names are
// what get stored in collection.language, so the two lists drifting apart would
// mean the UI offering a language the server does not recognise. Each row also
// carries the provider-specific spellings (Scryfall's zht, TCGdex's zh-tw); the UI
// ignores them and only ever speaks the canonical code.
import LANGUAGE_TABLE from '../../../shared/languages.js';
import GAME_TABLE from '../../../shared/games.js';

export const LANGUAGES = LANGUAGE_TABLE;

export const LANGUAGE_NAMES = LANGUAGES.map(l => l.name);

const byName = new Map(LANGUAGES.map(l => [l.name.toLowerCase(), l]));
const byCode = new Map(LANGUAGES.map(l => [l.code, l]));

// Display name -> code ('Japanese' -> 'ja', 'ja' -> 'ja'). The entry forms store names, the
// search/scan APIs want codes, so this is the bridge between them.
export const langCode = (nameOrCode) => {
  const raw = String(nameOrCode || '').toLowerCase();
  const found = byName.get(raw) || byCode.get(raw);
  return (found || LANGUAGES[0]).code;
};

// Code -> display name ('ja' -> 'Japanese', 'Japanese' -> 'Japanese').
export const langName = (nameOrCode) => {
  const raw = String(nameOrCode || '').toLowerCase();
  const found = byCode.get(raw) || byName.get(raw);
  return (found || LANGUAGES[0]).name;
};

export const isEnglish = (nameOrCode) => {
  const key = String(nameOrCode || '').toLowerCase();
  return !key || key === 'en' || key === 'english';
};

// Which languages a game is printed in, from the game registry (shared/games.json
// lists each game's language codes). No game means every language; an unknown
// game is printed in none. Same rule as backend/src/utils/languages.
export function getLanguagesForGame(game) {
  if (!game) return LANGUAGES;
  const entry = GAME_TABLE.find(g => g.value === String(game).toLowerCase());
  return entry ? LANGUAGES.filter(l => (entry.languages || []).includes(l.code)) : [];
}

export const getLanguageNamesForGame = (game) => getLanguagesForGame(game).map(l => l.name);

export const isLanguageSupported = (game, lang) => {
  if (!game || !lang) return true;
  const code = langCode(lang);
  return getLanguagesForGame(game).some(l => l.code === code);
};

import { getCardDisplayName } from './langHelper.js';

// The card name to show: providers give us the localized name (printed_name) for
// a non-English printing and the English one is still there for searching, so
// prefer whatever the card itself was printed with, falling back to translation dictionaries.
export const displayName = (card) => {
  if (!card) return '';
  return getCardDisplayName(card.name, card.language, card.printed_name, card.game || card.supertype);
};

// The English name to show ALONGSIDE the localized one, or null when there isn't a
// distinct one to show.
//
// This is free for Magic: Scryfall gives every printing an English `name` plus the
// localized `printed_name`, so a Japanese card already carries both. It is null for
// non-English Pokémon, where TCGdex has only the localized name — a Japan-only card
// has no English name anywhere, and the dexId that could give a species name is
// blank on exactly the ex/special cards, absent on Trainers and Energy.
export function translatedName(card) {
  if (!card) return null;
  const shown = displayName(card);
  const english = card.name || '';
  return english && english !== shown ? english : null;
}

// The set's code. Unlike its name this reads the same in every language, so it is
// what you can actually search for or quote. Some games' set ids are stored with
// a prefix ('mtg-fdn', 'lorcana-tfc'; shared/games.json `setIdPrefix`), which is
// not part of the code anyone types.
//
// Casing is left exactly as the provider gives it: TCGdex codes are mixed-case
// ("SV8a", "sv03") and upper-casing them produces a code that does not resolve.
const SET_PREFIXES = GAME_TABLE.map(g => g.setIdPrefix).filter(Boolean);
export function setCode(card) {
  const raw = String(card?.set_id || '');
  const prefix = SET_PREFIXES.find(p => raw.toLowerCase().startsWith(p));
  const code = prefix ? raw.slice(prefix.length) : raw;
  return code || null;
}

// Set code plus collector number, for places that don't already show the number.
export function setReference(card) {
  const code = setCode(card);
  if (!code) return null;
  return card.number ? `${code} #${card.number}` : code;
}
