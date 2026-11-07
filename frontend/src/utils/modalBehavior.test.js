import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trapTabTarget, closeDecision } from './modalBehavior.js';

test('Tab walks forward and wraps from the last element to the first', () => {
  assert.equal(trapTabTarget(3, 0, false), null); // browser moves 0 -> 1
  assert.equal(trapTabTarget(3, 1, false), null);
  assert.equal(trapTabTarget(3, 2, false), 0); // wrap
});

test('Shift+Tab walks backward and wraps from the first element to the last', () => {
  assert.equal(trapTabTarget(3, 2, true), null);
  assert.equal(trapTabTarget(3, 1, true), null);
  assert.equal(trapTabTarget(3, 0, true), 2); // wrap
});

test('focus on the dialog itself enters at the first (Tab) or last (Shift+Tab) element', () => {
  assert.equal(trapTabTarget(3, -1, false), 0);
  assert.equal(trapTabTarget(3, -1, true), 2);
});

test('a dialog with nothing tabbable keeps focus on itself', () => {
  assert.equal(trapTabTarget(0, -1, false), -1);
  assert.equal(trapTabTarget(0, -1, true), -1);
});

test('a single tabbable element is trapped in both directions', () => {
  assert.equal(trapTabTarget(1, 0, false), 0);
  assert.equal(trapTabTarget(1, 0, true), 0);
});

test('a clean dialog closes on backdrop click and Esc', () => {
  assert.equal(closeDecision({ source: 'backdrop' }), 'close');
  assert.equal(closeDecision({ source: 'escape' }), 'close');
  assert.equal(closeDecision({ source: 'button' }), 'close');
});

test('a dirty dialog asks before a backdrop click or Esc discards edits', () => {
  assert.equal(closeDecision({ source: 'backdrop', dirty: true }), 'confirm');
  assert.equal(closeDecision({ source: 'escape', dirty: true }), 'confirm');
});

test('the explicit close button is the user deciding, so it never re-asks', () => {
  assert.equal(closeDecision({ source: 'button', dirty: true }), 'close');
});

test('edit dialogs that opt out of backdrop close ignore it, dirty or not', () => {
  assert.equal(closeDecision({ source: 'backdrop', closeOnBackdrop: false }), 'ignore');
  assert.equal(closeDecision({ source: 'backdrop', dirty: true, closeOnBackdrop: false }), 'ignore');
  assert.equal(closeDecision({ source: 'escape', closeOnBackdrop: false }), 'close');
});
