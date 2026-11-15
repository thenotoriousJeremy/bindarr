// Turn the corner model's raw outputs into the result the scanner consumes.
//
// Shared by every engine that runs the model: the wasm worker (detectWorker.js)
// and native ONNX Runtime in the app (nativeDetector.js). Engines differ only in
// where the arithmetic happens; the gate, the corner order and the extra readings
// are decided here once, so switching engine cannot change what auto-scan sees.
import { sharpness } from './sharpness.js';
import { quadSignature } from './cardSignature.js';
import { orderQuad } from '../../../shared/imgproc.mjs';
import { SHARPNESS_GATE } from '../../../shared/scanModel.mjs';

// The confidence gate (below it the SimCC peaks are flat: the model is not
// looking at a card) and the corner order are the server's own, from shared/.
// Re-exported for this module's callers.
export { orderQuad, SHARPNESS_GATE };

// Shoelace area of a quad in normalised (0..1) coordinates, so the result is the
// fraction of the frame it covers. Absolute value: corner order decides the sign
// and a mirrored detection is still a detection.
export function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i], n = q[(i + 1) % 4];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

// corners: the model's 8 normalised numbers. score: its `sharpness` output (the
// corner confidence; absent means the model has no such head, so trust it).
// rgba/w/h: the frame the model saw, for the focus score and the card signature.
export function cornerResult({ seq, engine, runMs, corners, score, rgba, w, h }) {
  const sharp = score ?? 1;
  if (!(sharp > SHARPNESS_GATE)) return { seq, detected: false, engine, runMs, corners: sharp };
  const pts = [];
  for (let i = 0; i < 4; i++) pts.push({ x: corners[i * 2], y: corners[i * 2 + 1] });
  const quad = orderQuad(pts);
  return {
    seq,
    detected: true,
    engine,
    runMs,
    quad,
    // `pick.fill` gates auto-capture (>= 0.7). The old contour detector meant
    // "how solidly the quad fills its own contour"; cornelius has no contour,
    // so the equivalent question is how much of the guide crop the card
    // covers — which is what the gate was really protecting against, a
    // detection that is too small or too skewed to be the card being aimed.
    pick: { fill: quadArea(quad) },
    // The model's corner confidence, not image focus. Both matter and they
    // are not the same thing, so both are reported.
    corners: sharp,
    sharp: sharpness(rgba, w, h),
    // What the card looks like, so auto-scan can tell a new card laid on the
    // old one from the old one still sitting there (autoCapture.nextChangedFrames).
    sig: quadSignature(rgba, w, h, quad),
  };
}
