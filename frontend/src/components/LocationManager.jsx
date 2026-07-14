import { useState, useEffect, useMemo, useRef } from 'react';
import { Plus, Trash2, X, MoreVertical, Settings, LayoutList, RefreshCw, Lock, Unlock } from 'lucide-react';
import { sortCardsByOrder } from '../utils/cardSort';
import { getFoilOverlayClass } from '../utils/cardPrinting';
import { getCardRarityBorder } from '../utils/cardRarity';
import CardInspectorModal from './CardInspectorModal';
import { isBinderType as computeIsBinder } from '../utils/cardOptions';
import CompartmentView, { getPrimaryCategory, FocusedCardInfo } from './CompartmentView';
import { SortBuilder, FilterBuilder } from './SortFilterBuilder';
import CreateContainerModal from './CreateContainerModal';

function LocationManager({ statsTrigger, onUpdate, showToast, selectedLocationId, setSelectedLocationId, focusEntryId }) {
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
  const [showCategoryMap, setShowCategoryMap] = useState(false);
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [sortDraft, setSortDraft] = useState([]);
  const [filterDraft, setFilterDraft] = useState([]);

  const [inspectorCard, setInspectorCard] = useState(null);

  // Multi-select over cards inside the open container.
  const [storageSelectMode, setStorageSelectMode] = useState(false);
  const [storageSelectedIds, setStorageSelectedIds] = useState(() => new Set());

  // Per-compartment filing-rule editor.
  const [rulesComp, setRulesComp] = useState(null);
  const [compRuleDraft, setCompRuleDraft] = useState([]);

  const [unsortedSearch, setUnsortedSearch] = useState('');
  const [unsortedSort, setUnsortedSort] = useState('scanned-desc');

  const [activePageIndex, setActivePageIndex] = useState(0);
  const [binderActiveEntryId, setBinderActiveEntryId] = useState(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

  const [filingMode, setFilingMode] = useState(false);
  const [filingQueue, setFilingQueue] = useState([]);
  const [filingIndex, setFilingIndex] = useState(0);
  // Re-sort review reuses the filing UI, but the cards are already placed in the
  // DB by /resort — so "Placed" just advances instead of issuing a move.
  const [filingReadOnly, setFilingReadOnly] = useState(false);

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
          el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
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
  const touchStartRef = useRef(0);

  const [activeCompartmentId, setActiveCompartmentId] = useState(null);
  const [coverflowActiveIndex, setCoverflowActiveIndex] = useState(0);

  const handleTouchStart = (e) => {
    touchStartRef.current = e.changedTouches[0].clientX;
  };

  const handleTouchEnd = (e) => {
    const endX = e.changedTouches[0].clientX;
    const diffX = touchStartRef.current - endX;
    if (diffX > 50) {
      setActivePageIndex(prev => Math.min(compartments.length - 1, prev + 1));
    } else if (diffX < -50) {
      setActivePageIndex(prev => Math.max(0, prev - 1));
    }
  };

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    setActiveCompartmentId(null);
    setActivePageIndex(0);
    setBinderActiveEntryId(null);
    if (!filingReadOnly) setFilingQueue([]);
    setCoverflowActiveIndex(0);
    setStorageSelectMode(false);
    setStorageSelectedIds(new Set());
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
      setLoading(true);
      await Promise.all([fetchLocations(), fetchAllCards()]);
      setLoading(false);
    })();
  }, [statsTrigger]);

  useEffect(() => {
    fetchCompartments(activeLocationId);
  }, [activeLocationId, statsTrigger]);

  useEffect(() => {
    if (selectedLocationId) {
      if (selectedLocationId === 'unsorted') {
        setActiveLocationId(null);
      } else {
        setActiveLocationId(selectedLocationId);
      }
      setSelectedLocationId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLocationId]);

  useEffect(() => {
    // If the storage tab is opened without a specific container URL (selectedLocationId is falsy),
    // and there are locations available, auto-select the first one.
    if (!selectedLocationId && !activeLocationId && locations.length > 0) {
      setActiveLocationId(locations[0].id);
    }
  }, [locations, selectedLocationId, activeLocationId]);

  const unsortedCards = useMemo(() => {
    let cards = allCards.filter(c => !c.location_id && (
      c.name.toLowerCase().includes(unsortedSearch.toLowerCase()) ||
      (c.set_name || '').toLowerCase().includes(unsortedSearch.toLowerCase())
    ));
    return sortCardsByOrder([...cards], unsortedSort, selectedLoc?.foil_sorting, setsList);
  }, [allCards, unsortedSearch, unsortedSort, selectedLoc, setsList]);

  const availableCategories = useMemo(() => {
    const cats = new Set();
    allCards.forEach(c => {
      const cat = getPrimaryCategory(c, selectedLoc?.sort_order, setsList);
      if (cat) cats.add(cat);
    });
    return Array.from(cats).sort();
  }, [allCards, selectedLoc?.sort_order, setsList]);

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
        showToast('Storage container created!');
        setShowCreate(false);
        await fetchLocations();
        setActiveLocationId(data.id);
        onUpdate();
      } else {
        showToast(data.error || 'Failed to create container.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error creating container.');
    }
  };

  const handleDeleteLocation = async (locId, name) => {
    if (!window.confirm(`Delete "${name}"? Stored cards will move to Unsorted.`)) return;
    try {
      const res = await fetch(`/api/locations/${locId}`, { method: 'DELETE' });
      if (res.ok) {
        showToast(`Deleted "${name}".`);
        if (activeLocationId === locId) setActiveLocationId(null);
        await refreshAll();
        onUpdate();
      } else {
        showToast('Failed to delete container.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error deleting container.');
    }
  };

  const handleUpdateLocationFields = async (fields) => {
    if (!selectedLoc) return;
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
      showToast('Error updating container.');
    }
  };

  const handleAddCompartment = async () => {
    if (!selectedLoc) return;
    try {
      const res = await fetch(`/api/locations/${selectedLoc.id}/compartments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      if (res.ok) { showToast('Compartment added.'); await Promise.all([fetchCompartments(selectedLoc.id), fetchLocations()]); }
      else showToast('Failed to add compartment.');
    } catch (err) { console.error(err); showToast('Error adding compartment.'); }
  };

  const handleRemoveCompartment = async (compartmentId) => {
    if (!window.confirm('Remove this compartment?')) return;
    try {
      const res = await fetch(`/api/compartments/${compartmentId}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) { showToast('Compartment removed.'); await Promise.all([fetchCompartments(activeLocationId), fetchLocations()]); }
      else showToast(data.error || 'Failed to remove compartment.');
    } catch (err) { console.error(err); showToast('Error removing compartment.'); }
  };

  // Lock/unlock a row/page: filing skips locked ones (existing cards stay).
  // Uses the working /locations/:id/compartments/:comp_id route.
  const handleToggleCompartmentLock = async (compartmentId, locked) => {
    if (!activeLocationId) return;
    try {
      const res = await fetch(`/api/locations/${activeLocationId}/compartments/${compartmentId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locked })
      });
      if (res.ok) { showToast(locked ? 'Row locked — filing will skip it.' : 'Row unlocked.'); await fetchCompartments(activeLocationId); }
      else showToast('Failed to update lock.');
    } catch (err) { console.error(err); showToast('Error updating lock.'); }
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
      else showToast('Failed to update lock.');
    } catch (err) { console.error(err); showToast('Error updating lock.'); }
  };

  const handleRenameCompartment = async (compartmentId, label) => {
    try {
      await fetch(`/api/compartments/${compartmentId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) });
      await fetchCompartments(activeLocationId);
    } catch (err) { console.error(err); showToast('Error renaming compartment.'); }
  };

  const handleSetCapacity = async (compartmentId, capacity, forceUpdateAll = false) => {
    if (compartments.length > 1 && !forceUpdateAll && !capacityUpdatePending) {
      setCapacityUpdatePending({ id: compartmentId, capacity });
      return;
    }
    const updateAll = forceUpdateAll || false;
    try {
      await fetch(`/api/compartments/${compartmentId}${updateAll ? '?updateAll=true' : ''}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ capacity }) });
      await fetchCompartments(activeLocationId);
    } catch (err) { console.error(err); showToast('Error resizing compartment.'); }
  };

  // Files one sorting category to exactly one page: add it to the target page
  // and strip it from any other page that had it. Empty target = unassign.
  const handleAssignCategoryToPage = async (filterVal, compartmentId) => {
    const updates = [];
    for (const c of compartments) {
      const has = (c.assignedFilters || []).includes(filterVal);
      if (compartmentId && String(c.id) === String(compartmentId)) {
        if (!has) updates.push({ id: c.id, filters: [...(c.assignedFilters || []), filterVal] });
      } else if (has) {
        updates.push({ id: c.id, filters: (c.assignedFilters || []).filter(f => f !== filterVal) });
      }
    }
    if (!updates.length) return;
    try {
      await Promise.all(updates.map(u => fetch(`/api/compartments/${u.id}/filters`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filters: u.filters })
      })));
      showToast('Category assignment updated.');
      await fetchCompartments(activeLocationId);
    } catch (err) { console.error(err); showToast('Error assigning category.'); }
  };

  const handleAutoAssignCategories = async () => {
    if (!selectedLoc) return;
    if (!window.confirm(`Auto-distribute your owned categories across "${selectedLoc.name}"'s compartments by size? This replaces current assignments.`)) return;
    try {
      const res = await fetch(`/api/locations/${selectedLoc.id}/auto-assign-categories`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        showToast(data.skipped.length ? `Assigned categories. Didn't fit: ${data.skipped.join(', ')}` : 'Categories auto-assigned.');
        await fetchCompartments(selectedLoc.id);
      } else {
        showToast(data.error || 'Failed to auto-assign categories.');
      }
    } catch (err) { console.error(err); showToast('Error auto-assigning categories.'); }
  };

  const handleMoveCard = async (entryId, compartmentId) => {
    try {
      const res = await fetch(`/api/collection/${entryId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ compartment_id: compartmentId })
      });
      if (res.ok) { showToast('Card moved.'); await refreshAll(); }
      else {
        const errData = await res.json().catch(()=>({}));
        showToast(errData.error || 'Failed to move card.');
      }
    } catch (err) { console.error(err); showToast('Error moving card.'); }
  };

  // --- Manual tap-to-place (Arrange) ---
  // Pick/unpick a card to move. Tapping the picked card again cancels.
  const handlePickCard = (entryId) => setPickedEntryId(prev => (prev === entryId ? null : entryId));

  // Place the picked card at a slot. Binder + occupied pocket = swap; otherwise
  // send the slot and let the backend place absolutely (binder) or insert (box).
  const handlePlaceSlot = async (compartmentId, slotNumber, occupantEntryId) => {
    if (!pickedEntryId || occupantEntryId === pickedEntryId) { setPickedEntryId(null); return; }
    const body = { compartment_id: compartmentId };
    if (isBinderType && occupantEntryId) body.swap_with = occupantEntryId;
    else body.slot = slotNumber;
    try {
      const res = await fetch(`/api/collection/${pickedEntryId}/place`, {
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
    } catch (err) { console.error(err); showToast('Error placing card.'); }
  };

  const handleDeleteCard = async (entryId) => {
    if (!window.confirm('Remove this card from your collection?')) return;
    try {
      const res = await fetch(`/api/collection/${entryId}`, { method: 'DELETE' });
      if (res.ok) { showToast('Card removed.'); await refreshAll(); onUpdate(); }
      else showToast('Failed to remove card.');
    } catch (err) { console.error(err); showToast('Error removing card.'); }
  };

  // --- Multi-select over the open container ---
  const toggleStorageSelect = (entryId) => {
    setStorageSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId); else next.add(entryId);
      return next;
    });
  };
  const armStorageSelect = (entryId) => {
    setStorageSelectMode(true);
    setStorageSelectedIds(prev => new Set(prev).add(entryId));
  };
  const exitStorageSelect = () => { setStorageSelectMode(false); setStorageSelectedIds(new Set()); };

  // Cards physically in the open container (any compartment).
  const cardsInActiveLocation = useMemo(
    () => allCards.filter(c => c.location_id === activeLocationId),
    [allCards, activeLocationId]
  );

  const runStorageBulk = async (action, value, confirmMsg) => {
    const ids = Array.from(storageSelectedIds);
    if (ids.length === 0) { showToast('No cards selected.'); return; }
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    try {
      const res = await fetch('/api/collection/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_ids: ids, action, value })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { showToast(data.message || 'Done.'); exitStorageSelect(); await refreshAll(); onUpdate(); }
      else showToast(data.error || 'Bulk action failed.');
    } catch (err) { console.error(err); showToast('Error performing bulk action.'); }
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
        showToast('Failed to update row rules.');
      }
    } catch (err) { console.error(err); showToast('Error updating row rules.'); }
  };

  const handleFileCard = async (entryId, locationId) => {
    try {
      const res = await fetch(`/api/collection/${entryId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.placement?.label) showToast(`Filed → ${data.placement.label}`);
        else if (data.rule_rejected) showToast("Doesn't match this container's filing rule — left Unsorted.");
        else if (data.container_full) showToast('Container full — card left Unsorted.');
        else showToast('Card filed.');
        await refreshAll(); onUpdate();
      }
      else showToast('Failed to file card.');
    } catch (err) { console.error(err); showToast('Error filing card.'); }
  };

  const handleApplyAll = async () => {
    if (!activeLocationId || unsortedCards.length === 0) return;
    const target = locations.find(l => l.id === activeLocationId);
    if (!window.confirm(`Auto-file all ${unsortedCards.length} unsorted card(s) into "${target?.name}"? Cards that don't fit its rules or capacity stay unsorted.`)) return;
    try {
      const res = await fetch(`/api/locations/${activeLocationId}/apply-all`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_ids: unsortedCards.map(c => c.entry_id) })
      });
      const data = await res.json();
      if (res.ok) { showToast(data.message); await refreshAll(); onUpdate(); }
      else showToast(data.error || 'Failed to file batch.');
    } catch (err) { console.error(err); showToast('Error filing batch.'); }
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
      if (!res.ok) { showToast('Failed to start filing mode.'); return; }
      const data = await res.json();
      const placeable = data.filter(d => d.recommended);
      const noRoom = data.filter(d => !d.recommended);

      if (placeable.length === 0) {
        showToast(`No unsorted card fits "${target?.name}". ${noRoom.length} left unsorted — add space or adjust its filing rules.`);
        return;
      }

      setFilingQueue(placeable);
      setFilingIndex(0);
      setFilingMode(true);
      setMoveMode(false);
      setPickedEntryId(null);
      if (noRoom.length > 0) {
        showToast(`Filing ${placeable.length} card(s) into "${target?.name}". ${noRoom.length} don't fit and stay unsorted.`);
      }
    } catch (err) { console.error(err); showToast('Error starting filing mode.'); }
  };

  // Advance the walkthrough one card; end it when past the last card.
  const advanceFiling = () => {
    if (filingIndex < filingQueue.length - 1) {
      setFilingIndex(filingIndex + 1);
    } else {
      showToast(filingReadOnly ? 'Re-sort review complete!' : 'Filing complete!');
      setFilingMode(false);
      setFilingReadOnly(false);
      onUpdate();
    }
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
        showToast('Failed to file card.');
      }
    } catch (err) { console.error(err); showToast('Error filing card.'); }
  };

  const startResort = async () => {
    if (!selectedLoc) return;
    if (!window.confirm(`Re-sort "${selectedLoc.name}" by its current order? This recomputes where every card goes and gives you a card-by-card guide to re-file them physically.`)) return;
    try {
      const res = await fetch(`/api/locations/${selectedLoc.id}/resort`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        await refreshAll();
        if (!Array.isArray(data) || data.length === 0) { showToast('Nothing to re-sort.'); return; }
        setFilingQueue(data);
        setFilingIndex(0);
        setFilingReadOnly(true);
        setFilingMode(true);
        setActiveLocationId(selectedLoc.id);
        showToast('Container re-sorted. Follow the guide to re-file.');
      } else {
        showToast('Failed to re-sort container.');
      }
    } catch (err) { console.error(err); showToast('Error re-sorting container.'); }
  };

  if (loading) return <div className="spinner" />;

  return (
    <div className="storage-workspace-grid">
      {showCreate && (
        <CreateContainerModal
          onClose={() => setShowCreate(false)}
          onCreate={handleCreateLocation}
          setsList={setsList}
          filterFieldOptions={filterFieldOptions}
        />
      )}

      {rulesComp && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }} onClick={() => setRulesComp(null)}>
          <div className="glass-panel" style={{ width: '480px', maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', background: 'var(--bg-secondary)' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: 0 }}>{rulesComp.display_label}: Accepts</h3>
            <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: 0 }}>
              Rules controlling which cards may be filed into this {isBinderType ? 'page' : 'row'}. No rules = accepts anything the container allows.
            </p>
            <FilterBuilder value={compRuleDraft} onChange={setCompRuleDraft} setsList={setsList} fieldOptions={filterFieldOptions} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button className="btn btn-secondary" onClick={() => setRulesComp(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveCompartmentRules}>Save Rules</button>
            </div>
          </div>
        </div>
      )}

      {capacityUpdatePending && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="glass-panel" style={{ width: '400px', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem', background: 'var(--bg-secondary)' }}>
            <h3 style={{ margin: 0 }}>Sync Capacity</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>
              Do you want to apply the capacity <strong>{capacityUpdatePending.capacity}</strong> to ALL compartments in this container, or just this specific one?
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
              <button className="btn btn-secondary" onClick={() => { handleSetCapacity(capacityUpdatePending.id, capacityUpdatePending.capacity, false); setCapacityUpdatePending(null); }}>Just This One</button>
              <button className="btn btn-primary" onClick={() => { handleSetCapacity(capacityUpdatePending.id, capacityUpdatePending.capacity, true); setCapacityUpdatePending(null); }}>Apply To All</button>
            </div>
          </div>
        </div>
      )}

      {showRulesModal && selectedLoc && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="glass-panel" style={{ width: '400px', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem', background: 'var(--bg-secondary)' }}>
            <h3 style={{ margin: 0 }}>Container Settings</h3>
            
            {selectedLoc?.type === 'binder' && (
              <div style={{ background: 'rgba(255, 170, 0, 0.1)', border: '1px solid #d97706', padding: '0.75rem', borderRadius: 'var(--radius-sm)', fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                <strong>Binder Sorting Tip:</strong> When filing brand new cards into a tightly sorted binder, the app will append them to the first empty slot at the end of the binder to prevent cascading shifts of your physical cards. <br/><br/>
                <strong>Best Practice:</strong> File all your new cards into the binder first, then use <strong>Re-sort Container</strong> to shift everything into perfectly sorted order at once!
              </div>
            )}

            <SortBuilder value={sortDraft} onChange={setSortDraft} />
            <FilterBuilder value={filterDraft} onChange={setFilterDraft} setsList={setsList} fieldOptions={filterFieldOptions} />

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
              <button className="btn btn-secondary" onClick={() => setShowRulesModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => {
                handleUpdateLocationFields({
                  sort_order: JSON.stringify(sortDraft),
                  rule_type: filterDraft.length > 0 ? 'compound' : 'any',
                  rule_config: filterDraft.length > 0 ? JSON.stringify({ rules: filterDraft }) : null
                });
                setShowRulesModal(false);
              }}>Save Settings</button>
            </div>
          </div>
        </div>
      )}

      {/* Selected location detail */}
      <div className="glass-panel" style={{ padding: '0.9rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <select
              className="select-control"
              value={activeLocationId || ''}
              onChange={(e) => setActiveLocationId(parseInt(e.target.value, 10))}
              style={{ fontSize: '1rem', fontWeight: 'bold', padding: '0.3rem', width: 'auto', minWidth: '150px' }}
            >
              <option value="" disabled>Select Container...</option>
              {locations.map(loc => <option key={loc.id} value={loc.id}>{loc.name} ({loc.type})</option>)}
            </select>
            <button type="button" className="btn btn-secondary btn-icon-only" onClick={() => setShowCreate(s => !s)} style={{ width: '28px', height: '28px', padding: 0 }} title="Create Container">
              <Plus size={14} />
            </button>
            {selectedLoc && (
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{selectedLoc.total_cards || 0} cards • {compartments.length} compartments</span>
            )}
          </div>
          
          {selectedLoc && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            {!filingMode && !moveMode && (selectedLoc.total_cards || 0) > 0 && (
              <button
                type="button"
                className={`btn ${storageSelectMode ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => (storageSelectMode ? exitStorageSelect() : setStorageSelectMode(true))}
                style={{ fontSize: '0.7rem', padding: '0.3rem 0.6rem' }}
                title="Or long-press a card to start selecting"
              >
                {storageSelectMode ? 'Done' : 'Select'}
              </button>
            )}
            {!filingMode && !storageSelectMode && isCustom && (
              <button
                type="button"
                className={`btn ${moveMode ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => { setMoveMode(m => !m); setPickedEntryId(null); }}
                style={{ fontSize: '0.7rem', padding: '0.3rem 0.6rem' }}
                title="Tap a card, then tap a slot to place or swap it by hand"
              >
                {moveMode ? 'Done Arranging' : 'Arrange'}
              </button>
            )}
            <div className="kebab-menu">
              <button className="kebab-menu-button" onClick={() => setShowKebabMenu(s => !s)}>
                <MoreVertical size={16} color="var(--text-secondary)" />
              </button>
              {showKebabMenu && (
                <div className="kebab-dropdown">
                  <button className="kebab-item" onClick={() => { setShowKebabMenu(false); handleAddCompartment(); }}>
                    <Plus size={14} /> {isBinderType ? 'Add Page' : 'Add Compartment'}
                  </button>
                  <button className="kebab-item" 
                          disabled={compartments.length <= 1 || (cardsByCompartment.get(compartments[compartments.length-1]?.id) || []).length > 0} 
                          onClick={() => { setShowKebabMenu(false); handleRemoveCompartment(compartments[compartments.length-1].id); }}
                          title="Only the last empty row/page can be removed"
                  >
                    <Trash2 size={14} /> {isBinderType ? 'Remove Last Page' : 'Remove Last Compartment'}
                  </button>
                  <button className="kebab-item" onClick={() => { setShowKebabMenu(false); handleAutoAssignCategories(); }}>
                    <LayoutList size={14} /> Auto-Assign Categories
                  </button>
                  <button className="kebab-item" onClick={() => { setShowKebabMenu(false); startResort(); }} disabled={(selectedLoc.total_cards || 0) === 0}>
                    <RefreshCw size={14} /> Re-sort Container
                  </button>
                  <button className="kebab-item" onClick={() => { setShowKebabMenu(false); handleToggleContainerLock(); }} title="A locked container is skipped by Sort & File / Auto-File">
                    {selectedLoc.locked ? <Unlock size={14} /> : <Lock size={14} />} {selectedLoc.locked ? 'Unlock Container' : 'Lock Container'}
                  </button>
                  <button className="kebab-item" onClick={() => {
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
                    setShowRulesModal(true);
                  }}>
                    <Settings size={14} /> Container Settings
                  </button>
                  <button className="kebab-item" onClick={() => { setShowKebabMenu(false); handleDeleteLocation(selectedLoc.id, selectedLoc.name); }} style={{ color: 'var(--accent-red)' }}>
                    <Trash2 size={14} /> Delete Container
                  </button>
                </div>
              )}
            </div>
            </div>
          )}
        </div>

        {storageSelectMode && (
          <div className="glass-panel" style={{ padding: '0.6rem 0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', background: 'rgba(255,71,71,0.08)' }}>
            <span style={{ fontWeight: 800, color: '#fff', fontSize: '0.8rem' }}>{storageSelectedIds.size} selected</span>
            <button className="btn btn-secondary" style={{ fontSize: '0.68rem', padding: '0.25rem 0.5rem' }} onClick={() => setStorageSelectedIds(new Set(cardsInActiveLocation.map(c => c.entry_id)))}>Select all ({cardsInActiveLocation.length})</button>
            <button className="btn btn-secondary" style={{ fontSize: '0.68rem', padding: '0.25rem 0.5rem' }} onClick={() => setStorageSelectedIds(new Set())}>Clear</button>
            <div style={{ width: '1px', height: '20px', background: 'var(--border-glass)' }} />
            <button
              className="btn btn-primary"
              style={{ fontSize: '0.68rem', padding: '0.25rem 0.6rem' }}
              disabled={!storageSelectedIds.size}
              onClick={() => runStorageBulk('move', null, `Remove ${storageSelectedIds.size} card(s) from this container? They move to Unsorted.`)}
            >
              Remove from Storage
            </button>
            <button
              className="btn btn-danger"
              style={{ fontSize: '0.68rem', padding: '0.25rem 0.6rem' }}
              disabled={!storageSelectedIds.size}
              onClick={() => runStorageBulk('delete', null, `Delete ${storageSelectedIds.size} card(s) from your collection? This cannot be undone.`)}
            >
              Delete
            </button>
            <button className="btn btn-secondary" style={{ fontSize: '0.68rem', padding: '0.25rem 0.5rem', marginLeft: 'auto' }} onClick={exitStorageSelect}>Done</button>
          </div>
        )}

        {!selectedLoc ? (
          <p style={{ color: 'var(--text-secondary)' }}>Select a container to view its compartments.</p>
        ) : (
          <>
            {isBinderType && !isCustom && (
              <div style={{ background: 'rgba(255, 170, 0, 0.1)', border: '1px solid #d97706', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-sm)', fontSize: '0.72rem', color: 'var(--text-primary)', lineHeight: 1.4 }}>
                <strong>Heads up:</strong> Sorting &amp; filing renumber pocket positions, so a new card shifts every card after it and your physical binder drifts out of sync. For a fixed pocket layout, set this binder to <strong>Custom</strong> order in Container Settings, then use <strong>Arrange</strong> to place and swap cards by hand.
              </div>
            )}

            {moveMode && (
              <div style={{ background: 'rgba(255,71,71,0.1)', border: '1px solid var(--accent-red)', padding: '0.5rem 0.7rem', borderRadius: 'var(--radius-sm)', fontSize: '0.72rem', color: 'var(--text-primary)' }}>
                {pickedEntryId
                  ? (isBinderType ? 'Now tap a pocket to place it (tap a filled pocket to swap).' : 'Now tap a card to drop it in front of, or an empty slot.')
                  : 'Tap a card here or in Unsorted to pick it up.'}
              </div>
            )}

            {isBinderType && compartments.length > 0 && availableCategories.length > 0 && (
              <div style={{ background: 'rgba(0,0,0,0.1)', padding: '0.4rem 0.6rem', borderRadius: 'var(--radius-sm)' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowCategoryMap(s => !s)}
                  style={{ fontSize: '0.72rem', padding: '0.25rem 0.6rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                >
                  <LayoutList size={13} /> Category to Page map {showCategoryMap ? '▾' : '▸'}
                </button>
                {showCategoryMap && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', marginTop: '0.5rem' }}>
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                      Pick which page each sorting category files onto. Unset pages accept any category.
                    </span>
                    {availableCategories.map(cat => {
                      const owner = compartments.find(c => (c.assignedFilters || []).includes(cat));
                      return (
                        <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ fontSize: '0.72rem', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cat}</span>
                          <select
                            className="select-control"
                            value={owner ? owner.id : ''}
                            onChange={(e) => handleAssignCategoryToPage(cat, e.target.value)}
                            style={{ fontSize: '0.7rem', padding: '0.15rem 0.3rem', width: '140px' }}
                          >
                            <option value="">Any page</option>
                            {compartments.map(c => <option key={c.id} value={c.id}>{c.display_label}</option>)}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {isBinderType && compartments.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '1rem', margin: '0.2rem 0', background: 'rgba(0,0,0,0.1)', padding: '0.4rem', borderRadius: 'var(--radius-sm)' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={activePageIndex <= 0}
                  onClick={() => setActivePageIndex(prev => Math.max(0, isMobile ? prev - 1 : prev - 2))}
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                >
                  &larr; Prev
                </button>
                <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>
                  {isMobile ? (
                    `Page ${activePageIndex + 1} of ${compartments.length}`
                  ) : (
                    `Pages ${Math.floor(activePageIndex / 2) * 2 + 1}${Math.floor(activePageIndex / 2) * 2 + 2 <= compartments.length ? `-${Math.floor(activePageIndex / 2) * 2 + 2}` : ''} of ${compartments.length}`
                  )}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={isMobile ? activePageIndex >= compartments.length - 1 : Math.floor(activePageIndex / 2) * 2 + 2 >= compartments.length}
                  onClick={() => setActivePageIndex(prev => {
                    const next = isMobile ? prev + 1 : prev + 2;
                    return next < compartments.length ? next : prev;
                  })}
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                >
                  Next &rarr;
                </button>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: isBinderType ? '1rem' : '0.6rem' }}>
              {isBinderType ? (() => {
                if (compartments.length === 0) return null;
                const pageProps = (c, i) => ({
                  compartment: c,
                  cards: cardsByCompartment.get(c.id) || [],
                  sortOrder: selectedLoc.sort_order,
                  setsList,
                  canRemove: i === compartments.length - 1 && compartments.length > 1 && (cardsByCompartment.get(c.id) || []).length === 0,
                  moveTargets: compartments,
                  onRename: (label) => handleRenameCompartment(c.id, label),
                  onSetCapacity: (cap) => handleSetCapacity(c.id, cap),
                  onRemove: () => handleRemoveCompartment(c.id),
                  onToggleLock: () => handleToggleCompartmentLock(c.id, !c.locked),
                  onCardClick: setInspectorCard,
                  onDeleteCard: handleDeleteCard,
                  onMoveCard: handleMoveCard,
                  recommendedSpot: currentRecSpot && currentRecSpot.compartment_id === c.id ? {
                    index: Math.floor(currentRecSpot.position / 1000) - 1,
                    image_url: recCard?.image_url,
                    name: recCard?.name,
                    set_name: recCard?.set_name
                  } : null,
                  focusEntryId,
                  selectMode: storageSelectMode,
                  selectedIds: storageSelectedIds,
                  onCardLongPress: armStorageSelect,
                  onCardToggle: toggleStorageSelect,
                  onEditRules: openCompartmentRules,
                  placementMode: moveMode,
                  pickedEntryId,
                  onPickCard: handlePickCard,
                  onPlaceSlot: handlePlaceSlot,
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
                  const spreadIdx = Math.floor(Math.min(activePageIndex, compartments.length - 1) / 2);
                  const leftIdx = spreadIdx * 2;
                  const rightIdx = leftIdx + 1;
                  const left = compartments[leftIdx];
                  const right = compartments[rightIdx];

                  binderPages = (
                    <div className="binder-page-container">
                      <div className="binder-page-left">
                        <CompartmentView {...pageProps(left, leftIdx)} locationType={selectedLoc.type} />
                      </div>
                      <div className="binder-spine" />
                      {right && (
                        <div className="binder-page-right">
                          <CompartmentView {...pageProps(right, rightIdx)} locationType={selectedLoc.type} />
                        </div>
                      )}
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
                          <option value="">Move to...</option>
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
                if (compartments.length === 0) return <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>No compartments/rows in this location.</p>;

                const activeComp = compartments.find(c => c.id === activeCompartmentId) || compartments[0];
                if (!activeComp) return null;
                const activeCompIdx = compartments.findIndex(c => c.id === activeComp.id);

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
                          onChange={(e) => setActiveCompartmentId(parseInt(e.target.value, 10))}
                          style={{ fontSize: '0.8rem', padding: '0.2rem 0.4rem' }}
                        >
                          {compartments.map(c => <option key={c.id} value={c.id}>{c.display_label}</option>)}
                        </select>
                        <button className="btn btn-secondary btn-icon-only" disabled={activeCompIdx >= compartments.length - 1} onClick={() => setActiveCompartmentId(compartments[activeCompIdx + 1]?.id)} style={{ width: '24px', height: '24px', padding: 0 }}>
                          &rarr;
                        </button>
                      </div>
                    </div>
                    
                    <CompartmentView 
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
                      onDeleteCard={handleDeleteCard}
                      onMoveCard={handleMoveCard}
                      recommendedSpot={currentRecSpot && currentRecSpot.compartment_id === activeComp.id ? {
                        index: Math.floor(currentRecSpot.position / 1000) - 1,
                        image_url: recCard?.image_url,
                        name: recCard?.name,
                        set_name: recCard?.set_name
                      } : null}
                      focusEntryId={focusEntryId}
                      targetActiveIndex={coverflowActiveIndex}
                      canRemove={compartments.length > 1 && (cardsByCompartment.get(activeComp.id) || []).length === 0}
                      selectMode={storageSelectMode}
                      selectedIds={storageSelectedIds}
                      onCardLongPress={armStorageSelect}
                      onCardToggle={toggleStorageSelect}
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
      <div className="glass-panel location-unsorted-col" style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', overflowY: 'auto' }}>
        {filingMode ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', height: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: '0.85rem' }}>{filingReadOnly ? 'Re-sort: Re-file Guide' : 'Filing Mode'}</strong>
              <button type="button" className="btn btn-secondary btn-icon-only" onClick={() => { setFilingMode(false); setFilingReadOnly(false); refreshAll(); }} style={{ padding: '0.2rem 0.5rem', width: 'auto', fontSize: '0.7rem' }}>
                {filingReadOnly ? 'Done' : 'Cancel'}
              </button>
            </div>
            {filingReadOnly && (
              <div style={{ textAlign: 'center', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
                Cards already re-sorted in the app. Move each physical card to the spot shown, then tap Next.
              </div>
            )}
            
            <div style={{ textAlign: 'center', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Card {filingIndex + 1} of {filingQueue.length}
            </div>
            
            {filingQueue[filingIndex] && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem', marginTop: '1rem' }}>
                <img src={filingQueue[filingIndex].entry.image_url} alt={filingQueue[filingIndex].entry.name} style={{ width: '120px', borderRadius: '5px', boxShadow: '0 4px 12px rgba(0,0,0,0.4)' }} />
                
                <div style={{ textAlign: 'center' }}>
                  <strong style={{ fontSize: '1rem', display: 'block' }}>{filingQueue[filingIndex].entry.name}</strong>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{filingQueue[filingIndex].entry.set_name} • {filingQueue[filingIndex].entry.printing}</span>
                </div>
                
                {(() => {
                  const rec = filingQueue[filingIndex].recommended;
                  if (!rec) {
                    return (
                      <div style={{ background: 'rgba(255, 71, 71, 0.15)', border: '1px solid #ff4747', borderRadius: 'var(--radius-sm)', padding: '0.75rem', width: '100%', textAlign: 'center' }}>
                        <strong style={{ fontSize: '0.9rem', color: '#fff' }}>
                          {filingQueue[filingIndex].rejected ? "Doesn't match this container's filing rule" : 'Container Full!'}
                        </strong>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                          {filingQueue[filingIndex].rejected ? 'Skip it, or change the rule in Container Settings.' : 'Skip it, or add pages/rows to make room.'}
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div 
                      style={{ background: 'rgba(255, 193, 7, 0.15)', border: '1px solid #ffc107', borderRadius: 'var(--radius-sm)', padding: '0.75rem', width: '100%', textAlign: 'center', cursor: 'pointer', transition: 'all 0.2s' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 193, 7, 0.25)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 193, 7, 0.15)'; }}
                      onClick={() => {
                        if (rec.location_id !== activeLocationId) {
                          setActiveLocationId(rec.location_id);
                        }
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
                            el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
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
                      }}
                      title="Click to snap to this slot in the container"
                    >
                      <div style={{ fontSize: '0.7rem', color: '#ffc107', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 'bold', marginBottom: '0.25rem' }}>Click to Locate</div>
                      <strong style={{ fontSize: '0.9rem', color: '#fff', display: 'block' }}>{rec.label}</strong>
                      <strong style={{ fontSize: '1.2rem', color: '#ffc107', display: 'block', marginTop: '0.25rem' }}>Slot {Math.floor(rec.position / 1000)}</strong>
                      {rec.reason && (
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', marginTop: '0.35rem' }}>{rec.reason}</div>
                      )}
                    </div>
                  );
                })()}
                
                <div style={{ display: 'flex', gap: '0.5rem', width: '100%', marginTop: '0.5rem' }}>
                  <button type="button" className="btn btn-secondary" onClick={advanceFiling} style={{ flex: 1, padding: '0.6rem' }}>
                    Skip
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
                    {filingReadOnly ? 'Next' : 'Placed'}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            <strong style={{ fontSize: '0.85rem' }}>Unsorted ({unsortedCards.length})</strong>

            <input
              className="input-control" placeholder="Search..." value={unsortedSearch}
              onChange={(e) => setUnsortedSearch(e.target.value)} style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem' }}
            />
            <select className="select-control" value={unsortedSort} onChange={(e) => setUnsortedSort(e.target.value)} style={{ fontSize: '0.7rem', padding: '0.3rem 0.5rem' }}>
              <option value="scanned-desc">Scanned (Newest First)</option>
              <option value="scanned-asc">Scanned (Oldest First)</option>
              <option value="name-asc">A-Z</option>
              <option value="price-desc">Value (High-Low)</option>
              <option value="set-number">Set & Number</option>
            </select>

            {unsortedCards.length > 0 && (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={startFilingMode}
                  disabled={!activeLocationId}
                  title={activeLocationId ? 'Walk through filing each fitting card into the open container' : 'Select a container first'}
                  style={{ fontSize: '0.8rem', padding: '0.5rem', width: '100%' }}
                >
                  Sort & File (into open container)
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleApplyAll}
                  disabled={!activeLocationId}
                  title={activeLocationId ? 'File every unsorted card into the open container in one go' : 'Select a container first'}
                  style={{ fontSize: '0.7rem', padding: '0.35rem', width: '100%' }}
                >
                  Auto-File All (into open container)
                </button>
              </>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              {unsortedCards.map(card => {
                const picked = moveMode && pickedEntryId === card.entry_id;
                const onCardTap = moveMode ? () => handlePickCard(card.entry_id) : () => setInspectorCard(card);
                return (
                <div key={card.entry_id} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem', padding: '0.3rem', borderBottom: '1px solid var(--border-glass)', ...(picked ? { background: 'rgba(255,71,71,0.18)', outline: '2px solid var(--accent-red)', borderRadius: '4px' } : {}) }}>
                  <div onClick={onCardTap} title={moveMode ? 'Tap to pick / unpick' : 'View details'} style={{ position: 'relative', width: '48px', flexShrink: 0, overflow: 'hidden', borderRadius: '3px', cursor: 'pointer', ...getCardRarityBorder(card.rarity) }}>
                    <img src={card.image_url} alt={card.name} loading="lazy" decoding="async" style={{ width: '100%', aspectRatio: 0.718, objectFit: 'cover', display: 'block' }} />
                    {getFoilOverlayClass(card.printing) && (
                      <div className={getFoilOverlayClass(card.printing)} style={{ borderRadius: '3px' }} />
                    )}
                  </div>
                  <span
                    onClick={onCardTap}
                    title={moveMode ? 'Tap to pick / unpick' : 'View details'}
                    style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer', fontWeight: picked ? 700 : 400 }}
                  >
                    {picked ? '✓ ' : ''}{card.name}
                  </span>
                  {!moveMode && (
                    <select
                      className="select-control" value=""
                      onChange={(e) => { if (e.target.value) handleFileCard(card.entry_id, parseInt(e.target.value, 10)); }}
                      style={{ fontSize: '0.6rem', padding: '0.15rem 0.25rem', maxWidth: '90px' }}
                    >
                      <option value="">File to...</option>
                      {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  )}
                  {!moveMode && (
                    <button type="button" onClick={() => handleDeleteCard(card.entry_id)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}>
                      <X size={12} />
                    </button>
                  )}
                </div>
                );
              })}
              {unsortedCards.length === 0 && <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>Nothing unsorted.</p>}
            </div>
          </>
        )}
      </div>

      <CardInspectorModal
        card={inspectorCard}
        onClose={() => setInspectorCard(null)}
        onUpdate={onUpdate}
        showToast={showToast}
      />
    </div>
  );
}

export default LocationManager;
