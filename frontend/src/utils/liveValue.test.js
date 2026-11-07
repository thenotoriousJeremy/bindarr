import assert from 'node:assert';
import { createLiveValue } from './liveValue.js';

// The scanner's detection loop was moved from setState to live values without
// touching a single call: setDetectQuad(q => q && null), setAutoState(prev => ...)
// and setDetectQuad(null) all kept their state-setter meaning. These pin that.

const v = createLiveValue(null);
let calls = 0;
const unsubscribe = v.subscribe(() => { calls++; });

assert.strictEqual(v.get(), null, 'starts at the initial value');

v.set(null);
assert.strictEqual(calls, 0, 'setting the same value notifies nobody (a setState bail-out)');

const quad = { detected: true, quad: [] };
v.set(quad);
assert.strictEqual(v.get(), quad);
assert.strictEqual(calls, 1, 'a new value notifies once');

v.set(q => q && null);
assert.strictEqual(v.get(), null, 'an updater sees the previous value');
assert.strictEqual(calls, 2);

v.set(q => q && null);
assert.strictEqual(calls, 2, '"already empty: no re-render" holds for an updater too');

// refreshAutoState returns the previous object when the pill would say the same thing.
const pill = { status: 'ready', label: 'Ready', color: 'green' };
v.set(pill);
v.set(prev => (prev && prev.label === 'Ready' && prev.color === 'green' ? prev : { ...pill }));
assert.strictEqual(calls, 3, 'an updater returning prev is not a change');

// NaN is equal to itself here, as it is for React.
v.set(NaN);
const before = calls;
v.set(NaN);
assert.strictEqual(calls, before, 'Object.is semantics, not ===');

unsubscribe();
v.set('after');
assert.strictEqual(calls, before, 'an unsubscribed listener is not called');

// Two listeners each hear every change; one unsubscribing leaves the other.
const w = createLiveValue(0);
const heard = [];
const offA = w.subscribe(() => heard.push('a'));
w.subscribe(() => heard.push('b'));
w.set(1);
offA();
w.set(2);
assert.deepStrictEqual(heard, ['a', 'b', 'b']);

console.log('liveValue.test.js: all assertions passed');
