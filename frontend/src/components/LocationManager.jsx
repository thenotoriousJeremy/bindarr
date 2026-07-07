import { useState, useEffect, useMemo, useRef } from 'react';
import { Plus, Trash2, X, MoreVertical, Settings, LayoutList, RefreshCw } from 'lucide-react';
import { sortCardsByOrder } from '../utils/cardSort';
import { getPrintingBadgeLabel, getPrintingBadgeStyle, getFoilOverlayClass } from '../utils/cardPrinting';
import { getCardRarityBorder } from '../utils/cardRarity';
import CardInspectorModal from './CardInspectorModal';
import CompartmentView, { getSortCategory } from './CompartmentView';

const CONTAINER_TYPES = ['Binder', 'Toploader Binder', 'Box', 'Toploader Box', 'Graded Slab Box', 'Display Shelf / Stand', 'Deck Box', 'Tin / Case', 'Other'];

// Mirrors defaultCompartmentPlan in backend/src/routes/collection.js — used to
// prefill the creation form so the user sees (and can adjust) the container's
// shape before it exists.
const DEFAULT_COMPARTMENT_PLANS = {
  'Binder': { count: 30, capacity: 9 },
  'Toploader Binder': { count: 14, capacity: 4 },
  'Box': { count: 3, capacity: 1000 },
  'Toploader Box': { count: 1, capacity: 100 },
  'Graded Slab Box': { count: 1, capacity: 40 },
  'Display Shelf / Stand': { count: 1, capacity: 10 },
  'Deck Box': { count: 1, capacity: 60 },
  'Tin / Case': { count: 1, capacity: 200 },
  'Other': { count: 1, capacity: 1000 }
};

// What a compartment is called for a given container type.
function compartmentNoun(type, plural = true) {
  const isBinder = type === 'Binder' || type === 'Toploader Binder';
  const noun = isBinder ? 'Page' : 'Row';
  return plural ? `${noun}s` : noun;
}

// Base sort schemes a container can use. 'set-number' has a foil-aware
// sub-option (stored as the separate 'set-number-printing' scheme
// server-side) rather than existing as its own top-level entry — from the
// user's perspective it's one scheme with a toggle, not two schemes.
const SORT_BASES = [
  { value: 'custom', label: 'Custom (manual order, next empty slot)' },
  { value: 'name-asc', label: 'A-Z Alphabetical' },
  { value: 'set-number', label: 'Set & Number' },
  { value: 'price-desc', label: 'Value (High-Low)' },
  { value: 'type-name', label: 'Energy Type' },
  { value: 'language', label: 'Language' }
];

// Given a stored sort_order value, splits it into the base scheme shown in
// the main dropdown plus whether the foil-aware sub-option is active.
function splitSortOrder(sortOrder) {
  if (sortOrder === 'set-number-printing') return { base: 'set-number', foilAware: true };
  return { base: sortOrder || 'custom', foilAware: false };
}

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
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('Binder');
  const [newPlanCount, setNewPlanCount] = useState(DEFAULT_COMPARTMENT_PLANS['Binder'].count);
  const [newPlanCapacity, setNewPlanCapacity] = useState(DEFAULT_COMPARTMENT_PLANS['Binder'].capacity);

  const [capacityUpdatePending, setCapacityUpdatePending] = useState(null);
  const [showKebabMenu, setShowKebabMenu] = useState(false);
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [ruleTypeDraft, setRuleTypeDraft] = useState('any');
  const [ruleStartDraft, setRuleStartDraft] = useState('a');
  const [ruleEndDraft, setRuleEndDraft] = useState('z');
  const [ruleSetsDraft, setRuleSetsDraft] = useState([]);
  const [ruleSetSearch, setRuleSetSearch] = useState('');

  const [inspectorCard, setInspectorCard] = useState(null);

  const [unsortedSearch, setUnsortedSearch] = useState('');
  const [unsortedSort, setUnsortedSort] = useState('scanned-desc');

  const [activePageIndex, setActivePageIndex] = useState(0);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

  const [filingMode, setFilingMode] = useState(false);
  const [filingQueue, setFilingQueue] = useState([]);
  const [filingIndex, setFilingIndex] = useState(0);
  // Re-sort review reuses the filing UI, but the cards are already placed in the
  // DB by /resort — so "Placed" just advances instead of issuing a move.
  const [filingReadOnly, setFilingReadOnly] = useState(false);

  // The recommended slot for the card currently under review in filing mode —
  // drives the ghost preview shown in the container view.
  const currentRecSpot = filingMode ? (filingQueue[filingIndex]?.recommended || null) : null;
  const recCard = filingMode && filingQueue[filingIndex]?.recommended ? filingQueue[filingIndex].entry : null;

  // Declared here (not lower) because the filing-mode effect below reads
  // isBinderType in its dependency array, which is evaluated during render —
  // a lower `const` would be in the temporal dead zone at that point.
  const selectedLoc = locations.find(l => l.id === activeLocationId);
  const isBinderType = selectedLoc?.type === 'Binder' || selectedLoc?.type === 'Toploader Binder';

  useEffect(() => {
    if (filingMode && filingQueue[filingIndex]?.recommended) {
      const rec = filingQueue[filingIndex].recommended;
      // A card's home may be a different container than the one open (Sort &
      // File spans every container) — switch to it, then compartments reload
      // and this effect reruns to snap to the right page/row.
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
          el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
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
  const [showRowSets, setShowRowSets] = useState(false);

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

  const coverflowTouchStartRef = useRef(0);

  const handleCoverflowTouchStart = (e) => {
    coverflowTouchStartRef.current = e.changedTouches[0].clientX;
  };

  const handleCoverflowTouchEnd = (e, totalCards) => {
    const endX = e.changedTouches[0].clientX;
    const diffX = coverflowTouchStartRef.current - endX;
    const threshold = 40;
    if (diffX > threshold) {
      setCoverflowActiveIndex(prev => Math.min(totalCards - 1, prev + 1));
    } else if (diffX < -threshold) {
      setCoverflowActiveIndex(prev => Math.max(0, prev - 1));
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
    setCoverflowActiveIndex(0);
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
      const cat = getSortCategory(c, selectedLoc?.sort_order, setsList);
      if (cat) cats.add(cat);
    });
    return Array.from(cats).sort();
  }, [allCards, selectedLoc?.sort_order, setsList]);

  // Set names the user actually owns cards from — the default choices in the
  // specific-sets filter picker so it isn't the entire set catalog by default.
  const ownedSetNames = useMemo(() => {
    const s = new Set();
    allCards.forEach(c => { if (c.set_name) s.add(c.set_name); });
    return s;
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

  const handleCreateLocation = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      const res = await fetch('/api/locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          type: newType,
          compartmentPlan: {
            count: Math.max(1, parseInt(newPlanCount, 10) || 1),
            capacity: Math.max(1, parseInt(newPlanCapacity, 10) || 1)
          }
        })
      });
      const data = await res.json();
      if (res.ok) {
        showToast('Storage container created!');
        setNewName('');
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
        showToast('Container updated.');
        await fetchLocations();
      } else {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Failed to update container.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error updating container.');
    }
  };
  const handleUpdateLocationField = (field, value) => handleUpdateLocationFields({ [field]: value });

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

  const handleToggleCompartmentFilter = async (compartment, filterVal) => {
    const current = compartment.assignedFilters || [];
    const next = current.includes(filterVal) ? current.filter(s => s !== filterVal) : [...current, filterVal];
    try {
      await fetch(`/api/compartments/${compartment.id}/filters`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filters: next }) });
      await fetchCompartments(activeLocationId);
    } catch (err) { console.error(err); showToast('Error updating filter assignment.'); }
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

  const handleRemoveFromContainer = async (entryId) => {
    try {
      const res = await fetch(`/api/collection/${entryId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: null, compartment_id: null })
      });
      if (res.ok) { showToast('Card removed from container.'); await refreshAll(); }
      else {
        const errData = await res.json().catch(()=>({}));
        showToast(errData.error || 'Failed to remove card from container.');
      }
    } catch (err) { console.error(err); showToast('Error updating card.'); }
  };

  const handleDeleteCard = async (entryId) => {
    if (!window.confirm('Remove this card from your collection?')) return;
    try {
      const res = await fetch(`/api/collection/${entryId}`, { method: 'DELETE' });
      if (res.ok) { showToast('Card removed.'); await refreshAll(); onUpdate(); }
      else showToast('Failed to remove card.');
    } catch (err) { console.error(err); showToast('Error removing card.'); }
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
    if (unsortedCards.length === 0 || locations.length === 0) return;
    try {
      // Ask across every container where each card can go, then walk through
      // only the ones that actually have a home. Cards that fit nowhere are
      // reported and left in the Unsorted queue.
      const res = await fetch('/api/smart-recommend-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_ids: unsortedCards.map(c => c.entry_id) })
      });
      if (!res.ok) { showToast('Failed to start filing mode.'); return; }
      const data = await res.json();
      const placeable = data.filter(d => d.recommended);
      const noRoom = data.filter(d => !d.recommended);

      if (placeable.length === 0) {
        showToast(`No unsorted card fits any container. ${noRoom.length} left unsorted — add space or adjust filing rules.`);
        return;
      }

      setFilingQueue(placeable);
      setFilingIndex(0);
      setFilingMode(true);
      if (placeable[0].recommended.location_id) {
        setActiveLocationId(placeable[0].recommended.location_id);
      }
      if (noRoom.length > 0) {
        showToast(`Filing ${placeable.length} card(s). ${noRoom.length} have nowhere to go and stay unsorted.`);
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
      {capacityUpdatePending && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="glass-panel" style={{ width: '400px', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
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
          <div className="glass-panel" style={{ width: '400px', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <h3 style={{ margin: 0 }}>Container Settings</h3>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 'bold' }}>Sort Method</label>
              <select
                className="select-control"
                value={splitSortOrder(selectedLoc.sort_order).base}
                onChange={(e) => {
                  const foilAware = splitSortOrder(selectedLoc.sort_order).foilAware;
                  handleUpdateLocationField('sort_order', e.target.value === 'set-number' && foilAware ? 'set-number-printing' : e.target.value);
                }}
              >
                {SORT_BASES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            
            {splitSortOrder(selectedLoc.sort_order).base === 'set-number' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem' }}>
                  <input type="checkbox" checked={splitSortOrder(selectedLoc.sort_order).foilAware} onChange={(e) => handleUpdateLocationField('sort_order', e.target.checked ? 'set-number-printing' : 'set-number')} />
                  Split by printing (foil-aware)
                </label>
                {splitSortOrder(selectedLoc.sort_order).foilAware && (
                  <div style={{ display: 'flex', gap: '4px' }}>
                    {[{ v: 'normals_first', label: 'Normals First' }, { v: 'foils_first', label: 'Foils First' }].map(opt => (
                      <button
                        key={opt.v}
                        type="button"
                        onClick={() => handleUpdateLocationField('foil_sorting', opt.v)}
                        className={`btn ${(selectedLoc.foil_sorting || 'normals_first') === opt.v ? 'btn-primary' : 'btn-secondary'}`}
                        style={{ fontSize: '0.6rem', padding: '0.2rem 0.4rem' }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border-glass)', paddingTop: '1rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 'bold' }}>Filing Rule</label>
              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                Controls which cards this container accepts when filing automatically.
              </span>
              <select className="select-control" value={ruleTypeDraft} onChange={(e) => setRuleTypeDraft(e.target.value)}>
                <option value="any">Accept Any Card</option>
                <option value="alphabetical_range">Alphabetical Range (e.g. A-M)</option>
                <option value="specific_sets">Specific Sets</option>
              </select>

              {ruleTypeDraft === 'alphabetical_range' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem' }}>
                  <span>Card names from</span>
                  <input
                    className="input-control" maxLength={1} value={ruleStartDraft}
                    onChange={(e) => setRuleStartDraft(e.target.value.toLowerCase())}
                    style={{ width: '40px', textAlign: 'center', textTransform: 'uppercase' }}
                  />
                  <span>to</span>
                  <input
                    className="input-control" maxLength={1} value={ruleEndDraft}
                    onChange={(e) => setRuleEndDraft(e.target.value.toLowerCase())}
                    style={{ width: '40px', textAlign: 'center', textTransform: 'uppercase' }}
                  />
                </div>
              )}

              {ruleTypeDraft === 'specific_sets' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <input
                    className="input-control"
                    placeholder="Search all sets to add..."
                    value={ruleSetSearch}
                    onChange={(e) => setRuleSetSearch(e.target.value)}
                    style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem' }}
                  />
                  {(() => {
                    // No search: only sets you own cards from (the common case).
                    // Searching: the full catalog, filtered by name.
                    const q = ruleSetSearch.trim().toLowerCase();
                    const list = setsList.filter(s => q ? s.name.toLowerCase().includes(q) : ownedSetNames.has(s.name));
                    return (
                      <>
                        <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                          {q
                            ? `${list.length} matching set${list.length === 1 ? '' : 's'}`
                            : `${list.length} set${list.length === 1 ? '' : 's'} in your collection — search to add others`}
                        </div>
                        <div style={{ maxHeight: '160px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', padding: '0.25rem' }}>
                          {list.length === 0 ? (
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', padding: '0.25rem' }}>
                              {q ? 'No sets match.' : 'No cards in your collection yet — search to add sets.'}
                            </span>
                          ) : list.map(s => {
                            const on = ruleSetsDraft.includes(s.name);
                            return (
                              <button
                                type="button" key={s.id}
                                onClick={() => setRuleSetsDraft(prev => prev.includes(s.name) ? prev.filter(x => x !== s.name) : [...prev, s.name])}
                                className="kebab-item"
                                style={{ fontSize: '0.72rem', padding: '0.3rem 0.4rem', background: on ? 'rgba(255,71,71,0.15)' : 'transparent', borderRadius: '3px' }}
                              >
                                <span style={{ width: '0.9rem', flexShrink: 0 }}>{on ? '✓' : ''}</span>{s.name}
                              </button>
                            );
                          })}
                        </div>
                      </>
                    );
                  })()}
                  {ruleSetsDraft.length === 0 ? (
                    <span style={{ fontSize: '0.65rem', color: 'var(--accent-red)' }}>No sets selected — this container would reject every card.</span>
                  ) : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                      {ruleSetsDraft.map(name => (
                        <span key={name} className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', fontSize: '0.65rem', padding: '0.1rem 0.35rem', background: 'var(--accent-red)', borderRadius: '3px' }}>
                          {name}
                          <span style={{ cursor: 'pointer', fontWeight: 'bold' }} onClick={() => setRuleSetsDraft(prev => prev.filter(s => s !== name))}>&times;</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
              <button className="btn btn-secondary" onClick={() => setShowRulesModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => {
                const conf = ruleTypeDraft === 'alphabetical_range'
                  ? { start: (ruleStartDraft || 'a').toLowerCase(), end: (ruleEndDraft || 'z').toLowerCase() }
                  : ruleTypeDraft === 'specific_sets'
                    ? { sets: ruleSetsDraft }
                    : null;
                handleUpdateLocationFields({ rule_type: ruleTypeDraft, rule_config: conf });
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
                  <button className="kebab-item" onClick={() => {
                    setShowKebabMenu(false);
                    setRuleTypeDraft(selectedLoc.rule_type || 'any');
                    // Parse the stored rule into the structured drafts; tolerate
                    // legacy double-encoded strings from the old raw-JSON editor.
                    let cfg = {};
                    try { cfg = selectedLoc.rule_config ? JSON.parse(selectedLoc.rule_config) : {}; } catch { cfg = {}; }
                    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch { cfg = {}; } }
                    setRuleStartDraft(cfg.start || 'a');
                    setRuleEndDraft(cfg.end || 'z');
                    setRuleSetsDraft(Array.isArray(cfg.sets) ? cfg.sets : []);
                    setRuleSetSearch('');
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
          )}
        </div>

        {showCreate && (
          <form onSubmit={handleCreateLocation} style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', padding: '0.5rem', background: 'rgba(0,0,0,0.2)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
              <input className="input-control" placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem', flex: 1, minWidth: '110px' }} />
              <select
                className="select-control" value={newType}
                onChange={(e) => {
                  const t = e.target.value;
                  setNewType(t);
                  const plan = DEFAULT_COMPARTMENT_PLANS[t] || DEFAULT_COMPARTMENT_PLANS['Other'];
                  setNewPlanCount(plan.count);
                  setNewPlanCapacity(plan.capacity);
                }}
                style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem' }}
              >
                {CONTAINER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                {compartmentNoun(newType)}:
                <input type="number" min="1" className="input-control" value={newPlanCount} onChange={(e) => setNewPlanCount(e.target.value)} style={{ width: '55px', fontSize: '0.75rem', padding: '0.2rem 0.3rem' }} />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                Cards per {compartmentNoun(newType, false).toLowerCase()}:
                <input type="number" min="1" className="input-control" value={newPlanCapacity} onChange={(e) => setNewPlanCapacity(e.target.value)} style={{ width: '60px', fontSize: '0.75rem', padding: '0.2rem 0.3rem' }} />
              </label>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: '0.4rem' }}>
                <button type="submit" className="btn btn-primary" style={{ fontSize: '0.75rem', padding: '0.35rem' }}>Create</button>
                <button type="button" className="btn btn-secondary" onClick={() => setShowCreate(false)} style={{ fontSize: '0.75rem', padding: '0.35rem' }}>Cancel</button>
              </span>
            </div>
          </form>
        )}

        {!selectedLoc ? (
          <p style={{ color: 'var(--text-secondary)' }}>Select a container to view its compartments.</p>
        ) : (
          <>
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
                const pageProps = (c, idx) => ({
                  compartment: c,
                  cards: cardsByCompartment.get(c.id) || [],
                  sortOrder: selectedLoc.sort_order,
                  availableFilters: availableCategories, setsList,
                  canRemove: idx === compartments.length - 1 && compartments.length > 1 && (cardsByCompartment.get(c.id) || []).length === 0,
                  moveTargets: compartments,
                  onRename: (label) => handleRenameCompartment(c.id, label),
                  onSetCapacity: (cap) => handleSetCapacity(c.id, cap),
                  onToggleFilter: (filterVal) => handleToggleCompartmentFilter(c, filterVal),
                  onRemove: () => handleRemoveCompartment(c.id),
                  onDeleteCard: handleDeleteCard,
                  onMoveCard: handleMoveCard,
                  recommendedSpot: currentRecSpot && currentRecSpot.compartment_id === c.id ? {
                    index: Math.floor(currentRecSpot.position / 1000) - 1,
                    image_url: recCard?.image_url,
                    name: recCard?.name,
                    set_name: recCard?.set_name
                  } : null,
                  focusEntryId
                });

                if (isMobile) {
                  const targetIdx = Math.min(activePageIndex, compartments.length - 1);
                  const activePage = compartments[targetIdx];
                  if (!activePage) return null;
                  return (
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

                  return (
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
                          const posIdx = Math.floor(rec.position / 1000) - 1;
                          setCoverflowActiveIndex(Math.max(0, posIdx));
                        }
                        let attempts = 0;
                        const tryScroll = () => {
                          const el = document.getElementById('recommended-spot');
                          if (el) {
                            el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
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
                  disabled={locations.length === 0}
                  title={locations.length === 0 ? 'Create a container first' : 'File the cards that fit any container, walking through each spot'}
                  style={{ fontSize: '0.8rem', padding: '0.5rem', width: '100%' }}
                >
                  Sort & File Cards
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
              {unsortedCards.map(card => (
                <div key={card.entry_id} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem', padding: '0.3rem 0', borderBottom: '1px solid var(--border-glass)' }}>
                  <div onClick={() => setInspectorCard(card)} title="View details" style={{ position: 'relative', width: '48px', flexShrink: 0, overflow: 'hidden', borderRadius: '3px', cursor: 'pointer', ...getCardRarityBorder(card.rarity) }}>
                    <img src={card.image_url} alt={card.name} style={{ width: '100%', aspectRatio: 0.718, objectFit: 'cover', display: 'block' }} />
                    {getFoilOverlayClass(card.printing) && (
                      <div className={getFoilOverlayClass(card.printing)} style={{ borderRadius: '3px' }} />
                    )}
                  </div>
                  <span
                    onClick={() => setInspectorCard(card)}
                    title="View details"
                    style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                  >
                    {card.name}
                  </span>
                  <select
                    className="select-control" value=""
                    onChange={(e) => { if (e.target.value) handleFileCard(card.entry_id, parseInt(e.target.value, 10)); }}
                    style={{ fontSize: '0.6rem', padding: '0.15rem 0.25rem', maxWidth: '90px' }}
                  >
                    <option value="">File to...</option>
                    {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                  <button type="button" onClick={() => handleDeleteCard(card.entry_id)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}>
                    <X size={12} />
                  </button>
                </div>
              ))}
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
