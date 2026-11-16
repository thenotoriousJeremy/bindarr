// Which card games the UI shows (issue #26). A collector who only keeps Pokémon
// should not have to look at MTG tabs in every corner of the app.
//
// Stored in localStorage next to `theme`, `default_game` and
// `scanner_auto_confirm` — it is a per-device display preference, not collection
// data, and nothing on the server needs to know about it. Hiding a game hides its
// pickers and its cards from the browsing views; nothing is deleted, and export
// still contains everything.
//
// Which games exist at all is not decided here: it is shared/games.json, the one
// registry the backend reads too (this imports its ESM twin, shared/games.js, so
// the bare-Node tests can load it). Each entry carries its value and labels plus
// what the game supports — see gameInfo below.
import GAME_TABLE from '../../../shared/games.js';

// A game marked `nativeApp: false` is left out of the store-distributed native
// app. Riftbound is: Riot's fan policy (Legal Jibber Jabber, section 3) does not
// allow projects using its IP on the App Store or Google Play without a licence
// or an approved Riot API key, and Bindarr has neither. The web app is unaffected.
// window.Capacitor is what the native shell injects; bare Node has none.
const isNativeShell = () => !!globalThis.Capacitor?.isNativePlatform?.();
export const GAMES = GAME_TABLE.filter(g => g.nativeApp !== false || !isNativeShell());

const byValue = new Map(GAMES.map(g => [g.value, g]));

// The whole registry entry for a game, or null.
export const gameInfo = (game) => byValue.get(String(game || '')) || null;

// The game rows from before multi-game support belong to.
export const LEGACY_GAME = (GAMES.find(g => g.legacy) || GAMES[0]).value;

// The game a card belongs to: its own `game` field when it has one, else what its
// id says (a registered prefix, or the legacy pokemontcg.io id shape). Mirrors
// backend/src/utils/games.gameOfId, from the same table.
const PREFIXES = GAMES
  .flatMap(g => (g.idPrefixes || []).map(prefix => ({ prefix, game: g.value })))
  .sort((a, b) => b.prefix.length - a.prefix.length);
const legacyEntry = gameInfo(LEGACY_GAME);
const LEGACY_ID = legacyEntry?.legacyIdPattern ? new RegExp(legacyEntry.legacyIdPattern) : null;
export function gameOfCard(card) {
  if (card?.game && byValue.has(card.game)) return card.game;
  const id = String(card?.card_id || card?.id || '');
  for (const { prefix, game } of PREFIXES) if (id.startsWith(prefix)) return game;
  return LEGACY_ID && LEGACY_ID.test(id) ? LEGACY_GAME : null;
}

const KEY = 'hidden_games';
// Games switched ON by choice. Needed because some games start switched off
// (`defaultEnabled: false` in the registry: the five served from TCGplayer's
// catalogue), and "never hidden" can no longer mean "shown" for those.
const SHOWN_KEY = 'shown_games';
const ALL = GAMES.map(g => g.value);
// What a browser that has decided nothing shows: every game but the ones the
// registry starts off. An install upgraded to a release that adds a game does not
// suddenly grow its tabs, filters and pickers; the setup wizard and Settings ->
// Preferences say the others exist and switch them on.
export const DEFAULT_GAMES = GAMES.filter(g => g.defaultEnabled !== false).map(g => g.value);

const readList = (key) => {
  try {
    const raw = JSON.parse(localStorage.getItem(key));
    return Array.isArray(raw) ? raw.filter(g => ALL.includes(g)) : [];
  } catch {
    return []; // malformed value: fall back to the defaults rather than hide the app
  }
};
const readHidden = () => readList(KEY);
const readShown = () => readList(SHOWN_KEY);

// Enabled games, in GAMES order: switched on by choice, or on by default and not
// switched off. Hiding every game would leave an app with nothing in it, so a
// state with none shown falls back to the defaults.
export function enabledGames() {
  const hidden = readHidden();
  const chosen = readShown();
  const shown = ALL.filter(g => chosen.includes(g) || (DEFAULT_GAMES.includes(g) && !hidden.includes(g)));
  return shown.length ? shown : (DEFAULT_GAMES.length ? DEFAULT_GAMES : ALL);
}

export const isGameEnabled = (game) => enabledGames().includes(String(game || '').toLowerCase());

// True while more than one game is shown. Every game picker checks this: with a
// single game the picker is just a button that does nothing, which is exactly the
// clutter the setting exists to remove.
export const showGamePicker = () => enabledGames().length > 1;

// GAMES entries for the enabled games, for rendering a picker.
export const gameOptions = () => GAMES.filter(g => isGameEnabled(g.value));

// Persist the choice. Refuses to hide the last visible game.
export function setGameEnabled(game, enabled) {
  if (!ALL.includes(game)) return false;
  const hidden = new Set(readHidden());
  const shown = new Set(readShown());
  if (enabled) { hidden.delete(game); shown.add(game); } else { hidden.add(game); shown.delete(game); }
  const visible = ALL.filter(g => shown.has(g) || (DEFAULT_GAMES.includes(g) && !hidden.has(g)));
  if (!visible.length) return false;
  localStorage.setItem(KEY, JSON.stringify([...hidden]));
  localStorage.setItem(SHOWN_KEY, JSON.stringify([...shown]));
  return true;
}

// The game a view should open on: the Settings default when it is still visible,
// otherwise the first enabled game. Used instead of reading `default_game`
// directly so hiding the default game can't leave a view stuck on it.
export function defaultGame() {
  const stored = localStorage.getItem('default_game');
  return isGameEnabled(stored) ? stored : enabledGames()[0];
}

// Same, for the filters that also offer "All games": '' (all) stays '' while both
// games are shown, and collapses to the only game when one is hidden.
export const defaultGameFilter = () => (showGamePicker() ? '' : enabledGames()[0]);

export const gameLabel = (game, short = false) => {
  const entry = GAMES.find(g => g.value === game);
  return entry ? (short ? entry.short : entry.label) : game;
};
