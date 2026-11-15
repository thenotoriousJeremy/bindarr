import { useState, useEffect, useRef } from 'react';
import { Camera, RefreshCw, AlertTriangle, X, Zap, ZapOff, Settings, ScanLine, SwitchCamera } from 'lucide-react';
import { getCardDisplayName } from '../utils/langHelper';
import CardInspectorModal from './CardInspectorModal';
import { useBackGuard } from '../utils/useBackGuard';
import { onActivateKey, useEscape } from '../utils/a11y';
import { useMultiSelect } from '../utils/useMultiSelect';
import { langName } from '../utils/languages';
import { nextCamera } from '../utils/cameraPick';
import { isDeviceMode } from '../apiBase';
import { useT } from '../utils/i18n';
import { useCameraStream } from './scanner/useCameraStream';
import { useScanPipeline } from './scanner/useScanPipeline';
import { useScanSettings } from './scanner/useScanSettings';
import { useGuideGesture } from './scanner/useGuideGesture';
import { useAddFlow } from './scanner/useAddFlow';
import { useStableCallback, useStableHandlers } from '../utils/useStableCallback';
import { buildFramedCanvas as frameCanvas, localDewarp as dewarpQuad } from './scanner/scanFrame';
import { scanDecision, sameCard, rankByScore } from './scanner/scanDecision';
import AutoAddModal from './scanner/AutoAddModal';
import DupConfirmModal from './scanner/DupConfirmModal';
import ScanMatchesModal from './scanner/ScanMatchesModal';
import RecentScans from './scanner/RecentScans';
import ScanSettingsPanel from './scanner/ScanSettingsPanel';
import QuickAddDrawer from './scanner/QuickAddDrawer';
import { DetectOutline, AutoStatePill } from './scanner/LiveOverlays';
import { SCAN_MATCH_MIN_SCORE, SCAN_MATCH_MIN_INLIERS } from './scanner/scanConstants';

// The camera scanner. Its parts live in ./scanner: the camera (useCameraStream),
// the live detection loop and auto-capture (useScanPipeline), the settings
// (useScanSettings, ScanSettingsPanel, SetFilter), the guide box gesture
// (useGuideGesture), the frame geometry (scanFrame), what a match means
// (scanDecision) and what happens to a named card (useAddFlow, QuickAddDrawer
// and the modals). What stays here is the capture itself and the screen.
function CameraScanner({ onAddSuccess, showToast }) {
  const { t } = useT();

  const [loading, setLoading] = useState(false);
  const [scanStatus, setScanStatus] = useState('');
  const [scanMatches, setScanMatches] = useState([]);

  // UX scan history & effects states
  const [recentScans, setRecentScans] = useState([]);
  // Tap a recent scan to view/edit it; long-press to delete. Inspector reuses the
  // shared collection edit/delete modal (needs an entry-shaped object with entry_id).
  const [inspectorEntry, setInspectorEntry] = useState(null);
  // Long-press multi-select + bulk actions, same as the collection page.
  const recentSelect = useMultiSelect({
    showToast,
    onChanged: ({ ids, action }) => {
      onAddSuccess();
      // Recent scans is a local list: prune deleted tiles. Moves leave the tile
      // (its placement label just goes stale until the next scan).
      if (action === 'delete') setRecentScans(prev => prev.filter(s => !ids.includes(s.entry_id)));
    },
  });
  const [scanFlash, setScanFlash] = useState(null); // 'capture', 'error', or null
  const dewarpCanvas = useRef(null);    // reused for client dewarp

  // Scanning is the DEFAULT and only mode: point the camera at a card and it is
  // captured when the detector says it is there and still. There is no manual
  // shutter — the toggle in the action row pauses scanning instead. Deliberately
  // NOT persisted: every session starts scanning, so a pause is a pause and not a
  // setting the user has to remember undoing.
  const [autoScan, setAutoScan] = useState(true);

  const [debugHashImg, setDebugHashImg] = useState('');
  const [debugCandidates, setDebugCandidates] = useState([]);
  const [debugScoped, setDebugScoped] = useState(null); // set code if set-scoped, false if global, null if n/a

  // What is being scanned and how. Switching game or language makes the last
  // scan's diagnostics meaningless, and a language reset carries to the drawer.
  const settings = useScanSettings({
    onScanLanguageReset: (name) => flow.setLanguage(name),
    onCatalogSwitch: () => {
      setDebugCandidates([]);
      setDebugHashImg('');
      setDebugScoped(null);
    },
  });
  const { profile, scanGame, scanLang, scanSetParam, autoAdd, showScanSettings, showDebug } = settings;
  const guide = useGuideGesture();

  const currentScanId = useRef(0);
  const lastScanImgRef = useRef(null);
  const lastScanCroppedRef = useRef(false);

  // Auto-capture duplicate guard: a physical card lingers in frame across the
  // 3s auto-scan cycle. lastAddedId = the card just auto-added; a repeat match
  // of it means "same card again" — confirm a real 2nd copy vs a re-scan.
  // resolvedDupId = a repeat we already settled; skip it silently until a
  // different card appears (stops a re-prompt loop while it stays in view).
  const lastAddedIdRef = useRef(null);
  const resolvedDupIdRef = useRef(null);
  const beepCtxRef = useRef(null); // reused AudioContext for the scan cue
  const handleCaptureRef = useRef(null); // always the latest handleCapture, for timers
  // Same trick for the capture gate: the metronome interval closes over its first
  // render, so it needs a ref to reach the current predicate.
  const frameWorthCaptureRef = useRef(null);
  const captureBlockedRef = useRef(false); // true while a modal/picker/drawer is up
  const loadingRef = useRef(false); // mirrors `loading` for the metronome interval

  // Instant feedback cue: flash the whole preview white, click, and (on mobile)
  // vibrate. 'capture' fires the instant the photo is grabbed so the user can
  // move the card immediately; 'error' marks a failed/no-match scan. Web Audio
  // only (no asset/lib); no-ops if the browser blocks audio until a gesture.
  // The scan cue's AudioContext, created on demand and kept for the session.
  // Called from startCamera too: that tap is a real user gesture, which is what
  // the autoplay policy wants before a context may make sound.
  const beepCtx = () => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ctx = beepCtxRef.current || (beepCtxRef.current = new AC());
    // Anything that is not 'running' is silent, and there are three such states,
    // not one: 'suspended' (autoplay policy, or the browser parking an idle
    // context) and iOS Safari's 'interrupted' (another app took audio focus, a
    // call, a screen lock). Testing only for 'suspended' is why the cue worked on
    // the first scan and never again — the context had moved to a state the guard
    // did not recognise, so every later beep was scheduled into silence.
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    return ctx;
  };

  // Closing the scanner closes its AudioContext: browsers allow only a handful
  // alive at once, and every open used to leave one behind (MOB-05). In device
  // mode the on-device scan engine's model sessions are released too (MOB-08).
  useEffect(() => {
    // The context made last, read at cleanup time on purpose.
    const holder = beepCtxRef;
    return () => {
      const ctx = holder.current;
      holder.current = null;
      if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {});
      if (isDeviceMode()) import('../device/runtime.js').then(m => m.releaseScanEngine()).catch(() => {});
    };
  }, []);

  const signal = (type) => {
    setScanFlash(type);
    setTimeout(() => setScanFlash(null), type === 'capture' ? 400 : 1500);
    if (type === 'capture' && navigator.vibrate) navigator.vibrate(30);
    try {
      const ctx = beepCtx();
      if (!ctx) return;
      const play = () => {
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = type === 'capture' ? 'square' : 'sine';
        osc.frequency.value = type === 'error' ? 300 : 660; // capture = crisp click
        osc.connect(gain); gain.connect(ctx.destination);
        const dur = type === 'capture' ? 0.05 : 0.15; // short = click, long = tone
        gain.gain.setValueAtTime(0.18, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
        osc.start(); osc.stop(ctx.currentTime + dur);
      };
      // resume() is async, so scheduling into a context that is not running yet is
      // silent — wait for it. beepCtx() already asked for the resume; this awaits
      // the same transition rather than firing a second one.
      if (ctx.state === 'running') play();
      else ctx.resume().then(play).catch(() => {});
    } catch { /* audio unavailable — visual flash still fires */ }
  };

  const handleCancelScan = () => {
    currentScanId.current += 1;
    setLoading(false);
    resolvedDupIdRef.current = null;
    const msg = t('scan.cancelled');
    setScanStatus(msg);
    setTimeout(() => {
      setScanStatus(prev => prev === msg ? '' : prev);
    }, 2000);
  };

  // The picker opens compact and expands on request rather than dumping eight
  // cards at once.
  const [showAllMatches, setShowAllMatches] = useState(false);
  const PICKER_PREVIEW = 4;
  const [manualSearchText, setManualSearchText] = useState('');
  const [manualSearching, setManualSearching] = useState(false);

  // Act on whatever card is in frame next, rather than the one just handled.
  const rearm = () => {
    autoArmed.current = true;
    capturedQuad.current = null;
    resolvedDupIdRef.current = null;
  };
  // Back / Esc on the match picker and the duplicate prompt (their <Modal>s
  // own the back guard).
  const dismissMatches = () => {
    setScanMatches([]);
    rearm();
  };

  // What happens to a card once it is named: auto-add, the add drawer, the
  // duplicate prompt.
  const flow = useAddFlow({
    t, showToast, onAddSuccess, signal, scanGame, scanLang,
    setRecentScans, setScanMatches, setShowAllMatches,
    lastScanImgRef, lastScanCroppedRef, lastAddedIdRef, resolvedDupIdRef,
    rearm,
    // Restart camera on close only if stream was stopped
    ensureCamera: () => {
      if (!stream || !cameraActive) startCamera();
    },
  });
  const {
    isDrawerOpen, closeDrawer, openQuickAdd, autoAddCard, addLanguage,
    autoAddTargetCard, autoAddCountdown, autoAddEditing, dupConfirmCard,
  } = flow;
  useBackGuard(!!inspectorEntry, () => setInspectorEntry(null));
  useBackGuard(recentSelect.selectMode, recentSelect.exitSelectMode);

  // What a fresh camera open resets in the scanner itself. These were the first
  // lines of startCamera before the camera moved to useCameraStream, which calls
  // this at the same point.
  const resetForCameraOpen = () => {
    // Create/unlock the scan cue here: this call is inside a click handler, and a
    // context first created without a gesture starts suspended with no promise of
    // ever being allowed to resume. Every capture after this is gesture-less.
    beepCtx();
    setScanMatches([]);
    setScanStatus('');
    setDebugHashImg('');
    setDebugCandidates([]);
    setDebugScoped(null);
    lastAddedIdRef.current = null;
    resolvedDupIdRef.current = null;
    autoArmed.current = true;
    capturedQuad.current = null;
  };
  const camera = useCameraStream({ showToast, t, onBeforeOpen: resetForCameraOpen });
  const {
    stream, cameraActive, cameraErrorKey, isTorchOn, videoInputs, videoRef,
    toggleTorch, startCamera, switchCamera, cameraLabel, activeCameraId,
  } = camera;

  // No stopCamera: the stop button is gone. The camera lives exactly as long as
  // this component — leaving the scan tab unmounts it, and the unmount cleanup
  // above stops the tracks (which also kills the torch).

  // The guide box's region of the frame, and the card rectified out of it
  // (scanner/scanFrame.js), with the box as it is right now.
  const buildFramedCanvas = (video, guideElement, maxW = 0, target = null, square = false) =>
    frameCanvas(video, guideElement, { angle: guide.guideAngle, scale: guide.guideScale }, maxW, target, square);
  const localDewarp = (canvas, quad) => dewarpQuad(canvas, quad, dewarpCanvas);

  // Turn ORB candidates into full cards, preserving ORB's order so the options
  // on screen line up one-for-one with the match list. Each lookup is by the
  // matched printing, never by name as well: the index stores the name from when
  // the set was built, and one re-spelling would drop the candidate entirely.
  //
  // Failures resolve to null rather than throwing — one unresolvable candidate
  // must not take the other seven down with it.
  const resolveCandidates = async (cands, game, lang) => Promise.all(
    cands.map(async (cand) => {
      // Already hydrated server-side (exact set+number hit in card_cache).
      if (cand.card) return { ...cand.card, __match: { inliers: cand.inliers, score: cand.score } };
      const p = new URLSearchParams({ game, lang });
      if (cand.set && cand.number) {
        p.append('set', cand.set);
        p.append('number', cand.number);
      } else if (cand.name) {
        p.append('name', cand.name);
      } else return null;
      // Keep the row that IS this candidate. A set+number query should return
      // exactly one, but never assume — taking m[0] blindly is how a different
      // printing reached the picker.
      const ask = async (params) => {
        const res = await fetch(`/api/search?${params.toString()}`);
        if (!res.ok) return null;
        const m = await res.json();
        return (cand.number ? m.find(c => sameCard(c, cand)) : m[0]) || null;
      };
      try {
        let hit = await ask(p);
        // Nothing in the scanned language. The candidate's set id came from an
        // English catalog, and Korean/Japanese/Chinese Pokémon sets are their own
        // releases rather than localised editions of it — so that set id exists in
        // no other language and this lookup can only ever fail. Ask in English and
        // mark the answer, the same as the server does for the candidates it
        // resolves itself: the right card in the wrong language beats no card.
        if (!hit && lang && lang !== 'en') {
          p.set('lang', 'en');
          hit = await ask(p);
          if (hit) hit = { ...hit, langFallback: langName(lang) };
        }
        return hit ? { ...hit, __match: { inliers: cand.inliers, score: cand.score } } : null;
      } catch { return null; }
    })
  );

  // Present the image-match results: show the picker, and on a single result
  // take the fast path (auto-add / quick-
  // add per mode). autoSingle lets the caller allow the fast path for a single MTG
  // result too — used when the image match is confident and the printing is
  // unambiguous (only one printing, or the set code narrowed it to one). Ambiguous
  // MTG (many printings, no set code) still shows the picker.
  const applyMatches = async (matches, notFoundMsg, autoSingle = false) => {
    setScanMatches(matches);
    setShowAllMatches(false);   // each scan's picker opens compact again
    if (matches.length === 0) {
      // Nothing in frame — the resolved-duplicate card has left, so clear the
      // skip guard; re-presenting it later should prompt again, not skip forever.
      resolvedDupIdRef.current = null;
      setScanStatus(notFoundMsg);
      signal('error');
      return;
    }
    setScanStatus('');
    if (matches.length === 1 && (scanGame !== 'mtg' || autoSingle)) {
      // Auto-add, not auto-scan: scanning found the card either way. This decides
      // whether it is filed straight away or handed to the add drawer first.
      if (autoAdd) {
        const id = matches[0].id;
        if (id === resolvedDupIdRef.current) {
          // Same card we already handled, still sitting in frame — wait for a
          // different card before doing anything.
          setScanMatches([]);
          setScanStatus(t('scan.sameCardInView'));
          return;
        }
        if (id === lastAddedIdRef.current) {
          // Repeat of the card just auto-added: could be a real second copy or
          // just the same card lingering. Make the user decide.
          flow.setDupConfirmCard(matches[0]);
          flow.setDupQty(1);
          setScanMatches([]);
          return;
        }
        // A different card is now in frame — clear the skip guard so the old
        // resolved-duplicate card is scannable again later.
        resolvedDupIdRef.current = null;
        // countdown 0 (Turbo): add immediately, no confirm-modal idle. Higher
        // tiers show the countdown overlay so the user can cancel a mis-scan.
        if (profile.countdown === 0) {
          autoAddCard(matches[0]);
        } else {
          flow.setAutoAddTargetCard(matches[0]);
          flow.setAutoAddCountdown(profile.countdown);
        }
        setScanMatches([]);
      } else {
        openQuickAdd(matches[0]);
      }
    }
  };

  const handleCapture = async () => {
    if (loading || !videoRef.current || !cameraActive) return;

    // A manual capture consumes the card in frame exactly like an auto one, so
    // it disarms too. Otherwise tapping the button and then holding the same
    // card still would have auto-scan immediately fire a second scan of it.
    autoArmed.current = false;
    lastCaptureAt.current = Date.now();
    capturedQuad.current = lastRawQuad.current;
    capturedSig.current = lastSig.current;
    changedFrames.current = 0;

    setLoading(true);
    const scanId = ++currentScanId.current;
    setScanMatches([]);
    setScanStatus(t('scan.initializing'));

    const video = videoRef.current;

    const guideElement = document.querySelector('.scan-card-guide');
    if (!guideElement) {
      setLoading(false);
      setScanStatus(t('scan.errNoGuideBox'));
      return;
    }

    // 1. Capture the guide-box region, oriented and deskewed to the box.
    const framedCanvas = buildFramedCanvas(video, guideElement);
    if (!framedCanvas) {
      setLoading(false);
      setScanStatus(t('scan.errNoFrame'));
      return;
    }
    // Picture is now taken — fire the instant cue (click + vibrate + flash) so
    // the user can move the card immediately, before the server lookup runs.
    signal('capture');

    try {
      // Identify by image (server-side). Send the WHOLE oriented frame (downscaled)
      // so the server can auto-detect + deskew the card before matching — the guide
      // box is just an aim hint.
      {
        setScanStatus(t('scan.matching'));
        {
          // The browser already ran cornelius on this frame for the live outline,
          // so it knows where the four corners are. Dewarping here and uploading
          // only the rectified card sends ~35KB instead of ~155KB, and lets the
          // server skip both its JPEG decode of a full frame and its own corner
          // pass.
          //
          // Only when the detector actually had a card. With no quad — manual
          // shutter on a frame the detector could not read, or a degraded
          // fallback engine — the WHOLE frame goes up and the server detects it
          // there. That path is the safety net, because a bad client crop is
          // unrecoverable: the server never sees the pixels outside it.
          // Only a quad from a detection that is still current. A stale one — the
          // manual shutter on a frame the detector never read, or a card that has
          // since moved — would crop confidently around the wrong place.
          const fresh = bestFrame.current && (Date.now() - bestFrame.current.at) < 500;
          const quad = fresh ? lastRawQuad.current : null;
          const cropped = quad ? localDewarp(framedCanvas, quad) : null;
          const imageData = cropped || (() => {
            const up = document.createElement('canvas');
            const s = Math.min(1, profile.uploadW / framedCanvas.width);
            up.width = Math.round(framedCanvas.width * s);
            up.height = Math.round(framedCanvas.height * s);
            up.getContext('2d').drawImage(framedCanvas, 0, 0, up.width, up.height);
            return up.toDataURL('image/jpeg', 0.85);
          })();
          setDebugHashImg(imageData);
          lastScanImgRef.current = imageData;
          lastScanCroppedRef.current = !!cropped;
          try {
            const resp = await fetch('/api/scan-match', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ game: scanGame, image: imageData, cropped: !!cropped, set: scanSetParam, lang: scanLang, recallK: profile.recallK, orb: profile.orb }),
            });
            if (scanId !== currentScanId.current) return;
            // A 503 here is the server saying no catalog exists for this game and
            // language, with an error that names the fix. It used to fall straight
            // through to "no confident match", so the one message that could have
            // told an admin what to do was never shown.
            if (!resp.ok) {
              const j = await resp.json().catch(() => null);
              if (scanId !== currentScanId.current) return;
              if (j?.notBuilt) {
                setScanStatus(t('scan.catalogNotBuilt'));
                signal('error');
                return;
              }
              // Device mode: the scan data is there but the model would not run
              // on this phone. Downloading it again would not help (MOB-04).
              if (j?.scanFailed) {
                console.warn('On-device scan failed:', j.error);
                setScanStatus(t('scan.deviceScanFailed'));
                signal('error');
                return;
              }
            }
            if (resp.ok) {
              const match = await resp.json();
              const { game: matchGame, verified, candidates, crop, scoped, notInCatalog, unresolvedPublished } = match;
              console.log('Scan candidates:', matchGame, scanLang, scoped ? `(set-scoped ${scanSetParam})` : '(GLOBAL)', verified ? 'ORB' : 'CLIP', candidates);
              if (crop) setDebugHashImg(crop); // show the server's auto-cropped card
              setDebugScoped(scoped ? scanSetParam : false);
              setDebugCandidates((candidates || []).map(c => ({ ...c, verified })));
              // File the top card, or ask: confidence, a printing the image
              // cannot tell apart, a narrow margin, a card the catalog does not
              // know. The rules are scanner/scanDecision.js.
              const { top, confidentPick } = scanDecision(match);
              if (candidates && candidates.length > 0) {
                // Resolve the WHOLE ORB list to real cards, once, and use it for
                // both outcomes. The confident path used to resolve only the top
                // pick, which meant the auto-add overlay had nothing to offer if
                // it guessed wrong — and when scanning a whole set, the card in
                // hand often is not ORB's first choice.
                // Turbo (countdown 0) adds instantly with no overlay, so there is
                // nowhere to put alternatives — resolving eight cards per scan
                // would be pure latency on the fastest tier. Everywhere else the
                // whole list is resolved, because the countdown shows it.
                const wanted = (confidentPick && profile.countdown === 0)
                  ? candidates.slice(0, 1)
                  : candidates.slice(0, 8);
                // Only announce a fetch if one is actually needed; anything the
                // server pre-hydrated resolves without a round-trip.
                if (wanted.some(c => !c.card)) setScanStatus(t('scan.fetchingCandidates'));
                const resolved = await resolveCandidates(wanted, matchGame, scanLang);
                if (scanId !== currentScanId.current) return;
                const validCandidates = resolved.filter(Boolean);
                // Remembered for the add drawer, which otherwise loses every
                // alternative the moment a card is chosen.
                flow.setLastMatches(validCandidates);

                if (validCandidates.length > 0) {
                  // Confident: auto-add the top pick, but keep the rest on screen
                  // beside the countdown so a wrong guess is one tap to correct
                  // rather than an undo after the fact.
                  if (confidentPick && sameCard(validCandidates[0], top)) {
                    flow.setAutoAddAlternatives(validCandidates.slice(1));
                    await applyMatches([validCandidates[0]], '', true);
                    return;
                  }
                  flow.setAutoAddAlternatives([]);
                  await applyMatches(validCandidates, '', false);
                  // applyMatches clears the status line for a non-empty list, so
                  // this has to land after it.
                  if (notInCatalog) setScanStatus(t('scan.notInCatalog'));
                  return;
                }
                // The catalog matched and nothing could be named. Only the
                // ready-made Pokémon catalog can end up here (its ids are
                // TCGplayer product ids with no card data behind them), and
                // "no confident match" would blame the photo for an install
                // state the user can fix.
                if (unresolvedPublished) {
                  setScanStatus(t('scan.readyMadeUnresolved'));
                  signal('error');
                  return;
                }
              }
            }
          } catch (e) { console.warn('scan-match request failed:', e); }
        }
      }

      setScanStatus(t('scan.noConfidentMatch'));
      // Frame no longer shows a recognizable card — clear the skip guard so the
      // resolved-duplicate card isn't skipped forever once re-presented.
      resolvedDupIdRef.current = null;
      signal('error');
    } catch (err) {
      console.error('Scan match failed:', err);
      if (scanId === currentScanId.current) setScanStatus(t('scan.scanFailed'));
    } finally {
      if (scanId === currentScanId.current) setLoading(false);
    }
  };
  // Keep the ref pointing at the latest handleCapture so timers (metronome /
  // cooldown) always invoke the current closure, never a stale one.
  handleCaptureRef.current = handleCapture;
  // Metronome reads this (not effect deps) to decide whether to fire a capture,
  // so a modal/picker/drawer pauses the beat without restarting the interval.
  captureBlockedRef.current = isDrawerOpen || scanMatches.length > 0 || !!autoAddTargetCard || !!dupConfirmCard;
  loadingRef.current = loading;
  const {
    detectQuadStore, autoStateStore, detectStatsStore, detectorDown,
    autoArmed, capturedQuad, lastRawQuad, lastSig, capturedSig, changedFrames,
    lastCaptureAt, bestFrame, autoScanRef, minFillRef, minSteadyRef, showSettingsRef,
    frameWorthCapturing, refreshAutoState,
  } = useScanPipeline({
    cameraActive, autoScan, videoRef, buildFramedCanvas,
    handleCaptureRef, loadingRef, captureBlockedRef, resolvedDupIdRef, t,
  });
  frameWorthCaptureRef.current = frameWorthCapturing;
  autoScanRef.current = autoScan;
  showSettingsRef.current = showScanSettings;
  minFillRef.current = settings.minFill;
  minSteadyRef.current = settings.minSteady;
  // The "Next card" tap on the auto-scan pill: re-arm on whatever is in frame.
  const rearmFromPill = useStableCallback(() => {
    autoArmed.current = true;
    capturedQuad.current = null;
    resolvedDupIdRef.current = null;
    refreshAutoState();
  });

  const handleManualSearch = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    const q = manualSearchText.trim();
    if (!q || manualSearching) return;
    setManualSearching(true);
    try {
      const p = new URLSearchParams({
        game: scanGame,
        lang: scanLang,
        scope: 'internet',
        q,
      });
      const hasImage = lastScanImgRef.current;
      const searchResponse = hasImage
        ? await fetch('/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              game: scanGame,
              lang: scanLang,
              scope: 'internet',
              q,
              image: lastScanImgRef.current,
              cropped: lastScanCroppedRef.current,
            }),
          })
        : await fetch(`/api/search?${p.toString()}`);
      if (searchResponse.ok) {
        const m = await searchResponse.json();
        if (m.length) {
          setScanMatches(rankByScore(m));
          setShowAllMatches(true);
        } else {
          showToast(t('scan.errManualSearch'));
        }
      } else {
        showToast(t('scan.errManualSearch'));
      }
    } catch {
      showToast(t('scan.errManualSearch'));
    } finally {
      setManualSearching(false);
    }
  };

  useEscape(isDrawerOpen, closeDrawer);

  const removeRecentTile = (entryId) => setRecentScans(prev => prev.filter(s => s.entry_id !== entryId));
  // Tap: open the inspector, unless a long-press just armed selection or we're
  // already selecting (then toggle). Long-press + bulk actions come from the hook.
  const activateRecent = (item) => {
    if (recentSelect.longPressFired.current) { recentSelect.longPressFired.current = false; return; }
    if (recentSelect.selectMode) recentSelect.toggleSelect(item.entry_id);
    else setInspectorEntry(item);
  };

  // Handlers for the memoized panels below, stable across renders so a scanner
  // render does not re-render a panel whose own props did not change.
  const stable = useStableHandlers({
    cancelAutoAdd: flow.cancelAutoAdd, autoAddCard, openQuickAdd, dismissDupConfirm: flow.dismissDupConfirm, showToast,
    dismissMatches, startCamera, handleManualSearch, activateRecent,
  });

  return (
    <div className="scanner-container">



      {/* Camera Window */}
      {!cameraActive ? (
        <div
          className="camera-preview-wrapper"
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          role="button"
          tabIndex={0}
          onClick={startCamera}
          onKeyDown={onActivateKey(startCamera)}
        >
          {cameraErrorKey ? (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <AlertTriangle size={48} style={{ color: 'var(--accent-yellow)', marginBottom: '1rem' }} />
              <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
                {t(cameraErrorKey, { origin: window.location.origin, port: window.location.port || '80' })}
              </p>
              <button className="btn btn-primary" onClick={startCamera}>
                <RefreshCw size={14} /> Retry Camera
              </button>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <Camera size={48} style={{ color: 'var(--accent-red)', marginBottom: '1rem', opacity: 0.8 }} />
              <p style={{ fontSize: '0.95rem', color: 'var(--text-primary)', marginBottom: '0.5rem' }}>{t('scan.readyTitle')}</p>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>{t('scan.readyHint')}</p>
              <button className="btn btn-primary">
                {t('scan.activateCamera')}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <div className="camera-preview-wrapper camera-active">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="camera-video"
            />

            {/* Torch Toggle Overlay Button */}
            <button
                type="button"
                className={`btn ${isTorchOn ? 'btn-primary' : 'btn-secondary'}`}
                style={{
                  position: 'absolute',
                  top: '1rem',
                  right: '1rem',
                  zIndex: 20,
                  borderRadius: '50%',
                  padding: '0.6rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
                }}
                onClick={(e) => { e.stopPropagation(); toggleTorch(); }}
              >
                {isTorchOn ? <Zap size={18} /> : <ZapOff size={18} />}
              </button>

            {/* Quick lens switch, under the torch. On the camera view rather than
                only in settings: when the browser opened the wrong lens the
                preview is blurry, and the fix has to be where the user is looking.
                The full list (with names) is the picker in scan settings. */}
            {videoInputs.length >= 2 && (
              <button
                type="button"
                className="btn btn-secondary"
                title={t('scan.switchCamera')}
                aria-label={t('scan.switchCamera')}
                style={{
                  position: 'absolute',
                  top: 'calc(1rem + 46px)',
                  right: '1rem',
                  zIndex: 20,
                  borderRadius: '50%',
                  padding: '0.6rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  const id = nextCamera(videoInputs, activeCameraId);
                  const i = videoInputs.findIndex(d => d.deviceId === id);
                  if (id) { switchCamera(id); showToast(cameraLabel(videoInputs[i], i)); }
                }}
              >
                <SwitchCamera size={18} />
              </button>
            )}

            {/* Auto-scan state, where the capture countdown used to be. There is no
                clock to show any more — what the user needs to know is whether the
                scanner is waiting on them (no card / hold still) or on itself
                (scanning / lift the card), because those need opposite reactions. */}
            {/* "Next card" is also a button: the one state the scanner can sit in
                with nothing left to wait for is a card swapped so fast that no
                detection saw the mat empty and the new one landed where the old one
                was. A tap re-arms on whatever is in frame now. */}
            {autoScan && <AutoStatePill store={autoStateStore} onRearm={rearmFromPill} />}

            {/* Shutter flash. Mounted only for the length of the cue, so each
                capture restarts the animation instead of a repeat firing into an
                element that has already finished animating. */}
            {scanFlash === 'capture' && <div className="scan-flash" />}

            {/* Outline Box Guides */}
            <div className="camera-overlay">
              <style>{`
                @keyframes border-flash-error {
                  0%, 100% { border-color: rgba(255, 255, 255, 0.4); box-shadow: none; }
                  30%, 70% { border-color: var(--accent-red); box-shadow: 0 0 25px var(--accent-red-glow); }
                }
              `}</style>
              <div
                className="scan-card-guide"
                onPointerDown={guide.onGuidePointerDown}
                onPointerMove={guide.onGuidePointerMove}
                onPointerUp={guide.onGuidePointerUp}
                onPointerCancel={guide.onGuidePointerUp}
                style={{
                  pointerEvents: 'auto',
                  cursor: 'move',
                  touchAction: 'none',
                  transform: `translate(${guide.guideOffset.x}px, ${guide.guideOffset.y}px) rotate(${guide.guideAngle}deg) scale(${guide.guideScale})`,
                  animation: scanFlash === 'error' ? 'border-flash-error 1.5s ease-in-out' : 'none'
                }}
              >
                {loading && <div className="scan-line"></div>}
                {/* Live detection outline.

                    Drawn as a child of the guide box, so it inherits the box's
                    translate/rotate/scale for free and needs no coordinate maths
                    of its own — the earlier attempt mapped screen coordinates by
                    hand and got them wrong. Inset by -CROP_PAD on each side
                    because the quad is normalised to the CROP, which is the box
                    plus that margin.

                    Green = the detector has a card-like quad and the scan will
                    work from it. No outline = it has nothing, which is the state
                    worth seeing before pressing the shutter rather than after. */}
                {settings.showDetectOutline && <DetectOutline store={detectQuadStore} />}
              </div>
              {guide.guideMoved && (
                <button
                  type="button"
                  onClick={guide.resetGuide}
                  style={{ position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)', pointerEvents: 'auto', zIndex: 10, fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-strong)', background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.4)', borderRadius: 999, padding: '0.25rem 0.7rem', cursor: 'pointer' }}
                >
                  {t('scan.resetBox')}
                </button>
              )}
            </div>
          </div>

          {/* Settings panel (toggled by the gear in the action row): set, auto-add,
              scan detail, zoom, exposure, diagnostics. Card type and language are NOT
              here — they are what the user picks before every run, so they live in
              the row above the camera. Kept off the camera view so it stays clean. */}
          {showScanSettings && (
            <ScanSettingsPanel
              settings={settings}
              camera={camera}
              autoScan={autoScan}
              detectStatsStore={detectStatsStore}
              onScanLanguage={(code) => {
                settings.setScanLang(code);
                flow.setLanguage(langName(code));
              }}
            />
          )}

          {/* Scan crop + candidate diagnostics. Off unless the diagnostics switch in
              scan settings is on: this is for working out WHY a scan picked the wrong
              card, and it was eating a screenful on every correct scan too. Also
              needs an actual crop/candidate, so no empty dashed box. */}
          {showDebug && cameraActive && (debugHashImg || debugCandidates.length > 0) && (
            <div className="glass-panel" style={{ width: '100%', padding: '0.75rem 1rem', background: 'rgba(0,0,0,0.3)', border: '1px dashed var(--border-glass-hover)', display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.25rem' }}>
              {/* Hash-match diagnostics: what was cropped + the ranked candidates. */}
              {(debugHashImg || debugCandidates.length > 0) && (
                <div style={{ display: 'flex', gap: '0.75rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', marginTop: '0.25rem' }}>
                  {debugHashImg && (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem', flexShrink: 0 }}>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{t('scan.hashedCrop')}</span>
                      <img src={debugHashImg} style={{ width: '52px', maxHeight: '80px', objectFit: 'contain', background: '#111', borderRadius: '3px', border: '1px solid var(--border-glass-hover)' }} alt="Hashed crop" />
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                    {debugScoped !== null && (
                      <span style={{ fontSize: '0.65rem', fontWeight: 700, color: debugScoped ? 'var(--type-grass)' : 'var(--accent-red)' }}>
                        {debugScoped ? t('scan.debugScoped', { sets: debugScoped }) : t('scan.debugGlobal')}
                      </span>
                    )}
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{t(debugCandidates[0]?.verified ? 'scan.debugTopMatchesInliers' : 'scan.debugTopMatchesSimilarity')}</span>
                    {debugCandidates.length === 0 ? (
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{t('scan.noCandidates')}</span>
                    ) : debugCandidates.slice(0, 3).map((cd, i) => {
                      const pass = cd.verified ? cd.inliers >= SCAN_MATCH_MIN_INLIERS : cd.score >= SCAN_MATCH_MIN_SCORE;
                      const label = cd.verified ? `${cd.inliers} inl` : (cd.score != null ? cd.score.toFixed(2) : '?');
                      return (
                        <div key={i} style={{ fontSize: '0.7rem', color: i === 0 ? '#fff' : 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <span style={{ color: pass ? 'var(--type-grass)' : 'var(--accent-red)', fontWeight: 700 }}>{label}</span>
                          {' '}{cd.card ? getCardDisplayName(cd.card.name, addLanguage(cd.card), cd.card.printed_name) : cd.name} <span style={{ color: 'var(--text-muted)' }}>({cd.set} #{cd.number})</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* One control: scanning on or off. There is no manual shutter, no
              separate stop — scanning runs from the moment the camera opens and
              this pauses it. Pausing also cancels a scan still in flight, which is
              the only way out if a request never comes back. */}
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'stretch' }}>
            <button
              type="button"
              role="switch"
              aria-checked={autoScan}
              className={`btn ${autoScan ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => {
                const next = !autoScan;
                setAutoScan(next);
                // Turning it back on should act on the card already in frame
                // rather than waiting for the user to lift and replace it.
                if (next) {
                  autoArmed.current = true;
                  capturedQuad.current = null;
                  resolvedDupIdRef.current = null;
                } else {
                  autoStateStore.set(null);
                  if (loading) handleCancelScan();
                }
              }}
              style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
              title={t('scan.scanningHint')}
            >
              <ScanLine size={15} />
              <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>{t(autoScan ? 'scan.scanningOn' : 'scan.scanningOff')}</span>
              <span style={{ width: 28, height: 15, borderRadius: 999, background: autoScan ? '#fff' : 'rgba(255,255,255,0.22)', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                <span style={{ position: 'absolute', top: 2, left: autoScan ? 15 : 2, width: 11, height: 11, borderRadius: '50%', background: autoScan ? 'var(--accent-red)' : '#fff', transition: 'left 0.2s' }} />
              </span>
            </button>
            {/* The last fallback: no live detector could load at all, so auto-scan
                can never fire. A plain shutter still works — the whole frame goes
                up and the server finds the card itself. */}
            {detectorDown && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => handleCapture()}
                disabled={loading}
                title={t('scan.manualCaptureHint')}
                style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0 0.8rem' }}
              >
                <Camera size={15} />
                <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>{t('scan.manualCapture')}</span>
              </button>
            )}
            <button
              type="button"
              className={`btn ${showScanSettings ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => settings.setShowScanSettings(s => !s)}
              title={t('scan.settingsHint')}
              aria-label={t('scan.settings')}
              style={{ flexShrink: 0, padding: '0 0.7rem', position: 'relative' }}
            >
              <Settings size={16} />
              {!settings.scanSetCodes.length && <span style={{ position: 'absolute', top: 4, right: 4, width: 7, height: 7, borderRadius: '50%', background: 'var(--accent-yellow)' }} />}
            </button>
          </div>
        </div>
      )}

      {/* Top level, NOT inside the scan-settings panel: that panel is behind the
          gear and closed by default, so a notice about how to make scanning faster
          would only ever be read by someone already changing settings. Shown while a
          ready-made catalog is answering and no local one exists for this game and
          language, which is exactly when the advice applies — it disappears on its
          own once a local catalog is built, and the X keeps it gone before then. */}
      {settings.showLocalHint && (
        <div className="glass-panel" style={{
          width: '100%', display: 'flex', alignItems: 'flex-start', gap: '0.6rem',
          padding: '0.75rem 0.9rem', borderLeft: '3px solid var(--accent-blue, #60a5fa)',
        }}>
          <Zap size={16} style={{ color: 'var(--accent-blue, #60a5fa)', flexShrink: 0, marginTop: '0.1rem' }} />
          <p style={{ fontSize: '0.78rem', lineHeight: 1.45, color: 'var(--text-secondary)', margin: 0, flex: 1 }}>
            {t('scan.localCatalogSpeedHint')}
          </p>
          <button
            type="button"
            onClick={settings.dismissLocalHint}
            aria-label={t('common.close')}
            title={t('common.close')}
            style={{
              background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
              padding: 0, lineHeight: 1, flexShrink: 0,
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Scan Status Log */}
      {scanStatus && (
        <div className="glass-panel" style={{ width: '100%', padding: '1rem', borderLeft: '3px solid var(--accent-red)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {loading && <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div>}
          <span style={{ fontSize: '0.85rem', color: 'var(--text-strong)', fontWeight: 500 }}>{scanStatus}</span>
        </div>
      )}

      {/* Auto Add Countdown Overlay. Tap the card (before the countdown ends) to
          pause auto-add and adjust condition/printing before it's saved. */}
      {autoAddTargetCard && (autoAddCountdown !== null || autoAddEditing) && (
        <AutoAddModal
          cancelAutoAdd={stable.cancelAutoAdd} autoAddTargetCard={autoAddTargetCard} addLanguage={addLanguage} autoAddEditing={autoAddEditing}
          setAutoAddCond={flow.setAutoAddCond} setAutoAddPrint={flow.setAutoAddPrint} setAutoAddEditing={flow.setAutoAddEditing} autoAddCountdown={autoAddCountdown}
          autoAddCond={flow.autoAddCond} autoAddPrint={flow.autoAddPrint} setAutoAddTargetCard={flow.setAutoAddTargetCard} setAutoAddCountdown={flow.setAutoAddCountdown}
          autoAddCard={stable.autoAddCard} setAutoAddAlternatives={flow.setAutoAddAlternatives} autoAddAlternatives={flow.autoAddAlternatives} openQuickAdd={stable.openQuickAdd}
          setScanMatches={setScanMatches} setShowAllMatches={setShowAllMatches}
        />
      )}

      {/* Duplicate-Scan Confirm Overlay: the just-added card was scanned again. */}
      {dupConfirmCard && (
        <DupConfirmModal
          dismissDupConfirm={stable.dismissDupConfirm} dupConfirmCard={dupConfirmCard} addLanguage={addLanguage} setDupQty={flow.setDupQty}
          dupQty={flow.dupQty} resolvedDupIdRef={resolvedDupIdRef} setDupConfirmCard={flow.setDupConfirmCard} autoAddCard={stable.autoAddCard}
          showToast={stable.showToast} setAutoScan={setAutoScan}
        />
      )}

      {/* Scan Results Suggestions Popup Modal */}
      {scanMatches.length > 0 && (
        <ScanMatchesModal
          dismissMatches={stable.dismissMatches} setScanMatches={setScanMatches} setScanStatus={setScanStatus} autoArmed={autoArmed}
          capturedQuad={capturedQuad} resolvedDupIdRef={resolvedDupIdRef} stream={stream} cameraActive={cameraActive}
          startCamera={stable.startCamera} handleManualSearch={stable.handleManualSearch} manualSearchText={manualSearchText} setManualSearchText={setManualSearchText}
          manualSearching={manualSearching} showAllMatches={showAllMatches} scanMatches={scanMatches} PICKER_PREVIEW={PICKER_PREVIEW}
          openQuickAdd={stable.openQuickAdd} addLanguage={addLanguage} setShowAllMatches={setShowAllMatches} setAutoScan={setAutoScan}
        />
      )}

      {/* Recent Scans History Panel */}
      {recentScans.length > 0 && (
        <RecentScans
          recentSelect={recentSelect} setRecentScans={setRecentScans} recentScans={recentScans} activateRecent={stable.activateRecent}
        />
      )}

      {inspectorEntry && (
        <CardInspectorModal
          card={inspectorEntry}
          onClose={() => setInspectorEntry(null)}
          onUpdate={onAddSuccess}
          onDeleted={removeRecentTile}
          showToast={showToast}
        />
      )}

      <QuickAddDrawer
        flow={flow}
        onBackToMatches={() => { closeDrawer(); setScanMatches(flow.lastMatches); setShowAllMatches(true); }}
      />
    </div>
  );
}

export default CameraScanner;
