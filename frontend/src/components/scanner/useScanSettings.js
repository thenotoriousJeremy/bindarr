import { useState, useEffect } from 'react';
import { defaultGame, isGameEnabled } from '../../utils/games';
import { langName, isLanguageSupported } from '../../utils/languages';
import { useStableCallback } from '../../utils/useStableCallback';
import { MIN_FILL, STEADY_FRAMES_NEEDED, SCAN_PROFILES } from './scanConstants';

// The scanner's settings: what is being fed in (game, language, sets), how it is
// scanned (auto-add, detail, the auto-capture gates) and what is shown. Most are
// remembered in localStorage. Moved out of CameraScanner unchanged.
//
// onScanLanguageReset(name): the scan language fell back to English after a game
// switch, so the add drawer's language should follow.
// onCatalogSwitch(): the game or language changed; the last scan's diagnostics no
// longer describe anything.

const setsKey = (game, lang) => (lang === 'en' ? `scanner_set_${game}` : `scanner_set_${game}_${lang}`);

export function useScanSettings({ onScanLanguageReset, onCatalogSwitch }) {
  const [showDetectOutline, setShowDetectOutlineState] = useState(() => localStorage.getItem('scan_outline') !== '0');
  const setShowDetectOutline = (on) => { setShowDetectOutlineState(on); localStorage.setItem('scan_outline', on ? '1' : '0'); };
  // Auto-add is a SEPARATE decision from auto-scan: scanning identifies the card,
  // auto-add files it without asking. Off, a confident match opens the add drawer
  // so condition/printing/quantity can be set before it is saved.
  const [autoAdd, setAutoAddState] = useState(() => localStorage.getItem('scan_auto_add') !== '0');
  const setAutoAdd = (on) => { setAutoAddState(on); localStorage.setItem('scan_auto_add', on ? '1' : '0'); };
  // Crop + candidate diagnostics. Useful when a scan misidentifies a card and
  // nowhere near useful enough to occupy the screen the rest of the time.
  const [showDebug, setShowDebugState] = useState(() => localStorage.getItem('scan_debug') === '1');
  const setShowDebug = (on) => { setShowDebugState(on); localStorage.setItem('scan_debug', on ? '1' : '0'); };
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
  const [scanDetail, setScanDetailState] = useState(() => {
    const v = parseInt(localStorage.getItem('scan_detail'), 10);
    return Number.isInteger(v) && v >= 0 && v < SCAN_PROFILES.length ? v : 2;
  });
  const setScanDetail = (v) => { setScanDetailState(v); localStorage.setItem('scan_detail', String(v)); };
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
  // Which language of card is being fed in. Card art is language-specific, so
  // this selects which set index the scan is matched against — and it becomes the
  // language each added copy is recorded as. Remembered across sessions because
  // people scan a language at a time.
  const [scanLang, setScanLangState] = useState(() => localStorage.getItem('scanner_lang') || 'en');
  const setScanLang = (code) => { setScanLangState(code); localStorage.setItem('scanner_lang', code); };
  const setScanGame = (g) => {
    setScanGameState(g);
    localStorage.setItem('scanner_game', g);
    if (!isLanguageSupported(g, scanLang)) {
      setScanLang('en');
      onScanLanguageReset(langName('en'));
    }
  };
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
  const dismissLocalHint = () => { setLocalHintOff(true); localStorage.setItem('scan_local_hint', 'off'); };
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

  // On game switch: restore that game's remembered set filter and load its set
  // tree (families + subsets).
  const catalogSwitched = useStableCallback(onCatalogSwitch);
  useEffect(() => {
    let cancelled = false;
    setScanSetCodesState((localStorage.getItem(setsKey(scanGame, scanLang)) || '').split(',').map(s => s.trim()).filter(Boolean));
    setSetInput('');
    setSetList([]);
    setScanSets(null);
    catalogSwitched();

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
  }, [scanGame, scanLang, catalogSwitched]);

  return {
    showDetectOutline, setShowDetectOutline, autoAdd, setAutoAdd, showDebug, setShowDebug,
    showScanSettings, setShowScanSettings, minFill, setMinFill, minSteady, setMinSteady,
    scanDetail, setScanDetail, profile,
    scanGame, setScanGame, scanLang, setScanLang,
    scanSetCodes, persistSets, scanSetParam, setInput, setSetInput, scanSets,
    onlyBuiltSets, setOnlyBuiltSets, setScanCode, toggleCode, toggleSetFamily,
    scanBuiltLangs, showLocalHint, dismissLocalHint, treeSets, selectedSetCount,
  };
}
