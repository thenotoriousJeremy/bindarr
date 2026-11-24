import test from 'node:test';
import assert from 'node:assert/strict';
import { addedAtFromInput, addedAtInputValue, localInputValue } from './addedAt.js';

test('a stored added_at is read as UTC and shown on the local clock', () => {
  const stored = '2024-03-09 18:30:45';
  const instant = new Date('2024-03-09T18:30:45Z');
  assert.equal(addedAtInputValue(stored), localInputValue(instant));
  assert.match(addedAtInputValue(stored), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});

test('a missing or unreadable added_at is an empty field', () => {
  assert.equal(addedAtInputValue(null), '');
  assert.equal(addedAtInputValue(undefined), '');
  assert.equal(addedAtInputValue('not a date'), '');
});

test('the field goes back to the server as the same instant, in UTC', () => {
  const instant = new Date(2024, 2, 9, 19, 30);
  assert.equal(addedAtFromInput('2024-03-09T19:30'), instant.toISOString());
  assert.equal(addedAtFromInput('2024-03-09T19:30:15'), new Date(2024, 2, 9, 19, 30, 15).toISOString());
  // Stored -> field -> server loses only the seconds.
  assert.equal(addedAtFromInput(addedAtInputValue('2024-03-09 18:30:45')), '2024-03-09T18:30:00.000Z');
});

test('an empty or half-typed field sends nothing', () => {
  assert.equal(addedAtFromInput(''), null);
  assert.equal(addedAtFromInput(null), null);
  assert.equal(addedAtFromInput('2024-03-09'), null);
});
