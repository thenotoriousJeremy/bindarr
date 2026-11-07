// Tuning constants shared by CameraScanner and its hooks. Values and the
// measurements behind them are unchanged from when they lived in the component.
// Centered card-shaped guide box, styled in CSS (.scan-card-guide): card ratio
// with margin, centered by the overlay's flex. The crop maps the box's on-screen
// rect (getBoundingClientRect) into the frame, so its size is driven by CSS.
// Confidence gates for the server match. When ORB geometric verification ran
// (verified=true), gate on inlier count; otherwise on CLIP cosine similarity.
// Below the gate the scan shows the candidates for manual selection.
export const SCAN_MATCH_MIN_SCORE = 0.55;
export const SCAN_MATCH_MIN_INLIERS = 12;
// Minimum cosine gap between the top two embedding matches. Below it the model
// is saying "one of these", not "this one", and the picker is the right answer.
export const SCAN_MATCH_MIN_MARGIN = 0.02;
// Margin around the guide box when cropping. The box is an aim hint and a card
// can overhang it, so the crop runs slightly wider than the box itself.
export const CROP_PAD = 0.05;
// milo's input, and so the size of the crop the client uploads. Must match
// cvScan's EMBED_SIZE — the catalog was embedded at this size.
export const EMBED_SIZE = 448;
// Live-outline cadence. Detection is local, so this is bounded by CPU rather
// than by a network round trip: ~80ms per frame on a desktop, ~300ms on a phone.
// The loop is self-pacing, so a slower device simply updates less often.
// Detection costs ~50-70ms of real work per frame (a neural corner model, not a
// contour scan), and the loop schedules from the END of that work — the next
// frame is grabbed when the worker ANSWERS, not on a timer running underneath it.
// It used to reschedule 16ms after SUBMITTING, so while one detection was in
// flight the loop kept waking up and drawing the video into the detect canvas
// several times over, throwing every one of those frames away. That is a GPU
// readback and a full canvas draw per wasted tick, which is most of what makes
// the fan spin — and it got worse the slower detection was, so a degraded
// install burned the most CPU.
//
// So this is one frame's grace after a result, not a pacing budget.
export const DETECT_INTERVAL_MS = 16;
// Nothing to detect yet (video not ready, or a scan owns the pipeline). Retrying
// at DETECT_INTERVAL_MS would spin at 60Hz doing DOM lookups for nothing.
export const DETECT_IDLE_MS = 150;
// How still the corners must be, in normalised units, to count a frame as steady.
export const STEADY_DRIFT = 0.012;
// Consecutive steady frames before auto-capture will fire.
export const STEADY_FRAMES_NEEDED = 3;   // default; adjustable in scan settings
// How much of the guide crop the detected card must cover before auto-scan will
// take the picture. This was 0.7 against the contour detector, where `fill` meant
// how solidly a quad filled its own contour and a good detection scored ~0.9.
// Cornelius has no contour, so `fill` is now the quad's area as a fraction of the
// crop — a DIFFERENT quantity with a lower ceiling: the crop runs CROP_PAD wider
// than the guide box on each side, so a card aligned perfectly with the box tops
// out near 0.83. Carrying 0.7 across would have demanded near-perfect framing.
// Measured: card small in the frame scores 0.076, so this still rejects that by
// a wide margin. The real "there is no card" case is handled by `none`, not here.
export const MIN_FILL = 0.55;            // default; adjustable in scan settings
// Scan-detail presets (quick↔accurate slider). Higher index = more upload
// resolution, deeper server CLIP recall + more ORB features, longer cooldown:
// slower but more accurate. Lower = faster, less accurate. Turbo keeps ORB
// verify but with the fewest recall candidates + features — leanest ORB pass.
export const SCAN_PROFILES = [
  // uploadW floors at 720 even on the fastest preset: the guide crop is already
  // most of the way down from the capture, so a 400px upload delivered a ~250px
  // card, and exact-printing measures 76.0% at 250px against 91.0% at 420px.
  // That is 15 points given away for a few KB of JPEG, not a speed/accuracy
  // trade — recallK and orb below are where the real trade lives.
  //
  // `cooldown` and `cadence` are gone. Both existed to pace a clock-driven
  // auto-scan, and auto-scan is now driven by the detector: a card is scanned
  // when it is present and still, and not again until it is replaced. Waiting
  // out a preset delay after that only made the scanner feel slow. `countdown`
  // stays — it is the auto-ADD confirm window, which is a different decision.
  { label: 'Turbo',    uploadW: 720,  countdown: 0, recallK: 28,  orb: 240 },
  { label: 'Fast',     uploadW: 800,  countdown: 1, recallK: 60,  orb: 300 },
  { label: 'Balanced', uploadW: 900,  countdown: 2, recallK: 120, orb: 400 },
  { label: 'Accurate', uploadW: 1280, countdown: 2, recallK: 250, orb: 500 },
];
