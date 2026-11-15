import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutosave } from './noteAutosave.js';

// Timers the test fires by hand, and a save that records every call and answers
// as told (true, false, or a promise the test settles itself).
function harness({ answer = () => true } = {}) {
  const timers = new Map();
  let next = 1;
  const sent = [];
  const errors = [];
  const saver = createAutosave({
    delay: 800,
    save: (key, value) => { sent.push([key, value]); return answer(key, value, sent.length); },
    onError: (key, value) => errors.push([key, value]),
    setTimer: (fn) => { const id = next++; timers.set(id, fn); return id; },
    clearTimer: (id) => { timers.delete(id); },
  });
  const tick = async () => {
    const due = [...timers.values()];
    timers.clear();
    due.forEach(fn => fn());
    await new Promise(r => setImmediate(r));
  };
  return { saver, sent, errors, timers, tick };
}

const settle = () => new Promise(r => setImmediate(r));

test('typing saves once, after the pause, with the last text', async () => {
  const h = harness();
  h.saver.edit('1:body', 'H', '');
  h.saver.edit('1:body', 'He', '');
  h.saver.edit('1:body', 'Hello', '');
  assert.equal(h.sent.length, 0, 'nothing is sent while typing');
  assert.equal(h.timers.size, 1, 'one timer, re-armed by each keystroke');
  await h.tick();
  assert.deepEqual(h.sent, [['1:body', 'Hello']]);
  assert.equal(h.saver.isDirty('1:body'), false);
});

test('a flush saves at once and the pending timer does not save again', async () => {
  const h = harness();
  h.saver.edit('1:title', 'Deals', 'Untitled');
  await h.saver.flush('1:title');
  assert.deepEqual(h.sent, [['1:title', 'Deals']]);
  assert.equal(h.timers.size, 0, 'the flush cancelled the timer');
  await h.saver.flush('1:title');
  await h.saver.flushAll();
  assert.equal(h.sent.length, 1, 'text the server has is never sent twice');
});

test('typing back to the saved text sends nothing', async () => {
  const h = harness();
  h.saver.edit('1:title', 'Dealz', 'Deals');
  h.saver.edit('1:title', 'Deals', 'Deals');
  await h.tick();
  await h.saver.flushAll();
  assert.equal(h.sent.length, 0);
  assert.equal(h.saver.isDirty('1:title'), false);
});

test('a failed save keeps the edit and the next flush sends it again', async () => {
  let fail = true;
  const h = harness({ answer: () => !fail });
  h.saver.edit('2:body', 'Trade plan', '');
  await h.saver.flush('2:body');
  assert.deepEqual(h.errors, [['2:body', 'Trade plan']], 'the failure is reported');
  assert.equal(h.saver.isDirty('2:body'), true, 'the edit is still there');
  fail = false;
  await h.saver.flush('2:body');
  assert.deepEqual(h.sent, [['2:body', 'Trade plan'], ['2:body', 'Trade plan']]);
  assert.equal(h.saver.isDirty('2:body'), false);
});

test('a save that throws counts as failed, not as saved', async () => {
  const h = harness({ answer: () => { throw new TypeError('fetch failed'); } });
  h.saver.edit('3:body', 'x', '');
  await h.saver.flush('3:body');
  assert.equal(h.errors.length, 1);
  assert.equal(h.saver.isDirty('3:body'), true);
});

test('saves of one key never overlap, and the newest text lands last', async () => {
  const pending = [];
  const h = harness({ answer: () => new Promise(resolve => pending.push(resolve)) });
  h.saver.edit('4:body', 'first', '');
  const one = h.saver.flush('4:body');
  await settle();
  assert.equal(h.sent.length, 1);
  // Typed more, then blurred, while the first save is still out.
  h.saver.edit('4:body', 'first and more', '');
  const two = h.saver.flush('4:body');
  await settle();
  assert.equal(h.sent.length, 1, 'the second save waits for the first');
  pending.shift()(true);
  await one;
  await settle();
  assert.deepEqual(h.sent.map(s => s[1]), ['first', 'first and more']);
  pending.shift()(true);
  await two;
  assert.equal(h.saver.isDirty('4:body'), false);
});

test('a flush that finds its text already sent by the save before it sends nothing', async () => {
  const pending = [];
  const h = harness({ answer: () => new Promise(resolve => pending.push(resolve)) });
  h.saver.edit('5:title', 'Same', '');
  const one = h.saver.flush('5:title');
  const two = h.saver.flush('5:title'); // blur and pagehide back to back
  await settle();
  pending.shift()(true);
  await Promise.all([one, two]);
  assert.equal(h.sent.length, 1);
});

test('flushAll covers every key with typing in it', async () => {
  const h = harness();
  h.saver.edit('1:title', 'A', '');
  h.saver.edit('1:body', 'B', '');
  h.saver.edit('2:body', 'C', '');
  await h.saver.flushAll();
  assert.deepEqual(h.sent.sort(), [['1:body', 'B'], ['1:title', 'A'], ['2:body', 'C']]);
  assert.equal(h.timers.size, 0);
});

test('a forgotten key (its note was deleted) is never saved', async () => {
  const h = harness();
  h.saver.edit('6:body', 'gone', '');
  h.saver.forget('6:body');
  await h.tick();
  await h.saver.flushAll();
  assert.equal(h.sent.length, 0);
});

test('dispose stops the timers', async () => {
  const h = harness();
  h.saver.edit('7:body', 'x', '');
  h.saver.dispose();
  assert.equal(h.timers.size, 0);
});
