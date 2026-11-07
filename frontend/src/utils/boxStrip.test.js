// The box map's strips: what colour each slot is, where the tabs go, and the one
// gradient a row is drawn with.
// Run: `node --test src/utils/boxStrip.test.js`
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// cardSort.js reads the shared order tables as plain `.json` modules; see
// cardSort.test.js for why they are served this way.
const jsonAsModule = `
import { readFile } from 'node:fs/promises';
export async function load(url, context, next) {
  if (!url.endsWith('.json')) return next(url, context);
  const source = await readFile(new URL(url), 'utf8');
  return { format: 'module', source: 'export default ' + source, shortCircuit: true };
}`;
register('data:text/javascript,' + encodeURIComponent(jsonAsModule), import.meta.url);

const { stripColorKey, stripRarityKey, stripRuns, stripGradient, stripTabs } = await import('./boxStrip.js');

const mtg = (color_identity, rarity = 'common') => ({ game: 'mtg', supertype: 'MTG', color_identity, rarity, name: 'Card' });

test('Magic cards are painted by colour identity', () => {
  assert.equal(stripColorKey(mtg(['U'])), 'Blue');
  assert.equal(stripColorKey(mtg(['W', 'U'])), 'Multicolor');
  assert.equal(stripColorKey(mtg([])), 'Colorless');
});

test('Pokémon by energy type, with Trainers and Energy as themselves', () => {
  assert.equal(stripColorKey({ game: 'pokemon', supertype: 'Pokémon', types: ['Fire'] }), 'Fire');
  assert.equal(stripColorKey({ game: 'pokemon', supertype: 'Pokémon', types: ['Water', 'Metal'] }), 'Multicolor');
  assert.equal(stripColorKey({ game: 'pokemon', supertype: 'Trainer', types: [] }), 'Trainer');
  assert.equal(stripColorKey({ game: 'pokemon', supertype: 'Energy' }), 'Energy');
});

test('Lorcana by ink', () => {
  assert.equal(stripColorKey({ game: 'lorcana', supertype: 'Character', types: ['Amber'] }), 'Amber');
  assert.equal(stripColorKey(null), null);
});

test('commons leave the rarity lane blank', () => {
  assert.equal(stripRarityKey({ rarity: 'Common' }), null);
  assert.equal(stripRarityKey({ rarity: 'Uncommon' }), 'uncommon');
  assert.equal(stripRarityKey({ rarity: 'Rare Holo' }), 'rare');
  assert.equal(stripRarityKey({ rarity: 'Special Illustration Rare' }), 'top');
  assert.equal(stripRarityKey(null), null);
});

test("Magic's mythics and Lorcana's top rarities count as top, not common", () => {
  assert.equal(stripRarityKey({ rarity: 'Mythic' }), 'top');
  assert.equal(stripRarityKey({ rarity: 'Legendary' }), 'top');
  assert.equal(stripRarityKey({ rarity: 'Enchanted' }), 'top');
  assert.equal(stripRarityKey({ rarity: 'Super Rare' }), 'rare');
});

test('runs merge neighbours and keep empty slots as their own run', () => {
  const slots = [mtg(['U']), mtg(['U']), mtg(['R']), null, null];
  assert.deepEqual(stripRuns(slots, stripColorKey), [
    { start: 0, end: 2, key: 'Blue' },
    { start: 2, end: 3, key: 'Red' },
    { start: 3, end: 5, key: null },
  ]);
  assert.deepEqual(stripRuns([], stripColorKey), []);
});

test('a row is one hard-stop gradient, with uncoloured runs left clear', () => {
  const runs = [{ start: 0, end: 1, key: 'a' }, { start: 1, end: 3, key: null }];
  const colors = { a: '#111111' };
  assert.equal(
    stripGradient(runs, 3, key => colors[key]),
    'linear-gradient(to right, #111111 0% 33.333%, transparent 33.333% 100%)'
  );
  assert.equal(stripGradient([], 3, () => '#000'), 'none');
});

test('tabs sit at the dividers, top level labelled and deeper ones as ticks', () => {
  const sortOrder = JSON.stringify([{ by: 'color', divider: true }, { by: 'rarity', divider: true }]);
  const slots = [mtg(['W'], 'Common'), mtg(['W'], 'Rare'), mtg(['U'], 'Common'), mtg(['U'], 'Common'), null];
  const tabs = stripTabs(slots, sortOrder);
  assert.deepEqual(tabs.map(t => [t.index, t.depth, t.label, t.end, t.count]), [
    [0, 0, 'White', 2, 2],
    [1, 1, 'Rare', 2, 1],
    [2, 0, 'Blue', 4, 2],
  ]);
});

test('a custom-order row has no tabs', () => {
  assert.deepEqual(stripTabs([mtg(['W']), mtg(['U'])], 'custom'), []);
});
