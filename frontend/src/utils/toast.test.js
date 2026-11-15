import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToast, showToast, dismissToast, getToast, subscribeToast } from './toast.js';

test('normalizeToast turns whatever a caller has into { message }', () => {
  assert.deepEqual(normalizeToast('Saved'), { id: null, message: 'Saved' });
  assert.deepEqual(normalizeToast(new Error('Boom')), { id: null, message: 'Boom' });
  assert.deepEqual(normalizeToast({ error: 'Not found' }), { id: null, message: 'Not found' });
  assert.deepEqual(normalizeToast({ message: 'Hi', id: 7 }), { id: 7, message: 'Hi' });
  assert.deepEqual(normalizeToast(42), { id: null, message: '42' });
});

test('normalizeToast says nothing for empty input, never an object', () => {
  for (const empty of [null, undefined, '', false, {}, { message: { nested: true } }]) {
    assert.equal(normalizeToast(empty), null, JSON.stringify(empty));
  }
});

test('normalizeToast keeps an action only when it is a function', () => {
  const undo = () => {};
  assert.deepEqual(normalizeToast('Deleted', { onAction: undo }), { id: null, message: 'Deleted', onAction: undo });
  assert.deepEqual(
    normalizeToast('Deleted', { onAction: undo, actionLabel: 'Restore' }),
    { id: null, message: 'Deleted', onAction: undo, actionLabel: 'Restore' },
  );
  assert.deepEqual(normalizeToast('Deleted', { onAction: 'nope', actionLabel: 'Restore' }), { id: null, message: 'Deleted' });
});

test('the store hands out a fresh id per toast and notifies subscribers', () => {
  let calls = 0;
  const off = subscribeToast(() => { calls++; });
  showToast('One');
  const first = getToast();
  showToast('One');
  const second = getToast();
  assert.equal(first.message, 'One');
  assert.notEqual(first.id, second.id, 'the same text twice is two toasts');
  assert.equal(calls, 2);
  off();
  dismissToast();
  assert.equal(getToast(), null);
});

test("an earlier toast's dismissal leaves the newer one up", () => {
  showToast('Old');
  const old = getToast();
  showToast('New');
  dismissToast(old.id);
  assert.equal(getToast().message, 'New');
  dismissToast(getToast().id);
  assert.equal(getToast(), null);
});

test('showToast ignores an empty message', () => {
  dismissToast();
  showToast('');
  showToast(null);
  assert.equal(getToast(), null);
});
