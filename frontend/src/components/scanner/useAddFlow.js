import { useState, useEffect, useCallback } from 'react';
// Loaded on the first ultra-rare, so the scanner's chunk does not carry it.
const confetti = (options) => import('canvas-confetti').then(m => m.default(options)).catch(() => {});
import { getCardDisplayName } from '../../utils/langHelper';
import { resolveCardPrice } from '../../utils/resolveCardPrice';
import { langName, langCode } from '../../utils/languages';
import { rankByScore } from './scanDecision';

// What happens to a card once the scanner has named it: filed straight away
// (auto-add, with or without a countdown to cancel), offered in the add drawer to
// adjust first, or questioned as a possible duplicate. Moved out of CameraScanner
// unchanged.
//
// From the scanner: rearm() makes auto-scan act on the next card in frame;
// ensureCamera() reopens the camera if it is not running; setScanMatches and
// setShowAllMatches drive the match picker, which the add drawer can return to.
export function useAddFlow({
  t, showToast, onAddSuccess, signal, scanGame, scanLang,
  setRecentScans, setScanMatches, setShowAllMatches,
  lastScanImgRef, lastScanCroppedRef, lastAddedIdRef, resolvedDupIdRef,
  rearm, ensureCamera,
}) {
  // Drawer states
  const [selectedCard, setSelectedCard] = useState(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [autoAddCountdown, setAutoAddCountdown] = useState(null);
  const [autoAddTargetCard, setAutoAddTargetCard] = useState(null);
  // The rest of the ORB list, shown beside the countdown. Scanning a whole set
  // means many near-identical cards, and the one in hand is regularly not ORB's
  // first pick — so the runners-up stay one tap away instead of requiring an undo.
  const [autoAddAlternatives, setAutoAddAlternatives] = useState([]);
  // The last scan's full candidate list, kept after the picker closes so the
  // add drawer can go back to it. openQuickAdd clears scanMatches, which is why
  // reaching the alternatives from the drawer was impossible.
  const [lastMatches, setLastMatches] = useState([]);
  // True while the "different printing" lookup is in flight.
  const [findingPrintings, setFindingPrintings] = useState(false);
  // Tap the countdown popup to pause auto-add and tweak these before adding
  // (slower tiers only — Turbo adds instantly with no overlay).
  const [autoAddEditing, setAutoAddEditing] = useState(false);
  const [autoAddCond, setAutoAddCond] = useState('Near Mint');
  const [autoAddPrint, setAutoAddPrint] = useState('Normal');
  // Duplicate-scan confirm: set to the repeat-matched card; dupQty = copies to add.
  const [dupConfirmCard, setDupConfirmCard] = useState(null);
  const [dupQty, setDupQty] = useState(1);

  // Form states
  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState('Near Mint');
  const [printing, setPrinting] = useState('Normal');
  // Language of the copy being added. Defaults to whatever is being scanned, so a
  // Japanese run does not have to be corrected card by card.
  const [language, setLanguage] = useState(() => langName(localStorage.getItem('scanner_lang') || 'en'));
  const [purchasePrice, setPurchasePrice] = useState(0);

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
    rearm();
    showToast(t('scan.autoAddCancelled'));
  };

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
        // Each copy is filed on its own; one with no room stays in Unsorted (`unplaced`).
        if (placementLabel && data.unplaced > 0) {
          showToast(t('scan.addedSomeUnplaced', { qty: qtyLabel, name: cardDisplayName, place: placementLabel, count: data.unplaced }));
        } else if (placementLabel) {
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

  const closeDrawer = () => {
    setIsDrawerOpen(false);
    setSelectedCard(null);
    setScanMatches([]);
    setQuantity(1);
    setCondition('Near Mint');
    setPrinting('Normal');
    setLanguage(langName(scanLang));
    setPurchasePrice(0);
    rearm();
    // Restart camera on close only if stream was stopped
    ensureCamera();
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
      const found = rankByScore(raw);
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

  return {
    selectedCard, isDrawerOpen, openQuickAdd, closeDrawer, handleSubmit, handleLanguageChange,
    quantity, setQuantity, condition, setCondition, printing, setPrinting, language, setLanguage,
    purchasePrice, setPurchasePrice, lastMatches, setLastMatches, findingPrintings, findOtherPrintings,
    autoAddCountdown, setAutoAddCountdown, autoAddTargetCard, setAutoAddTargetCard,
    autoAddAlternatives, setAutoAddAlternatives, autoAddEditing, setAutoAddEditing,
    autoAddCond, setAutoAddCond, autoAddPrint, setAutoAddPrint, autoAddCard, cancelAutoAdd,
    dupConfirmCard, setDupConfirmCard, dupQty, setDupQty, dismissDupConfirm,
    addLanguage,
  };
}
