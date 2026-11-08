import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onActivateKey } from './a11y.js';

const keyEvent = (key, nested = false) => {
  const el = {};
  return { key, target: nested ? {} : el, currentTarget: el, prevented: false, preventDefault() { this.prevented = true; } };
};

test('Enter and Space activate, and Space does not scroll the page', () => {
  for (const key of ['Enter', ' ']) {
    let calls = 0;
    const e = keyEvent(key);
    onActivateKey(() => calls++)(e);
    assert.equal(calls, 1, key);
    assert.equal(e.prevented, true, key);
  }
});

test('other keys pass through', () => {
  let calls = 0;
  const e = keyEvent('a');
  onActivateKey(() => calls++)(e);
  assert.equal(calls, 0);
  assert.equal(e.prevented, false);
});

test('keys typed in a nested control are not hijacked', () => {
  let calls = 0;
  const e = keyEvent('Enter', true);
  onActivateKey(() => calls++)(e);
  assert.equal(calls, 0);
  assert.equal(e.prevented, false);
});
