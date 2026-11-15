import test from 'node:test';
import assert from 'node:assert/strict';
import { shownTrigger } from './useShownTrigger.js';

// Walk a tab through a session: what it sees after each step.
function walk(steps) {
  let held = 0;
  return steps.map(([trigger, active]) => (held = shownTrigger(held, trigger, active)));
}

test('a shown tab follows every bump', () => {
  assert.deepEqual(walk([[1, true], [2, true], [3, true]]), [1, 2, 3]);
});

test('a hidden tab holds still through bumps, then catches up once when shown', () => {
  assert.deepEqual(walk([[1, false], [2, false], [3, false], [3, true], [3, true]]), [0, 0, 0, 3, 3]);
});

test('hiding a tab keeps the last value it saw', () => {
  assert.deepEqual(walk([[1, true], [2, false], [5, false], [5, true]]), [1, 1, 1, 5]);
});

test('active defaults to shown', () => {
  assert.equal(shownTrigger(0, 4), 4);
});
