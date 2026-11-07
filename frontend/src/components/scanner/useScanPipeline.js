import { useState, useRef, useEffect } from 'react';
import { requestDetect, stopDetect, smoothQuad, meanCornerDrift, DETECT_W } from '../../utils/cardDetector';
import { shouldCapture, shouldRearm, nextChangedFrames, autoStatusKey } from '../../utils/autoCapture';
import { createLiveValue } from '../../utils/liveValue';
import { DETECT_INTERVAL_MS, DETECT_IDLE_MS, STEADY_DRIFT, STEADY_FRAMES_NEEDED, MIN_FILL } from './scanConstants';

// The live detection loop and the auto-capture decision it drives, moved out of
// CameraScanner unchanged (utils/autoCapture.js and cardSignature.js still hold
// the rules; this is the wiring).
//
// What changed is where the per-frame results go. The outline quad, the
// auto-scan pill and the tuning readout used to be state of the whole scanner,
// so every detection re-rendered all ~3,000 lines of it. They are now live
// values (utils/liveValue.js) that only the small components drawing them
// subscribe to (LiveOverlays.jsx); a detection tick renders those and nothing
// else. The callers of setDetectQuad/setAutoState/setDetectStats below are
// untouched: a live value's set() takes a value or an updater and skips an
// unchanged one, exactly as a state setter does.
// One place that decides what auto-scan is doing, so the pill and the trigger
// can never disagree about why nothing is happening.
const AUTO_BADGE = {
  scanning: { key: 'scan.autoScanning', color: 'var(--accent-red)' },
  waiting: { key: 'scan.autoWaiting', color: '#fbbf24' },
  lift: { key: 'scan.autoLiftCard', color: '#fbbf24' },
  nocard: { key: 'scan.autoNoCard', color: 'rgba(255,255,255,0.55)' },
  closer: { key: 'scan.autoCloser', color: '#fbbf24' },
  hold: { key: 'scan.autoHoldStill', color: '#fbbf24' },
  ready: { key: 'scan.autoReady', color: 'var(--type-grass)' },
};

export function useScanPipeline({
  cameraActive, autoScan, videoRef, buildFramedCanvas,
  handleCaptureRef, loadingRef, captureBlockedRef, resolvedDupIdRef, t,
}) {
  // What auto-scan is waiting for, shown as a small pill. Without the old
  // countdown ring there is otherwise no feedback at all when it declines to
  // fire, and "nothing happens" is indistinguishable from "it is broken".
  const [autoStateStore] = useState(() => createLiveValue(null));
  const setAutoState = autoStateStore.set;
  // Latest detector result for the live outline, or null. Kept small on purpose:
  // { detected, quad(0..1 of the CROP), pick }.
  const [detectQuadStore] = useState(() => createLiveValue(null));
  const setDetectQuad = detectQuadStore.set;
  // Latest raw detector numbers, for the readout. Kept separate from bestFrame
  // so rendering never depends on a ref the detection loop mutates in place.
  const [detectStatsStore] = useState(() => createLiveValue(null));
  const setDetectStats = detectStatsStore.set;

  const outlineCanvas = useRef(null);   // one canvas, reused every update
  const smoothed = useRef(null);        // eased corners, what actually gets drawn
  const lastRawQuad = useRef(null);     // previous RAW detection, for drift
  const steadyFrames = useRef(0);       // consecutive low-drift detections
  const degradedWarned = useRef(false); // logged the detector fallback once
  // No live detector at all (the worker itself failed to load), so auto-scan can
  // never fire. A manual shutter appears instead; the server finds the card.
  const [detectorDown, setDetectorDown] = useState(false);
  const showSettingsRef = useRef(false); // the readout is only rendered while open
  const autoArmed = useRef(true);       // auto-capture is ready to fire
  const emptyFrames = useRef(0);        // consecutive "no card" detections
  const lastSeenAt = useRef(0);         // when a detection last saw a card
  const capturedQuad = useRef(null);    // quad at the last auto-capture
  const lastSig = useRef(null);         // previous detection's appearance signature
  const capturedSig = useRef(null);     // signature at the last capture
  const changedFrames = useRef(0);      // consecutive settled frames of a different card
  const lastCaptureAt = useRef(0);      // debounce floor, not a cadence
  const autoScanRef = useRef(false);    // autoScan for the detection callback
  const minFillRef = useRef(MIN_FILL);  // gates, read from the detection callback
  const minSteadyRef = useRef(STEADY_FRAMES_NEEDED); // which outlives any render
  const lastDrift = useRef(null);       // raw numbers behind the readout
  const lastCorners = useRef(null);
  const lastEngine = useRef(null);
  // Wall time of one detection, worker round trip included. The engine name alone
  // could not explain a crawling outline — cornelius on a phone without WebGPU
  // and the contour fallback both just say "slow".
  const detectStart = useRef(0);
  const lastDetectMs = useRef(null);
  const lastRunMs = useRef(null);   // inference alone, without the JS around it
  const bestFrame = useRef(null);       // latest { sharp, fill, steady } for capture gating

  // Is this moment worth taking the picture?
  //
  // Auto-scan used to fire on a clock and send whatever frame the tick landed
  // on — including motion-blurred ones, which measurably produced confident
  // WRONG answers that no amount of recall tuning could rescue. It is now driven
  // by the detector instead: the card decides when the photo happens.
  //
  // Deliberately NOT permissive about the no-card case. The old version answered
  // "yes" whenever it had no opinion, which was safe only because the contour
  // detector always returned something. A detector that can say "there is no
  // card" has to be believed, or auto-scan photographs empty desks.
  // Gate inputs, assembled once so the trigger and the badge read the same state.
  const autoArgs = () => ({
    armed: autoArmed.current,
    busy: loadingRef.current,
    blocked: captureBlockedRef.current,
    reading: bestFrame.current,
    now: Date.now(),
    lastCaptureAt: lastCaptureAt.current,
    minSteady: minSteadyRef.current,
    minFill: minFillRef.current,
  });

  const frameWorthCapturing = () => shouldCapture(autoArgs());

  // Auto-capture, edge triggered.
  //
  // The rule is "one scan per card presented", not "a scan every N ms". Firing
  // on an interval meant a card sitting under the camera got scanned over and
  // over while the user was still reaching for the next one, and a card placed
  // just after a tick waited out the rest of the beat for no reason.
  //
  // So: arm -> the detector reports a steady, well-framed card -> capture ->
  // disarm. Re-arm only once the scene has actually changed, which is either the
  // card leaving the frame or a visibly different quad appearing in it (swapping
  // one card for another without a gap in between). MIN_RECAPTURE_MS is a floor
  // against double-firing on the same card, not a cadence.

  // Called on every detection, so it only sets state that actually changed: each
  // set re-renders the pill (it used to re-render the whole scanner), and
  // per-frame renders of a badge that says the same thing are pure main-thread
  // cost on a phone.
  const refreshAutoState = () => {
    const status = autoStatusKey(autoArgs());
    const b = AUTO_BADGE[status];
    const label = t(b.key);
    setAutoState(prev => (prev && prev.label === label && prev.color === b.color ? prev : { status, label, color: b.color }));
    // The numeric readout is only on screen while scan settings are open.
    if (!showSettingsRef.current) return;
    const r = bestFrame.current;
    setDetectStats({
      none: !r || !!r.none,
      fill: r?.fill ?? 0,
      steady: r?.steady ?? 0,
      drift: lastDrift.current,
      corners: lastCorners.current,
      engine: lastEngine.current,
      ms: lastDetectMs.current,
      runMs: lastRunMs.current,
      armed: autoArmed.current,
    });
  };

  const tryAutoCapture = () => {
    refreshAutoState();
    if (!autoScanRef.current || !cameraActive) return;
    if (!frameWorthCapturing()) return;
    autoArmed.current = false;
    lastCaptureAt.current = Date.now();
    capturedQuad.current = lastRawQuad.current;
    capturedSig.current = lastSig.current;
    changedFrames.current = 0;
    handleCaptureRef.current?.();
  };

  // Live "where does the scanner think the card is" outline.
  //
  // Every crop failure used to be invisible until after the shutter: you framed a
  // card, got a wrong answer, and had no way to see the detector had locked onto a
  // sleeve edge or nothing at all. This closes that loop.
  //
  // The cost model is the entire design, because the first attempt at this froze
  // the app. Per update it does exactly one canvas draw and one async encode:
  //   · ONE canvas, reused (allocating per frame exhausts mobile canvas memory,
  //     after which new canvases come back blank rather than failing)
  //   · toBlob, not toDataURL — the latter is a SYNCHRONOUS JPEG encode
  //   · no getImageData anywhere — each call is a GPU readback
  //   · self-pacing: the next request is scheduled after the last one lands, so a
  //     slow phone or a slow network stretches the interval instead of queueing
  //   · kept running while a real scan's request is in flight, so a card lifted
  //     during it still re-arms auto-scan (see tick)
  // Roughly 1.5 requests/second of small JPEGs, and nothing synchronous.
  // Runs whenever the camera is on AND something needs it: the outline to draw,
  // or auto-scan to decide when to fire. Gating it on the outline alone meant
  // hiding the outline silently disabled auto-scan, since the detector is what
  // triggers a capture now.
  useEffect(() => {
    // Scanning off means the detector stops too. It exists to decide when to take
    // the picture; the outline is a readout of that same work, so drawing it while
    // nothing can fire would be paying ~1.5 inferences a second to animate a box.
    if (!cameraActive || !autoScan) { setDetectQuad(null); setAutoState(null); return; }
    refreshAutoState();
    let stopped = false;
    let timer;
    let cancelFrame = null;
    const schedule = (ms) => { if (!stopped) { clearTimeout(timer); timer = setTimeout(tick, ms); } };
    // After a result, wait for the camera's NEXT frame rather than a fixed delay:
    // a frame is never detected twice and none sits waiting on a timer. The
    // timeout is a guard for a video that stops presenting frames.
    const scheduleFrame = () => {
      const v = videoRef.current;
      if (stopped || !v?.requestVideoFrameCallback) { schedule(DETECT_INTERVAL_MS); return; }
      const id = v.requestVideoFrameCallback(() => tick());
      cancelFrame = () => v.cancelVideoFrameCallback(id);
      schedule(500);
    };

    // Applied when the worker answers, not when the frame was submitted.
    const onDetectResult = (found) => {
      if (stopped) return;
      // The pacing lives here, not after the submit: one frame in flight, and the
      // next grabbed only once this one has landed.
      scheduleFrame();
      // Say so, once, when the neural detector could not be loaded and the
      // contour fallback is carrying the outline. Silent degradation here looks
      // exactly like "the scanner got worse for no reason".
      if (found.runMs != null) lastRunMs.current = found.runMs;
      if (detectStart.current) {
        lastDetectMs.current = Math.round(performance.now() - detectStart.current);
        detectStart.current = 0;
      }
      if (found.degraded && !degradedWarned.current) {
        degradedWarned.current = true;
        console.warn(`Card detector degraded to contour fallback: ${found.degraded}`);
      }
      if (found.error) console.warn(`Card detector (${found.engine || 'none'}): ${found.error}`);
      if (found.fatal) setDetectorDown(true);
      if (!found.detected) {
        steadyFrames.current = 0;
        smoothed.current = null;
        lastRawQuad.current = null;
        lastSig.current = null;
        changedFrames.current = 0;
        // A DEFINITE "no card", not an absence of information. The old contour
        // detector always returned some quad and a bad one simply scored low, so
        // "no answer" and "no card" were the same state and nulling this was
        // harmless. Cornelius declines outright, and a null here reads as "the
        // detector has not spoken yet", which frameWorthCapturing treats as
        // permission to fire — auto-scan then photographed an empty desk.
        bestFrame.current = { at: Date.now(), sharp: 0, fill: 0, steady: 0, none: true };
        // The frame emptying is the normal way a card is "finished": the user
        // lifts it off the mat. Require a few consecutive empty frames so a
        // hand passing over the card does not re-arm mid-scan.
        emptyFrames.current += 1;
        const emptyMs = Date.now() - lastSeenAt.current;
        if (shouldRearm({ armed: autoArmed.current, emptyFrames: emptyFrames.current, emptyMs, quad: null, capturedQuad: capturedQuad.current })) {
          autoArmed.current = true;
          capturedQuad.current = null;
          resolvedDupIdRef.current = null;
        }
        lastDrift.current = null;
        lastCorners.current = found.corners ?? null;
        lastEngine.current = found.engine || 'none';
        setDetectQuad(q => q && null);   // already empty: no re-render
        refreshAutoState();
        return;
      }
      emptyFrames.current = 0;
      lastSeenAt.current = Date.now();
      // Drift is measured between RAW results; the smoothed quad is only what
      // gets drawn, and easing it would make everything look steady.
      const drift = meanCornerDrift(lastRawQuad.current, found.quad);
      lastDrift.current = Number.isFinite(drift) ? drift : null;
      lastCorners.current = found.corners ?? null;
      lastEngine.current = found.engine || 'none';
      lastRawQuad.current = found.quad;
      smoothed.current = smoothQuad(smoothed.current, found.quad);
      steadyFrames.current = drift < STEADY_DRIFT ? steadyFrames.current + 1 : 0;
      bestFrame.current = {
        at: Date.now(),
        sharp: found.sharp || 0,
        fill: found.pick?.fill ?? 0,
        steady: steadyFrames.current,
      };
      // Card swapped without the frame ever emptying — a different quad in the
      // same place counts as a new card, otherwise feeding cards edge-to-edge
      // would only ever scan the first one. And a different PICTURE in the same
      // quad counts too: the next card dropped onto the last one never empties
      // the frame and never moves the quad, and with auto-add on nothing else
      // re-arms (only the add drawer closing does, and auto-add skips it).
      changedFrames.current = nextChangedFrames(changedFrames.current, {
        sig: found.sig, prevSig: lastSig.current, capturedSig: capturedSig.current,
      });
      lastSig.current = found.sig || null;
      if (shouldRearm({ armed: autoArmed.current, emptyFrames: 0, quad: found.quad, capturedQuad: capturedQuad.current, changedFrames: changedFrames.current })) {
        autoArmed.current = true;
        capturedQuad.current = null;
        resolvedDupIdRef.current = null;
      }
      setDetectQuad({ ...found, quad: smoothed.current });
      tryAutoCapture();
    };

    const tick = () => {
      if (stopped) return;
      clearTimeout(timer);
      cancelFrame?.();
      cancelFrame = null;
      try {
        const guideElement = document.querySelector('.scan-card-guide');
        // Skip before the video has a frame to copy: videoWidth is set at
        // metadata, but there are no pixels until readyState reaches
        // HAVE_CURRENT_DATA, and drawing early yields black.
        //
        // NOT skipped while a scan is in flight. The capture cue tells the user to
        // move the card at once, so the swap usually happens during the request;
        // a paused detector never saw the frame empty, the next card landed in the
        // same guide box (well under REARM_DRIFT), and auto-scan sat on "Next
        // card" for good. The capture has already copied its pixels by then, and
        // shouldCapture's busy gate keeps this from firing a second scan.
        const v = videoRef.current;
        if (guideElement && v?.videoWidth && v.readyState >= 2) {
          if (!outlineCanvas.current) outlineCanvas.current = document.createElement('canvas');
          const c = buildFramedCanvas(v, guideElement, DETECT_W, outlineCanvas.current, true);
          // Fire-and-forget: the worker answers on its own schedule and a frame
          // is skipped rather than queued while one is in flight. Queueing would
          // only produce results describing a scene that has already moved.
          if (c && requestDetect(c, onDetectResult)) {
            detectStart.current = performance.now();
            return;   // onDetectResult schedules the next one
          }
        }
      } catch {
        // A dropped preview frame is not worth surfacing; the next tick retries.
        if (!stopped) setDetectQuad(q => q && null);
      }
      // Nothing was submitted, so nothing will call back. Idle poll.
      schedule(DETECT_IDLE_MS);
    };
    timer = setTimeout(tick, 400);   // let the camera settle before the first look
    return () => { stopped = true; clearTimeout(timer); cancelFrame?.(); stopDetect(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraActive, autoScan]);

  return {
    detectQuadStore, autoStateStore, detectStatsStore, detectorDown,
    autoArmed, capturedQuad, lastRawQuad, lastSig, capturedSig, changedFrames,
    lastCaptureAt, bestFrame, autoScanRef, minFillRef, minSteadyRef, showSettingsRef,
    frameWorthCapturing, refreshAutoState,
  };
}
