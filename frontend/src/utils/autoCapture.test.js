import assert from 'node:assert';
import {
  shouldCapture, shouldRearm, nextChangedFrames, autoStatusKey, worstCornerDrift,
  REARM_EMPTY_FRAMES, REARM_EMPTY_MS, REARM_DRIFT, MIN_RECAPTURE_MS, REARM_CHANGED_FRAMES,
} from './autoCapture.js';

const GATE = { minSteady: 3, minFill: 0.55 };
const NOW = 1_000_000;
const quad = (x, y) => [
  { x, y }, { x: x + 0.6, y }, { x: x + 0.6, y: y + 0.8 }, { x, y: y + 0.8 },
];
const good = { none: false, steady: 4, fill: 0.8, at: NOW };
const base = { armed: true, busy: false, blocked: false, reading: good, now: NOW, lastCaptureAt: 0, ...GATE };

// --- the whole point: a card present and still fires exactly once ------------
assert.strictEqual(shouldCapture(base), true, 'steady framed card captures');
assert.strictEqual(shouldCapture({ ...base, armed: false }), false, 'disarmed does not re-fire on the same card');

// --- no card must NEVER fire. This is the regression that photographed desks --
assert.strictEqual(shouldCapture({ ...base, reading: { none: true, at: NOW } }), false, 'explicit no-card');
assert.strictEqual(shouldCapture({ ...base, reading: null }), false, 'no reading yet is not permission');
assert.strictEqual(shouldCapture({ ...base, reading: { ...good, at: NOW - 5000 } }), false, 'stale reading');

// --- quality gates -----------------------------------------------------------
assert.strictEqual(shouldCapture({ ...base, reading: { ...good, steady: 1 } }), false, 'still moving');
assert.strictEqual(shouldCapture({ ...base, reading: { ...good, fill: 0.2 } }), false, 'card too small in frame');

// --- busy / blocked ----------------------------------------------------------
assert.strictEqual(shouldCapture({ ...base, busy: true }), false, 'scan in flight');
assert.strictEqual(shouldCapture({ ...base, blocked: true }), false, 'modal up');
assert.strictEqual(shouldCapture({ ...base, lastCaptureAt: NOW - 100 }), false, 'debounce floor');
assert.strictEqual(shouldCapture({ ...base, lastCaptureAt: NOW - MIN_RECAPTURE_MS - 1 }), true, 'past the floor');

// --- re-arming ---------------------------------------------------------------
const held = quad(0.2, 0.1);
assert.strictEqual(
  shouldRearm({ armed: false, emptyFrames: 0, quad: held, capturedQuad: held }), false,
  'same card held still stays disarmed');
assert.strictEqual(
  shouldRearm({ armed: false, emptyFrames: REARM_EMPTY_FRAMES, quad: null, capturedQuad: held }), true,
  'card lifted re-arms');
assert.strictEqual(
  shouldRearm({ armed: false, emptyFrames: 1, quad: null, capturedQuad: held }), false,
  'one empty frame is not enough (a hand passing over)');
assert.strictEqual(
  shouldRearm({ armed: false, emptyFrames: 1, emptyMs: 120, quad: null, capturedQuad: held }), false,
  'one short empty reading on a fast detector is still a hand passing over');
assert.strictEqual(
  shouldRearm({ armed: false, emptyFrames: 1, emptyMs: REARM_EMPTY_MS, quad: null, capturedQuad: held }), true,
  'a slow detector re-arms on one empty reading that spans enough time');
assert.strictEqual(
  shouldRearm({ armed: false, emptyFrames: 0, emptyMs: 5000, quad: held, capturedQuad: held }), false,
  'elapsed time alone never re-arms while the card is still seen');
assert.strictEqual(
  shouldRearm({ armed: false, emptyFrames: 0, quad: quad(0.2, 0.1 + REARM_DRIFT + 0.02), capturedQuad: held }), true,
  'card swapped without the frame emptying re-arms');
assert.strictEqual(
  shouldRearm({ armed: false, emptyFrames: 0, quad: quad(0.2, 0.105), capturedQuad: held }), false,
  'small drift while holding does not re-arm');

// Drift is measured against the CAPTURED quad, so creeping frame-by-frame never
// accumulates into a false re-arm.
let creeping = held;
for (let i = 0; i < 20; i++) {
  creeping = quad(0.2, 0.1 + i * 0.002);
  if (worstCornerDrift(held, creeping) > REARM_DRIFT) break;
}
assert.ok(worstCornerDrift(held, quad(0.2, 0.1 + 0.002)) < REARM_DRIFT, 'one creep step is below the threshold');

// --- re-arming on appearance: the next card laid on top of the last one -------
// Unit vectors stand in for signatures: distance is 1 - correlation, so a and b
// are unrelated pictures and each is identical to itself.
const N = 8;
const sigA = Float32Array.from({ length: N }, (_, i) => (i % 2 ? 1 : -1));
const sigB = Float32Array.from({ length: N }, (_, i) => (i < N / 2 ? 1 : -1));
let changed = 0;
for (let i = 0; i < REARM_CHANGED_FRAMES; i++) {
  changed = nextChangedFrames(changed, { sig: sigB, prevSig: i ? sigB : sigA, capturedSig: sigA });
}
// The first frame of B differs from the frame before it (still A), so it only
// counts once the picture has settled.
assert.strictEqual(changed, REARM_CHANGED_FRAMES - 1, 'the swap frame itself is not settled yet');
changed = nextChangedFrames(changed, { sig: sigB, prevSig: sigB, capturedSig: sigA });
assert.strictEqual(
  shouldRearm({ armed: false, emptyFrames: 0, quad: held, capturedQuad: held, changedFrames: changed }), true,
  'a different card in the same quad re-arms once it has settled');
assert.strictEqual(
  shouldRearm({ armed: false, emptyFrames: 0, quad: held, capturedQuad: held, changedFrames: REARM_CHANGED_FRAMES - 1 }), false,
  'not before it has settled');
assert.strictEqual(
  nextChangedFrames(2, { sig: sigA, prevSig: sigB, capturedSig: sigA }), 0,
  'a transient (hand, shadow) that returns to the captured picture resets the count');
assert.strictEqual(
  nextChangedFrames(2, { sig: sigB, prevSig: null, capturedSig: sigA }), 0,
  'no previous picture to call it settled against resets');
assert.strictEqual(
  nextChangedFrames(2, { sig: null, prevSig: sigB, capturedSig: sigA }), 0,
  'no signature is "cannot tell", never "changed"');
assert.strictEqual(
  nextChangedFrames(2, { sig: sigB, prevSig: sigB, capturedSig: null }), 0,
  'nothing captured to compare against');

// --- status never disagrees with the trigger --------------------------------
assert.strictEqual(autoStatusKey({ ...base }), 'ready');
assert.strictEqual(autoStatusKey({ ...base, busy: true }), 'scanning');
assert.strictEqual(autoStatusKey({ ...base, blocked: true }), 'waiting');
assert.strictEqual(autoStatusKey({ ...base, armed: false }), 'lift');
assert.strictEqual(autoStatusKey({ ...base, reading: { none: true, at: NOW } }), 'nocard');
assert.strictEqual(autoStatusKey({ ...base, reading: { ...good, fill: 0.2 } }), 'closer');
assert.strictEqual(autoStatusKey({ ...base, reading: { ...good, steady: 1 } }), 'hold');

// If the badge says ready, the trigger must agree — the two are read off the
// same inputs and a mismatch is what makes a scanner look broken.
for (const reading of [good, { ...good, steady: 1 }, { ...good, fill: 0.1 }, { none: true, at: NOW }, null]) {
  const args = { ...base, reading };
  assert.strictEqual(
    autoStatusKey(args) === 'ready', shouldCapture(args),
    `status and trigger agree for ${JSON.stringify(reading)}`);
}

console.log('PASS: autoCapture.test.js');
