// Self-check for the hide-a-game setting (issue #26).
// Run: `node src/utils/games.test.js`
import assert from 'node:assert';

// games.js reads localStorage at call time, so a plain in-memory stand-in is
// enough — install it before importing the module.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const {
  enabledGames, isGameEnabled, showGamePicker, gameOptions,
  setGameEnabled, defaultGame, defaultGameFilter, gameLabel,
} = await import('./games.js');

// --- Default: all games shown -------------------------------------------------
assert.deepStrictEqual(enabledGames(), ['pokemon', 'mtg', 'lorcana']);
assert.ok(showGamePicker(), 'three games means the picker is worth showing');
assert.strictEqual(gameOptions().length, 3);
assert.strictEqual(defaultGameFilter(), '', "'all games' is meaningful with multiple shown");

// --- Hiding MTG & Lorcana -----------------------------------------------------
assert.strictEqual(setGameEnabled('mtg', false), true);
assert.deepStrictEqual(enabledGames(), ['pokemon', 'lorcana']);
assert.ok(isGameEnabled('pokemon'));
assert.ok(!isGameEnabled('mtg'));
assert.ok(isGameEnabled('lorcana'));

assert.strictEqual(setGameEnabled('lorcana', false), true);
assert.deepStrictEqual(enabledGames(), ['pokemon']);
assert.ok(!showGamePicker(), 'one game means every picker hides');
assert.deepStrictEqual(gameOptions().map(g => g.value), ['pokemon']);
assert.strictEqual(defaultGameFilter(), 'pokemon', 'filters collapse to the only visible game');

// A hidden game cannot remain what views open on, even if it is still the stored
// Settings default — otherwise the collection opens filtered to invisible cards.
store.set('default_game', 'mtg');
assert.strictEqual(defaultGame(), 'pokemon', 'default falls back to a visible game');
store.set('default_game', 'pokemon');
assert.strictEqual(defaultGame(), 'pokemon');

// --- The last visible game can never be hidden --------------------------------
assert.strictEqual(setGameEnabled('pokemon', false), false, 'refused: nothing would be left');
assert.deepStrictEqual(enabledGames(), ['pokemon'], 'state unchanged after the refusal');

// --- Re-enabling brings it back -----------------------------------------------
assert.strictEqual(setGameEnabled('mtg', true), true);
assert.strictEqual(setGameEnabled('lorcana', true), true);
assert.deepStrictEqual(enabledGames(), ['pokemon', 'mtg', 'lorcana']);
assert.ok(showGamePicker());

// --- A corrupt stored value must not hide the whole app -----------------------
store.set('hidden_games', 'not json');
assert.deepStrictEqual(enabledGames(), ['pokemon', 'mtg', 'lorcana'], 'malformed value falls back to showing everything');
store.set('hidden_games', JSON.stringify(['pokemon', 'mtg', 'lorcana', 'gibberish']));
assert.deepStrictEqual(enabledGames(), ['pokemon', 'mtg', 'lorcana'], 'hiding every known game is ignored');
store.set('hidden_games', JSON.stringify(['gibberish']));
assert.deepStrictEqual(enabledGames(), ['pokemon', 'mtg', 'lorcana'], 'an unknown game name hides nothing');

assert.strictEqual(gameLabel('mtg'), 'Magic: The Gathering');
assert.strictEqual(gameLabel('mtg', true), 'MTG');
assert.strictEqual(gameLabel('lorcana'), 'Disney Lorcana');
assert.strictEqual(gameLabel('lorcana', true), 'Lorcana');

console.log('games self-check passed');
