import { useState, useEffect, useMemo, useRef } from 'react';
import { DndContext, DragOverlay, MouseSensor, useSensor, useSensors, useDraggable, useDroppable, pointerWithin } from '@dnd-kit/core';
import { Plus, Trash2, X, MoreVertical, Settings, RefreshCw, Lock, LayoutGrid, List, MousePointerClick, ChevronDown, ChevronUp, Edit3 } from 'lucide-react';
import { sortCardsByOrder } from '../utils/cardSort';
import { getFoilOverlayClass, getPrintingBadgeLabel, getPrintingBadgeStyle } from '../utils/cardPrinting';
import { getCardRarityBorder, getRarityBadgeStyle, getRarityBadgeLabel } from '../utils/cardRarity';
import CardInspectorModal from './CardInspectorModal';
import { useMultiSelect } from '../utils/useMultiSelect';
import { isBinderType as computeIsBinder, binderSpread } from '../utils/cardOptions';
import { displayName } from '../utils/languages';
import CompartmentView, { FocusedCardInfo } from './CompartmentView';
import { SortBuilder, FilterBuilder } from './SortFilterBuilder';
import CreateContainerModal from './CreateContainerModal';
import CardImage from './CardImage';
import { useBackGuard } from '../utils/useBackGuard';
import { useT } from '../utils/i18n';

// An Unsorted-queue card that can be dragged into a binder pocket. Split in two
// so the hook only mounts when dragging is on — the queue also renders for
// auto-sorted and locked containers, where there is nothing to drag to.
// MouseSensor activates on mousedown, while hold-to-select listens on
// pointerdown, so both sets of listeners can be spread onto the same element.
function ActiveDraggable({ entryId, card, style, children, ...divProps }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: entryId, data: { card } });
  return (
    <div
      ref={setNodeRef}
      style={{ ...style, cursor: 'grab', ...(isDragging ? { opacity: 0.4 } : {}) }}
      {...attributes}
      {...listeners}
      {...divProps}
    >
      {children}
    </div>
  );
}

function DraggableCard({ enabled, entryId, card, children, ...divProps }) {
  if (!enabled) return <div {...divProps}>{children}</div>;
  return <ActiveDraggable entryId={entryId} card={card} {...divProps}>{children}</ActiveDraggable>;
}

// The Unsorted queue as a drop target, so a filed card can be dragged back OUT
// of the binder. Without it the queue is one-way: cards go in by drag and only
// come back by opening the card and clearing its container.
function UnsortedDropZone({ enabled, children }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'unsorted-queue' });
  if (!enabled) return <>{children}</>;
  return (
    <div
      ref={setNodeRef}
      style={{
        // An empty queue is exactly when you most want to drag a card out of the
        // binder, and an empty div is nothing to aim at — so it keeps a target
        // worth of height whether or not there is anything in it.
        minHeight: '90px',
        borderRadius: 'var(--radius-sm)',
        ...(isOver ? { outline: '3px solid var(--accent-green)', outlineOffset: '-3px' } : {}),
      }}
    >
      {children}
    </div>
  );
}

function LocationManager({ statsTrigger, onUpdate, showToast, selectedLocationId, setSelectedLocationId, focusEntryId }) {
  const { t } = useT();
  const [locations, setLocations] = useState([]);
  const [activeLocationId, setActiveLocationId] = useState(null);
  const [compartments, setCompartments] = useState([]);
  const [allCards, setAllCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [setsList, setSetsList] = useState([]);

  useEffect(() => {
    fetch('/api/sets')
      .then(res => res.json())
      .then(data => setSetsList(data))
      .catch(err => console.error(err));
  }, []);


  const [showCreate, setShowCreate] = useState(false);

  const [capacityUpdatePending, setCapacityUpdatePending] = useState(null);
  const [showKebabMenu, setShowKebabMenu] = useState(false);
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [sortDraft, setSortDraft] = useState([]);
  const [filterDraft, setFilterDraft] = useState([]);
  const [nameDraft, setNameDraft] = useState('');
  const [capacityDraft, setCapacityDraft] = useState('');
  const [countDraft, setCountDraft] = useState('');
  const [stackingDraft, setStackingDraft] = useState(false);

  const [inspectorCard, setInspectorCard] = useState(null);

  // Binder "sorting renumbers pockets" heads-up: dismissible, and stays dismissed
  // across sessions so it doesn't permanently occupy screen space.
  const [binderTipDismissed, setBinderTipDismissed] = useState(
    () => localStorage.getItem('bindarr_binder_tip_dismissed') === '1'
  );
  const dismissBinderTip = () => {
    localStorage.setItem('bindarr_binder_tip_dismissed', '1');
    setBinderTipDismissed(true);
  };

  // Per-compartment filing-rule editor.
  const [rulesComp, setRulesComp] = useState(null);
  useBackGuard(!!rulesComp, () => setRulesComp(null));
  useBackGuard(showRulesModal, () => setShowRulesModal(false));
  useBackGuard(!!capacityUpdatePending, () => setCapacityUpdatePending(null));
  useBackGuard(!!selectedLocationId, () => setSelectedLocationId && setSelectedLocationId(null));
  const [compRuleDraft, setCompRuleDraft] = useState([]);

  const [unsortedSearch, setUnsortedSearch] = useState('');
  const [unsortedSort, setUnsortedSort] = useState('scanned-desc');
  const [unsortedViewMode, setUnsortedViewMode] = useState('grid'); // 'grid' | 'detail'
  const [unsortedBulkLocation, setUnsortedBulkLocation] = useState('');

  const {
    selectMode: unsortedSelectMode,
    setSelectMode: setUnsortedSelectMode,
    selectedIds: unsortedSelectedIds,
    setSelectedIds: setUnsortedSelectedIds,
    toggleSelect: toggleUnsortedSelect,
    clearSelection: clearUnsortedSelection,
    exitSelectMode: exitUnsortedSelectMode,
    pressHandlers: unsortedPressHandlers,
    longPressFired: unsortedLongPressFired,
    runBulk: runUnsortedBulk,
  } = useMultiSelect({
    showToast,
    onChanged: () => {
      onUpdate && onUpdate();
      refreshAll();
    }
  });

  // Multi-select over cards inside the open container. A locked container blocks
  // arming and bulk actions (guard); a successful action exits select mode.
  const storage = useMultiSelect({
    showToast,
    guard: () => selectedLoc?.locked ? 'Container is locked. Unlock it first to modify stored cards.' : null,
    onChanged: () => { storage.exitSelectMode(); refreshAll(); onUpdate(); },
  });

  const activateUnsortedCard = (card) => {
    if (unsortedLongPressFired.current) return;
    if (moveMode) {
      handlePickCard(card.entry_id);
      return;
    }
    if (unsortedSelectMode) {
      toggleUnsortedSelect(card.entry_id);
      return;
    }
    setInspectorCard(card);
  };

  const [activePageIndex, setActivePageIndex] = useState(0);
  const [binderActiveEntryId, setBinderActiveEntryId] = useState(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  // Stacked = single-column layout (matches the 1024px CSS breakpoint). Below it,
  // the detail panel and Unsorted queue are shown one at a time via a segmented
  // toggle instead of stacked, so you don't scroll between them.
  const [isStacked, setIsStacked] = useState(window.innerWidth <= 1024);
  const [mobilePane, setMobilePane] = useState('container'); // 'container' | 'unsorted'

  const [filingMode, setFilingMode] = useState(false);
  const [filingQueue, setFilingQueue] = useState([]);
  const [filingIndex, setFilingIndex] = useState(0);
  // Re-sort review reuses the filing UI, but the cards are already placed in the
  // DB by /resort — so "Placed" just advances instead of issuing a move.
  const [filingReadOnly, setFilingReadOnly] = useState(false);
  // Collapse the mobile filing bar to a slim strip so it stops covering the binder.
  const [filingBarCollapsed, setFilingBarCollapsed] = useState(false);

  // Back gesture exits filing mode. Declared HERE, after filingMode/filingReadOnly:
  // useBackGuard reads filingMode during render, so placing it above the useState
  // above would hit the temporal dead zone (crashes the whole view on mount).
  useBackGuard(filingMode, () => { setFilingMode(false); setFilingReadOnly(false); refreshAll(); });

  // Manual tap-to-place ("Arrange"), custom-order containers only. Pick a card
  // (unsorted or in-container), then tap a slot to place/swap it.
  const [moveMode, setMoveMode] = useState(false);
  const [pickedEntryId, setPickedEntryId] = useState(null);

  // The recommended slot for the card currently under review in filing mode —
  // drives the ghost preview shown in the container view.
  const currentRecSpot = filingMode ? (filingQueue[filingIndex]?.recommended || null) : null;
  const recCard = filingMode && filingQueue[filingIndex]?.recommended ? filingQueue[filingIndex].entry : null;

  // Declared here (not lower) because the filing-mode effect below reads
  // isBinderType in its dependency array, which is evaluated during render —
  // a lower `const` would be in the temporal dead zone at that point.
  const selectedLoc = locations.find(l => l.id === activeLocationId);
  const isBinderType = computeIsBinder(selectedLoc?.type);
  const isCustom = selectedLoc?.sort_order === 'custom';

  useEffect(() => {
    if (filingMode && filingQueue[filingIndex]?.recommended) {
      const rec = filingQueue[filingIndex].recommended;
      // Filing is scoped to the open container, so rec.location_id normally
      // matches it. Guard anyway (re-sort review reuses this path) — switch,
      // then compartments reload and this effect reruns to snap to the slot.
      if (rec.location_id && rec.location_id !== activeLocationId) {
        setActiveLocationId(rec.location_id);
        return;
      }
      if (isBinderType) {
        const compIdx = compartments.findIndex(c => c.id === rec.compartment_id);
        if (compIdx !== -1) setActivePageIndex(compIdx);
      } else {
        setActiveCompartmentId(rec.compartment_id);
        const posIdx = Math.floor(rec.position / 1000) - 1;
        setCoverflowActiveIndex(Math.max(0, posIdx));
      }
      
      let attempts = 0;
      const tryScroll = () => {
        const el = document.getElementById('recommended-spot');
        if (el) {
          if (isBinderType) {
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
          }
          el.classList.remove('flash-highlight');
          void el.offsetWidth;
          el.classList.add('flash-highlight');
        } else if (attempts < 10) {
          attempts++;
          setTimeout(tryScroll, 100);
        }
      };
      tryScroll();
    }
  }, [filingMode, filingIndex, filingQueue, compartments, isBinderType, activeLocationId]);
  const touchStartRef = useRef({ x: 0, y: 0 });
  const focusNavRef = useRef(null); // focusEntryId already navigated to (run-once guard)

  const [activeCompartmentId, setActiveCompartmentId] = useState(null);
  const [, setCoverflowActiveIndex] = useState(0); // value unused; setter drives filing-snap resets

  const handleTouchStart = (e) => {
    if (!e.changedTouches || !e.changedTouches[0]) return;
    touchStartRef.current = {
      x: e.changedTouches[0].clientX,
      y: e.changedTouches[0].clientY
    };
  };

  const handleTouchEnd = (e) => {
    if (!e.changedTouches || !e.changedTouches[0]) return;
    const endX = e.changedTouches[0].clientX;
    const endY = e.changedTouches[0].clientY;
    const diffX = touchStartRef.current.x - endX;
    const diffY = touchStartRef.current.y - endY;
    if (Math.abs(diffX) > 35 && Math.abs(diffX) > Math.abs(diffY)) {
      if (diffX > 0) {
        setActivePageIndex(prev => Math.min(compartments.length - 1, prev + 1));
      } else {
        setActivePageIndex(prev => Math.max(0, prev - 1));
      }
    }
  };

  useEffect(() => {
    const handleResize = () => { setIsMobile(window.innerWidth <= 768); setIsStacked(window.innerWidth <= 1024); };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    setActiveCompartmentId(null);
    setActivePageIndex(0);
    setBinderActiveEntryId(null);
    if (!filingReadOnly) setFilingQueue([]);
    setCoverflowActiveIndex(0);
    storage.exitSelectMode();
    setMoveMode(false);
    setPickedEntryId(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLocationId]);

  useEffect(() => {
    if (compartments.length > 0) {
      const exists = compartments.some(c => c.id === activeCompartmentId);
      if (!exists) {
        setActiveCompartmentId(compartments[0].id);
      }
    } else {
      setActiveCompartmentId(null);
    }
  }, [compartments, activeCompartmentId]);

  useEffect(() => {
    setCoverflowActiveIndex(0);
  }, [activeCompartmentId]);

  useEffect(() => {
    if (activePageIndex >= compartments.length && compartments.length > 0) {
      setActivePageIndex(compartments.length - 1);
    }
  }, [compartments.length, activePageIndex]);

  const fetchLocations = async () => {
    try {
      const res = await fetch('/api/locations');
      if (res.ok) setLocations(await res.json());
    } catch (err) { console.error(err); }
  };

  const fetchAllCards = async () => {
    try {
      const res = await fetch('/api/collection');
      if (res.ok) setAllCards(await res.json());
    } catch (err) { console.error(err); }
  };

  const fetchCompartments = async (locId) => {
    if (!locId) { setCompartments([]); return; }
    try {
      const res = await fetch(`/api/locations/${locId}/compartments`);
      if (res.ok) setCompartments(await res.json());
    } catch (err) { console.error(err); }
  };

  const refreshAll = async () => {
    await Promise.all([fetchLocations(), fetchAllCards()]);
    if (activeLocationId) await fetchCompartments(activeLocationId);
  };

  useEffect(() => {
    (async () => {
      if (locations.length === 0 && allCards.length === 0) {
        setLoading(true);
      }
      await Promise.all([fetchLocations(), fetchAllCards()]);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- length reads only gate the first-load spinner; adding them would loop on refetch
  }, [statsTrigger]);

  useEffect(() => {
    fetchCompartments(activeLocationId);
  }, [activeLocationId, statsTrigger]);

  useEffect(() => {
    if (selectedLocationId) {
      if (selectedLocationId === 'unsorted' || selectedLocationId === 'unassigned') {
        setActiveLocationId(null);
        setMobilePane('unsorted'); // deterministically show the Unsorted pane, not the focus effect's job
      } else {
        setActiveLocationId(selectedLocationId);
        setMobilePane('container');
      }
      setSelectedLocationId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLocationId]);

  useEffect(() => {
    if (!focusEntryId || allCards.length === 0) return;
    const targetCard = allCards.find(c => (c.entry_id || c.id) === focusEntryId);
    if (!targetCard) return;

    // Navigate to the card's location ONCE per focus request. Reruns (compartments
    // reload when you open another container) must NOT re-apply this, or an
    // unsorted focus target would yank you back to Unsorted every time you open a
    // container. Compartment snapping is left to run on reruns so it can settle
    // once the target location's compartments finish loading.
    const firstForThisFocus = focusNavRef.current !== focusEntryId;
    if (firstForThisFocus) {
      focusNavRef.current = focusEntryId;
      if (targetCard.location_id) {
        setActiveLocationId(targetCard.location_id);
      } else {
        setActiveLocationId(null);
        setMobilePane('unsorted');
      }
    }

    if (targetCard.location_id && targetCard.compartment_id && compartments.length > 0) {
      const compIdx = compartments.findIndex(c => c.id === targetCard.compartment_id);
      if (compIdx !== -1) {
        setActivePageIndex(compIdx);
        setActiveCompartmentId(targetCard.compartment_id);
        setBinderActiveEntryId(targetCard.entry_id || targetCard.id);
      }
    }

    if (firstForThisFocus) {
      let attempts = 0;
      const tryScroll = () => {
        const el = document.getElementById(`card-${focusEntryId}`) || document.querySelector(`.focus-flash`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        } else if (attempts < 15) {
          attempts++;
          setTimeout(tryScroll, 100);
        }
      };
      tryScroll();
    }
  }, [focusEntryId, allCards, compartments]);

  useEffect(() => {
    // If the storage tab is opened without a specific container URL (selectedLocationId is falsy),
    // and there are locations available, auto-select the first one.
    if (!selectedLocationId && !activeLocationId && !focusEntryId && mobilePane !== 'unsorted' && locations.length > 0) {
      setActiveLocationId(locations[0].id);
    }
  }, [locations, selectedLocationId, activeLocationId, focusEntryId, mobilePane]);

  const unsortedCards = useMemo(() => {
    let cards = allCards.filter(c => !c.location_id && (
      c.name.toLowerCase().includes(unsortedSearch.toLowerCase()) ||
      (c.set_name || '').toLowerCase().includes(unsortedSearch.toLowerCase())
    ));
    return sortCardsByOrder([...cards], unsortedSort, selectedLoc?.foil_sorting, setsList);
  }, [allCards, unsortedSearch, unsortedSort, selectedLoc, setsList]);

  // Distinct values per filterable field from the cards actually owned, so the
  // FilterBuilder value box suggests real options (e.g. subtypes like "Basic")
  // instead of only a hardcoded list.
  const filterFieldOptions = useMemo(() => {
    const uniq = (fn) => Array.from(new Set(allCards.flatMap(fn).filter(v => v !== null && v !== undefined && v !== ''))).sort();
    return {
      name: uniq(c => [c.name]),
      supertype: uniq(c => [c.supertype]),
      types: uniq(c => c.types || []),
      subtypes: uniq(c => c.subtypes || []),
      color_identity: uniq(c => c.color_identity || []),
      cmc: uniq(c => [c.cmc]).sort((a, b) => a - b),
      set_name: uniq(c => [c.set_name]),
      set_id: uniq(c => [c.set_id]),
      rarity: uniq(c => [c.rarity]),
      printing: uniq(c => [c.printing]),
    };
  }, [allCards]);

  const cardsByCompartment = useMemo(() => {
    const map = new Map();
    allCards.forEach(c => {
      if (!c.compartment_id) return;
      if (!map.has(c.compartment_id)) map.set(c.compartment_id, []);
      map.get(c.compartment_id).push(c);
    });
    // Display order must match the container's scheme so the digital layout
    // mirrors the physical binder/box (and the REC SPOT highlight, derived from
    // slot index, points at the right pocket). Custom = manual order, honored
    // via stored position. Structured schemes sort by the scheme directly, which
    // is robust even if stored positions drifted before a re-sort.
    const isCustom = !selectedLoc || selectedLoc.sort_order === 'custom';
    map.forEach(cards => {
      if (isCustom) cards.sort((a, b) => (a.position || 0) - (b.position || 0));
      else sortCardsByOrder(cards, selectedLoc.sort_order, selectedLoc.foil_sorting, setsList);
    });
    return map;
  }, [allCards, selectedLoc, setsList]);

  // Receives the full payload built by the create wizard.
  const handleCreateLocation = async (payload) => {
    try {
      const res = await fetch('/api/locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        showToast(t('loc.containerCreated'));
        setShowCreate(false);
        await fetchLocations();
        setActiveLocationId(data.id);
        onUpdate();
      } else {
        showToast(data.error || 'Failed to create container.');
      }
    } catch (err) {
      console.error(err);
      showToast(t('loc.errCreate'));
    }
  };

  const handleDeleteLocation = async (locId, name) => {
    if (selectedLoc && selectedLoc.id === locId && selectedLoc.locked) {
      showToast(t('loc.lockedDelete'));
      return;
    }
    if (!window.confirm(t('loc.confirmDeleteContainer', { name }))) return;
    try {
      const res = await fetch(`/api/locations/${locId}`, { method: 'DELETE' });
      if (res.ok) {
        showToast(t('loc.containerDeleted', { name }));
        if (activeLocationId === locId) setActiveLocationId(null);
        await refreshAll();
        onUpdate();
      } else {
        showToast(t('loc.errDelete'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('loc.errDeleteGeneric'));
    }
  };

  const handleUpdateLocationFields = async (fields) => {
    if (!selectedLoc) return;
    if (selectedLoc.locked && !('locked' in fields)) {
      showToast(t('loc.lockedSettings'));
      return;
    }
    try {
      const res = await fetch(`/api/locations/${selectedLoc.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields)
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.evicted ? `Container updated. ${data.evicted} card${data.evicted === 1 ? '' : 's'} moved to Unsorted.` : 'Container updated.');
        await refreshAll();
        onUpdate();
      } else {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Failed to update container.');
      }
    } catch (err) {
      console.error(err);
      showToast(t('loc.errUpdateContainer'));
    }
  };

  const handleAddCompartment = async () => {
    if (!selectedLoc) return;
    if (selectedLoc.locked) {
      showToast(t('loc.lockedAdd'));
      return;
    }
    try {
      const res = await fetch(`/api/locations/${selectedLoc.id}/compartments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      if (res.ok) { 
        const created = await res.json();
        showToast(t(isBinderType ? 'loc.pageAdded' : 'loc.rowAdded')); 
        await Promise.all([fetchCompartments(selectedLoc.id), fetchLocations()]);
        if (created && created.id) {
          setActiveCompartmentId(created.id);
          if (created.idx) setActivePageIndex(created.idx - 1);
        }
      }
      else showToast(t('loc.errAddCompartment'));
    } catch (err) { console.error(err); showToast(t('loc.errAddCompartmentGeneric')); }
  };

  const handleRemoveCompartment = async (compartmentId) => {
    if (!selectedLoc) return;
    if (selectedLoc.locked) {
      showToast(t('loc.lockedRemove'));
      return;
    }
    if (!window.confirm(t('loc.confirmRemoveCompartment'))) return;
    try {
      const res = await fetch(`/api/compartments/${compartmentId}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) { showToast(t('loc.compartmentRemoved')); await Promise.all([fetchCompartments(activeLocationId), fetchLocations()]); }
      else showToast(data.error || 'Failed to remove compartment.');
    } catch (err) { console.error(err); showToast(t('loc.errRemoveCompartment')); }
  };

  // Lock/unlock a row/page: filing skips locked ones (existing cards stay).
  // Uses the working /locations/:id/compartments/:comp_id route.
  const handleToggleCompartmentLock = async (compartmentId, locked) => {
    if (selectedLoc?.locked) {
      showToast(t('loc.lockedRowLocks'));
      return;
    }
    if (!activeLocationId) return;
    try {
      const res = await fetch(`/api/locations/${activeLocationId}/compartments/${compartmentId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locked })
      });
      if (res.ok) { showToast(t(locked ? 'loc.rowLocked' : 'loc.rowUnlocked')); await fetchCompartments(activeLocationId); }
      else showToast(t('loc.errLock'));
    } catch (err) { console.error(err); showToast(t('loc.errLockGeneric')); }
  };

  // Lock/unlock a whole container: filing (and overflow) skip it entirely.
  const handleToggleContainerLock = async () => {
    if (!selectedLoc) return;
    const next = !selectedLoc.locked;
    try {
      const res = await fetch(`/api/locations/${selectedLoc.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locked: next })
      });
      if (res.ok) { showToast(next ? `"${selectedLoc.name}" locked — filing will skip it.` : `"${selectedLoc.name}" unlocked.`); await fetchLocations(); }
      else showToast(t('loc.errLock'));
    } catch (err) { console.error(err); showToast(t('loc.errLockGeneric')); }
  };

  const handleRenameCompartment = async (compartmentId, label) => {
    if (selectedLoc?.locked) {
      showToast(t('loc.lockedRename'));
      return;
    }
    try {
      await fetch(`/api/compartments/${compartmentId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) });
      await fetchCompartments(activeLocationId);
    } catch (err) { console.error(err); showToast(t('loc.errRename')); }
  };

  const handleSetCapacity = async (compartmentId, capacity, forceUpdateAll = false) => {
    if (selectedLoc?.locked) {
      showToast(t('loc.lockedCapacity'));
      return;
    }
    if (compartments.length > 1 && !forceUpdateAll && !capacityUpdatePending) {
      setCapacityUpdatePending({ id: compartmentId, capacity });
      return;
    }
    const updateAll = forceUpdateAll || false;
    try {
      await fetch(`/api/compartments/${compartmentId}${updateAll ? '?updateAll=true' : ''}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ capacity }) });
      await fetchCompartments(activeLocationId);
    } catch (err) { console.error(err); showToast(t('loc.errResize')); }
  };

  const handleMoveCard = async (entryId, compartmentId) => {
    if (selectedLoc?.locked) {
      showToast(t('loc.lockedMove'));
      return;
    }
    try {
      const res = await fetch(`/api/collection/${entryId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ compartment_id: compartmentId })
      });
      if (res.ok) { showToast(t('loc.cardMoved')); await refreshAll(); }
      else {
        const errData = await res.json().catch(()=>({}));
        showToast(errData.error || 'Failed to move card.');
      }
    } catch (err) { console.error(err); showToast(t('loc.errMove')); }
  };

  // --- Manual tap-to-place (Arrange) ---
  // Pick/unpick a card to move. Tapping the picked card again cancels.
  const handlePickCard = (entryId) => {
    if (selectedLoc?.locked) {
      showToast(t('loc.lockedArrange'));
      return;
    }
    setPickedEntryId(prev => (prev === entryId ? null : entryId));
  };

  // Place a card at a slot. Binder + occupied pocket = swap; otherwise send the
  // slot and let the backend place absolutely (binder) or insert (box). The card
  // defaults to the tap-picked one; drag-and-drop passes the dragged card
  // explicitly, because its id is known before setPickedEntryId would land.
  const handlePlaceSlot = async (compartmentId, slotNumber, occupantEntryId, entryId = pickedEntryId) => {
    if (selectedLoc?.locked) {
      showToast(t('loc.lockedArrange'));
      return;
    }
    if (!entryId || occupantEntryId === entryId) { setPickedEntryId(null); return; }
    const body = { compartment_id: compartmentId };
    if (isBinderType && occupantEntryId) body.swap_with = occupantEntryId;
    else body.slot = slotNumber;
    try {
      const res = await fetch(`/api/collection/${entryId}/place`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast(body.swap_with ? 'Cards swapped.' : (data.placement?.label ? `Placed → ${data.placement.label}` : 'Card placed.'));
        setPickedEntryId(null);
        await refreshAll(); onUpdate();
      } else {
        showToast(data.error === 'COMPARTMENT_FULL' ? 'That page/row is full.' : (data.error || 'Failed to place card.'));
      }
    } catch (err) { console.error(err); showToast(t('loc.errPlace')); }
  };

  // --- Drag-and-drop filing ---
  // Drop lands on the same handler tap-to-place uses, so the lock guard, the
  // swap rule and the backend call are shared. Only custom-order binders: the
  // /place route rejects anything else, and a box's coverflow has no stable
  // drop geometry to aim at.
  const [draggingCard, setDraggingCard] = useState(null);
  const dndEnabled = isBinderType && isCustom && !selectedLoc?.locked;
  // ponytail: mouse only. A distance-activated touch drag would swallow the
  // binder's page-swipe and the queue's scroll; touch still files by tapping
  // under Arrange. Add a delay-activated TouchSensor if that proves too slow.
  const dndSensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }));

  // Drag a filed card back out. The bulk endpoint with a null target is what the
  // Move-to-Unassigned action already uses, so unfiling has one implementation
  // and one set of rules whichever way it is triggered.
  const unfileCard = async (entryId) => {
    if (selectedLoc?.locked) {
      showToast(t('loc.lockedArrange'));
      return;
    }
    try {
      const res = await fetch('/api/collection/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_ids: [entryId], action: 'move', value: null })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        showToast(body?.error || t('loc.errPlace'));
        return;
      }
      showToast(t('loc.movedToUnsorted'));
      setPickedEntryId(null);
      await refreshAll(); onUpdate();
    } catch (err) { console.error(err); showToast(t('loc.errPlace')); }
  };

  const handleDragEnd = ({ active, over }) => {
    setDraggingCard(null);
    if (!over) return;
    // Dropped on the queue: the card leaves the binder rather than moving inside it.
    if (over.id === 'unsorted-queue') {
      unfileCard(active.id);
      return;
    }
    const pocket = over.data?.current;
    if (!pocket) return;
    handlePlaceSlot(pocket.compartmentId, pocket.slot, pocket.occupantEntryId, active.id);
  };

  const handleDeleteCard = async (entryId) => {
    if (selectedLoc?.locked) {
      showToast(t('loc.lockedDeleteCards'));
      return;
    }
    if (!window.confirm(t('loc.confirmRemoveCard'))) return;
    try {
      const res = await fetch(`/api/collection/${entryId}`, { method: 'DELETE' });
      if (res.ok) { showToast(t('loc.cardRemoved')); await refreshAll(); onUpdate(); }
      else showToast(t('loc.errRemoveCard'));
    } catch (err) { console.error(err); showToast(t('loc.errRemoveCardGeneric')); }
  };

  // Cards physically in the open container (any compartment).
  const cardsInActiveLocation = useMemo(
    () => allCards.filter(c => c.location_id === activeLocationId),
    [allCards, activeLocationId]
  );

  const openCompartmentRules = (comp) => {
    let draft = [];
    const cfg = comp.rule_config;
    if (cfg) {
      try {
        const p = typeof cfg === 'string' ? JSON.parse(cfg) : cfg;
        draft = Array.isArray(p) ? p : (p.rules || []);
      } catch (e) { draft = []; }
    }
    setCompRuleDraft(draft);
    setRulesComp(comp);
  };

  const saveCompartmentRules = async () => {
    if (!rulesComp) return;
    try {
      const res = await fetch(`/api/compartments/${rulesComp.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule_config: compRuleDraft.length > 0 ? { rules: compRuleDraft } : null })
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.evicted ? `Row rules updated. ${data.evicted} card${data.evicted === 1 ? '' : 's'} moved to Unsorted.` : 'Row rules updated.');
        setRulesComp(null);
        await refreshAll();
        onUpdate();
      } else {
        showToast(t('loc.errRowRules'));
      }
    } catch (err) { console.error(err); showToast(t('loc.errRowRulesGeneric')); }
  };

  const handleApplyAll = async () => {
    if (!activeLocationId || unsortedCards.length === 0) return;
    const target = locations.find(l => l.id === activeLocationId);
    if (!window.confirm(t('loc.confirmAutoFile', { count: unsortedCards.length, name: target?.name }))) return;
    try {
      const res = await fetch(`/api/locations/${activeLocationId}/apply-all`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_ids: unsortedCards.map(c => c.entry_id) })
      });
      const data = await res.json();
      if (res.ok) { showToast(data.message); await refreshAll(); onUpdate(); }
      else showToast(data.error || 'Failed to file batch.');
    } catch (err) { console.error(err); showToast(t('loc.errFileBatch')); }
  };

  const startFilingMode = async () => {
    if (unsortedCards.length === 0 || !activeLocationId) return;
    const target = locations.find(l => l.id === activeLocationId);
    try {
      // Scope the walkthrough to the open container only — file just the cards
      // that fit its rules and capacity; the rest stay in the Unsorted queue.
      const res = await fetch(`/api/locations/${activeLocationId}/recommend-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_ids: unsortedCards.map(c => c.entry_id) })
      });
      if (!res.ok) { showToast(t('loc.errFilingMode')); return; }
      const data = await res.json();
      const placeable = data.filter(d => d.recommended);
      const noRoom = data.filter(d => !d.recommended);

      if (placeable.length === 0) {
        showToast(t('loc.filingNoFit', { name: target?.name, count: noRoom.length }));
        return;
      }

      setFilingQueue(placeable);
      setFilingIndex(0);
      setFilingMode(true);
      setMobilePane('container'); // keep the binder visible on mobile; guide is the pinned bar
      setMoveMode(false);
      setPickedEntryId(null);
      if (noRoom.length > 0) {
        showToast(t('loc.filingStarted', { count: placeable.length, name: target?.name, left: noRoom.length }));
      }
    } catch (err) { console.error(err); showToast(t('loc.errFilingModeGeneric')); }
  };

  // Advance the walkthrough one card; end it when past the last card.
  const advanceFiling = () => {
    if (filingIndex < filingQueue.length - 1) {
      setFilingIndex(filingIndex + 1);
    } else {
      showToast(t(filingReadOnly ? 'loc.resortComplete' : 'loc.filingComplete'));
      setFilingMode(false);
      setFilingReadOnly(false);
      onUpdate();
    }
  };

  // Snap the container view to a recommendation's slot and flash it. Shared by
  // the desktop guide card and the mobile filing bar.
  const locateRecommendedSpot = (rec) => {
    if (!rec) return;
    if (rec.location_id && rec.location_id !== activeLocationId) setActiveLocationId(rec.location_id);
    if (isBinderType) {
      const compIdx = compartments.findIndex(c => c.id === rec.compartment_id);
      if (compIdx !== -1) setActivePageIndex(compIdx);
    } else {
      setActiveCompartmentId(rec.compartment_id);
    }
    let attempts = 0;
    const tryScroll = () => {
      const el = document.getElementById('recommended-spot');
      if (el) {
        if (isBinderType) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        el.click(); // Rotates coverflow in Box view
        el.classList.remove('flash-highlight');
        void el.offsetWidth;
        el.classList.add('flash-highlight');
      } else if (attempts < 10) {
        attempts++;
        setTimeout(tryScroll, 100);
      }
    };
    tryScroll();
  };

  const handleFilingPlaced = async (entryId, locationId, compartmentId, position) => {
    // Re-sort review: the DB already reflects this placement, just advance.
    if (filingReadOnly) { advanceFiling(); return; }
    try {
      const res = await fetch(`/api/collection/${entryId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, compartment_id: compartmentId, position })
      });
      if (res.ok) {
        await refreshAll();
        advanceFiling();
      } else {
        showToast(t('loc.errFileCard'));
      }
    } catch (err) { console.error(err); showToast(t('loc.errFileCardGeneric')); }
  };

  const startResort = async (skipConfirm = false) => {
    if (!selectedLoc) return;
    if (!skipConfirm && !window.confirm(t('loc.confirmResort', { name: selectedLoc.name }))) return;
    try {
      const res = await fetch(`/api/locations/${selectedLoc.id}/resort`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        await refreshAll();
        if (!Array.isArray(data) || data.length === 0) { showToast(t('loc.nothingToResort')); return; }
        setFilingQueue(data);
        setFilingIndex(0);
        setFilingReadOnly(true);
        setFilingMode(true);
        setMobilePane('container'); // keep the binder visible on mobile; guide is the pinned bar
        setActiveLocationId(selectedLoc.id);
        showToast(t('loc.resorted'));
      } else {
        showToast(t('loc.errResort'));
      }
    } catch (err) { console.error(err); showToast(t('loc.errResortGeneric')); }
  };

  // Save the Container Settings modal: rename, sort/filter rules, and a
  // one-shot capacity applied to every row/page. Switching to Custom freezes
  // the current order server-side; a structured sort change offers a re-sort.
  const saveContainerSettings = async () => {
    if (!selectedLoc) return;
    const newSort = sortDraft.length > 0 ? JSON.stringify(sortDraft) : 'custom';
    const sortChanged = newSort !== selectedLoc.sort_order;

    const fields = {
      sort_order: newSort,
      rule_type: filterDraft.length > 0 ? 'compound' : 'any',
      rule_config: filterDraft.length > 0 ? JSON.stringify({ rules: filterDraft }) : null,
      allow_stacking: stackingDraft,
    };
    const trimmedName = (nameDraft || '').trim();
    if (trimmedName && trimmedName !== selectedLoc.name) fields.name = trimmedName;

    await handleUpdateLocationFields(fields);

    const capNum = parseInt(capacityDraft, 10);
    if (capNum > 0 && compartments[0] && capNum !== compartments[0].capacity) {
      try {
        await fetch(`/api/compartments/${compartments[0].id}?updateAll=true`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ capacity: capNum })
        });
      } catch (err) { console.error(err); showToast(t('loc.errResizeRows')); }
    }

    const targetCount = parseInt(countDraft, 10);
    if (!isNaN(targetCount) && targetCount > 0 && targetCount !== compartments.length) {
      try {
        if (targetCount > compartments.length) {
          const toAdd = targetCount - compartments.length;
          for (let i = 0; i < toAdd; i++) {
            await fetch(`/api/locations/${selectedLoc.id}/compartments`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({})
            });
          }
        } else if (targetCount < compartments.length) {
          const trailing = compartments.slice(targetCount);
          for (const comp of trailing) {
            await fetch(`/api/locations/${selectedLoc.id}/compartments/${comp.id}`, { method: 'DELETE' });
          }
        }
      } catch (err) {
        console.error(err);
        showToast(t('loc.errPageCount'));
      }
    }

    await Promise.all([fetchCompartments(selectedLoc.id), fetchLocations()]);

    setShowRulesModal(false);

    if (sortChanged && newSort !== 'custom' && (selectedLoc.total_cards || 0) > 0) {
      if (window.confirm(t('loc.confirmResortAfterChange'))) {
        startResort(true);
      }
    }
  };

  if (loading) return <div className="spinner" />;

  return (
    <DndContext
      sensors={dndSensors}
      collisionDetection={pointerWithin}
      // The dragged card travels as drag data: a card pulled OUT of a pocket is
      // not in the queue's list, so looking it up there would leave the overlay
      // empty for exactly the drags that move cards around inside the binder.
      onDragStart={({ active }) => setDraggingCard(active.data?.current?.card || unsortedCards.find(c => c.entry_id === active.id) || null)}
      onDragCancel={() => setDraggingCard(null)}
      onDragEnd={handleDragEnd}
    >
    <div className="storage-workspace-grid">
      {draggingCard && (
        <DragOverlay dropAnimation={null}>
          <img
            src={draggingCard.image_url}
            alt={displayName(draggingCard)}
            style={{ width: '90px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: '4px', boxShadow: '0 8px 20px rgba(0,0,0,0.6)', cursor: 'grabbing' }}
          />
        </DragOverlay>
      )}
      {showCreate && (
        <CreateContainerModal
          onClose={() => setShowCreate(false)}
          onCreate={handleCreateLocation}
          setsList={setsList}
          filterFieldOptions={filterFieldOptions}
        />
      )}

      {rulesComp && (
        <div className="modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setRulesComp(null)}>
          <div className="glass-panel" style={{ width: '480px', maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', background: 'var(--bg-secondary)' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: 0 }}>{rulesComp.display_label}: Accepts</h3>
            <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: 0 }}>
              Rules controlling which cards may be filed into this {isBinderType ? 'page' : 'row'}. No rules = accepts anything the container allows.
            </p>
            <FilterBuilder value={compRuleDraft} onChange={setCompRuleDraft} setsList={setsList} fieldOptions={filterFieldOptions} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button className="btn btn-secondary" onClick={() => setRulesComp(null)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" onClick={saveCompartmentRules}>{t('loc.saveRules')}</button>
            </div>
          </div>
        </div>
      )}

      {capacityUpdatePending && (
        <div className="modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="glass-panel" style={{ width: '400px', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem', background: 'var(--bg-secondary)' }}>
            <h3 style={{ margin: 0 }}>{t('loc.syncCapacity')}</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>
              Do you want to apply the capacity <strong>{capacityUpdatePending.capacity}</strong> to ALL compartments in this container, or just this specific one?
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
              <button className="btn btn-secondary" onClick={() => { handleSetCapacity(capacityUpdatePending.id, capacityUpdatePending.capacity, false); setCapacityUpdatePending(null); }}>{t('loc.justThisOne')}</button>
              <button className="btn btn-primary" onClick={() => { handleSetCapacity(capacityUpdatePending.id, capacityUpdatePending.capacity, true); setCapacityUpdatePending(null); }}>{t('loc.applyToAll')}</button>
            </div>
          </div>
        </div>
      )}

      {showRulesModal && selectedLoc && (
        <div className="modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div className="glass-panel" style={{ width: '400px', maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem', background: 'var(--bg-secondary)' }}>
            <h3 style={{ margin: 0 }}>{t('loc.containerSettings')}</h3>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
              {t('loc.containerName')}
              <input
                className="input-control"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder={selectedLoc.name}
                style={{ padding: '0.35rem 0.5rem', fontSize: '0.9rem' }}
              />
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                {t(isBinderType ? 'loc.numberOfPages' : 'loc.numberOfRows')}
                <input
                  type="number"
                  min="1"
                  max="500"
                  className="input-control"
                  value={countDraft}
                  onChange={(e) => setCountDraft(e.target.value)}
                  style={{ padding: '0.35rem 0.5rem', fontSize: '0.85rem' }}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                Cards per {isBinderType ? 'page' : 'row'}
                <input
                  type="number"
                  min="1"
                  className="input-control"
                  value={capacityDraft}
                  onChange={(e) => setCapacityDraft(e.target.value)}
                  placeholder={t('loc.varies')}
                  style={{ padding: '0.35rem 0.5rem', fontSize: '0.85rem' }}
                />
              </label>
            </div>

            {/* Binders only: a box row shows its cards in a coverflow, where a
                shared slot has nothing to show — the pocket grid is what makes a
                stack visible. */}
            {isBinderType && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  id="allowStackingOpt"
                  checked={stackingDraft}
                  onChange={(e) => setStackingDraft(e.target.checked)}
                  style={{ width: '16px', height: '16px', cursor: 'pointer', marginTop: '0.1rem', flexShrink: 0 }}
                />
                <label htmlFor="allowStackingOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--text-primary)', lineHeight: 1.35 }}>
                  <strong>{t('loc.allowStacking')}</strong>
                  <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                    {t('loc.allowStackingHint')}
                  </span>
                </label>
              </div>
            )}

            <div style={{ background: 'var(--bg-tertiary, rgba(255,255,255,0.04))', borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.55rem', fontSize: '0.72rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              {/* Label only — the count sits in the value beside it, so this is
                  not loc.cardsCurrentlyStored, whose sentence carries a {count}
                  this row has nowhere to put. */}
              <span style={{ color: 'var(--text-muted)' }}>{t(selectedLoc.allow_stacking ? 'loc.slotsUsedLabel' : 'loc.cardsStoredLabel')}</span>
              <strong style={{ fontSize: '0.9rem', color: 'var(--text-strong)' }}>{selectedLoc.total_cards || 0} / {selectedLoc.total_capacity || 0}</strong>
            </div>

            <div style={{ background: 'rgba(255, 170, 0, 0.1)', border: '1px solid #d97706', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-sm)', fontSize: '0.72rem', color: 'var(--text-primary)', lineHeight: 1.4 }}>
              <strong>{t('loc.reorganizeWarningTitle')}</strong>
              <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem' }}>
                <li>{t('loc.ruleNoteResort', { containerType: isBinderType ? t('loc.binderLower') : t('loc.boxLower') })}</li>
                <li>{t('loc.ruleNoteFilter')}</li>
                <li>{t('loc.ruleNoteCustom')}</li>
                <li>{t('loc.ruleNoteShrink', { unitType: isBinderType ? t('loc.pageLower') : t('loc.rowLower') })}</li>
              </ul>
            </div>

            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
              {t('loc.sortHint')}
            </span>
            <SortBuilder value={sortDraft} onChange={setSortDraft} />
            <FilterBuilder value={filterDraft} onChange={setFilterDraft} setsList={setsList} fieldOptions={filterFieldOptions} />

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
              <button className="btn btn-secondary" onClick={() => setShowRulesModal(false)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" onClick={saveContainerSettings}>{t('admin.saveSettings')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Tabs stay visible during filing so there's always a way back — otherwise
          starting Sort & File hides them and dismissing the filing popup leaves no
          navigation. Switching to Unsorted cancels filing (its column is hidden
          while filing, so it must exit to be shown). */}
      {isStacked && (
        <div className="sub-nav-tabs storage-pane-tabs" style={{ gridColumn: '1 / -1', marginBottom: 0, position: 'sticky', top: 0, zIndex: 50 }}>
          <button type="button" className={`sub-nav-tab ${mobilePane === 'container' ? 'active' : ''}`} onClick={() => setMobilePane('container')}>{t('loc.paneContainer')}</button>
          <button type="button" className={`sub-nav-tab ${mobilePane === 'unsorted' ? 'active' : ''}`} onClick={() => { if (filingMode) { setFilingMode(false); setFilingReadOnly(false); refreshAll(); } setMobilePane('unsorted'); }}>
            Unsorted <span className={`tab-count-badge ${unsortedCards.length > 0 ? 'has-unsorted' : ''}`}>{unsortedCards.length}</span>
          </button>
        </div>
      )}

      {/* Selected location detail. During mobile filing the binder stays visible
          (the recommended slot blinks in it); the compact filing bar is pinned
          at the bottom of the screen. */}
      <div className="glass-panel" style={{ padding: '0.9rem', display: (isStacked && !filingMode && mobilePane !== 'container') ? 'none' : 'flex', flexDirection: 'column', gap: '0.75rem', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <select
              className="select-control"
              value={activeLocationId || ''}
              onChange={(e) => setActiveLocationId(parseInt(e.target.value, 10))}
              style={{ fontSize: '1rem', fontWeight: 'bold', padding: '0.3rem', width: 'auto', minWidth: '150px' }}
            >
              <option value="" disabled>{t('loc.selectContainer')}</option>
              {locations.map(loc => <option key={loc.id} value={loc.id}>{loc.locked ? '🔒 ' : ''}{loc.name} ({loc.type})</option>)}
            </select>
            <button type="button" className="btn btn-secondary btn-icon-only" onClick={() => setShowCreate(s => !s)} style={{ width: '28px', height: '28px', padding: 0 }} title={t('loc.createContainer')}>
              <Plus size={14} />
            </button>
            {selectedLoc && !!selectedLoc.locked && (
              <button type="button" onClick={handleToggleContainerLock} title={t('loc.lockedBadgeHint')} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.62rem', fontWeight: 800, padding: '0.15rem 0.45rem', borderRadius: '999px', cursor: 'pointer', background: 'rgba(255,193,7,0.15)', border: '1px solid var(--accent-yellow)', color: 'var(--accent-yellow)' }}>
                <Lock size={11} /> Locked
              </button>
            )}
          </div>
          
          {selectedLoc && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            {!filingMode && !moveMode && (selectedLoc.total_cards || 0) > 0 && (
              <button
                type="button"
                className={`btn ${storage.selectMode ? 'btn-primary' : 'btn-secondary'}`}
                disabled={!!selectedLoc.locked}
                onClick={() => (storage.selectMode ? storage.exitSelectMode() : storage.setSelectMode(true))}
                style={{ fontSize: '0.7rem', padding: '0.3rem 0.6rem' }}
                title={t(selectedLoc.locked ? 'loc.lockedSelectHint' : 'loc.selectHint')}
              >
                {t(storage.selectMode ? 'bulk.done' : 'collection.select')}
              </button>
            )}
            {!filingMode && !storage.selectMode && isCustom && (
              <button
                type="button"
                className={`btn ${moveMode ? 'btn-primary' : 'btn-secondary'}`}
                disabled={!!selectedLoc.locked}
                onClick={() => { setMoveMode(m => !m); setPickedEntryId(null); }}
                style={{ fontSize: '0.7rem', padding: '0.3rem 0.6rem' }}
                title={t(selectedLoc.locked ? 'loc.lockedArrangeHint' : 'loc.arrangeHint')}
              >
                {t(moveMode ? 'loc.doneArranging' : 'loc.arrange')}
              </button>
            )}
            <div className="kebab-menu">
              <button className="kebab-menu-button" onClick={() => setShowKebabMenu(s => !s)}>
                <MoreVertical size={16} color="var(--text-secondary)" />
              </button>
              {showKebabMenu && (
                <div className="kebab-dropdown">
                  <button className="kebab-item" disabled={!!selectedLoc.locked} onClick={() => { setShowKebabMenu(false); handleAddCompartment(); }}>
                    <Plus size={14} /> {t(isBinderType ? 'loc.addPage' : 'loc.addCompartment')}
                  </button>
                  <button className="kebab-item" 
                          disabled={!!selectedLoc.locked || compartments.length <= 1 || (cardsByCompartment.get(compartments[compartments.length-1]?.id) || []).length > 0} 
                          onClick={() => { setShowKebabMenu(false); handleRemoveCompartment(compartments[compartments.length-1].id); }}
                          title={t(selectedLoc.locked ? 'loc.containerLockedShort' : 'loc.removeLastHint')}
                  >
                    <Trash2 size={14} /> {t(isBinderType ? 'loc.removeLastPage' : 'loc.removeLastCompartment')}
                  </button>
                  <button className="kebab-item" onClick={() => { setShowKebabMenu(false); startResort(); }} disabled={!!selectedLoc.locked || (selectedLoc.total_cards || 0) === 0}>
                    <RefreshCw size={14} /> Re-sort Container
                  </button>
                  <button className="kebab-item" onClick={() => { setShowKebabMenu(false); handleToggleContainerLock(); }} title={t('loc.lockKebabHint')}>
                    <Lock size={14} /> {t(selectedLoc.locked ? 'loc.unlockContainer' : 'loc.lockContainer')}
                  </button>
                  <button className="kebab-item" disabled={!!selectedLoc.locked} onClick={() => {
                    setShowKebabMenu(false);
                    let sDraft = [];
                    if (selectedLoc.sort_order && selectedLoc.sort_order.startsWith('[')) {
                      try { sDraft = JSON.parse(selectedLoc.sort_order); } catch { /* ignore */ }
                    } else if (selectedLoc.sort_order && selectedLoc.sort_order !== 'custom') {
                      if (selectedLoc.sort_order === 'name-asc') sDraft = [{id: '1', by:'name', dir:'asc'}];
                      else if (selectedLoc.sort_order === 'price-desc') sDraft = [{id: '1', by:'price', dir:'desc'}];
                      else if (selectedLoc.sort_order === 'set-number') sDraft = [{id: '1', by:'set', dir:'asc'}];
                      else if (selectedLoc.sort_order === 'set-number-printing') sDraft = [{id: '1', by:'set', dir:'asc'}, {id: '2', by:'printing', dir:'asc'}];
                      else if (selectedLoc.sort_order === 'type-name') sDraft = [{id: '1', by:'type', dir:'asc'}, {id: '2', by:'name', dir:'asc'}];
                      else if (selectedLoc.sort_order === 'language') sDraft = [{id: '1', by:'language', dir:'asc'}];
                    }
                    setSortDraft(sDraft);

                    let fDraft = [];
                    if (selectedLoc.rule_type === 'compound') {
                      try {
                        const cfg = typeof selectedLoc.rule_config === 'string' ? JSON.parse(selectedLoc.rule_config) : selectedLoc.rule_config;
                        fDraft = cfg?.rules || [];
                      } catch { /* ignore */ }
                    } else if (selectedLoc.rule_type === 'alphabetical_range') {
                      let cfg = {};
                      try { cfg = typeof selectedLoc.rule_config === 'string' ? JSON.parse(selectedLoc.rule_config) : selectedLoc.rule_config; } catch { /* ignore */ }
                      if (cfg?.start) fDraft.push({ id: '1', action: 'include', field: 'name', operator: '>=', value: cfg.start });
                      if (cfg?.end) fDraft.push({ id: '2', action: 'include', field: 'name', operator: '<=', value: cfg.end });
                    }
                    setFilterDraft(fDraft);

                    setNameDraft(selectedLoc.name || '');
                    setStackingDraft(!!selectedLoc.allow_stacking);
                    setCountDraft(String(compartments.length));
                    const caps = compartments.map(c => c.capacity);
                    const uniform = caps.length > 0 && caps.every(c => c === caps[0]);
                    setCapacityDraft(uniform ? String(caps[0]) : '');

                    setShowRulesModal(true);
                  }}>
                    <Settings size={14} /> Container Settings
                  </button>
                  <button className="kebab-item" disabled={!!selectedLoc.locked} onClick={() => { setShowKebabMenu(false); handleDeleteLocation(selectedLoc.id, selectedLoc.name); }} style={{ color: 'var(--accent-red)' }}>
                    <Trash2 size={14} /> Delete Container
                  </button>
                </div>
              )}
            </div>
            </div>
          )}
        </div>

        {storage.selectMode && (
          <div className="glass-panel" style={{ padding: '0.6rem 0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', background: 'rgba(255,71,71,0.08)' }}>
            <span style={{ fontWeight: 800, color: 'var(--text-strong)', fontSize: '0.8rem' }}>{storage.selectedIds.size} selected</span>
            <button className="btn btn-secondary" style={{ fontSize: '0.68rem', padding: '0.25rem 0.5rem' }} onClick={() => storage.setSelectedIds(new Set(cardsInActiveLocation.map(c => c.entry_id)))}>Select all ({cardsInActiveLocation.length})</button>
            <button className="btn btn-secondary" style={{ fontSize: '0.68rem', padding: '0.25rem 0.5rem' }} onClick={() => storage.setSelectedIds(new Set())}>{t('bulk.clear')}</button>
            <div style={{ width: '1px', height: '20px', background: 'var(--border-glass)' }} />
            <button
              className="btn btn-primary"
              style={{ fontSize: '0.68rem', padding: '0.25rem 0.6rem' }}
              disabled={!storage.selectedIds.size}
              onClick={() => storage.runBulk('move', null, t('loc.confirmRemoveFromStorage', { count: storage.selectedIds.size }))}
            >
              {t('loc.removeFromStorage')}
            </button>
            <button
              className="btn btn-danger"
              style={{ fontSize: '0.68rem', padding: '0.25rem 0.6rem' }}
              disabled={!storage.selectedIds.size}
              onClick={() => storage.runBulk('delete', null, t('loc.confirmDeleteFromCollection', { count: storage.selectedIds.size }))}
            >
              {t('common.delete')}
            </button>
            <button className="btn btn-secondary" style={{ fontSize: '0.68rem', padding: '0.25rem 0.5rem', marginLeft: 'auto' }} onClick={storage.exitSelectMode}>{t('bulk.done')}</button>
          </div>
        )}

        {!selectedLoc ? (
          <p style={{ color: 'var(--text-secondary)' }}>{t('loc.selectPrompt')}</p>
        ) : (
          <>
            {!!selectedLoc.locked && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', background: 'rgba(255,193,7,0.12)', border: '1px solid var(--accent-yellow)', padding: '0.55rem 0.75rem', borderRadius: 'var(--radius-sm)', fontSize: '0.72rem', color: 'var(--text-primary)', lineHeight: 1.4 }}>
                <Lock size={16} color="var(--accent-yellow)" style={{ flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{t('loc.lockedBanner')}</span>
                <button type="button" className="btn btn-secondary" onClick={handleToggleContainerLock} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.68rem', padding: '0.25rem 0.6rem', flexShrink: 0, borderColor: 'var(--accent-yellow)', color: 'var(--accent-yellow)' }}>
                  <Lock size={13} /> Unlock
                </button>
              </div>
            )}

            {isBinderType && !isCustom && !binderTipDismissed && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem', background: 'rgba(255, 170, 0, 0.1)', border: '1px solid #d97706', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-sm)', fontSize: '0.72rem', color: 'var(--text-primary)', lineHeight: 1.4 }}>
                <span style={{ flex: 1 }}>
                  {t('loc.binderTip')}
                </span>
                <button type="button" onClick={dismissBinderTip} title={t('loc.dismiss')} aria-label={t('loc.dismiss')} style={{ flexShrink: 0, background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.1rem', lineHeight: 0 }}>
                  <X size={15} />
                </button>
              </div>
            )}

            {moveMode && (
              <div style={{ background: 'rgba(255,71,71,0.1)', border: '1px solid var(--accent-red)', padding: '0.5rem 0.7rem', borderRadius: 'var(--radius-sm)', fontSize: '0.72rem', color: 'var(--text-primary)' }}>
                {pickedEntryId
                  ? t(isBinderType ? 'loc.arrangeStepPocket' : 'loc.arrangeStepSlot')
                  : 'Tap a card here or in Unsorted to pick it up.'}
              </div>
            )}

            {isBinderType && compartments.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '1rem', margin: '0.2rem 0', background: 'rgba(0,0,0,0.1)', padding: '0.4rem', borderRadius: 'var(--radius-sm)' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={activePageIndex <= 0}
                  onClick={() => setActivePageIndex(prev => {
                    if (isMobile) return Math.max(0, prev - 1);
                    const { spread } = binderSpread(prev);
                    return spread <= 1 ? 0 : (spread - 1) * 2 - 1;
                  })}
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                >
                  {t('loc.prev')}
                </button>
                <select
                  className="select-control"
                  value={activePageIndex}
                  onChange={(e) => {
                    if (e.target.value === '__add_new__') {
                      handleAddCompartment();
                    } else {
                      setActivePageIndex(parseInt(e.target.value, 10));
                    }
                  }}
                  style={{ fontSize: '0.75rem', padding: '0.15rem 0.35rem', fontWeight: 600 }}
                >
                  {compartments.map((c, idx) => (
                    <option key={c.id} value={idx}>
                      {c.display_label || t('loc.pageName', { number: idx + 1 })} ({idx + 1}/{compartments.length})
                    </option>
                  ))}
                  <option value="__add_new__" disabled={!!selectedLoc.locked}>+ {t('loc.addPage')}</option>
                </select>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={isMobile
                    ? activePageIndex >= compartments.length - 1
                    : binderSpread(activePageIndex).spread * 2 + 1 >= compartments.length}
                  onClick={() => setActivePageIndex(prev => {
                    // Next spread's left page — the opening spread has none, so
                    // stepping off page 1 lands on page 2.
                    const next = isMobile ? prev + 1 : binderSpread(prev).spread * 2 + 1;
                    return next < compartments.length ? next : prev;
                  })}
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                >
                  {t('loc.next')}
                </button>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: isBinderType ? '1rem' : '0.6rem' }}>
              {isBinderType ? (() => {
                if (compartments.length === 0) return null;
                const pageProps = (c, i) => ({
                  compartment: c,
                  cards: cardsByCompartment.get(c.id) || [],
                  allowStacking: !!selectedLoc.allow_stacking,
                  sortOrder: selectedLoc.sort_order,
                  setsList,
                  canRemove: i === compartments.length - 1 && compartments.length > 1 && (cardsByCompartment.get(c.id) || []).length === 0,
                  moveTargets: compartments,
                  onRename: (label) => handleRenameCompartment(c.id, label),
                  onSetCapacity: (cap) => handleSetCapacity(c.id, cap),
                  onRemove: () => handleRemoveCompartment(c.id),
                  onToggleLock: () => handleToggleCompartmentLock(c.id, !c.locked),
                  containerLocked: !!selectedLoc.locked,
                  onCardClick: setInspectorCard,
                  onDeleteCard: handleDeleteCard,
                  onMoveCard: handleMoveCard,
                  recommendedSpot: currentRecSpot && currentRecSpot.compartment_id === c.id ? {
                    index: Math.floor(currentRecSpot.position / 1000) - 1,
                    image_url: recCard?.image_url,
                    name: recCard ? displayName(recCard) : undefined,
                    set_name: recCard?.set_name,
                    card: recCard
                  } : null,
                  focusEntryId,
                  selectMode: storage.selectMode,
                  selectedIds: storage.selectedIds,
                  onCardLongPress: storage.arm,
                  onCardToggle: storage.toggleSelect,
                  onEditRules: openCompartmentRules,
                  placementMode: moveMode,
                  pickedEntryId,
                  onPickCard: handlePickCard,
                  onPlaceSlot: handlePlaceSlot,
                  dropEnabled: dndEnabled,
                  activeEntryId: binderActiveEntryId,
                  onActiveEntryIdChange: setBinderActiveEntryId,
                  hideFocusedCardInfo: true
                });

                let binderPages = null;
                if (isMobile) {
                  const targetIdx = Math.min(activePageIndex, compartments.length - 1);
                  const activePage = compartments[targetIdx];
                  if (!activePage) return null;
                  binderPages = (
                    <div
                      className="binder-page-container"
                      onTouchStart={handleTouchStart}
                      onTouchEnd={handleTouchEnd}
                      style={{ touchAction: 'pan-y' }}
                    >
                      <div className="binder-page-left" style={{ width: '100%' }}>
                        <CompartmentView {...pageProps(activePage, targetIdx)} locationType={selectedLoc.type} />
                      </div>
                    </div>
                  );
                } else {
                  const { leftIdx, rightIdx } = binderSpread(Math.min(activePageIndex, compartments.length - 1));
                  const left = leftIdx >= 0 ? compartments[leftIdx] : null;
                  const right = compartments[rightIdx];

                  // The missing half of an opening or closing spread still holds
                  // its side of the binder, so the page that is there stays on
                  // its own side of the spine instead of sliding across it.
                  binderPages = (
                    <div className="binder-page-container">
                      <div className="binder-page-left">
                        {left && <CompartmentView {...pageProps(left, leftIdx)} locationType={selectedLoc.type} />}
                      </div>
                      <div className="binder-spine" />
                      <div className="binder-page-right">
                        {right && <CompartmentView {...pageProps(right, rightIdx)} locationType={selectedLoc.type} />}
                      </div>
                    </div>
                  );
                }

                return (
                  <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                    {binderPages}
                    {(() => {
                      if (!binderActiveEntryId) return null;
                      const activeCard = cardsInActiveLocation.find(c => c.entry_id === binderActiveEntryId);
                      if (!activeCard) return null;
                      const compCards = cardsByCompartment.get(activeCard.compartment_id) || [];
                      const slotNumber = compCards.findIndex(c => c.entry_id === binderActiveEntryId) + 1;
                      
                      const moveSelect = selectedLoc.sort_order === 'custom' && compartments.length > 1 ? (
                        <select
                          className="select-control"
                          value=""
                          onChange={(e) => { if (e.target.value) handleMoveCard(activeCard.entry_id, parseInt(e.target.value, 10)); }}
                          style={{ fontSize: '0.65rem', padding: '0.15rem 0.3rem', width: '110px', flexShrink: 0 }}
                        >
                          <option value="">{t('compartment.moveTo')}</option>
                          {compartments.filter(t => t.id !== activeCard.compartment_id).map(t => (
                            <option key={t.id} value={t.id}>{t.display_label}</option>
                          ))}
                        </select>
                      ) : null;
                      
                      return <FocusedCardInfo card={activeCard} slotNumber={slotNumber} moveSelect={moveSelect} />;
                    })()}
                  </div>
                );
              })() : (() => {
                if (compartments.length === 0) return <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('loc.noCompartments')}</p>;

                const activeComp = compartments.find(c => c.id === activeCompartmentId) || compartments[0];
                if (!activeComp) return null;
                const activeCompIdx = compartments.findIndex(c => c.id === activeComp.id);
                const activeCompRuleCount = Array.isArray(activeComp.assignedFilters) ? activeComp.assignedFilters.length : (activeComp.rule_config ? 1 : 0);
                const activeAcceptsLabel = activeCompRuleCount > 0 ? `Rules (${activeCompRuleCount})` : 'Accepts All';

                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <div key={activeComp.id} className="row-flash" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', background: 'rgba(0,0,0,0.1)', padding: '0.4rem 0.6rem', borderRadius: 'var(--radius-sm)', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <button className="btn btn-secondary btn-icon-only" disabled={activeCompIdx <= 0} onClick={() => setActiveCompartmentId(compartments[activeCompIdx - 1]?.id)} style={{ width: '24px', height: '24px', padding: 0 }}>
                          &larr;
                        </button>
                        <select
                          className="select-control"
                          value={activeComp.id}
                          onChange={(e) => {
                            if (e.target.value === '__add_new__') {
                              handleAddCompartment();
                            } else {
                              setActiveCompartmentId(parseInt(e.target.value, 10));
                            }
                          }}
                          style={{ fontSize: '0.8rem', padding: '0.2rem 0.4rem' }}
                        >
                          {compartments.map(c => <option key={c.id} value={c.id}>{c.display_label}</option>)}
                          <option value="__add_new__" disabled={!!selectedLoc.locked}>+ {t('loc.addRow')}</option>
                        </select>
                        <button className="btn btn-secondary btn-icon-only" disabled={activeCompIdx >= compartments.length - 1} onClick={() => setActiveCompartmentId(compartments[activeCompIdx + 1]?.id)} style={{ width: '24px', height: '24px', padding: 0 }}>
                          &rarr;
                        </button>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => {
                            const newLabel = window.prompt(t('loc.promptRename', { name: activeComp.display_label }), activeComp.label || '');
                            if (newLabel !== null) handleRenameCompartment(activeComp.id, newLabel);
                          }}
                          title={t('loc.renameRow')}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', fontSize: '0.6rem', padding: '0.2rem 0.5rem' }}
                        >
                          <Edit3 size={11} /> {t('common.rename')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => openCompartmentRules(activeComp)}
                          title={t('compartment.acceptsHintRow')}
                          style={{ fontSize: '0.6rem', padding: '0.2rem 0.5rem', ...(activeCompRuleCount > 0 ? { borderColor: 'var(--accent-red)', color: 'var(--text-strong)' } : {}) }}
                        >
                          {activeAcceptsLabel}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => handleToggleCompartmentLock(activeComp.id, !activeComp.locked)}
                          disabled={!!selectedLoc.locked}
                          title={t(selectedLoc.locked ? 'compartment.lockContainerRow' : activeComp.locked ? 'compartment.lockedHintRow' : 'compartment.lockHintRow')}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', fontSize: '0.6rem', padding: '0.2rem 0.5rem', opacity: selectedLoc.locked ? 0.5 : 1, ...((activeComp.locked || selectedLoc.locked) ? { borderColor: 'var(--accent-yellow)', color: 'var(--accent-yellow)' } : {}) }}
                        >
                          <Lock size={12} /> {t(activeComp.locked ? 'compartment.locked' : 'compartment.lock')}
                        </button>
                      </div>
                    </div>
                    
                    <CompartmentView 
                      hideHeader={true}
                      compartment={activeComp}
                      cards={cardsByCompartment.get(activeComp.id) || []}
                      locationType={selectedLoc.type}
                      sortOrder={selectedLoc.sort_order}
                      setsList={setsList}
                      moveTargets={compartments}
                      onRename={(label) => handleRenameCompartment(activeComp.id, label)}
                      onSetCapacity={(cap) => handleSetCapacity(activeComp.id, cap)}
                      onRemove={() => handleRemoveCompartment(activeComp.id)}
                      onToggleLock={() => handleToggleCompartmentLock(activeComp.id, !activeComp.locked)}
                      containerLocked={!!selectedLoc.locked}
                      onCardClick={setInspectorCard}
                      onDeleteCard={handleDeleteCard}
                      onMoveCard={handleMoveCard}
                      recommendedSpot={currentRecSpot && currentRecSpot.compartment_id === activeComp.id ? {
                        index: Math.floor(currentRecSpot.position / 1000) - 1,
                        image_url: recCard?.image_url,
                        name: recCard ? displayName(recCard) : undefined,
                        set_name: recCard?.set_name,
                        card: recCard
                      } : null}
                      focusEntryId={focusEntryId}
                      targetActiveIndex={currentRecSpot && currentRecSpot.compartment_id === activeComp.id ? Math.floor(currentRecSpot.position / 1000) - 1 : null}
                      canRemove={compartments.length > 1 && (cardsByCompartment.get(activeComp.id) || []).length === 0}
                      selectMode={storage.selectMode}
                      selectedIds={storage.selectedIds}
                      onCardLongPress={storage.arm}
                      onCardToggle={storage.toggleSelect}
                      onEditRules={openCompartmentRules}
                      placementMode={moveMode}
                      pickedEntryId={pickedEntryId}
                      onPickCard={handlePickCard}
                      onPlaceSlot={handlePlaceSlot}
                    />
                  </div>
                );
              })()}
            </div>
          </>
        )}
      </div>

      {/* Unsorted queue */}
      <div className="glass-panel location-unsorted-col" style={{ padding: '0.75rem', display: (isStacked && (filingMode || mobilePane !== 'unsorted')) ? 'none' : 'flex', flexDirection: 'column', gap: '0.5rem', overflowY: 'auto', maxHeight: (isStacked && !filingMode && mobilePane === 'unsorted') ? 'none' : undefined }}>
        {filingMode ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', height: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: '0.85rem' }}>{t(filingReadOnly ? 'loc.refileGuide' : 'loc.filingMode')}</strong>
              <button type="button" className="btn btn-secondary btn-icon-only" onClick={() => { setFilingMode(false); setFilingReadOnly(false); refreshAll(); }} style={{ padding: '0.2rem 0.5rem', width: 'auto', fontSize: '0.7rem' }}>
                {t(filingReadOnly ? 'bulk.done' : 'common.cancel')}
              </button>
            </div>
            {filingReadOnly && (
              <div style={{ textAlign: 'center', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
                {t('loc.resortGuideHint')}
              </div>
            )}
            
            <div style={{ textAlign: 'center', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {t('loc.filingCardProgress', { current: filingIndex + 1, total: filingQueue.length })}
            </div>
            
            {filingQueue[filingIndex] && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.6rem' }}>
                <CardImage card={filingQueue[filingIndex].entry} style={{ width: 'min(120px, 26vh)', borderRadius: '5px', boxShadow: '0 4px 12px rgba(0,0,0,0.4)' }} />
                
                <div style={{ textAlign: 'center' }}>
                  <strong style={{ fontSize: '1rem', display: 'block' }}>{displayName(filingQueue[filingIndex].entry)}</strong>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{filingQueue[filingIndex].entry.set_name} • {filingQueue[filingIndex].entry.printing}</span>
                </div>
                
                {(() => {
                  const rec = filingQueue[filingIndex].recommended;
                  if (!rec) {
                    return (
                      <div style={{ background: 'rgba(255, 71, 71, 0.15)', border: '1px solid #ff4747', borderRadius: 'var(--radius-sm)', padding: '0.75rem', width: '100%', textAlign: 'center' }}>
                        <strong style={{ fontSize: '0.9rem', color: 'var(--text-strong)' }}>
                          {filingQueue[filingIndex].rejected ? t('loc.rejectedRule') : t('loc.containerFull')}
                        </strong>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                          {t(filingQueue[filingIndex].rejected ? 'loc.skipRejected' : 'loc.skipNoRoom')}
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div 
                      style={{ background: 'rgba(255, 193, 7, 0.15)', border: '1px solid #ffc107', borderRadius: 'var(--radius-sm)', padding: '0.75rem', width: '100%', textAlign: 'center', cursor: 'pointer', transition: 'all 0.2s' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 193, 7, 0.25)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 193, 7, 0.15)'; }}
                      onClick={() => locateRecommendedSpot(rec)}
                      title={t('loc.snapToSlot')}
                    >
                      <div style={{ fontSize: '0.7rem', color: '#ffc107', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 'bold', marginBottom: '0.25rem' }}>{t('loc.clickToLocate')}</div>
                      <strong style={{ fontSize: '0.9rem', color: 'var(--text-strong)', display: 'block' }}>{rec.label}</strong>
                      <strong style={{ fontSize: '1.2rem', color: '#ffc107', display: 'block', marginTop: '0.25rem' }}>{t('loc.slotNumber', { n: Math.floor(rec.position / 1000) })}</strong>
                      {rec.after ? (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', marginTop: '0.4rem' }}>
                          <CardImage card={rec.after} style={{ width: '26px', borderRadius: '3px' }} />
                          <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{t('loc.fileAfter')} <strong style={{ color: 'var(--text-strong)' }}>{displayName(rec.after)}</strong></span>
                        </div>
                      ) : rec.before ? (
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>{t('loc.fileBefore')} <strong style={{ color: 'var(--text-strong)' }}>{displayName(rec.before)}</strong></div>
                      ) : (
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>{t('loc.firstInSection')}</div>
                      )}
                    </div>
                  );
                })()}
                
                <div style={{ display: 'flex', gap: '0.5rem', width: '100%', marginTop: '0.5rem' }}>
                  <button type="button" className="btn btn-secondary" onClick={advanceFiling} style={{ flex: 1, padding: '0.6rem' }}>
                    {t('loc.skip')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!filingQueue[filingIndex].recommended}
                    onClick={() => {
                      const rec = filingQueue[filingIndex].recommended;
                      handleFilingPlaced(filingQueue[filingIndex].entry.entry_id, rec.location_id, rec.compartment_id, rec.position);
                    }}
                    style={{ flex: 2, padding: '0.6rem', fontSize: '0.9rem', fontWeight: 'bold' }}
                  >
                    {filingReadOnly ? t('loc.next') : t('loc.placed')}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: '0.85rem' }}>{t('loc.unsortedCount', { count: unsortedCards.length })}</strong>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <button
                  type="button"
                  className={`btn ${unsortedSelectMode ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => (unsortedSelectMode ? exitUnsortedSelectMode() : setUnsortedSelectMode(true))}
                  style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem', height: '24px' }}
                  title={t('loc.toggleMultiSelect')}
                >
                  <MousePointerClick size={12} />
                  {t(unsortedSelectMode ? 'bulk.done' : 'collection.select')}
                </button>
                <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                  <button
                    type="button"
                    className={`btn btn-icon-only ${unsortedViewMode === 'grid' ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setUnsortedViewMode('grid')}
                    style={{ borderRadius: 'var(--radius-sm)', padding: '0.25rem 0.35rem', width: '28px', height: '24px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                    title={t('loc.gridView')}
                  >
                    <LayoutGrid size={13} />
                  </button>
                  <button
                    type="button"
                    className={`btn btn-icon-only ${unsortedViewMode === 'detail' ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setUnsortedViewMode('detail')}
                    style={{ borderRadius: 'var(--radius-sm)', padding: '0.25rem 0.35rem', width: '28px', height: '24px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                    title={t('loc.detailView')}
                  >
                    <List size={13} />
                  </button>
                </div>
              </div>
            </div>

            {unsortedSelectMode && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', background: 'rgba(0,0,0,0.25)', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', marginTop: '0.25rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-strong)' }}>{t('bulk.selectedCount', { count: unsortedSelectedIds.size })}</span>
                  <div style={{ display: 'flex', gap: '0.3rem' }}>
                    <button type="button" className="btn btn-secondary" style={{ fontSize: '0.65rem', padding: '0.15rem 0.4rem' }} onClick={() => setUnsortedSelectedIds(new Set(unsortedCards.map(c => c.entry_id)))}>{t('loc.selectAll')}</button>
                    <button type="button" className="btn btn-secondary" style={{ fontSize: '0.65rem', padding: '0.15rem 0.4rem' }} onClick={clearUnsortedSelection}>{t('bulk.clear')}</button>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '0.3rem' }}>
                  <select
                    className="select-control"
                    value={unsortedBulkLocation}
                    onChange={(e) => setUnsortedBulkLocation(e.target.value)}
                    style={{ fontSize: '0.7rem', padding: '0.25rem 0.4rem', flex: 1, minWidth: 0 }}
                  >
                    <option value="">{t('loc.fileSelectedTo')}</option>
                    {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!unsortedBulkLocation || !unsortedSelectedIds.size}
                    onClick={() => {
                      if (!unsortedBulkLocation) return;
                      const locObj = locations.find(l => String(l.id) === String(unsortedBulkLocation));
                      runUnsortedBulk('move', unsortedBulkLocation, t('loc.confirmBulkFile', { count: unsortedSelectedIds.size, name: locObj?.name || t('loc.containerLower') }));
                      setUnsortedBulkLocation('');
                    }}
                    style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem', fontWeight: 'bold' }}
                  >
                    {t('loc.file')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={!unsortedSelectedIds.size}
                    onClick={() => runUnsortedBulk('delete', null, t('bulk.confirmDelete', { count: unsortedSelectedIds.size }))}
                    style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
                  >
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
              <input
                className="input-control" placeholder={t('loc.searchPlaceholder')} value={unsortedSearch}
                onChange={(e) => setUnsortedSearch(e.target.value)} style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem' }}
              />
              <select className="select-control" value={unsortedSort} onChange={(e) => setUnsortedSort(e.target.value)} style={{ fontSize: '0.7rem', padding: '0.3rem 0.5rem' }}>
                <option value="scanned-desc">{t('collection.sort.scanned-desc')}</option>
                <option value="scanned-asc">{t('collection.sort.scanned-asc')}</option>
                <option value="name-asc">{t('loc.sortAZ')}</option>
                <option value="price-desc">{t('collection.sort.price-desc')}</option>
                <option value="set-number">{t('loc.sortSetNumber')}</option>
              </select>
            </div>

            {unsortedCards.length > 0 && !unsortedSelectMode && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={startFilingMode}
                  disabled={!activeLocationId}
                  title={t(activeLocationId ? 'loc.fileWalkHint' : 'loc.selectContainerFirst')}
                  style={{ fontSize: '0.8rem', padding: '0.45rem', width: '100%' }}
                >
                  {t('loc.sortAndFile')}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleApplyAll}
                  disabled={!activeLocationId}
                  title={t(activeLocationId ? 'loc.autoFileHint' : 'loc.selectContainerFirst')}
                  style={{ fontSize: '0.7rem', padding: '0.35rem', width: '100%' }}
                >
                  {t('loc.autoFileAll')}
                </button>
              </div>
            )}

            {/* Drop a filed card here to take it back out of the container. */}
            <UnsortedDropZone enabled={dndEnabled}>
            {unsortedViewMode === 'grid' ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '0.6rem', marginTop: '0.25rem' }}>
                {unsortedCards.map(card => {
                  const picked = moveMode && pickedEntryId === card.entry_id;
                  const isSelected = unsortedSelectMode && unsortedSelectedIds.has(card.entry_id);
                  const isHighlighted = picked || isSelected;
                  const rarityBorder = getCardRarityBorder(card.rarity);
                  const foilClass = getFoilOverlayClass(card.printing);
                  const printingBadgeLabel = getPrintingBadgeLabel(card.printing);

                  return (
                    <DraggableCard
                      enabled={dndEnabled}
                      entryId={card.entry_id}
                      card={card}
                      key={card.entry_id}
                      id={`card-${card.entry_id}`}
                      className={card.entry_id === focusEntryId ? 'focus-flash' : ''}
                      {...unsortedPressHandlers(card.entry_id)}
                      onClick={() => activateUnsortedCard(card)}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        background: isHighlighted ? 'rgba(255, 71, 71, 0.12)' : 'rgba(255, 255, 255, 0.03)',
                        border: isHighlighted ? '2px solid var(--accent-red)' : '1px solid var(--border-glass)',
                        borderRadius: 'var(--radius-sm)',
                        padding: '0.35rem',
                        position: 'relative',
                        cursor: 'pointer',
                        userSelect: 'none',
                        transition: 'all 0.15s ease-in-out'
                      }}
                    >
                      {/* Card Thumbnail Box */}
                      <div
                        style={{
                          position: 'relative',
                          width: '100%',
                          aspectRatio: 0.718,
                          borderRadius: 'var(--radius-sm)',
                          overflow: 'hidden',
                          ...rarityBorder
                        }}
                      >
                        <CardImage card={card} loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                        {foilClass && <div className={foilClass} style={{ borderRadius: 'var(--radius-sm)' }} />}
                        
                        {/* Selected / Picked checkmark badge */}
                        {isHighlighted && (
                          <div style={{ position: 'absolute', top: '4px', right: '4px', zIndex: 20, width: '20px', height: '20px', borderRadius: '50%', background: 'var(--accent-red)', border: '2px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-strong)', fontSize: '0.75rem', fontWeight: 900 }}>
                            ✓
                          </div>
                        )}

                        {/* Rarity badge */}
                        <span style={{
                          position: 'absolute',
                          top: '4px',
                          left: '4px',
                          fontSize: '0.5rem',
                          fontWeight: 900,
                          padding: '1px 3px',
                          borderRadius: '2px',
                          zIndex: 10,
                          textTransform: 'uppercase',
                          boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
                          ...getRarityBadgeStyle(card.rarity)
                        }}>
                          {getRarityBadgeLabel(card.rarity)}
                        </span>

                        {/* Printing badge overlay */}
                        {printingBadgeLabel && (
                          <span style={{
                            position: 'absolute',
                            bottom: '4px',
                            right: '4px',
                            fontSize: '0.5rem',
                            fontWeight: 900,
                            padding: '1px 3px',
                            borderRadius: '2px',
                            zIndex: 10,
                            border: '1px solid rgba(255,255,255,0.2)',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
                            ...getPrintingBadgeStyle(card.printing)
                          }}>
                            {printingBadgeLabel}
                          </span>
                        )}
                      </div>

                      {/* Card Info */}
                      <div style={{ marginTop: '0.35rem', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '0.15rem' }}>
                        <div
                          style={{
                            fontSize: '0.72rem',
                            fontWeight: isHighlighted ? 700 : 600,
                            color: 'var(--text-primary)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                          }}
                        >
                          {isHighlighted ? '✓ ' : ''}{displayName(card)}
                        </div>
                        <div style={{ fontSize: '0.62rem', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{card.set_name || ''}</span>
                          {card.price_trend > 0 && <span style={{ color: 'var(--accent-yellow)', fontWeight: 600, flexShrink: 0 }}>${card.price_trend.toFixed(2)}</span>}
                        </div>
                      </div>
                    </DraggableCard>
                  );
                })}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginTop: '0.25rem' }}>
                {unsortedCards.map(card => {
                  const picked = moveMode && pickedEntryId === card.entry_id;
                  const isSelected = unsortedSelectMode && unsortedSelectedIds.has(card.entry_id);
                  const isHighlighted = picked || isSelected;
                  const rarityBorder = getCardRarityBorder(card.rarity);
                  const foilClass = getFoilOverlayClass(card.printing);
                  const printingBadgeLabel = getPrintingBadgeLabel(card.printing);

                  return (
                    <DraggableCard
                      enabled={dndEnabled}
                      entryId={card.entry_id}
                      card={card}
                      key={card.entry_id}
                      id={`card-${card.entry_id}`}
                      className={card.entry_id === focusEntryId ? 'focus-flash' : ''}
                      {...unsortedPressHandlers(card.entry_id)}
                      onClick={() => activateUnsortedCard(card)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        fontSize: '0.72rem',
                        padding: '0.4rem',
                        background: isHighlighted ? 'rgba(255,71,71,0.18)' : 'rgba(255, 255, 255, 0.02)',
                        border: isHighlighted ? '2px solid var(--accent-red)' : '1px solid var(--border-glass)',
                        borderRadius: 'var(--radius-sm)',
                        cursor: 'pointer',
                        userSelect: 'none',
                        transition: 'all 0.15s ease-in-out'
                      }}
                    >
                      <div
                        style={{ position: 'relative', width: '42px', flexShrink: 0, overflow: 'hidden', borderRadius: '4px', ...rarityBorder }}
                      >
                        <CardImage card={card} loading="lazy" decoding="async" style={{ width: '100%', aspectRatio: 0.718, objectFit: 'cover', display: 'block' }} />
                        {foilClass && <div className={foilClass} style={{ borderRadius: '4px' }} />}
                        {isHighlighted && (
                          <div style={{ position: 'absolute', inset: 0, background: 'rgba(255, 71, 71, 0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-strong)', fontWeight: 900, fontSize: '0.8rem' }}>
                            ✓
                          </div>
                        )}
                      </div>

                      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.1rem' }}>
                        <div style={{ fontWeight: isHighlighted ? 700 : 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {isHighlighted ? '✓ ' : ''}{displayName(card)}
                        </div>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'flex', gap: '0.4rem', alignItems: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <span>{card.set_name || 'Unset'} {card.number ? `#${card.number}` : ''}</span>
                          {card.condition && (
                            <span style={{ padding: '1px 3px', borderRadius: '2px', background: 'rgba(0,0,0,0.4)', fontSize: '0.55rem', fontWeight: 700 }}>
                              {card.condition}
                            </span>
                          )}
                          {printingBadgeLabel && (
                            <span style={{ padding: '1px 3px', borderRadius: '2px', fontSize: '0.55rem', fontWeight: 700, ...getPrintingBadgeStyle(card.printing) }}>
                              {printingBadgeLabel}
                            </span>
                          )}
                        </div>
                      </div>

                      {card.price_trend > 0 && (
                        <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--accent-yellow)', flexShrink: 0 }}>
                          ${card.price_trend.toFixed(2)}
                        </span>
                      )}
                    </DraggableCard>
                  );
                })}
              </div>
            )}

            {unsortedCards.length === 0 && <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontStyle: 'italic', marginTop: '0.5rem' }}>{t('loc.nothingUnsorted')}</p>}
            </UnsortedDropZone>
          </>
        )}
      </div>

      {/* Filing card (mobile): the container shows the blinking slot; this card
          shows what to file, where, and which physical card it goes behind, and
          carries Locate / Placed / Skip. Replaces the full desktop guide so the
          container and the guide share one screen. */}
      {isStacked && filingMode && filingQueue[filingIndex] && (
        <div style={{ position: 'fixed', left: 0, right: 0, bottom: 'calc(6rem + max(env(safe-area-inset-bottom, 0px), var(--sab, 0px)))', zIndex: 90, padding: '0 0.6rem' }}>
          <div className="glass-panel" style={{ padding: '0.7rem 0.8rem', display: 'flex', flexDirection: 'column', gap: '0.6rem', background: 'var(--bg-secondary)', boxShadow: '0 -6px 20px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, whiteSpace: 'nowrap' }}>
                {t(filingReadOnly ? 'loc.refile' : 'loc.filing')} {filingIndex + 1} / {filingQueue.length}
              </span>
              {filingBarCollapsed && (
                <span style={{ flex: 1, minWidth: 0, fontSize: '0.72rem', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {filingQueue[filingIndex].entry.name}
                </span>
              )}
              <div style={{ display: 'flex', gap: '0.3rem', flexShrink: 0 }}>
                <button type="button" className="btn btn-secondary btn-icon-only" onClick={() => setFilingBarCollapsed(c => !c)} title={t(filingBarCollapsed ? 'loc.expand' : 'loc.collapse')} style={{ width: '26px', height: '26px', padding: 0 }}>
                  {filingBarCollapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
                <button type="button" className="btn btn-secondary btn-icon-only" onClick={() => { setFilingMode(false); setFilingReadOnly(false); refreshAll(); }} title={t('loc.exitFiling')} style={{ width: '26px', height: '26px', padding: 0 }}>
                  <X size={13} />
                </button>
              </div>
            </div>

            {!filingBarCollapsed && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              <CardImage card={filingQueue[filingIndex].entry} style={{ width: '48px', borderRadius: '4px', boxShadow: '0 2px 8px rgba(0,0,0,0.5)', flexShrink: 0 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.95rem', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {filingQueue[filingIndex].entry.name}
                </div>
                <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {filingQueue[filingIndex].entry.set_name} &middot; {filingQueue[filingIndex].entry.printing}
                </div>
              </div>
            </div>
            )}

            {currentRecSpot ? (
              <>
                <div
                  onClick={() => locateRecommendedSpot(currentRecSpot)}
                  title={t('loc.tapToSnap')}
                  style={{ background: 'rgba(255,193,7,0.14)', border: '1px solid #ffc107', borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.6rem', cursor: 'pointer' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.6rem', color: '#ffc107', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 }}>{t('loc.tapToLocate')}</span>
                    <strong style={{ fontSize: '0.95rem', color: '#ffc107', whiteSpace: 'nowrap' }}>Slot {Math.floor(currentRecSpot.position / 1000)}</strong>
                  </div>
                  {!filingBarCollapsed && (<>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-strong)', fontWeight: 600, marginTop: '0.1rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {currentRecSpot.label}
                  </div>
                  {currentRecSpot.after ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.4rem' }}>
                      <CardImage card={currentRecSpot.after} style={{ width: '26px', borderRadius: '3px', flexShrink: 0 }} />
                      <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('loc.fileAfter')} <strong style={{ color: 'var(--text-strong)' }}>{currentRecSpot.after.name}</strong></span>
                    </div>
                  ) : currentRecSpot.before ? (
                    <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: '0.4rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t('loc.fileBefore')} <strong style={{ color: 'var(--text-strong)' }}>{currentRecSpot.before.name}</strong></div>
                  ) : (
                    <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>{t('loc.firstInSection')}</div>
                  )}
                  </>)}
                </div>

                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button type="button" className="btn btn-secondary" onClick={advanceFiling} style={{ flex: 1, padding: '0.55rem', fontSize: '0.8rem' }}>{t('loc.skip')}</button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => handleFilingPlaced(filingQueue[filingIndex].entry.entry_id, currentRecSpot.location_id, currentRecSpot.compartment_id, currentRecSpot.position)}
                    style={{ flex: 2, padding: '0.55rem', fontSize: '0.85rem', fontWeight: 700 }}
                  >
                    {filingReadOnly ? 'Next' : 'Placed'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: '0.75rem', color: 'var(--accent-red)', fontWeight: 700, textAlign: 'center' }}>
                  {filingQueue[filingIndex].rejected ? "Doesn't fit this container's rule" : 'Container full'}
                </div>
                <button type="button" className="btn btn-secondary" onClick={advanceFiling} style={{ padding: '0.55rem', fontSize: '0.82rem', fontWeight: 700 }}>{t('loc.skip')}</button>
              </>
            )}
          </div>
        </div>
      )}

      <CardInspectorModal
        card={inspectorCard}
        onClose={() => setInspectorCard(null)}
        onUpdate={onUpdate}
        showToast={showToast}
      />
    </div>
    </DndContext>
  );
}

export default LocationManager;
