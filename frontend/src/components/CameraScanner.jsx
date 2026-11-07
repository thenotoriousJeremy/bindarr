import { useState, useEffect, useRef, useCallback } from 'react';
import { Camera, RefreshCw, AlertTriangle, X, Zap, ZapOff, Settings, ScanLine, ListFilter, Layers, SwitchCamera } from 'lucide-react';
import confetti from 'canvas-confetti';
import { getCardDisplayName } from '../utils/langHelper';
import Price from './Price';
import { resolveCardPrice } from '../utils/resolveCardPrice';
import CardEntryFields from './CardEntryFields';
import CardInspectorModal from './CardInspectorModal';
import { useBackGuard } from '../utils/useBackGuard';
import { onActivateKey, useEscape } from '../utils/a11y';
import { useMultiSelect } from '../utils/useMultiSelect';
import { langName, langCode, getLanguagesForGame, isLanguageSupported } from '../utils/languages';
import { getPerspectiveTransform, warpPerspective } from '../../../shared/imgproc.mjs';
import { nextCamera } from '../utils/cameraPick';
import { defaultGame, gameOptions, showGamePicker, isGameEnabled } from '../utils/games';
import { isNative } from '../apiBase';
import { useT } from '../utils/i18n';
import SetTree from './SetTree';
import LangFallbackNote from './scanner/LangFallbackNote';
import { useCameraStream } from './scanner/useCameraStream';
import { useScanPipeline } from './scanner/useScanPipeline';
import { useStableCallback, useStableHandlers } from './scanner/useStableCallback';
import AutoAddModal from './scanner/AutoAddModal';
import DupConfirmModal from './scanner/DupConfirmModal';
import ScanMatchesModal from './scanner/ScanMatchesModal';
import RecentScans from './scanner/RecentScans';
import { DetectOutline, AutoStatePill, AutoTuningPanel } from './scanner/LiveOverlays';
import {
  SCAN_MATCH_MIN_SCORE, SCAN_MATCH_MIN_INLIERS, SCAN_MATCH_MIN_MARGIN, CROP_PAD, EMBED_SIZE,
  STEADY_FRAMES_NEEDED, MIN_FILL, SCAN_PROFILES,
} from './scanner/scanConstants';
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
  // Fixed-cadence capture countdown (Turbo): ms remaining until the next photo,
  // or null when the metronome isn't running. Drives the countdown ring.
  // Draggable/rotatable scan guide: translate (px, relative to centered) + angle
  // (deg). Lets the user aim the crop at an off-center or tilted card.
  const [showDetectOutline, setShowDetectOutline] = useState(() => localStorage.getItem('scan_outline') !== '0');
  const dewarpCanvas = useRef(null);    // reused for client dewarp
  const [guideOffset, setGuideOffset] = useState({ x: 0, y: 0 });
  const [guideAngle, setGuideAngle] = useState(0);
  const [guideScale, setGuideScale] = useState(1);
  const guidePtrs = useRef(new Map());     // active pointerId -> {x,y}
  const guideGesture = useRef(null);        // snapshot taken at each pointer-count change
  
  // Scanning is the DEFAULT and only mode: point the camera at a card and it is
  // captured when the detector says it is there and still. There is no manual
  // shutter — the toggle in the action row pauses scanning instead. Deliberately
  // NOT persisted: every session starts scanning, so a pause is a pause and not a
  // setting the user has to remember undoing.
  const [autoScan, setAutoScan] = useState(true);
  // Auto-add is a SEPARATE decision from auto-scan: scanning identifies the card,
  // auto-add files it without asking. Off, a confident match opens the add drawer
  // so condition/printing/quantity can be set before it is saved.
  const [autoAdd, setAutoAdd] = useState(() => localStorage.getItem('scan_auto_add') !== '0');
  // Crop + candidate diagnostics. Useful when a scan misidentifies a card and
  // nowhere near useful enough to occupy the screen the rest of the time.
  const [showDebug, setShowDebug] = useState(() => localStorage.getItem('scan_debug') === '1');
  const [showScanSettings, setShowScanSettings] = useState(false);
  // Auto-capture gates, exposed because the right values depend on the camera,
  // the lighting and how the user holds a card — none of which are knowable from
  // here. Defaults are the measured ones; the live readout below the sliders is
  // what makes them tunable rather than guesswork.
  const [minFill, setMinFill] = useState(() => {
    const v = parseFloat(localStorage.getItem('scan_min_fill'));
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : MIN_FILL;
  });
  const [minSteady, setMinSteady] = useState(() => {
    const v = parseInt(localStorage.getItem('scan_min_steady'), 10);
    return Number.isInteger(v) && v >= 1 && v <= 10 ? v : STEADY_FRAMES_NEEDED;
  });
  // Scan detail level: index into SCAN_PROFILES. Persisted; default Balanced.
  const [scanDetail, setScanDetail] = useState(() => {
    const v = parseInt(localStorage.getItem('scan_detail'), 10);
    return Number.isInteger(v) && v >= 0 && v < SCAN_PROFILES.length ? v : 2;
  });
  const profile = SCAN_PROFILES[scanDetail];
  // Which game is being fed in — the user's pick, not an inference. Persisted:
  // a scanning run is one game at a time, and re-picking it on every camera open
  // was friction for nothing. Falls back to the Settings default game if the
  // remembered one has since been hidden.
  const [scanGame, setScanGameState] = useState(() => {
    const saved = localStorage.getItem('scanner_game');
    if (saved && isGameEnabled(saved)) return saved;
    return defaultGame() || 'pokemon';
  });
  const setScanGame = (g) => {
    setScanGameState(g);
    localStorage.setItem('scanner_game', g);
    if (!isLanguageSupported(g, scanLang)) {
      setScanLang('en');
      setLanguage(langName('en'));
    }
  };
  // Which language of card is being fed in. Card art is language-specific, so
  // this selects which set index the scan is matched against — and it becomes the
  // language each added copy is recorded as. Remembered across sessions because
  // people scan a language at a time.
  const [scanLang, setScanLangState] = useState(() => localStorage.getItem('scanner_lang') || 'en');
  const setScanLang = (code) => { setScanLangState(code); localStorage.setItem('scanner_lang', code); };
  const setsKey = (game, lang) => (lang === 'en' ? `scanner_set_${game}` : `scanner_set_${game}_${lang}`);
  // Set-scoped scanning across one OR MORE sets (both games). Persisted per game
  // as a comma-joined code list so switching Pokémon<->MTG restores that game's
  // sets. Scanning within the chosen sets (~300 cards each) is far more accurate
  // than a global search.
  const [scanSetCodes, setScanSetCodesState] = useState(() => {
    const savedGame = localStorage.getItem('scanner_game');
    const g = (savedGame && isGameEnabled(savedGame)) ? savedGame : (defaultGame() || 'pokemon');
    const l = localStorage.getItem('scanner_lang') || 'en';
    return (localStorage.getItem(setsKey(g, l)) || '').split(',').map(s => s.trim()).filter(Boolean);
  });
  const persistSets = (arr) => { setScanSetCodesState(arr); localStorage.setItem(setsKey(scanGame, scanLang), arr.join(',')); };
  const scanSetParam = scanSetCodes.join(',');
  const [setInput, setSetInput] = useState('');
  const [setList, setSetList] = useState([]);        // {id,name,children[],...} for the active game
  // Per-set catalog coverage: { local, published, sets: { <setId>: {cached,embedded} } }.
  const [scanSets, setScanSets] = useState(null);
  const [localHintOff, setLocalHintOff] = useState(() => localStorage.getItem('scan_local_hint') === 'off');
  // Hide sets the scanner holds nothing for. On by default: a filter that lists
  // 523 sets when 40 are built is a menu of mostly wrong answers.
  const [onlyBuiltSets, setOnlyBuiltSets] = useState(true);
  // Code fed to the scanner: pokemontcg.io set id as-is; for MTG the bare
  // Scryfall code (sets.id is stored prefixed as "mtg-<code>").
  const setScanCode = (s) => scanGame === 'mtg' ? (s.ptcgo_code || (s.id || '').replace(/^mtg-/, '')) : s.id;
  // The filter is a flat list of catalog set codes — parent codes and subset codes
  // sit side by side in it, because that is what card_cache.set_id holds and what
  // the scan route filters on. The tree is a VIEW of that list, not a second
  // format: a family is "on" when its parent code is in there, and a subset is
  // included when its own code is. Nothing to migrate, nothing to keep in sync.
  const hasCode = (code) => scanSetCodes.some(c => c.toLowerCase() === String(code).toLowerCase());
  const dropCodes = (arr, codes) => {
    const gone = new Set(codes.map(c => String(c).toLowerCase()));
    return arr.filter(c => !gone.has(c.toLowerCase()));
  };
  const toggleCode = (code) => persistSets(hasCode(code) ? dropCodes(scanSetCodes, [code]) : [...scanSetCodes, code]);
  // Ticking a family takes its subsets with it; unticking drops the whole family.
  // Untick one subset afterwards and the parent stays on — that is the "I am
  // feeding the box but not the tokens" case this exists for.
  const toggleSetFamily = (s) => {
    const code = setScanCode(s);
    const kids = (s.children || []).map(c => c.code);
    persistSets(hasCode(code)
      ? dropCodes(scanSetCodes, [code, ...kids])
      : [...dropCodes(scanSetCodes, [code, ...kids]), code, ...kids]);
  };
  // Sets the catalog knows about that the set table does not list at all. For
  // Pokemon that is 51 of 172 cached set ids (TCG Pocket, TCGdex-only numbering),
  // and without this they are unreachable from the filter — the user can see the
  // cards in their collection but can never scope a scan to them.
  // Which languages this game has a catalog of its own in. Empty until /scan-sets
  // answers, and every check below treats empty as "do not claim anything".
  const scanBuiltLangs = scanSets?.builtLangs || [];
  // Worth saying once: a published catalog names cards by a PROVIDER id, so every
  // new card costs a call to that provider before it can be shown (measured 971 to
  // 1963 ms for Pokémon, 164 ms for MTG). A locally built catalog is keyed by this
  // install's own card ids, so the same answer is a primary-key read — ~1 ms.
  //
  // Shown only when it is true for what is being scanned right now: a published
  // catalog is answering and no local one exists. Dismissal sticks, because this is
  // information, not a nag, and it is the same sentence every time.
  const showLocalHint = !!scanSets && !scanSets.local && !!scanSets.published && !localHintOff;
  const currentGameSets = setList.filter(s => !s.game || s.game === scanGame);
  const strayCatalogSets = (scanSets?.game === scanGame ? Object.entries(scanSets?.sets || {}) : [])
    .filter(([sid, v]) => v.embedded > 0
      && !currentGameSets.some(s => String(setScanCode(s)).toLowerCase() === sid
        || (s.children || []).some(c => String(c.code).toLowerCase() === sid)))
    .map(([sid]) => ({ id: sid, name: sid.toUpperCase(), ptcgo_code: sid, children: [] }));
  // Newest first: a scanning run is nearly always a recent release, and the set
  // list arrives in release order. Searching and coverage filtering happen inside
  // SetTree, which the build picker and the wizard share.
  const treeSets = [...currentGameSets, ...strayCatalogSets].reverse();
  // Families the filter names, for the summary line — 3 sets reads better than the
  // 41 codes they expand to.
  const selectedSetCount = currentGameSets.filter(s => hasCode(setScanCode(s))).length;

  const [debugHashImg, setDebugHashImg] = useState('');
  const [debugCandidates, setDebugCandidates] = useState([]);
  const [debugScoped, setDebugScoped] = useState(null); // set code if set-scoped, false if global, null if n/a

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

  // Guide box drag/rotate/scale. Pointer capture on the box routes all move/up
  // events here. One finger = move; two fingers = pinch-scale + twist-rotate +
  // drag by the midpoint. Snapshot is re-taken on every pointer-count change so
  // switching finger count rebases smoothly.
  const snapshotGuideGesture = () => {
    const el = document.querySelector('.scan-card-guide');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const base = {
      startOffset: guideOffset, startAngle: guideAngle, startScale: guideScale,
      cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2,
    };
    const pts = [...guidePtrs.current.values()];
    if (pts.length >= 2) {
      const [p, q] = pts;
      guideGesture.current = {
        mode: 'pinch', ...base,
        d0: Math.hypot(q.x - p.x, q.y - p.y) || 1,
        a0: Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI,
        mid0: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 },
      };
    } else if (pts.length === 1) {
      guideGesture.current = { mode: 'move', ...base, startX: pts[0].x, startY: pts[0].y };
    } else {
      guideGesture.current = null;
    }
  };
  const onGuidePointerDown = (e) => {
    guidePtrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    snapshotGuideGesture();
    e.stopPropagation();
  };
  const onGuidePointerMove = (e) => {
    if (!guidePtrs.current.has(e.pointerId)) return;
    guidePtrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = guideGesture.current;
    if (!g) return;
    const pts = [...guidePtrs.current.values()];
    if (g.mode === 'pinch' && pts.length >= 2) {
      const [p, q] = pts;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      const a = Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI;
      const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      setGuideScale(Math.min(3, Math.max(0.3, g.startScale * (d / g.d0))));
      setGuideAngle(g.startAngle + (a - g.a0));
      setGuideOffset({ x: g.startOffset.x + (mid.x - g.mid0.x), y: g.startOffset.y + (mid.y - g.mid0.y) });
    } else if (g.mode === 'move') {
      setGuideOffset({ x: g.startOffset.x + (e.clientX - g.startX), y: g.startOffset.y + (e.clientY - g.startY) });
    }
  };
  const onGuidePointerUp = (e) => {
    guidePtrs.current.delete(e.pointerId);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    snapshotGuideGesture(); // rebase any remaining finger
  };
  const resetGuide = () => { setGuideOffset({ x: 0, y: 0 }); setGuideAngle(0); setGuideScale(1); };

  // Drawer states
  const [selectedCard, setSelectedCard] = useState(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [autoAddCountdown, setAutoAddCountdown] = useState(null);
  const [autoAddTargetCard, setAutoAddTargetCard] = useState(null);
  // The rest of the ORB list, shown beside the countdown. Scanning a whole set
  // means many near-identical cards, and the one in hand is regularly not ORB's
  // first pick — so the runners-up stay one tap away instead of requiring an undo.
  const [autoAddAlternatives, setAutoAddAlternatives] = useState([]);
  // The picker opens compact and expands on request rather than dumping eight
  // cards at once.
  const [showAllMatches, setShowAllMatches] = useState(false);
  const PICKER_PREVIEW = 4;
  // The last scan's full candidate list, kept after the picker closes so the
  // add drawer can go back to it. openQuickAdd clears scanMatches, which is why
  // reaching the alternatives from the drawer was impossible.
  const [lastMatches, setLastMatches] = useState([]);
  // True while the "different printing" lookup is in flight.
  const [findingPrintings, setFindingPrintings] = useState(false);
  const [manualSearchText, setManualSearchText] = useState('');
  const [manualSearching, setManualSearching] = useState(false);
  // Tap the countdown popup to pause auto-add and tweak these before adding
  // (slower tiers only — Turbo adds instantly with no overlay).
  const [autoAddEditing, setAutoAddEditing] = useState(false);
  const [autoAddCond, setAutoAddCond] = useState('Near Mint');
  const [autoAddPrint, setAutoAddPrint] = useState('Normal');
  // Duplicate-scan confirm: set to the repeat-matched card; dupQty = copies to add.
  const [dupConfirmCard, setDupConfirmCard] = useState(null);
  const [dupQty, setDupQty] = useState(1);

  // Back / Esc on the match picker and the duplicate prompt (their <Modal>s
  // own the back guard).
  const dismissMatches = () => {
    setScanMatches([]);
    autoArmed.current = true;
    capturedQuad.current = null;
    resolvedDupIdRef.current = null;
  };
  const dismissDupConfirm = () => {
    setDupConfirmCard(null);
    resolvedDupIdRef.current = null;
  };
  // Cancel, Back or Esc on the auto-add popup: drop the card and re-arm.
  const cancelAutoAdd = () => {
    setAutoAddTargetCard(null);
    setAutoAddCountdown(null);
    setAutoAddAlternatives([]);
    setAutoAddEditing(false);
    autoArmed.current = true;
    capturedQuad.current = null;
    resolvedDupIdRef.current = null;
    showToast(t('scan.autoAddCancelled'));
  };
  useBackGuard(!!inspectorEntry, () => setInspectorEntry(null));
  useBackGuard(recentSelect.selectMode, recentSelect.exitSelectMode);
  
  // Form states
  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState('Near Mint');
  const [printing, setPrinting] = useState('Normal');
  // Language of the copy being added. Defaults to whatever is being scanned, so a
  // Japanese run does not have to be corrected card by card.
  const [language, setLanguage] = useState(() => langName(localStorage.getItem('scanner_lang') || 'en'));
  const [purchasePrice, setPurchasePrice] = useState(0);


  // On game switch: restore that game's remembered set filter and load its set
  // tree (families + subsets).
  useEffect(() => {
    let cancelled = false;
    setScanSetCodesState((localStorage.getItem(setsKey(scanGame, scanLang)) || '').split(',').map(s => s.trim()).filter(Boolean));
    setSetInput('');
    setSetList([]);
    setScanSets(null);
    setDebugCandidates([]);
    setDebugHashImg('');
    setDebugScoped(null);

    // tree=1: parents carrying their subsets, so the filter can offer a release
    // family as one tick and still let its tokens/art cards be dropped.
    fetch(`/api/sets?game=${scanGame}&lang=${encodeURIComponent(scanLang)}&tree=1`)
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        if (!cancelled) setSetList(data);
      })
      .catch(() => {
        if (!cancelled) setSetList([]);
      });

    // How much of each set the scanner actually holds. Without this the filter
    // offers sets that match NOTHING — Pokemon's set table is pokemontcg.io's
    // numbering while the catalog is keyed by TCGdex's, and a filter that matches
    // no rows makes cvScan fall back to an unscoped scan without saying so.
    fetch(`/api/scan-sets?game=${scanGame}&lang=${encodeURIComponent(scanLang)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!cancelled) setScanSets(data);
      })
      .catch(() => {
        if (!cancelled) setScanSets(null);
      });

    return () => {
      cancelled = true;
    };
  }, [scanGame, scanLang]);

  // Selecting a set no longer builds anything. It is a FILTER over the catalog
  // the scanner already has — the server skips catalog rows outside the chosen
  // sets — so there is nothing to prepare and nothing to wait for. Measured on
  // MTG: scoping to the right set moved exact-printing accuracy from 81% to 91%
  // at the same latency, where the old path made the user wait for an index build
  // first.


  // Auto-Add Countdown Effect
  useEffect(() => {
    let intervalId;
    if (autoAddEditing) {
      // Paused for manual edit: freeze the countdown, don't fire.
    } else if (autoAddCountdown !== null && autoAddCountdown > 0) {
      intervalId = setInterval(() => {
        setAutoAddCountdown(prev => prev - 1);
      }, 1000);
    } else if (autoAddCountdown === 0 && autoAddTargetCard) {
      const cardToTrigger = autoAddTargetCard;
      setAutoAddTargetCard(null);
      setAutoAddCountdown(null);
      setAutoAddAlternatives([]);   // the choice is made; don't leak it to the next card
      autoAddCard(cardToTrigger);
    }
    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAddCountdown, autoAddTargetCard, autoAddEditing]);


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
  const {
    stream, cameraActive, cameraErrorKey, isTorchOn,
    exposureCaps, exposure, setExposure, zoomCaps, zoom, videoInputs,
    videoRef, updateAdvancedConstraints, toggleTorch, changeExposure, changeZoom,
    startCamera, switchCamera, cameraLabel, activeCameraId,
  } = useCameraStream({ showToast, t, onBeforeOpen: resetForCameraOpen });

  // No stopCamera: the stop button is gone. The camera lives exactly as long as
  // this component — leaving the scan tab unmounts it, and the unmount cleanup
  // above stops the tracks (which also kills the torch).

  const autoAddCard = async (card, qty = 1, overrides = null) => {
    // Mark the dup guard BEFORE the await: a fast cooldown can fire the next
    // capture before this POST resolves, and a match of the same card must hit
    // the duplicate path instead of auto-adding a second time.
    lastAddedIdRef.current = card.id;
    try {
      const autoPrinting = overrides?.printing || ((card.rarity || '').toLowerCase().includes('holo') ? 'Holofoil' : 'Normal');
      const autoCondition = overrides?.condition || 'Near Mint';
      // See addLanguage: a localized printing files as itself, an English row files
      // as the language being scanned. Auto-add used to hard-code English, and then
      // to take the row's language unconditionally — which filed every fallback
      // match as an English copy no matter what the user was scanning.
      const autoLanguage = overrides?.language || addLanguage(card);
      const response = await fetch('/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_id: card.id,
          quantity: qty,
          condition: autoCondition,
          printing: autoPrinting,
          language: autoLanguage,
          // price_trend is whichever finish the TCG API returned first (usually
          // Normal), not necessarily the Holofoil finish just chosen above —
          // resolve against the printing actually being recorded.
          purchase_price: resolveCardPrice(card, autoPrinting),
          location_id: null
        })
      });

      if (response.ok) {
        const data = await response.json();
        const qtyLabel = qty > 1 ? `${qty}× ` : '';
        const placementLabel = data.placement?.label || null;
        const cardDisplayName = getCardDisplayName(card.name, autoLanguage, card.printed_name);
        if (placementLabel) {
          showToast(t('scan.addedTo', { qty: qtyLabel, name: cardDisplayName, place: placementLabel }));
        } else if (data.container_full) {
          showToast(t('scan.addedFull', { qty: qtyLabel, name: cardDisplayName }));
        } else {
          showToast(t('scan.autoAdded', { qty: qtyLabel, name: cardDisplayName, set: card.set_name }));
        }

        // Append to recent scans history log. entry_id (the last inserted row)
        // lets the recent-scans price splitter target these exact entries and the
        // inspector edit/delete the entry; member_ids (every row this add made)
        // is what the tile's quantity stands for. Carry the entry fields it was saved with.
        setRecentScans(prev => [{
          ...card, card_id: card.id, placementLabel, entry_id: data.id, member_ids: data.ids,
          quantity: qty, condition: autoCondition, printing: autoPrinting,
          language: autoLanguage, purchase_price: resolveCardPrice(card, autoPrinting), location_id: null,
        }, ...prev].slice(0, 10));

        // Brief confetti blast for ultra-rares
        const rarity = (card.rarity || '').toLowerCase();
        if (rarity.includes('secret') || rarity.includes('ultra') || (card.price_trend || 0) > 15) {
          confetti({ particleCount: 50, spread: 40, origin: { y: 0.8 } });
        }
        
        onAddSuccess(); // Refresh stats
      } else {
        showToast(t('scan.errAutoAdd', { name: getCardDisplayName(card.name, autoLanguage, card.printed_name) }));
        signal('error');
      }
    } catch (err) {
      console.error('Auto-add error:', err);
      showToast(t('scan.errAutoAddGeneric'));
      signal('error');
    }
  };

  // Resolves the landscape-to-portrait camera stream rotation bug on mobile devices.
  // Stream orientation rotation applies to mobile devices (iOS/Android) where
  // physical camera sensors deliver landscape raw frames while displayed in
  // portrait. Desktop webcams deliver unrotated frames matching the screen layout.
  // Returns the oriented frame size and a draw that paints the video into that
  // oriented space on any context — no intermediate canvas.
  const videoOrientation = (video, videoRect) => {
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    const streamRatio = videoWidth / videoHeight;
    const visualRatio = videoRect.width / videoRect.height;
    const isMobile = isNative || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    const isRotated = isMobile && ((streamRatio > 1.0 && visualRatio < 1.0) || (streamRatio < 1.0 && visualRatio > 1.0));
    const outW = isRotated ? videoHeight : videoWidth;
    const outH = isRotated ? videoWidth : videoHeight;
    const draw = (ctx) => {
      if (isRotated) {
        ctx.translate(outW / 2, outH / 2);
        ctx.rotate(90 * Math.PI / 180);
        ctx.drawImage(video, -videoWidth / 2, -videoHeight / 2, videoWidth, videoHeight);
      } else {
        ctx.drawImage(video, 0, 0, videoWidth, videoHeight);
      }
    };
    return { width: outW, height: outH, draw };
  };

  // The guide-box region of the current frame, oriented and deskewed to the box.
  //
  // ONE implementation, shared by the capture and by the live overlay. The
  // overlay's whole value is that it shows what the SCAN will see, so if it
  // framed the picture even slightly differently it would be confidently
  // misleading — and a preview that lies is worse than none.
  //
  // `maxW` downscales for the overlay (a detection frame needs far fewer pixels
  // than a match does); `target` reuses a canvas rather than allocating one per
  // frame, which is what mobile browsers punish by handing back BLANK canvases
  // once their per-tab canvas memory is exhausted.
  // `square` scales both axes to maxW directly in hardware (384x384), eliminating
  // software bilinear resize in the detect worker.
  //
  // The video is drawn STRAIGHT into the output with orientation and crop folded
  // into one transform. It used to be drawn full-resolution into an intermediate
  // oriented canvas first — a resize plus a full-frame (often 1080p+) GPU copy on
  // EVERY live-detection frame, just to sample a 384x384 crop out of it.
  const buildFramedCanvas = (video, guideElement, maxW = 0, target = null, square = false) => {
    if (!video?.videoWidth || !guideElement) return null;
    const videoRect = video.getBoundingClientRect();
    const oc = videoOrientation(video, videoRect);
    const guideRect = guideElement.getBoundingClientRect();
    // Cover-transform mapping from displayed video px to oriented-canvas px
    // (matches object-fit:cover on the preview).
    const k = Math.max(videoRect.width / oc.width, videoRect.height / oc.height);
    const offX = (videoRect.width - oc.width * k) / 2;
    const offY = (videoRect.height - oc.height * k) / 2;
    // Box centre (rotation is about the element centre, so the rotated AABB
    // centre from getBoundingClientRect is still the true centre).
    const cx = ((guideRect.left + guideRect.width / 2) - videoRect.left - offX) / k;
    const cy = ((guideRect.top + guideRect.height / 2) - videoRect.top - offY) / k;
    // offsetWidth/Height are the unscaled layout size; the CSS scale transform
    // does not change them, so fold guideScale in here.
    const fullW = Math.max(1, Math.round((guideElement.offsetWidth * guideScale / k) * (1 + 2 * CROP_PAD)));
    const fullH = Math.max(1, Math.round((guideElement.offsetHeight * guideScale / k) * (1 + 2 * CROP_PAD)));
    const sX = square ? (maxW ? maxW / fullW : 1) : ((maxW && fullW > maxW) ? maxW / fullW : 1);
    const sY = square ? (maxW ? maxW / fullH : 1) : sX;
    const destW = Math.max(1, Math.round(fullW * sX));
    const destH = Math.max(1, Math.round(fullH * sY));

    const canvas = target || document.createElement('canvas');
    // Resizing reallocates the backing store, so only when the size changed —
    // the live loop reuses one canvas at the same size every frame.
    if (canvas.width !== destW || canvas.height !== destH) {
      canvas.width = destW;                     // also resets pixels + transform
      canvas.height = destH;
    }
    const fctx = canvas.getContext('2d');
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.clearRect(0, 0, destW, destH);
    // Sample the (possibly rotated, off-centre) box region upright: dest centre
    // maps to the box centre, undo the box rotation, draw the frame. Pixels past
    // the box come through black; the server auto-detects the card inside.
    fctx.scale(sX, sY);
    fctx.translate(fullW / 2, fullH / 2);
    fctx.rotate(-(guideAngle * Math.PI) / 180);
    fctx.translate(-cx, -cy);
    oc.draw(fctx);
    return canvas;
  };

  // Rectify the card out of a capture, into the square the embedder expects.
  //
  // Geometry identical to the server's dewarp (cvScan.detectAndDewarp): same
  // square, same corner-to-corner mapping. It has to be — milo is measurably
  // sensitive to how tight the crop is, so a client crop that framed the card
  // differently would quietly cost accuracy rather than fail outright.
  //
  // `quad` is normalised to the framed canvas in TL,TR,BR,BL order (the worker
  // already reorders cornelius's BL,BR,TL,TR). Returns null rather than a bad
  // crop if anything about it is off, so the caller uploads the frame instead.
  const localDewarp = (canvas, quad) => {
    if (!Array.isArray(quad) || quad.length !== 4) return null;
    try {
      const w = canvas.width, h = canvas.height;
      const src = quad.map(p => ({ x: p.x * w, y: p.y * h }));
      if (src.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
      const N = EMBED_SIZE - 1;
      const dst = [{ x: 0, y: 0 }, { x: N, y: 0 }, { x: N, y: N }, { x: 0, y: N }];
      const rgba = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
      const out = warpPerspective(rgba, w, h, getPerspectiveTransform(src, dst), EMBED_SIZE, EMBED_SIZE);
      const c = dewarpCanvas.current || (dewarpCanvas.current = document.createElement('canvas'));
      c.width = EMBED_SIZE; c.height = EMBED_SIZE;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(out), EMBED_SIZE, EMBED_SIZE), 0, 0);
      return c.toDataURL('image/jpeg', 0.9);
    } catch {
      return null;   // any canvas/geometry failure: send the frame instead
    }
  };

  // Present the image-match results: show the picker, and on a single result
  // take the fast path (auto-add / quick-
  // add per mode). autoSingle lets the caller allow the fast path for a single MTG
  // result too — used when the image match is confident and the printing is
  // unambiguous (only one printing, or the set code narrowed it to one). Ambiguous
  // MTG (many printings, no set code) still shows the picker.
  // Is this resolved card the printing ORB reported? Set + number is the
  // identity; the name is not checked because the index and the provider can
  // spell it differently, which is exactly the disagreement that used to make
  // candidates vanish.
  // Number compared with leading zeros stripped: TCGdex writes '013' where
  // pokemontcg.io and the TCGplayer product map write '13', so a string compare
  // threw away every correct TCGdex answer.
  const sameNumber = (a, b) => {
    const norm = (n) => String(n ?? '').trim().toLowerCase().replace(/^0+(?=\d)/, '');
    return !!norm(a) && norm(a) === norm(b);
  };
  const sameCard = (card, cand) => !!card && !!cand
    && sameNumber(card.number, cand.number)
    && (String(card.set_id).toLowerCase() === String(cand.set).toLowerCase()
      || String(card.set_name || '').toLowerCase() === String(cand.set).toLowerCase());

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
          setDupConfirmCard(matches[0]);
          setDupQty(1);
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
          setAutoAddTargetCard(matches[0]);
          setAutoAddCountdown(profile.countdown);
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
            }
            if (resp.ok) {
              const { game: matchGame, verified, candidates, crop, scoped, notInCatalog, unresolvedPublished } = await resp.json();
              console.log('Scan candidates:', matchGame, scanLang, scoped ? `(set-scoped ${scanSetParam})` : '(GLOBAL)', verified ? 'ORB' : 'CLIP', candidates);
              if (crop) setDebugHashImg(crop); // show the server's auto-cropped card
              setDebugScoped(scoped ? scanSetParam : false);
              setDebugCandidates((candidates || []).map(c => ({ ...c, verified })));
              const top = candidates && candidates[0];
              const confident = top && (verified ? top.inliers >= SCAN_MATCH_MIN_INLIERS : top.score >= SCAN_MATCH_MIN_SCORE);
              // Printing ambiguity: basic lands (and other low-art cards) share one
              // big symbol + frame, so ORB scores nearly tie across every printing
              // of the same card. A near-tied same-name runner-up means the image
              // can't tell the printings apart — so DON'T auto-add the top pick's
              // set; fall through to the picker and let the user choose the set.
              const second = candidates && candidates[1];
              const ambiguousPrinting = top && second && top.name === second.name
                && (top.set !== second.set || top.number !== second.number)
                && (verified ? second.inliers >= top.inliers * 0.7 : second.score >= top.score - 0.02);
              // Embedding matches fail differently from ORB ones: a wrong answer
              // can carry a HIGH cosine (0.88 on the eval sample) while sitting a
              // hair above the runner-up, because the two cards genuinely look
              // alike. Absolute similarity cannot separate those; the margin can.
              // This is deliberately name-blind — the confident wrong answers were
              // different cards, which ambiguousPrinting above never catches.
              const lowMargin = !verified && top && second
                && (top.score - second.score) < SCAN_MATCH_MIN_MARGIN;
              // The server says nothing in any catalog resembles this card, so the
              // candidates below are the nearest strangers rather than a shortlist.
              // Auto-add is exactly wrong here — a card the catalog has never heard
              // of is the one case where a high cosine and a clean margin prove
              // nothing — but the list still goes on screen: it costs the user one
              // glance and beats claiming the card does not exist.
              if (candidates && candidates.length > 0) {
                // Resolve the WHOLE ORB list to real cards, once, and use it for
                // both outcomes. The confident path used to resolve only the top
                // pick, which meant the auto-add overlay had nothing to offer if
                // it guessed wrong — and when scanning a whole set, the card in
                // hand often is not ORB's first choice.
                const confidentPick = confident && !ambiguousPrinting && !lowMargin && !notInCatalog;
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
                setLastMatches(validCandidates);

                if (validCandidates.length > 0) {
                  // Confident: auto-add the top pick, but keep the rest on screen
                  // beside the countdown so a wrong guess is one tap to correct
                  // rather than an undo after the fact.
                  if (confidentPick && sameCard(validCandidates[0], top)) {
                    setAutoAddAlternatives(validCandidates.slice(1));
                    await applyMatches([validCandidates[0]], '', true);
                    return;
                  }
                  setAutoAddAlternatives([]);
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
  minFillRef.current = minFill;
  minSteadyRef.current = minSteady;
  // The "Next card" tap on the auto-scan pill: re-arm on whatever is in frame.
  const rearmFromPill = useStableCallback(() => {
    autoArmed.current = true;
    capturedQuad.current = null;
    resolvedDupIdRef.current = null;
    refreshAutoState();
  });

  // What language a scanned copy gets filed as.
  //
  // A NON-English card row wins: that is a real localized printing and it knows
  // what it is. An English row does not, because an English row is also what a
  // fallback match returns — the English catalog identifies a Japanese card by its
  // artwork and hands back the English printing, and filing that as an English
  // copy contradicts both the card in your hand and the language you chose to scan
  // in. The row stays the English printing (it is the only one the provider could
  // give us); the COPY is recorded in the language being scanned.
  // Memoized on scanLang alone (all it reads), because the panels call it while
  // rendering and a new identity every render would re-render them every time.
  const addLanguage = useCallback((card) => {
    const own = card?.language;
    return own && langCode(own) !== 'en' ? own : langName(scanLang);
  }, [scanLang]);

  const openQuickAdd = (card) => {
    setScanMatches([]);
    setSelectedCard(card);
    setPurchasePrice(0);
    const rarity = (card.rarity || '').toLowerCase();
    if (rarity.includes('holo') || rarity.includes('secret') || rarity.includes('ultra') || rarity.includes('shining')) {
      setPrinting('Holofoil');
    } else {
      setPrinting('Normal');
    }
    setLanguage(addLanguage(card));
    setIsDrawerOpen(true);
  };

  const handleLanguageChange = async (newLang) => {
    setLanguage(newLang);
    if (!selectedCard) return;
    try {
      const targetGame = selectedCard.game || scanGame;
      const resp = await fetch(`/api/cards/${encodeURIComponent(selectedCard.id)}/printing?lang=${encodeURIComponent(newLang)}&game=${encodeURIComponent(targetGame)}`);
      if (resp.ok) {
        const localized = await resp.json();
        if (localized && localized.id) {
          setSelectedCard(prev => (prev ? { ...prev, ...localized, language: newLang } : { ...localized, language: newLang }));
          return;
        }
      }
    } catch (e) {
      console.warn('Could not switch to localized printing:', e);
    }
    setSelectedCard(prev => (prev ? { ...prev, language: newLang } : prev));
  };

  // "Change printing"
  //
  // Visual scanning matches artwork, but the same illustration is reprinted across sets.
  // This asks for every printing of this card's name across sets, sorted by visual match to the scan.
  const findOtherPrintings = async () => {
    if (!selectedCard || findingPrintings) return;
    setFindingPrintings(true);
    try {
      const searchGame = selectedCard.game || scanGame;
      const searchLang = scanLang;
      const p = new URLSearchParams({
        game: searchGame,
        lang: searchLang,
        name: selectedCard.name,
        prints: '1',
        scope: 'internet',
      });
      const hasImage = lastScanImgRef.current;
      const res = hasImage
        ? await fetch('/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              game: searchGame,
              lang: searchLang,
              name: selectedCard.name,
              prints: '1',
              scope: 'internet',
              image: lastScanImgRef.current,
              cropped: lastScanCroppedRef.current,
            }),
          })
        : await fetch(`/api/search?${p.toString()}`);
      const raw = res.ok ? await res.json() : [];
      const found = [...raw].sort((a, b) => {
        const aScore = a.score !== undefined && a.score !== null ? a.score : -Infinity;
        const bScore = b.score !== undefined && b.score !== null ? b.score : -Infinity;
        if (aScore !== bScore) return bScore - aScore;
        return (b.image_url ? 1 : 0) - (a.image_url ? 1 : 0);
      });
      if (found.length <= 1) {
        showToast(t('scan.noOtherPrintings'));
        return;
      }
      setLastMatches(found);
      closeDrawer();
      setScanMatches(found);
      setShowAllMatches(true);
    } catch {
      showToast(t('scan.noOtherPrintings'));
    } finally {
      setFindingPrintings(false);
    }
  };

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
          const sorted = [...m].sort((a, b) => {
            const aScore = a.score !== undefined && a.score !== null ? a.score : -Infinity;
            const bScore = b.score !== undefined && b.score !== null ? b.score : -Infinity;
            if (aScore !== bScore) return bScore - aScore;
            return (b.image_url ? 1 : 0) - (a.image_url ? 1 : 0);
          });
          setScanMatches(sorted);
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

  const closeDrawer = () => {
    setIsDrawerOpen(false);
    setSelectedCard(null);
    setScanMatches([]);
    setQuantity(1);
    setCondition('Near Mint');
    setPrinting('Normal');
    setLanguage(langName(scanLang));
    setPurchasePrice(0);
    autoArmed.current = true;
    capturedQuad.current = null;
    resolvedDupIdRef.current = null;
    // Restart camera on close only if stream was stopped
    if (!stream || !cameraActive) {
      startCamera();
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

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!selectedCard) return;

    try {
      const response = await fetch('/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_id: selectedCard.id,
          quantity: parseInt(quantity, 10),
          condition,
          printing,
          language,
          purchase_price: parseFloat(purchasePrice) || 0,
          location_id: null
        })
      });

      if (response.ok) {
        const data = await response.json();
        const placementLabel = data.placement?.label || null;
        const cardDisplayName = getCardDisplayName(selectedCard.name, language, selectedCard.printed_name);
        if (placementLabel) {
          showToast(t('scan.addedToPlain', { name: cardDisplayName, place: placementLabel }));
        } else if (data.container_full) {
          showToast(t('scan.addedFullPlain', { name: cardDisplayName }));
        } else {
          showToast(t('search.addedToCollection', { name: cardDisplayName }));
        }

        // Append to recent scans history. Carry entry_id + saved fields so the
        // strip supports tap-to-edit / long-press-delete like the auto-add path.
        setRecentScans(prev => [{
          ...selectedCard, card_id: selectedCard.id, placementLabel, entry_id: data.id, member_ids: data.ids,
          quantity: parseInt(quantity, 10), condition, printing, language,
          purchase_price: parseFloat(purchasePrice) || 0, location_id: null,
        }, ...prev].slice(0, 10));

        const rarity = (selectedCard.rarity || '').toLowerCase();
        const price = selectedCard.price_trend || 0;
        if (rarity.includes('holo') || rarity.includes('secret') || rarity.includes('ultra') || price > 10) {
          confetti({
            particleCount: 150,
            spread: 80,
            origin: { y: 0.6 }
          });
        }

        onAddSuccess();
        closeDrawer();
      } else {
        showToast(t('search.errAddCard'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('scan.errSaveCard'));
    }
  };

  // Handlers for the memoized panels below, stable across renders so a scanner
  // render does not re-render a panel whose own props did not change.
  const stable = useStableHandlers({
    cancelAutoAdd, autoAddCard, openQuickAdd, dismissDupConfirm, showToast,
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
                onPointerDown={onGuidePointerDown}
                onPointerMove={onGuidePointerMove}
                onPointerUp={onGuidePointerUp}
                onPointerCancel={onGuidePointerUp}
                style={{
                  pointerEvents: 'auto',
                  cursor: 'move',
                  touchAction: 'none',
                  transform: `translate(${guideOffset.x}px, ${guideOffset.y}px) rotate(${guideAngle}deg) scale(${guideScale})`,
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
                {showDetectOutline && <DetectOutline store={detectQuadStore} />}
              </div>
              {(guideOffset.x !== 0 || guideOffset.y !== 0 || guideAngle !== 0 || guideScale !== 1) && (
                <button
                  type="button"
                  onClick={resetGuide}
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
          <div className="glass-panel" style={{ width: '100%', padding: '1rem', background: 'rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.25rem', order: 2, position: 'relative' }}>
            {/* Auto-add. Separate from scanning on purpose: scanning is how a card
                is identified, auto-add is whether it is filed without a look. Off,
                every confident match opens the add drawer first. */}
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
              <span style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('scan.autoAdd')}</span>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{t('scan.autoAddHint')}</span>
              </span>
              <input
                type="checkbox"
                checked={autoAdd}
                onChange={(e) => { setAutoAdd(e.target.checked); localStorage.setItem('scan_auto_add', e.target.checked ? '1' : '0'); }}
                style={{ accentColor: 'var(--type-grass)', flexShrink: 0 }}
              />
            </label>


            {/* Card type and language: what is being fed in. Card art is
                language-specific, so the language picks which catalog the scan is
                matched against AND the language each added copy is recorded as.
                Card type is a dropdown, not tabs — the list grows (sports, Yu-Gi-Oh)
                and tabs stop fitting. */}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {showGamePicker() && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', flex: 1, minWidth: 0 }}>
                  <label htmlFor="scan-card-type" style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                    {t('scan.cardType')}
                  </label>
                  <select
                    id="scan-card-type"
                    className="select-control"
                    value={scanGame}
                    onChange={(e) => setScanGame(e.target.value)}
                    style={{ fontSize: '0.8rem' }}
                  >
                    {gameOptions().map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', flex: 1, minWidth: 0 }}>
                <label htmlFor="scan-language" style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                  {t('scan.cardLanguage')}
                </label>
                <select
                  id="scan-language"
                  className="select-control"
                  value={scanLang}
                  onChange={(e) => {
                    const code = e.target.value;
                    setScanLang(code);
                    setLanguage(langName(code));
                  }}
                  style={{ fontSize: '0.8rem' }}
                >
                  {/* Marked, not hidden. Scanning a language with no catalog of
                      its own still works — the English catalog identifies the
                      card by artwork — but for Pokémon it cannot see the sets
                      that never released in English, and it files the English
                      printing. Offering eleven identical-looking options hid all
                      of that until after the scan. */}
                  {getLanguagesForGame(scanGame).map(l => (
                    <option key={l.code} value={l.code}>
                      {l.name}{scanBuiltLangs.length && !scanBuiltLangs.includes(l.name)
                        ? ` — ${t('scan.langNoCatalogTag')}` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {!!scanBuiltLangs.length && !scanBuiltLangs.includes(langName(scanLang)) && (
              <p style={{
                margin: '0.4rem 0 0', fontSize: '0.72rem', lineHeight: 1.4,
                color: scanGame === 'pokemon' ? 'var(--accent-yellow)' : 'var(--text-muted)',
              }}>
                {t(scanGame === 'pokemon' ? 'scan.langNoCatalogPokemon' : 'scan.langNoCatalogMtg',
                  { lang: langName(scanLang) })}
              </p>
            )}

            {/* Filter by set. A scan scoped to the sets in front of you is measurably
                more accurate (91% vs 81% exact printing on MTG), so this is a filter
                over the catalog, not an index to build — nothing to wait for.
                Organised as the release family, because that is how the cards
                physically arrive: ticking Foundations takes its tokens, art cards and
                promos with it, and expanding it lets you drop the parts you are not
                feeding in. Each subset is its own set code in the catalog, so an
                unexpanded parent tick genuinely could not see a token. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                <label htmlFor="scan-set-filter" style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                  {t('scan.filterBySet')}
                </label>
                {scanSetCodes.length > 0 && (
                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.6rem', padding: '0.2rem 0.5rem' }} onClick={() => { persistSets([]); setSetInput(''); }}>
                    {t('bulk.clear')}
                  </button>
                )}
              </div>
              <p style={{ fontSize: '0.7rem', color: scanSetCodes.length ? 'var(--type-grass)' : 'var(--text-secondary)', margin: 0 }}>
                {scanSetCodes.length
                  ? t('scan.setsFiltered', { count: selectedSetCount, codes: scanSetCodes.length })
                  : t('scan.setsAllHint')}
              </p>
              <input
                id="scan-set-filter"
                type="text"
                value={setInput}
                onChange={(e) => setSetInput(e.target.value)}
                placeholder={t(scanGame === 'mtg' ? 'scan.setSearchMtg' : 'scan.setSearchPokemon')}
                style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem', background: 'rgba(255,255,255,0.06)', border: `1px solid ${scanSetCodes.length ? 'var(--type-grass)' : 'var(--border-glass)'}`, borderRadius: 'var(--radius-sm)', color: 'var(--text-strong)' }}
              />
              {/* Scoping to a set the catalog does not hold is worse than not
                  scoping at all: cvScan fails open and scans everything, so the
                  filter appears to work and silently did nothing. */}
              {scanSets?.local && (
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.68rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={onlyBuiltSets}
                    onChange={(e) => setOnlyBuiltSets(e.target.checked)}
                    style={{ accentColor: 'var(--type-grass)', flexShrink: 0 }}
                  />
                  {t('scan.onlyBuiltSets')}
                </label>
              )}
              {scanSets?.published && (
                <p style={{ fontSize: '0.66rem', color: 'var(--text-muted)', margin: 0 }}>{t('scan.publishedCatalogNote')}</p>
              )}
              {/* Shared with the catalog build picker and the first-run wizard:
                  one implementation of "which sets?", three things done with the answer. */}
              <SetTree
                sets={treeSets}
                codeOf={setScanCode}
                selected={scanSetCodes}
                onToggleCode={toggleCode}
                onToggleFamily={toggleSetFamily}
                counts={scanSets?.sets}
                showCounts={!!scanSets?.local}
                query={setInput}
                onlyWithCounts={onlyBuiltSets && !!scanSets?.local}
              />
            </div>
            {/* Live outline of what the detector currently sees. On by default:
                it turns aiming into a feedback loop, and it is the only way a bad
                crop is visible BEFORE the shutter rather than inferred from a
                wrong answer afterwards. Off is offered because it costs a small
                request roughly every 650ms. */}
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('scan.showDetectOutline')}</span>
              <input
                type="checkbox"
                checked={showDetectOutline}
                onChange={(e) => { setShowDetectOutline(e.target.checked); localStorage.setItem('scan_outline', e.target.checked ? '1' : '0'); }}
                style={{ accentColor: 'var(--type-grass)' }}
              />
            </label>

            {/* Diagnostics: the hashed crop and the ranked candidates behind the
                last scan. Off by default — it is for debugging a wrong match, not
                for watching correct ones. */}
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
              <span style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('scan.debugPanel')}</span>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{t('scan.debugPanelHint')}</span>
              </span>
              <input
                type="checkbox"
                checked={showDebug}
                onChange={(e) => { setShowDebug(e.target.checked); localStorage.setItem('scan_debug', e.target.checked ? '1' : '0'); }}
                style={{ accentColor: 'var(--type-grass)', flexShrink: 0 }}
              />
            </label>

            {/* Auto-capture gates + what the detector sees right now.
                These two numbers decide whether auto-scan ever fires, and the
                right values depend on the camera, the lighting and how the user
                holds a card. Shipping them as constants meant "it never scans"
                had no visible cause and no user-side fix. The live row below is
                the point: each gate shows its current reading next to its
                threshold, so a card that will not trigger says why. */}
            {autoScan && (
              <AutoTuningPanel
                store={detectStatsStore}
                minFill={minFill} setMinFill={setMinFill}
                minSteady={minSteady} setMinSteady={setMinSteady}
              />
            )}

            {/* Scan Detail. What it still controls: upload resolution and the
                auto-add confirm window. recallK/orb are inert — every scan is
                CollectorVision now, whose cost is fixed at one 448px embed and one
                cosine sweep per catalog, and the ORB pipeline those two knobs
                tuned no longer exists. Kept rather than hidden because uploadW and
                the countdown are real on every path; the request still carries the
                two dead fields so an older backend keeps working. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('scan.detail')}</span>
                <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--accent-red)' }}>{profile.label}</span>
              </div>
              <input
                type="range"
                min="0"
                max={SCAN_PROFILES.length - 1}
                step="1"
                value={scanDetail}
                onChange={(e) => { const v = parseInt(e.target.value, 10); setScanDetail(v); localStorage.setItem('scan_detail', String(v)); }}
                style={{ width: '100%', accentColor: 'var(--accent-red)' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                <span>{t('scan.detailQuick')}</span>
                <span>{t('scan.detailSlow')}</span>
              </div>
            </div>

            {/* Lens picker: only with two or more cameras. Multi-lens phones expose
                each lens as its own camera, and the browser's default can be the
                macro or ultra-wide one. The pick is remembered (scan_camera_id). */}
            {videoInputs.length >= 2 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)' }}>
                <label htmlFor="scan-camera" style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('scan.cameraLens')}</label>
                <select
                  id="scan-camera"
                  className="select-control"
                  value={activeCameraId}
                  onChange={(e) => switchCamera(e.target.value)}
                  style={{ fontSize: '0.8rem' }}
                >
                  {/* The live lens can be missing from the list (getSettings
                      without deviceId); an empty option keeps the select honest. */}
                  {!videoInputs.some(d => d.deviceId === activeCameraId) && <option value={activeCameraId} />}
                  {videoInputs.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>{cameraLabel(d, i)}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Zoom: only rendered when the camera track supports it. Slider only,
                no pinch — a pinch on the preview already resizes the guide box. */}
            {zoomCaps && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)' }}>
                {/* No "×" readout: the unit is the camera's own. Phones report a
                    ratio (1–8), desktop UVC webcams an arbitrary range (0–60). */}
                <label htmlFor="scan-zoom" style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('scan.zoom')}</label>
                <input
                  id="scan-zoom"
                  type="range"
                  min={zoomCaps.min}
                  max={zoomCaps.max}
                  step={zoomCaps.step}
                  value={zoom}
                  onChange={(e) => changeZoom(parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--accent-red)' }}
                />
              </div>
            )}

            {/* Manual exposure: only rendered when the camera track supports it
                (Android Chrome back cams). Auto-exposure stays default until you
                move this. */}
            {exposureCaps && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('scan.exposure')}</span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ fontSize: '0.6rem', padding: '0.15rem 0.4rem' }}
                    onClick={() => {
                      const track = stream?.getVideoTracks?.()[0];
                      if (track) updateAdvancedConstraints(track, { exposureMode: 'continuous', exposureCompensation: null });
                      const cur = track?.getSettings?.().exposureCompensation;
                      setExposure(typeof cur === 'number' ? cur : 0);
                    }}
                  >
                    {t('scan.auto')}
                  </button>
                </div>
                <input
                  type="range"
                  min={exposureCaps.min}
                  max={exposureCaps.max}
                  step={exposureCaps.step}
                  value={exposure}
                  onChange={(e) => changeExposure(parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--accent-red)' }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                  <span>{t('scan.darker')}</span>
                  <span>{t('scan.brighter')}</span>
                </div>
              </div>
            )}
          </div>
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
              onClick={() => setShowScanSettings(s => !s)}
              title={t('scan.settingsHint')}
              aria-label={t('scan.settings')}
              style={{ flexShrink: 0, padding: '0 0.7rem', position: 'relative' }}
            >
              <Settings size={16} />
              {!scanSetCodes.length && <span style={{ position: 'absolute', top: 4, right: 4, width: 7, height: 7, borderRadius: '50%', background: 'var(--accent-yellow)' }} />}
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
      {showLocalHint && (
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
            onClick={() => { setLocalHintOff(true); localStorage.setItem('scan_local_hint', 'off'); }}
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
          setAutoAddCond={setAutoAddCond} setAutoAddPrint={setAutoAddPrint} setAutoAddEditing={setAutoAddEditing} autoAddCountdown={autoAddCountdown}
          autoAddCond={autoAddCond} autoAddPrint={autoAddPrint} setAutoAddTargetCard={setAutoAddTargetCard} setAutoAddCountdown={setAutoAddCountdown}
          autoAddCard={stable.autoAddCard} setAutoAddAlternatives={setAutoAddAlternatives} autoAddAlternatives={autoAddAlternatives} openQuickAdd={stable.openQuickAdd}
          setScanMatches={setScanMatches} setShowAllMatches={setShowAllMatches}
        />
      )}

      {/* Duplicate-Scan Confirm Overlay: the just-added card was scanned again. */}
      {dupConfirmCard && (
        <DupConfirmModal
          dismissDupConfirm={stable.dismissDupConfirm} dupConfirmCard={dupConfirmCard} addLanguage={addLanguage} setDupQty={setDupQty}
          dupQty={dupQty} resolvedDupIdRef={resolvedDupIdRef} setDupConfirmCard={setDupConfirmCard} autoAddCard={stable.autoAddCard}
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

      {/* Drawer Overlay for Selected Card */}
      {/* Pointer-only dismissal; Esc is the keyboard twin (useEscape above). */}
      <div role="presentation" className={`drawer-backdrop ${isDrawerOpen ? 'open' : ''}`} onClick={closeDrawer}></div>
      <div className={`quick-add-drawer ${isDrawerOpen ? 'open' : ''}`}>
        {selectedCard && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', width: '100%', maxWidth: '100%', boxSizing: 'border-box', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem', gap: '0.75rem', width: '100%', maxWidth: '100%', boxSizing: 'border-box' }}>
              {/* The name and number ARE the identification — the title above them
                  is boilerplate. So they get the size, and the set name (which the
                  number already implies) drops to the small line. */}
              <div style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                <h3 style={{ color: 'var(--text-muted)', fontSize: '0.7rem', margin: 0, textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 800 }}>{t('scan.addScannedTitle')}</h3>
                <p style={{ color: 'var(--text-strong)', fontSize: '1.25rem', fontWeight: 800, margin: '0.1rem 0 0 0', lineHeight: 1.2, wordBreak: 'break-word' }}>
                  {getCardDisplayName(selectedCard.name, language, selectedCard.printed_name)} <span style={{ color: 'var(--text-primary)' }}>#{selectedCard.number}</span>
                </p>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0, wordBreak: 'break-word' }}>{selectedCard.set_name}</p>
                <LangFallbackNote card={selectedCard} style={{ justifyContent: 'flex-start' }} />
              </div>
              <button type="button" className="btn btn-secondary btn-icon-only" onClick={closeDrawer} aria-label={t('common.close')} style={{ borderRadius: '50%', flexShrink: 0 }}>
                <X size={18} />
              </button>
            </div>

            {/* Three Column Layout (No vertical scroll) */}
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: '100%', maxWidth: '100%', boxSizing: 'border-box' }}>
              <div className="quick-add-grid">
                
                {/* Column 1: Card Preview (Smaller card: width 150px) */}
                <div className="quick-add-preview">
                  <img 
                    src={selectedCard.image_url} 
                    alt={getCardDisplayName(selectedCard.name, language, selectedCard.printed_name)} 
                    className="quick-add-preview-img"
                  />
                  <div className="quick-add-preview-info">
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>TCG Market ({printing})</div>
                    <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--accent-yellow)', margin: '0.1rem 0' }}>
                      <Price value={resolveCardPrice(selectedCard, printing)} currency={selectedCard.price_currency} />
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                      Rarity: <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{selectedCard.rarity || 'Common'}</span>
                    </div>
                  </div>
                </div>

                {/* Column 2: Card Properties Form */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  <div className="quick-add-section-title">{t('scan.cardProperties')}</div>
                  
                  <CardEntryFields
                    variant="stacked"
                    game={selectedCard.game || selectedCard.supertype}
                    quantity={quantity} purchasePrice={purchasePrice} condition={condition} printing={printing} language={language}
                    onQuantity={setQuantity} onPurchasePrice={setPurchasePrice} onCondition={setCondition} onPrinting={setPrinting} onLanguage={handleLanguageChange}
                  />
                </div>
              </div>

              {/* Submit Buttons.
                  "Other matches" goes back to what the scanner saw (alternative visual guesses).
                  "Right name, wrong printing" lists all printings of this card name across sets. */}
              <div className="quick-add-footer">
                <div className="quick-add-footer-tools">
                  {lastMatches.length > 1 && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => { closeDrawer(); setScanMatches(lastMatches); setShowAllMatches(true); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                    >
                      <ListFilter size={14} /> {t('scan.backToMatches', { n: lastMatches.length })}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={findOtherPrintings}
                    disabled={findingPrintings}
                    title={t('scan.otherPrintingsHint')}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                  >
                    {findingPrintings ? <RefreshCw size={14} className="spin" /> : <Layers size={14} />}
                    <span>{findingPrintings ? t('scan.fetchingCandidates') : (t('scan.changePrinting') || t('scan.otherPrintings') || t('scan.rightNameWrongPrinting'))}</span>
                  </button>
                </div>
                <div className="quick-add-footer-actions">
                  <button type="button" className="btn btn-secondary" onClick={closeDrawer}>{t('common.cancel')}</button>
                  <button type="submit" className="btn btn-primary">{t('search.addToCollection')}</button>
                </div>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

export default CameraScanner;
