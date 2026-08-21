// Which card games the UI shows (issue #26). A collector who only keeps Pokémon
// should not have to look at MTG tabs in every corner of the app.
//
// Stored in localStorage next to `theme`, `default_game` and
// `scanner_auto_confirm` — it is a per-device display preference, not collection
// data, and nothing on the server needs to know about it. Hiding a game hides its
// pickers and its cards from the browsing views; nothing is deleted, and export
// still contains everything.
export const GAMES = [
  { value: 'pokemon', label: 'Pokémon', short: 'Pokémon' },
  { value: 'mtg', label: 'Magic: The Gathering', short: 'MTG' },
  { value: 'lorcana', label: 'Disney Lorcana', short: 'Lorcana' },
];

const KEY = 'hidden_games';
const ALL = GAMES.map(g => g.value);

const readHidden = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(raw) ? raw.filter(g => ALL.includes(g)) : [];
  } catch {
    return []; // malformed value: show everything rather than hide the app
  }
};

// Enabled games, in GAMES order. Hiding every game would leave an app with
// nothing in it, so the last one always stays visible.
export function enabledGames() {
  const hidden = readHidden();
  const shown = ALL.filter(g => !hidden.includes(g));
  return shown.length ? shown : ALL;
}

export const isGameEnabled = (game) => enabledGames().includes(String(game || '').toLowerCase());

// True while more than one game is shown. Every game picker checks this: with a
// single game the picker is just a button that does nothing, which is exactly the
// clutter the setting exists to remove.
export const showGamePicker = () => enabledGames().length > 1;

// GAMES entries for the enabled games, for rendering a picker.
export const gameOptions = () => GAMES.filter(g => isGameEnabled(g.value));

// Persist the hidden set. Refuses to hide the last visible game.
export function setGameEnabled(game, enabled) {
  const hidden = new Set(readHidden());
  if (enabled) hidden.delete(game);
  else hidden.add(game);
  if (ALL.every(g => hidden.has(g))) return false;
  localStorage.setItem(KEY, JSON.stringify([...hidden]));
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
