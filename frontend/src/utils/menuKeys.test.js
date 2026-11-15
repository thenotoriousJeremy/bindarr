import test from 'node:test';
import assert from 'node:assert/strict';
import { menuKeyTarget } from './menuKeys.js';

test('arrows walk the items and wrap around', () => {
  assert.equal(menuKeyTarget('ArrowDown', 0, 3), 1);
  assert.equal(menuKeyTarget('ArrowDown', 2, 3), 0);
  assert.equal(menuKeyTarget('ArrowUp', 0, 3), 2);
  assert.equal(menuKeyTarget('ArrowUp', 2, 3), 1);
});

test('with nothing focused, down starts at the top and up at the bottom', () => {
  assert.equal(menuKeyTarget('ArrowDown', -1, 4), 0);
  assert.equal(menuKeyTarget('ArrowUp', -1, 4), 3);
});

test('Home and End jump to the ends', () => {
  assert.equal(menuKeyTarget('Home', 2, 4), 0);
  assert.equal(menuKeyTarget('End', 0, 4), 3);
});

test('Escape and Tab close the menu; other keys pass through', () => {
  assert.equal(menuKeyTarget('Escape', 1, 3), 'close');
  assert.equal(menuKeyTarget('Tab', 1, 3), 'close');
  assert.equal(menuKeyTarget('Escape', -1, 0), 'close', 'even an empty menu closes');
  assert.equal(menuKeyTarget('a', 1, 3), null);
  assert.equal(menuKeyTarget('Enter', 1, 3), null, 'Enter activates the focused item itself');
  assert.equal(menuKeyTarget('ArrowDown', -1, 0), null);
});
