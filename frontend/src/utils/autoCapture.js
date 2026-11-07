// When auto-scan takes the picture.
//
// The rule is ONE SCAN PER CARD PRESENTED, not a scan every N milliseconds.
// Interval capture rescanned a card that was simply sitting there while the user
// reached for the next one, and made a card placed just after a tick wait out the
// rest of the beat for nothing.
//
// So this is an edge trigger with an explicit armed/disarmed state:
//
//   armed --(steady, well-framed card)--> CAPTURE --> disarmed
//   disarmed --(frame empties, or a visibly different quad appears)--> armed
//
// Pure on purpose: the component owns the refs and the camera, this owns the
// decision, and the decision is the part worth testing.

import { signatureDistance } from './cardSignature.js';

// Consecutive empty frames before re-arming. At ~60ms per detection this is
// about a fifth of a second of clear mat — long enough that a hand crossing the
// frame is not mistaken for the card being taken away.
export const REARM_EMPTY_FRAMES = 3;
// The same fifth of a second, measured as time rather than frames. A frame count
// only means "a fifth of a second" at the detection rate it was tuned on: a phone
// running the detector at 300ms+ needed ~1s of empty mat, a quick swap never got
// it, the next card landed in the same guide box (under REARM_DRIFT) and auto-scan
// sat on "Next card" for good. Either rule re-arms, so a fast detector keeps its
// behaviour and a slow one re-arms on the first empty reading that spans enough
// time. A hand pass that does slip through only re-scans the card, and the
// repeat-card prompt catches that.
export const REARM_EMPTY_MS = 200;
// How far the quad must move from the captured one to count as a different card.
// Well above the ~0.012 jitter of a card lying still.
export const REARM_DRIFT = 0.09;
// Floor between two captures, against a double fire while the first request is
// still being assembled. NOT a cadence: nothing fires just because it elapses.
export const MIN_RECAPTURE_MS = 600;
// Appearance change (cardSignature distance, 1 - correlation) that counts as a
// different card. Measured on synthetic cards sharing one frame layout (see
// cardSignature.test.js): the same card under corner jitter, an exposure shift
// and sensor noise stays at or under 0.03; different cards ran 0.13 to 0.48. A
// shared layout pulls different cards much closer than unrelated pictures, so
// this sits low in that gap: a false re-arm only re-scans the card and the
// repeat-card prompt catches it, a missed one leaves auto-scan stuck.
export const REARM_SIG_DIST = 0.1;
// Frame-to-frame appearance change still small enough to call the scene settled.
// A hand sweeping across the card moves it far more than this.
export const REARM_SIG_STABLE = 0.08;
// Consecutive settled, changed frames before re-arming. A transient (a hand, a
// shadow, glare as the sleeve tilts) returns to the old picture and resets it.
export const REARM_CHANGED_FRAMES = 3;

// WORST corner movement between two quads, in normalised units — deliberately not
// the mean that cardDetector.meanCornerDrift returns. One corner slipping off the
// card is a different card even when the other three sit still, and the mean
// divides that signal by four. REARM_DRIFT is tuned against this metric; the two
// are not interchangeable, which is why neither is called just "quadDrift" any
// more.
export function worstCornerDrift(a, b) {
  if (!a || !b || a.length !== 4 || b.length !== 4) return Infinity;
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    worst = Math.max(worst, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y));
  }
  return worst;
}

// Next count of consecutive frames showing a different, settled card. `sig` is
// this frame's signature, `prevSig` the last frame's, `capturedSig` the one taken
// with the photo. Any missing signature means "cannot tell", which resets.
export function nextChangedFrames(count, { sig, prevSig, capturedSig }) {
  if (!sig || !capturedSig) return 0;
  if (signatureDistance(capturedSig, sig) <= REARM_SIG_DIST) return 0;
  if (signatureDistance(prevSig, sig) > REARM_SIG_STABLE) return 0;
  return count + 1;
}

// Should a disarmed scanner become ready again?
//
// `emptyFrames` counts consecutive no-card readings and `emptyMs` how long it has
// been since a reading last saw a card. `quad` is the current detection (null
// when there is none) and `capturedQuad` the one that was last photographed.
// Comparing against the CAPTURED quad rather than the previous frame matters:
// drift compared frame-to-frame never accumulates while a user holds a card
// still, so a slow hand would re-arm on the same card.
//
// `changedFrames` (nextChangedFrames) covers what geometry cannot: the next card
// laid exactly where the last one was, with no empty reading in between.
export function shouldRearm({ armed, emptyFrames, emptyMs = 0, quad, capturedQuad, changedFrames = 0 }) {
  if (armed) return true;
  if (emptyFrames >= REARM_EMPTY_FRAMES) return true;
  if (emptyFrames > 0 && emptyMs >= REARM_EMPTY_MS) return true;
  if (changedFrames >= REARM_CHANGED_FRAMES) return true;
  if (!quad) return false;
  if (!capturedQuad) return true;
  return worstCornerDrift(capturedQuad, quad) > REARM_DRIFT;
}

// Should the shutter fire right now?
//
// `reading` is the latest detector result: { none, steady, fill, at }. A missing
// reading is NOT permission — the old code answered "yes" when it had no opinion,
// which was survivable only because the old contour detector always returned
// something. A detector that can say "there is no card" has to be believed.
export function shouldCapture({
  armed, busy, blocked, reading, now, lastCaptureAt,
  minSteady, minFill, staleMs = 1500,
}) {
  if (!armed || busy || blocked) return false;
  if (now - lastCaptureAt < MIN_RECAPTURE_MS) return false;
  if (!reading || reading.none) return false;
  if (now - reading.at > staleMs) return false;      // detection loop has stalled
  return reading.steady >= minSteady && reading.fill >= minFill;
}

// What auto-scan is waiting for, as a label key + severity. Derived from the same
// inputs as shouldCapture so the badge can never claim "Ready" while the trigger
// is declining, which is how a user ends up thinking the scanner is broken.
export function autoStatusKey({ armed, busy, blocked, reading, now, minSteady, minFill, staleMs = 1500 }) {
  if (busy) return 'scanning';
  if (blocked) return 'waiting';
  if (!armed) return 'lift';
  if (!reading || reading.none || now - reading.at > staleMs) return 'nocard';
  if (reading.fill < minFill) return 'closer';
  if (reading.steady < minSteady) return 'hold';
  return 'ready';
}
