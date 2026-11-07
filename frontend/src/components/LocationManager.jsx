import { memo, useState, useEffect, useMemo, useRef } from 'react';
import { DndContext, DragOverlay, MouseSensor, useSensor, useSensors, pointerWithin } from '@dnd-kit/core';
import { X, Lock } from 'lucide-react';
import { sortCardsByOrder } from '../utils/cardSort';
import CardInspectorModal from './CardInspectorModal';
import { useMultiSelect } from '../utils/useMultiSelect';
import { undoToast, placementUndo } from '../utils/undo';
import { isBinderType as computeIsBinder } from '../utils/cardOptions';
import { displayName } from '../utils/languages';
import ContainerOverview from './ContainerOverview';
import CreateContainerModal from './CreateContainerModal';
import BinderArtworkEditor from './BinderArtworkEditor';
import { useBinderArt } from '../utils/useBinderArt';
import { isDeviceMode } from '../apiBase';
import { artPocketsByPage } from '../utils/binderArtGeometry';
import { useBackGuard } from '../utils/useBackGuard';
import { useTabParam, setTabParam } from '../utils/router';
import { useT } from '../utils/i18n';
import { apiErrorText } from '../utils/apiError';
import ContainerList from './storage/ContainerList';
import ContainerSettingsModal, { CompartmentRulesModal, CapacitySyncModal } from './storage/ContainerSettings';
import BinderViewPanel, { BinderPageNav } from './storage/BinderViewPanel';
import BoxViewPanel from './storage/BoxViewPanel';
import UnsortedQueue from './storage/UnsortedQueue';
import { FilingGuidePanel, FilingBar } from './storage/FilingGuide';

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
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [sortDraft, setSortDraft] = useState([]);
  const [filterDraft, setFilterDraft] = useState([]);
  const [nameDraft, setNameDraft] = useState('');
  const [capacityDraft, setCapacityDraft] = useState('');
  const [countDraft, setCountDraft] = useState('');
  const [stackingDraft, setStackingDraft] = useState(false);
  // Binder page width in pockets: '' = automatic (from the page capacity).
  const [columnsDraft, setColumnsDraft] = useState('');
  // Fixed slots by collector number: null = off, else rows of { set_id, start_slot, max_number }.
  const [fixedDraft, setFixedDraft] = useState(null);

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
  const [compRuleDraft, setCompRuleDraft] = useState([]);

  const [unsortedSearch, setUnsortedSearch] = useState('');
  const [unsortedSort, setUnsortedSort] = useState('scanned-desc');
  const [unsortedViewMode, setUnsortedViewMode] = useState('grid'); // 'grid' | 'detail'
  // Per kind of container: 'layout' is a box's coverflow or a binder's page
  // spread, 'overview' every card at once. Remembered, so someone who reads their
  // boxes as a grid gets the grid without asking each time.
  const [containerViewModes, setContainerViewModes] = useState(() => ({
    box: localStorage.getItem('bindarr_container_view_box') === 'overview' ? 'overview' : 'layout',
    binder: localStorage.getItem('bindarr_container_view_binder') === 'overview' ? 'overview' : 'layout',
  }));
  const [containerCardScale, setContainerCardScale] = useState(1);
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

  const containerKind = isBinderType ? 'binder' : 'box';
  const containerViewMode = containerViewModes[containerKind];
  const setContainerViewMode = (mode) => {
    localStorage.setItem(`bindarr_container_view_${containerKind}`, mode);
    setContainerViewModes(modes => ({ ...modes, [containerKind]: mode }));
  };
  // Filing and Arrange both work on the layout (the ghost slot, tap-to-place)
  // and hide the view switch while they run, so they always get the layout.
  const viewMode = (filingMode || moveMode) ? 'layout' : containerViewMode;

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

  // Box map and coverflow, kept in step: boxSeek asks the open row to centre a
  // slot (CompartmentView's seekTo), boxCursor is the slot it reports back.
  const [boxSeek, setBoxSeek] = useState(null);
  const [boxCursor, setBoxCursor] = useState(null);
  const seekNonce = useRef(0);
  const seekBox = (compartmentId, slot, { divider = false } = {}) => {
    seekNonce.current += 1;
    setActiveCompartmentId(compartmentId);
    setBoxSeek({ compartmentId, slot, divider, nonce: seekNonce.current });
  };

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
    setBoxSeek(null);
    setBoxCursor(null);
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

  // The open container is mirrored in the URL (/storage/:id) so a reload or a
  // link reopens it. Switching containers replaces the entry rather than
  // stacking one per container: Back leaves Storage.
  const routeLocationId = useTabParam('storage');
  const routedLocationRef = useRef(null);
  useEffect(() => {
    if (routeLocationId == null || String(activeLocationId) === routeLocationId) return;
    routedLocationRef.current = Number(routeLocationId);
    setActiveLocationId(Number(routeLocationId));
    setMobilePane('container');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeLocationId]);
  useEffect(() => {
    if (activeLocationId == null || String(activeLocationId) === routeLocationId) return;
    setTabParam('storage', activeLocationId, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLocationId]);
  // A link to a container that is gone (or not yours) falls back to the first.
  // Only for ids the URL supplied: one just created is set before the list
  // reloads, and must not be taken for a dead link.
  useEffect(() => {
    if (activeLocationId != null && activeLocationId === routedLocationRef.current
      && locations.length > 0 && !locations.some(l => l.id === activeLocationId)) {
      setActiveLocationId(locations[0].id);
    }
  }, [locations, activeLocationId]);

  useEffect(() => {
    // App clears the request when you leave this tab (the tab stays mounted), so
    // forget it here too: locating the same card again must navigate again.
    if (!focusEntryId) { focusNavRef.current = null; return; }
    if (allCards.length === 0) return;
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
          // The Unsorted queue mounts only the rows in view, so the card may have
          // no element yet: scroll its row in, and the next attempt finds it.
          const idx = unsortedCardsRef.current.findIndex(c => c.entry_id === focusEntryId);
          if (idx !== -1 && unsortedGridRef.current) unsortedGridRef.current.scrollToIndex(idx);
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
  // For locating a card the windowed queue has not mounted (see the focus effect).
  const unsortedGridRef = useRef(null);
  const unsortedCardsRef = useRef(unsortedCards);
  unsortedCardsRef.current = unsortedCards;

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

  // Binder artwork (issue #104): decoration over empty pockets, never a card.
  // Server-only: the embedded phone backend has no sharp and no image store.
  const artworkAvailable = isBinderType && !isDeviceMode();
  const [artworkOpen, setArtworkOpen] = useState(false);
  const binderArt = useBinderArt(selectedLoc?.id, artworkAvailable);
  const artByPage = useMemo(() => {
    const byPage = artPocketsByPage({ layers: binderArt.layers, compartments, pageColumns: selectedLoc?.page_columns });
    for (const pockets of byPage.values()) {
      for (const [slot, piece] of pockets) {
        if (binderArt.srcs[piece.artworkId]) pockets.set(slot, { ...piece, src: binderArt.srcs[piece.artworkId] });
        else pockets.delete(slot);
      }
    }
    return byPage;
  }, [binderArt.layers, binderArt.srcs, compartments, selectedLoc?.page_columns]);

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
        showToast(apiErrorText(t, data, 'loc.errCreate'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('loc.errCreate'));
    }
  };

  const handleContainerImportFile = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const response = await fetch('/api/import-container', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: String(reader.result || ''), name: file.name.replace(/\.[^.]+$/, '') })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(apiErrorText(t, data, 'loc.errCreate'));
        showToast(data.message);
        setActiveLocationId(data.id);
        await refreshAll();
        onUpdate();
      } catch (error) {
        console.error(error);
        showToast(error.message);
      }
    };
    reader.onerror = () => showToast(t('settings.errReadFile'));
    reader.readAsText(file);
    event.target.value = '';
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
        showToast(apiErrorText(t, data, 'loc.errUpdateContainer'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('loc.errUpdateContainer'));
    }
  };

  const handleAddCompartment = async ({ before_id = null, after_id = null, idx = null } = {}) => {
    if (!selectedLoc) return;
    if (selectedLoc.locked) {
      showToast(t('loc.lockedAdd'));
      return;
    }
    try {
      const body = {};
      if (before_id !== null && before_id !== undefined) body.before_id = before_id;
      else if (after_id !== null && after_id !== undefined) body.after_id = after_id;
      else if (idx !== null && idx !== undefined) body.idx = idx;

      const res = await fetch(`/api/locations/${selectedLoc.id}/compartments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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

  const handleMoveCompartmentToBinder = async (compartmentId, targetLocationId) => {
    if (!targetLocationId || targetLocationId === activeLocationId) return;
    const compartment = compartments.find(c => c.id === compartmentId);
    if (selectedLoc?.locked || compartment?.locked) {
      showToast(t('loc.lockedMove'));
      return;
    }
    try {
      const res = await fetch(`/api/compartments/${compartmentId}/reorder`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: targetLocationId, idx: 1 })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast(t('loc.compartmentMoved'));
        await Promise.all([fetchLocations(), fetchCompartments(activeLocationId)]);
      } else {
        const friendlyError = (data.error || '').toLowerCase().includes('do not match the destination binder rules')
          ? t('loc.moveRuleMismatch')
          : apiErrorText(t, data, 'loc.errMove');
        showToast(friendlyError);
      }
    } catch (err) {
      console.error(err);
      showToast(t('loc.errMove'));
    }
  };

  const handleReorderCompartment = async (compartmentId, { before_id = null, after_id = null } = {}) => {
    const compartment = compartments.find(c => c.id === compartmentId);
    if (!selectedLoc || selectedLoc.locked || compartment?.locked) {
      showToast(t('loc.lockedMove'));
      return;
    }
    try {
      const body = { location_id: selectedLoc.id };
      if (before_id !== null && before_id !== undefined) body.before_id = before_id;
      else if (after_id !== null && after_id !== undefined) body.after_id = after_id;
      const res = await fetch(`/api/compartments/${compartmentId}/reorder`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast(t('loc.compartmentMoved'));
        await Promise.all([fetchCompartments(selectedLoc.id), fetchLocations()]);
      } else {
        showToast(apiErrorText(t, data, 'loc.errMove'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('loc.errMove'));
    }
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
      else showToast(apiErrorText(t, data, 'loc.errRemoveCompartment'));
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
        showToast(apiErrorText(t, errData, 'loc.errMove'));
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
        showToast(apiErrorText(t, data, 'loc.errPlace'));
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
        showToast(apiErrorText(t, body, 'loc.errPlace'));
        return;
      }
      showToast(t('loc.movedToUnsorted'), undoToast(placementUndo(allCards.find(c => c.entry_id === entryId)), {
        showToast, t, onDone: async () => { await refreshAll(); onUpdate(); }
      }));
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
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(t('loc.cardRemoved'), undoToast(data.trash_batch && { kind: 'trash', batch: data.trash_batch }, {
          showToast, t, onDone: async () => { await refreshAll(); onUpdate(); }
        }));
        await refreshAll(); onUpdate();
      }
      else showToast(t('loc.errRemoveCard'));
    } catch (err) { console.error(err); showToast(t('loc.errRemoveCardGeneric')); }
  };

  // Cards physically in the open container (any compartment).
  const cardsInActiveLocation = useMemo(
    () => allCards.filter(c => c.location_id === activeLocationId),
    [allCards, activeLocationId]
  );

  // From the All cards overview back to the layout, at that row or page.
  const openCompartmentInLayout = (compartmentId) => {
    setContainerViewMode('layout');
    if (isBinderType) {
      const idx = compartments.findIndex(c => c.id === compartmentId);
      if (idx !== -1) setActivePageIndex(idx);
    } else {
      setActiveCompartmentId(compartmentId);
    }
  };

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
      else showToast(apiErrorText(t, data, 'loc.errFileBatch'));
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
        // Filled up since the recommendation was made: the card stays unfiled.
        const filed = await res.json().catch(() => ({}));
        if (filed.container_full) showToast(t('loc.containerFull'));
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

  // Seed the Container Settings drafts from the open container (kebab menu).
  const openContainerSettings = () => {
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
    setColumnsDraft(selectedLoc.page_columns ? String(selectedLoc.page_columns) : '');
    let fixed = null;
    try { fixed = selectedLoc.fixed_slots ? JSON.parse(selectedLoc.fixed_slots) : null; } catch { /* ignore */ }
    setFixedDraft(Array.isArray(fixed) && fixed.length > 0 ? fixed.map(r => ({ ...r, max_number: r.max_number ?? '' })) : null);
    setCountDraft(String(compartments.length));
    const caps = compartments.map(c => c.capacity);
    const uniform = caps.length > 0 && caps.every(c => c === caps[0]);
    setCapacityDraft(uniform ? String(caps[0]) : '');

    setShowRulesModal(true);
  };

  // Save the Container Settings modal: rename, sort/filter rules, and a
  // one-shot capacity applied to every row/page. Switching to Custom freezes
  // the current order server-side; a structured sort change offers a re-sort.
  const saveContainerSettings = async () => {
    if (!selectedLoc) return;
    const newSort = sortDraft.length > 0 ? JSON.stringify(sortDraft) : 'custom';
    const sortChanged = newSort !== selectedLoc.sort_order;

    const fixedRows = (fixedDraft || []).filter(r => r.set_id).map(r => ({
      set_id: r.set_id,
      start_slot: parseInt(r.start_slot, 10) || 1,
      max_number: r.max_number === '' || r.max_number == null ? null : parseInt(r.max_number, 10)
    }));
    const fixedSlots = fixedRows.length > 0 ? fixedRows : null;
    const fixedChanged = JSON.stringify(fixedSlots) !== (selectedLoc.fixed_slots || 'null');

    const fields = {
      sort_order: newSort,
      rule_type: filterDraft.length > 0 ? 'compound' : 'any',
      rule_config: filterDraft.length > 0 ? JSON.stringify({ rules: filterDraft }) : null,
      allow_stacking: stackingDraft,
      fixed_slots: fixedSlots,
    };
    if (isBinderType) fields.page_columns = columnsDraft === '' ? null : parseInt(columnsDraft, 10);
    const trimmedName = (nameDraft || '').trim();
    if (trimmedName && trimmedName !== selectedLoc.name) fields.name = trimmedName;

    // Fewer pages/rows sends whatever the cut ones hold to Unsorted: say how many
    // before anything is saved, so backing out leaves the container untouched.
    const shrinkTo = parseInt(countDraft, 10);
    if (shrinkTo > 0 && shrinkTo < compartments.length) {
      let message = t('loc.confirmShrinkUnknown');
      try {
        const res = await fetch(`/api/locations/${selectedLoc.id}/shrink-preview?count=${shrinkTo}`);
        if (res.ok) {
          const { wouldMove } = await res.json();
          message = wouldMove > 0 ? t('loc.confirmShrink', { count: wouldMove }) : null;
        }
      } catch (err) { console.error(err); }
      if (message && !window.confirm(message)) return;
    }

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

    if ((fixedChanged || (sortChanged && newSort !== 'custom')) && (selectedLoc.total_cards || 0) > 0) {
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
        <CompartmentRulesModal
          rulesComp={rulesComp}
          setRulesComp={setRulesComp}
          isBinderType={isBinderType}
          compRuleDraft={compRuleDraft}
          setCompRuleDraft={setCompRuleDraft}
          setsList={setsList}
          filterFieldOptions={filterFieldOptions}
          saveCompartmentRules={saveCompartmentRules}
        />
      )}

      {capacityUpdatePending && (
        <CapacitySyncModal
          capacityUpdatePending={capacityUpdatePending}
          setCapacityUpdatePending={setCapacityUpdatePending}
          handleSetCapacity={handleSetCapacity}
        />
      )}

      {showRulesModal && selectedLoc && (
        <ContainerSettingsModal
          selectedLoc={selectedLoc}
          isBinderType={isBinderType}
          setsList={setsList}
          filterFieldOptions={filterFieldOptions}
          nameDraft={nameDraft}
          setNameDraft={setNameDraft}
          countDraft={countDraft}
          setCountDraft={setCountDraft}
          capacityDraft={capacityDraft}
          setCapacityDraft={setCapacityDraft}
          columnsDraft={columnsDraft}
          setColumnsDraft={setColumnsDraft}
          stackingDraft={stackingDraft}
          setStackingDraft={setStackingDraft}
          fixedDraft={fixedDraft}
          setFixedDraft={setFixedDraft}
          sortDraft={sortDraft}
          setSortDraft={setSortDraft}
          filterDraft={filterDraft}
          setFilterDraft={setFilterDraft}
          setShowRulesModal={setShowRulesModal}
          saveContainerSettings={saveContainerSettings}
        />
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
        <ContainerList
          locations={locations}
          activeLocationId={activeLocationId}
          setActiveLocationId={setActiveLocationId}
          selectedLoc={selectedLoc}
          compartments={compartments}
          cardsByCompartment={cardsByCompartment}
          cardsInActiveLocation={cardsInActiveLocation}
          isBinderType={isBinderType}
          isCustom={isCustom}
          filingMode={filingMode}
          moveMode={moveMode}
          setMoveMode={setMoveMode}
          setPickedEntryId={setPickedEntryId}
          containerViewMode={containerViewMode}
          setContainerViewMode={setContainerViewMode}
          viewMode={viewMode}
          containerCardScale={containerCardScale}
          setContainerCardScale={setContainerCardScale}
          storage={storage}
          setShowCreate={setShowCreate}
          handleContainerImportFile={handleContainerImportFile}
          handleToggleContainerLock={handleToggleContainerLock}
          handleAddCompartment={handleAddCompartment}
          handleRemoveCompartment={handleRemoveCompartment}
          startResort={startResort}
          openContainerSettings={openContainerSettings}
          handleDeleteLocation={handleDeleteLocation}
        />

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

            {viewMode === 'layout' && isBinderType && compartments.length > 0 && (
              <BinderPageNav
                compartments={compartments}
                activePageIndex={activePageIndex}
                setActivePageIndex={setActivePageIndex}
                isMobile={isMobile}
                selectedLoc={selectedLoc}
                handleAddCompartment={handleAddCompartment}
                artworkAvailable={artworkAvailable}
                setArtworkOpen={setArtworkOpen}
              />
            )}

            {viewMode === 'overview' && (
              <ContainerOverview
                location={selectedLoc}
                compartments={compartments}
                cardsByCompartment={cardsByCompartment}
                setsList={setsList}
                cardScale={containerCardScale}
                selectedIds={storage.selectMode ? storage.selectedIds : null}
                onCardClick={(card) => (storage.selectMode ? storage.toggleSelect(card.entry_id) : setInspectorCard(card))}
                onOpenCompartment={openCompartmentInLayout}
              />
            )}
            <div style={{ display: viewMode === 'layout' ? 'flex' : 'none', flexDirection: 'column', gap: isBinderType ? '1rem' : '0.6rem' }}>
              {isBinderType ? (
                <BinderViewPanel
                  compartments={compartments}
                  cardsByCompartment={cardsByCompartment}
                  cardsInActiveLocation={cardsInActiveLocation}
                  selectedLoc={selectedLoc}
                  locations={locations}
                  setsList={setsList}
                  isMobile={isMobile}
                  activePageIndex={activePageIndex}
                  handleTouchStart={handleTouchStart}
                  handleTouchEnd={handleTouchEnd}
                  handleAddCompartment={handleAddCompartment}
                  handleReorderCompartment={handleReorderCompartment}
                  handleMoveCompartmentToBinder={handleMoveCompartmentToBinder}
                  handleRenameCompartment={handleRenameCompartment}
                  handleSetCapacity={handleSetCapacity}
                  handleRemoveCompartment={handleRemoveCompartment}
                  handleToggleCompartmentLock={handleToggleCompartmentLock}
                  openCompartmentRules={openCompartmentRules}
                  setInspectorCard={setInspectorCard}
                  handleDeleteCard={handleDeleteCard}
                  handleMoveCard={handleMoveCard}
                  currentRecSpot={currentRecSpot}
                  recCard={recCard}
                  focusEntryId={focusEntryId}
                  storage={storage}
                  moveMode={moveMode}
                  pickedEntryId={pickedEntryId}
                  handlePickCard={handlePickCard}
                  handlePlaceSlot={handlePlaceSlot}
                  dndEnabled={dndEnabled}
                  binderActiveEntryId={binderActiveEntryId}
                  setBinderActiveEntryId={setBinderActiveEntryId}
                  artByPage={artByPage}
                />
              ) : (
                <BoxViewPanel
                  compartments={compartments}
                  cardsByCompartment={cardsByCompartment}
                  selectedLoc={selectedLoc}
                  setsList={setsList}
                  activeCompartmentId={activeCompartmentId}
                  setActiveCompartmentId={setActiveCompartmentId}
                  boxSeek={boxSeek}
                  boxCursor={boxCursor}
                  setBoxCursor={setBoxCursor}
                  seekBox={seekBox}
                  handleAddCompartment={handleAddCompartment}
                  handleRenameCompartment={handleRenameCompartment}
                  handleSetCapacity={handleSetCapacity}
                  handleRemoveCompartment={handleRemoveCompartment}
                  handleToggleCompartmentLock={handleToggleCompartmentLock}
                  openCompartmentRules={openCompartmentRules}
                  setInspectorCard={setInspectorCard}
                  handleDeleteCard={handleDeleteCard}
                  handleMoveCard={handleMoveCard}
                  currentRecSpot={currentRecSpot}
                  recCard={recCard}
                  focusEntryId={focusEntryId}
                  storage={storage}
                  moveMode={moveMode}
                  pickedEntryId={pickedEntryId}
                  handlePickCard={handlePickCard}
                  handlePlaceSlot={handlePlaceSlot}
                />
              )}
            </div>
          </>
        )}
      </div>

      {/* Unsorted queue */}
      <div className="glass-panel location-unsorted-col" style={{ padding: '0.75rem', display: (isStacked && (filingMode || mobilePane !== 'unsorted')) ? 'none' : 'flex', flexDirection: 'column', gap: '0.5rem', overflowY: 'auto', maxHeight: (isStacked && !filingMode && mobilePane === 'unsorted') ? 'none' : undefined }}>
        {filingMode ? (
          <FilingGuidePanel
            filingQueue={filingQueue}
            filingIndex={filingIndex}
            filingReadOnly={filingReadOnly}
            setFilingMode={setFilingMode}
            setFilingReadOnly={setFilingReadOnly}
            refreshAll={refreshAll}
            locateRecommendedSpot={locateRecommendedSpot}
            advanceFiling={advanceFiling}
            handleFilingPlaced={handleFilingPlaced}
          />
        ) : (
          <UnsortedQueue
            unsortedCards={unsortedCards}
            locations={locations}
            activeLocationId={activeLocationId}
            focusEntryId={focusEntryId}
            unsortedGridRef={unsortedGridRef}
            unsortedSearch={unsortedSearch}
            setUnsortedSearch={setUnsortedSearch}
            unsortedSort={unsortedSort}
            setUnsortedSort={setUnsortedSort}
            unsortedViewMode={unsortedViewMode}
            setUnsortedViewMode={setUnsortedViewMode}
            unsortedSelectMode={unsortedSelectMode}
            setUnsortedSelectMode={setUnsortedSelectMode}
            exitUnsortedSelectMode={exitUnsortedSelectMode}
            unsortedSelectedIds={unsortedSelectedIds}
            setUnsortedSelectedIds={setUnsortedSelectedIds}
            clearUnsortedSelection={clearUnsortedSelection}
            unsortedPressHandlers={unsortedPressHandlers}
            runUnsortedBulk={runUnsortedBulk}
            unsortedBulkLocation={unsortedBulkLocation}
            setUnsortedBulkLocation={setUnsortedBulkLocation}
            activateUnsortedCard={activateUnsortedCard}
            startFilingMode={startFilingMode}
            handleApplyAll={handleApplyAll}
            moveMode={moveMode}
            pickedEntryId={pickedEntryId}
            dndEnabled={dndEnabled}
          />
        )}
      </div>

      {/* Filing card (mobile): see FilingBar. */}
      {isStacked && filingMode && filingQueue[filingIndex] && (
        <FilingBar
          filingQueue={filingQueue}
          filingIndex={filingIndex}
          filingReadOnly={filingReadOnly}
          filingBarCollapsed={filingBarCollapsed}
          setFilingBarCollapsed={setFilingBarCollapsed}
          setFilingMode={setFilingMode}
          setFilingReadOnly={setFilingReadOnly}
          refreshAll={refreshAll}
          currentRecSpot={currentRecSpot}
          locateRecommendedSpot={locateRecommendedSpot}
          advanceFiling={advanceFiling}
          handleFilingPlaced={handleFilingPlaced}
        />
      )}

      {artworkOpen && selectedLoc && artworkAvailable && compartments.length > 0 && (
        <BinderArtworkEditor
          location={selectedLoc}
          compartments={compartments}
          pageIndex={activePageIndex}
          cardsByCompartment={cardsByCompartment}
          layers={binderArt.layers}
          onClose={() => setArtworkOpen(false)}
          onSaved={binderArt.reload}
          showToast={showToast}
        />
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

// Memoized: App re-renders on every toast, and its props here are stable.
export default memo(LocationManager);
