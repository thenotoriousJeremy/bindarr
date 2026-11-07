// Where a container's dividers fall. The coverflow, binder pages, the All cards
// overview and the box map all split rows with these, so they must agree.
// Run: `node --test src/utils/sortCategories.test.js`
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// cardSort.js (imported by sortCategories.js) reads the shared order tables as
// plain `.json` modules; see cardSort.test.js for why they are served this way.
const jsonAsModule = `
import { readFile } from 'node:fs/promises';
export async function load(url, context, next) {
  if (!url.endsWith('.json')) return next(url, context);
  const source = await readFile(new URL(url), 'utf8');
  return { format: 'module', source: 'export default ' + source, shortCircuit: true };
}`;
register('data:text/javascript,' + encodeURIComponent(jsonAsModule), import.meta.url);

const { changedCategories, dividerStarts, getSortCategories, groupByDividers } = await import('./sortCategories.js');

const cat = (field, label) => ({ field, label, color: '#6b7280' });
// Set, then rarity, with a divider on both.
const SET_THEN_RARITY = JSON.stringify([
  { by: 'set', dir: 'asc', divider: true },
  { by: 'rarity', dir: 'asc', divider: true },
]);
const card = (set_name, rarity, name = 'Card') => ({ name, set_name, rarity, entry_id: `${set_name}-${rarity}-${name}` });

test('the first card starts every category it has', () => {
  const cats = [cat('set', 'A'), cat('rarity', 'Rare')];
  assert.deepEqual(changedCategories(cats, []), cats);
});

test('a change at one level restarts that level and every level below it', () => {
  const prev = [cat('set', 'A'), cat('rarity', 'Rare')];
  assert.deepEqual(changedCategories([cat('set', 'A'), cat('rarity', 'Common')], prev), [cat('rarity', 'Common')]);
  assert.deepEqual(changedCategories([cat('set', 'B'), cat('rarity', 'Rare')], prev), [cat('set', 'B'), cat('rarity', 'Rare')]);
  assert.deepEqual(changedCategories(prev, prev), []);
  assert.deepEqual(changedCategories([], prev), []);
});

test('a container with no explicit divider divides on its first sort field', () => {
  const labels = getSortCategories(card('Base', 'Rare'), JSON.stringify([{ by: 'rarity' }, { by: 'name' }])).map(c => c.label);
  assert.deepEqual(labels, ['Rare']);
  assert.deepEqual(getSortCategories(card('Base', 'Rare'), 'custom'), []);
});

test('empty pockets and the filing ghost neither start nor break a run', () => {
  const items = [card('A', 'Rare'), null, { __ghost: true, set_name: 'Z' }, card('A', 'Rare'), card('B', 'Rare')];
  const starts = dividerStarts(items, SET_THEN_RARITY).map(changed => changed.map(c => c.label));
  assert.deepEqual(starts, [['A', 'Rare'], [], [], [], ['B', 'Rare']]);
});

test('a row splits wherever a divider would go, carrying the full path', () => {
  const cards = [card('A', 'Common'), card('A', 'Common'), card('A', 'Rare'), card('B', 'Rare')];
  const groups = groupByDividers(cards, SET_THEN_RARITY);
  assert.deepEqual(groups.map(g => [g.start, g.path.map(c => c.label), g.cards.length]), [
    [0, ['A', 'Common'], 2],
    [2, ['A', 'Rare'], 1],
    [3, ['B', 'Rare'], 1],
  ]);
});

test('a custom-order row is one group with no path', () => {
  const groups = groupByDividers([card('A', 'Common'), card('B', 'Rare')], 'custom');
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].path, []);
  assert.equal(groups[0].cards.length, 2);
  assert.deepEqual(groupByDividers([], 'custom'), []);
});
