import { useState, useEffect, useMemo, useRef } from 'react';
import { Search, Trash2, Edit2, LayoutGrid, List, SlidersHorizontal, X, MousePointerClick } from 'lucide-react';
import { getCardDisplayName, translateJapaneseName } from '../utils/langHelper';
import { formatPrice } from '../utils/formatPrice';
import { CONDITIONS, PRINTINGS } from '../utils/cardOptions';
import { getPrintingBadgeLabel, getPrintingBadgeStyle, getFoilOverlayClass } from '../utils/cardPrinting';
import { getCardRarityBorder, getRarityBadgeLabel, getRarityBadgeStyle } from '../utils/cardRarity';
import { sortCardsByOrder } from '../utils/cardSort';
import CardInspectorModal from './CardInspectorModal';
import PackPriceSplitter from './PackPriceSplitter';

const labelStyle = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' };

// Maps each Sort By option to sortCardsByOrder criteria so ordering matches the
// storage engine (set = chronological via setsList, type = POKEMON_TYPE_ORDER).
// 'qty-desc' isn't a card-order scheme, handled separately.
const SORT_CRITERIA = {
  'added-newest': [{ by: 'added_at', dir: 'desc' }, { by: 'entry_id', dir: 'desc' }],
  'added-oldest': [{ by: 'added_at', dir: 'asc' }],
  'name-asc': [{ by: 'name', dir: 'asc' }],
  'name-desc': [{ by: 'name', dir: 'desc' }],
  'price-desc': [{ by: 'price', dir: 'desc' }],
  'price-asc': [{ by: 'price', dir: 'asc' }],
  'set-asc': [{ by: 'set', dir: 'asc' }, { by: 'number', dir: 'asc' }],
  'number-asc': [{ by: 'number', dir: 'asc' }, { by: 'name', dir: 'asc' }],
  'rarity-asc': [{ by: 'rarity', dir: 'asc' }, { by: 'name', dir: 'asc' }],
  'type-asc': [{ by: 'type', dir: 'asc' }, { by: 'name', dir: 'asc' }],
  'language-asc': [{ by: 'language', dir: 'asc' }, { by: 'name', dir: 'asc' }],
  'favorite-first': [{ by: 'favorite', dir: 'desc' }, { by: 'added_at', dir: 'desc' }],
};

// Small labelled field wrapper to keep the filter grid uniform.
function Field({ label, children }) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

function CollectionList({ statsTrigger, onUpdate, showToast, selectedCardFilter, setSelectedCardFilter, onNavigate, setSelectedLocationId }) {
  const [collection, setCollection] = useState([]);
  const [locations, setLocations] = useState([]);
  const [setsList, setSetsList] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (selectedCardFilter) {
      setSearchFilter(selectedCardFilter);
      // Reset after applying so they can clear search manually
      setSelectedCardFilter('');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCardFilter]);

  // UX view state
  const [viewMode, setViewMode] = useState('gallery'); // 'gallery' or 'list'
  const [inspectorCard, setInspectorCard] = useState(null);
  const [inspectorStartEdit, setInspectorStartEdit] = useState(false);
  const [subTab, setSubTab] = useState('collection'); // 'collection', 'wishlist'
  const [showFilters, setShowFilters] = useState(false);

  // Search & Filter state
  const [searchFilter, setSearchFilter] = useState('');
  const [gameFilter, setGameFilter] = useState(() => localStorage.getItem('default_game') || ''); // '' | 'pokemon' | 'mtg'
  const [locationFilter, setLocationFilter] = useState('');
  const [rarityFilter, setRarityFilter] = useState('');
  const [conditionFilter, setConditionFilter] = useState('');
  const [printingFilter, setPrintingFilter] = useState('');
  const [setFilter, setSetFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [supertypeFilter, setSupertypeFilter] = useState('');
  const [cmcFilter, setCmcFilter] = useState('');
  const [languageFilter, setLanguageFilter] = useState('');
  const [minPriceFilter, setMinPriceFilter] = useState('');
  const [maxPriceFilter, setMaxPriceFilter] = useState('');
  const [sortBy, setSortBy] = useState('added-newest');
  const [tradeOnly, setTradeOnly] = useState(false);
  const [favoriteOnly, setFavoriteOnly] = useState(false);

  // Stacking state
  const [stackCards, setStackCards] = useState(false);
  const [stackByCondition, setStackByCondition] = useState(false);
  const [stackByPrinting, setStackByPrinting] = useState(false);

  // Multi-select / bulk actions
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkMoveTarget, setBulkMoveTarget] = useState('');

  // Long-press-to-arm selection (works for mouse + touch via pointer events).
  const longPressTimer = useRef(null);
  const longPressFired = useRef(false);
  const pointerStart = useRef(null);

  useEffect(() => () => clearTimeout(longPressTimer.current), []);

  useEffect(() => {
    fetchCollection();
    fetchLocations();
    fetchSets();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsTrigger, subTab, tradeOnly]);

  const fetchCollection = async () => {
    try {
      setLoading(true);
      let url = '/api/collection?list_type=collection';
      if (subTab === 'wishlist') {
        url = '/api/collection?list_type=wishlist';
      }
      if (tradeOnly) {
        url += '&is_trade=1';
      }

      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        setCollection(data);
      }
    } catch (err) {
      console.error(err);
      showToast('Error loading collection.');
    } finally {
      setLoading(false);
    }
  };

  const fetchLocations = async () => {
    try {
      const response = await fetch('/api/locations');
      if (response.ok) {
        const data = await response.json();
        setLocations(data);
      }
    } catch (err) {
      console.error('Error fetching locations:', err);
    }
  };

  const fetchSets = async () => {
    try {
      const response = await fetch('/api/sets');
      if (response.ok) setSetsList(await response.json());
    } catch (err) {
      console.error('Error fetching sets:', err);
    }
  };

  const handleDelete = async (entryId, cardName) => {
    if (!window.confirm(`Are you sure you want to delete ${cardName} from your collection?`)) {
      return;
    }

    try {
      const response = await fetch(`/api/collection/${entryId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        showToast(`${cardName} removed from collection.`);
        onUpdate();
      } else {
        showToast('Failed to delete card.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error connecting to backend.');
    }
  };

  const openEdit = (item) => {
    setInspectorCard(item);
    setInspectorStartEdit(true);
  };

  const toggleSelect = (entryId) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId); else next.add(entryId);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());
  const exitSelectMode = () => { setSelectMode(false); clearSelection(); setBulkMoveTarget(''); };

  // --- Long-press handlers ---
  const beginPress = (e, entryId) => {
    longPressFired.current = false;
    pointerStart.current = { x: e.clientX, y: e.clientY };
    clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      setSelectMode(true);
      setSelectedIds(prev => new Set(prev).add(entryId));
      if (navigator.vibrate) navigator.vibrate(25);
    }, 450);
  };
  const movePress = (e) => {
    if (!pointerStart.current) return;
    if (Math.abs(e.clientX - pointerStart.current.x) > 10 || Math.abs(e.clientY - pointerStart.current.y) > 10) {
      clearTimeout(longPressTimer.current);
    }
  };
  const endPress = () => { clearTimeout(longPressTimer.current); pointerStart.current = null; };

  // Tap: swallowed if a long-press just armed selection; otherwise toggle (in
  // select mode) or open the inspector.
  const activateCard = (item) => {
    if (longPressFired.current) { longPressFired.current = false; return; }
    if (selectMode) toggleSelect(item.entry_id);
    else { setInspectorCard(item); setInspectorStartEdit(false); }
  };
  const pressHandlers = (entryId) => ({
    onPointerDown: (e) => beginPress(e, entryId),
    onPointerMove: movePress,
    onPointerUp: endPress,
    onPointerLeave: endPress,
    onContextMenu: (e) => e.preventDefault(), // suppress mobile long-press image popup
  });

  // Runs one bulk action against every selected entry via the bulk endpoint.
  const runBulk = async (action, value, confirmMsg) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) { showToast('No cards selected.'); return; }
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    try {
      const res = await fetch('/api/collection/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_ids: ids, action, value })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast(data.message || 'Done.');
        clearSelection();
        onUpdate();
        fetchCollection();
      } else {
        showToast(data.error || 'Bulk action failed.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error performing bulk action.');
    }
  };

  const handleViewStorage = (card) => {
    setInspectorCard(null);
    if (setSelectedLocationId) {
      setSelectedLocationId(card.location_id || 'unassigned');
    }
    if (onNavigate) {
      onNavigate('storage');
    }
  };

  // Extract unique filter values from the loaded collection.
  const uniqueRarities = useMemo(
    () => Array.from(new Set(collection.map(item => item.rarity).filter(Boolean))).sort(),
    [collection]
  );
  const uniqueSets = useMemo(
    () => Array.from(new Set(collection.map(item => item.set_name).filter(Boolean))).sort(),
    [collection]
  );
  const uniqueTypes = useMemo(
    () => Array.from(new Set(collection.flatMap(item => item.types || []).filter(Boolean))).sort(),
    [collection]
  );
  const uniqueSupertypes = useMemo(
    () => Array.from(new Set(collection.map(item => item.supertype).filter(Boolean))).sort(),
    [collection]
  );
  const uniqueLanguages = useMemo(
    () => Array.from(new Set(collection.map(item => item.language).filter(Boolean))).sort(),
    [collection]
  );
  const uniqueCmcs = useMemo(
    () => Array.from(new Set(collection.map(item => item.cmc).filter(v => v !== null && v !== undefined))).sort((a, b) => a - b),
    [collection]
  );

  const activeFilterCount = [
    gameFilter, locationFilter, rarityFilter, conditionFilter, printingFilter,
    setFilter, typeFilter, supertypeFilter, cmcFilter, languageFilter,
    minPriceFilter, maxPriceFilter
  ].filter(v => v !== '').length + (tradeOnly ? 1 : 0) + (favoriteOnly ? 1 : 0);

  const clearAllFilters = () => {
    setSearchFilter('');
    setGameFilter(''); setLocationFilter(''); setRarityFilter(''); setConditionFilter('');
    setPrintingFilter(''); setSetFilter(''); setTypeFilter(''); setSupertypeFilter('');
    setCmcFilter(''); setLanguageFilter(''); setMinPriceFilter('');
    setMaxPriceFilter(''); setTradeOnly(false); setFavoriteOnly(false);
  };

  // Filter + sort
  const filteredCollection = useMemo(() => {
    const translatedSearch = searchFilter ? (translateJapaneseName(searchFilter) || searchFilter).toLowerCase() : '';
    const result = collection.filter(item => {
      const matchesSearch = item.name.toLowerCase().includes(translatedSearch) ||
                            (item.set_name || '').toLowerCase().includes(translatedSearch) ||
                            (item.number || '').includes(searchFilter);
      const matchesLocation = locationFilter === '' ? true :
                              locationFilter === 'unassigned' ? !item.location_id :
                              item.location_id == locationFilter;
      const matchesGame = gameFilter === '' ? true : (item.game || 'pokemon') === gameFilter;
      const matchesRarity = rarityFilter === '' ? true : item.rarity === rarityFilter;
      const matchesCondition = conditionFilter === '' ? true : item.condition === conditionFilter;
      const matchesPrinting = printingFilter === '' ? true : item.printing === printingFilter;
      const matchesSet = setFilter === '' ? true : item.set_name === setFilter;
      const matchesType = typeFilter === '' ? true : (item.types || []).includes(typeFilter);
      const matchesSupertype = supertypeFilter === '' ? true : item.supertype === supertypeFilter;
      const matchesCmc = cmcFilter === '' ? true : String(item.cmc) === cmcFilter;
      const matchesLanguage = languageFilter === '' ? true : item.language === languageFilter;
      const matchesFavorite = favoriteOnly ? item.favorite === 1 : true;

      const price = item.price_trend || 0;
      const matchesMinPrice = minPriceFilter === '' ? true : price >= parseFloat(minPriceFilter);
      const matchesMaxPrice = maxPriceFilter === '' ? true : price <= parseFloat(maxPriceFilter);

      return matchesSearch && matchesGame && matchesLocation && matchesRarity && matchesCondition &&
             matchesPrinting && matchesSet && matchesType && matchesSupertype &&
             matchesCmc && matchesLanguage && matchesFavorite && matchesMinPrice && matchesMaxPrice;
    });

    if (sortBy === 'qty-desc') {
      result.sort((a, b) => (b.quantity || 0) - (a.quantity || 0));
    } else {
      sortCardsByOrder(result, SORT_CRITERIA[sortBy] || SORT_CRITERIA['added-newest'], undefined, setsList);
    }
    return result;
  }, [collection, searchFilter, gameFilter, locationFilter, rarityFilter, conditionFilter, printingFilter, setFilter, typeFilter, supertypeFilter, cmcFilter, languageFilter, favoriteOnly, minPriceFilter, maxPriceFilter, sortBy, setsList]);

  // Group duplicate cards if stack option is active
  const processedCollection = useMemo(() => {
    if (!stackCards) return filteredCollection;

    const groups = {};
    filteredCollection.forEach(item => {
      let key = item.card_id;
      if (stackByCondition) key += `-${item.condition}`;
      if (stackByPrinting) key += `-${item.printing}`;

      if (!groups[key]) {
        groups[key] = { ...item };
      } else {
        groups[key].quantity += item.quantity;
      }
    });
    return Object.values(groups);
  }, [filteredCollection, stackCards, stackByCondition, stackByPrinting]);

  // In select mode, render the unstacked list so every entry is individually
  // selectable and bulk actions hit real entry_ids (stacking merges rows).
  const displayCards = selectMode ? filteredCollection : processedCollection;

  const totalValue = useMemo(
    () => displayCards.reduce((sum, item) => sum + (item.price_trend || 0) * (item.quantity || 1), 0),
    [displayCards]
  );

  return (
    <div>
      {/* Header: sub-tabs + selection hint + view toggle */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            className={`btn ${subTab === 'collection' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setSubTab('collection')}
            style={{ fontSize: '0.85rem', padding: '0.45rem 1.25rem', borderRadius: 'var(--radius-sm)' }}
          >
            Collection
          </button>
          <button
            className={`btn ${subTab === 'wishlist' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setSubTab('wishlist')}
            style={{ fontSize: '0.85rem', padding: '0.45rem 1.25rem', borderRadius: 'var(--radius-sm)' }}
          >
            Wishlist
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          {/* Multi-select toggle (long-press cards is the primary path) */}
          <button
            className={`btn ${selectMode ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            style={{ fontSize: '0.8rem', padding: '0.4rem 0.9rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
            title="Or long-press any card to start selecting"
          >
            <MousePointerClick size={14} />
            {selectMode ? 'Done' : 'Select'}
          </button>

          {/* View Toggle */}
          <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
            <button
              className={`btn btn-icon-only ${viewMode === 'gallery' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setViewMode('gallery')}
              style={{ borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.5rem', width: '32px', height: '32px' }}
              title="Gallery View"
            >
              <LayoutGrid size={14} />
            </button>
            <button
              className={`btn btn-icon-only ${viewMode === 'list' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setViewMode('list')}
              style={{ borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.5rem', width: '32px', height: '32px' }}
              title="List Table View"
            >
              <List size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Filter Panel */}
      <div className="glass-panel" style={{ marginBottom: '1.5rem', padding: '1rem 1.25rem' }}>
        {/* Always-visible top bar: search + sort + filters toggle */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2.5fr) minmax(150px, 1fr) auto', gap: '0.75rem', alignItems: 'flex-end' }}>
          <Field label="Search Cards">
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                className="input-control"
                placeholder="Search name, set, card number..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                style={{ width: '100%', paddingLeft: '2.5rem' }}
              />
              <Search size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            </div>
          </Field>

          <Field label="Sort By">
            <select className="select-control" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="added-newest">Added (Newest)</option>
              <option value="added-oldest">Added (Oldest)</option>
              <option value="name-asc">Name (A-Z)</option>
              <option value="name-desc">Name (Z-A)</option>
              <option value="price-desc">Value (High-Low)</option>
              <option value="price-asc">Value (Low-High)</option>
              <option value="qty-desc">Quantity (High-Low)</option>
              <option value="set-asc">Set</option>
              <option value="number-asc">Card Number</option>
              <option value="type-asc">Type / Color</option>
              <option value="rarity-asc">Rarity</option>
              <option value="language-asc">Language</option>
              <option value="favorite-first">Favorites First</option>
            </select>
          </Field>

          <button
            className={`btn ${showFilters ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setShowFilters(s => !s)}
            style={{ padding: '0.5rem 0.9rem', height: '40px', display: 'inline-flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap' }}
          >
            <SlidersHorizontal size={15} />
            Filters
            {activeFilterCount > 0 && (
              <span style={{ background: 'var(--accent-red)', color: '#fff', fontSize: '0.65rem', fontWeight: 900, borderRadius: '999px', padding: '1px 7px', minWidth: '18px', textAlign: 'center' }}>
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        {showFilters && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border-glass)' }}>
            {/* Selector filters grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.75rem' }}>
              <Field label="Game">
                <select className="select-control" value={gameFilter} onChange={(e) => setGameFilter(e.target.value)}>
                  <option value="">All Games</option>
                  <option value="pokemon">Pokémon</option>
                  <option value="mtg">Magic: The Gathering</option>
                </select>
              </Field>

              <Field label="Location">
                <select className="select-control" value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)}>
                  <option value="">All Locations</option>
                  <option value="unassigned">Unassigned Pile</option>
                  {locations.map(loc => (
                    <option key={loc.id} value={loc.id}>{loc.name}</option>
                  ))}
                </select>
              </Field>

              <Field label="Set">
                <select className="select-control" value={setFilter} onChange={(e) => setSetFilter(e.target.value)}>
                  <option value="">All Sets</option>
                  {uniqueSets.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>

              <Field label="Supertype">
                <select className="select-control" value={supertypeFilter} onChange={(e) => setSupertypeFilter(e.target.value)}>
                  <option value="">All Supertypes</option>
                  {uniqueSupertypes.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>

              <Field label="Type / Color">
                <select className="select-control" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                  <option value="">All Types</option>
                  {uniqueTypes.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>

              <Field label="Rarity">
                <select className="select-control" value={rarityFilter} onChange={(e) => setRarityFilter(e.target.value)}>
                  <option value="">All Rarities</option>
                  {uniqueRarities.map(rarity => (
                    <option key={rarity} value={rarity}>{rarity}</option>
                  ))}
                </select>
              </Field>

              <Field label="Condition">
                <select className="select-control" value={conditionFilter} onChange={(e) => setConditionFilter(e.target.value)}>
                  <option value="">All Conditions</option>
                  {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>

              <Field label="Printing">
                <select className="select-control" value={printingFilter} onChange={(e) => setPrintingFilter(e.target.value)}>
                  <option value="">All Printings</option>
                  {PRINTINGS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </Field>

              {uniqueCmcs.length > 0 && (
                <Field label="Mana Value">
                  <select className="select-control" value={cmcFilter} onChange={(e) => setCmcFilter(e.target.value)}>
                    <option value="">All Mana Values</option>
                    {uniqueCmcs.map(c => <option key={c} value={String(c)}>{c}</option>)}
                  </select>
                </Field>
              )}

              <Field label="Language">
                <select className="select-control" value={languageFilter} onChange={(e) => setLanguageFilter(e.target.value)}>
                  <option value="">All Languages</option>
                  {uniqueLanguages.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </Field>

              <Field label="Min Price">
                <input type="number" className="input-control" placeholder="Min $" value={minPriceFilter} onChange={(e) => setMinPriceFilter(e.target.value)} />
              </Field>

              <Field label="Max Price">
                <input type="number" className="input-control" placeholder="Max $" value={maxPriceFilter} onChange={(e) => setMaxPriceFilter(e.target.value)} />
              </Field>
            </div>

            {/* Options row: stacking + trade + clear */}
            <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--border-glass)', paddingTop: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="checkbox" id="stackCardsOpt" checked={stackCards} onChange={(e) => setStackCards(e.target.checked)} style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                <label htmlFor="stackCardsOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.8rem', fontWeight: 700, color: '#fff' }}>
                  Stack Duplicates
                </label>
              </div>

              {stackCards && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input type="checkbox" id="stackByConditionOpt" checked={stackByCondition} onChange={(e) => setStackByCondition(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                    <label htmlFor="stackByConditionOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      Split by Condition
                    </label>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input type="checkbox" id="stackByPrintingOpt" checked={stackByPrinting} onChange={(e) => setStackByPrinting(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                    <label htmlFor="stackByPrintingOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      Split by Holo/Printing
                    </label>
                  </div>
                </>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="checkbox" id="tradeOnlyOpt" checked={tradeOnly} onChange={(e) => setTradeOnly(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                <label htmlFor="tradeOnlyOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--accent-yellow)', fontWeight: 600 }}>
                  For Trade Only
                </label>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="checkbox" id="favoriteOnlyOpt" checked={favoriteOnly} onChange={(e) => setFavoriteOnly(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                <label htmlFor="favoriteOnlyOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: '#facc15', fontWeight: 600 }}>
                  Favorites Only
                </label>
              </div>

              {activeFilterCount > 0 && (
                <button className="btn btn-secondary" onClick={clearAllFilters} style={{ marginLeft: 'auto', fontSize: '0.72rem', padding: '0.3rem 0.7rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                  <X size={13} /> Clear filters
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Result summary bar */}
      {!loading && !selectMode && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.85rem', fontSize: '0.78rem', color: 'var(--text-secondary)', flexWrap: 'wrap', gap: '0.5rem' }}>
          <span><strong style={{ color: '#fff' }}>{displayCards.length}</strong> {displayCards.length === 1 ? 'card' : 'cards'}</span>
          <span>Total value <strong style={{ color: 'var(--accent-yellow)' }}>${formatPrice(totalValue)}</strong></span>
        </div>
      )}

      {/* Bulk action bar */}
      {selectMode && (
        <div className="glass-panel" style={{ marginBottom: '1rem', padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', position: 'sticky', top: '0.5rem', zIndex: 30 }}>
          <span style={{ fontWeight: 800, color: '#fff', fontSize: '0.85rem' }}>{selectedIds.size} selected</span>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} onClick={() => setSelectedIds(new Set(filteredCollection.map(i => i.entry_id)))}>Select all ({filteredCollection.length})</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} onClick={clearSelection}>Clear</button>
          <div style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />
          <button className="btn btn-danger" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('delete', null, `Delete ${selectedIds.size} selected card(s)? This cannot be undone.`)}>Delete</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('trade', null)}>Mark Trade</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('untrade', null)}>Untrade</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('list_type', subTab === 'wishlist' ? 'collection' : 'wishlist', null)}>{subTab === 'wishlist' ? 'Move to Collection' : 'Move to Wishlist'}</button>
          <div style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />
          <select className="select-control" value="" disabled={!selectedIds.size} onChange={(e) => { if (e.target.value) runBulk('condition', e.target.value); e.target.value = ''; }} style={{ fontSize: '0.72rem', maxWidth: '150px', padding: '0.3rem 0.4rem' }}>
            <option value="">Set condition…</option>
            {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="select-control" value="" disabled={!selectedIds.size} onChange={(e) => { if (e.target.value) runBulk('printing', e.target.value); e.target.value = ''; }} style={{ fontSize: '0.72rem', maxWidth: '150px', padding: '0.3rem 0.4rem' }}>
            <option value="">Set printing…</option>
            {PRINTINGS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <div style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />
          <PackPriceSplitter
            entryIds={Array.from(selectedIds)}
            showToast={showToast}
            onApplied={() => { clearSelection(); onUpdate(); fetchCollection(); }}
          />
          <select className="select-control" value={bulkMoveTarget} onChange={(e) => setBulkMoveTarget(e.target.value)} style={{ fontSize: '0.72rem', maxWidth: '170px', padding: '0.3rem 0.4rem' }}>
            <option value="">Move to container…</option>
            <option value="unassign">Unassigned Pile</option>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <button className="btn btn-primary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!bulkMoveTarget || !selectedIds.size} onClick={() => runBulk('move', bulkMoveTarget === 'unassign' ? null : bulkMoveTarget)}>Apply Move</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem', marginLeft: 'auto' }} onClick={exitSelectMode}>Done</button>
        </div>
      )}

      {loading ? (
        <div className="spinner"></div>
      ) : displayCards.length === 0 ? (
        <div className="glass-panel" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '3rem 1.5rem' }}>
          <p>No cards matched your filters. {activeFilterCount > 0 ? 'Try clearing some filters.' : 'Add some cards!'}</p>
        </div>
      ) : viewMode === 'gallery' ? (
        /* Visual Cards Grid Gallery View */
        <div className="card-grid">
          {displayCards.map((item) => {
            const rarityStyle = getCardRarityBorder(item.rarity);
            const selected = selectedIds.has(item.entry_id);

            return (
              <div
                key={item.entry_id}
                className="tcg-card tilt-card-wrapper"
                style={{ cursor: 'pointer', touchAction: 'pan-y' }}
                onClick={() => activateCard(item)}
                {...pressHandlers(item.entry_id)}
              >
                <div className="tcg-card-inner" style={{ ...rarityStyle, ...(selected ? { outline: '3px solid var(--accent-red)', outlineOffset: '2px' } : {}) }}>
                  {selectMode && (
                    <div style={{ position: 'absolute', top: '6px', right: '6px', zIndex: 20, width: '22px', height: '22px', borderRadius: '50%', background: selected ? 'var(--accent-red)' : 'rgba(0,0,0,0.6)', border: '2px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '0.8rem', fontWeight: 900 }}>{selected ? '✓' : ''}</div>
                  )}
                  <img src={item.image_url} alt={item.name} className="tcg-card-image" loading="lazy" draggable={false} />
                  {getFoilOverlayClass(item.printing) && (
                    <div className={getFoilOverlayClass(item.printing)} style={{ borderRadius: 'var(--radius-sm)' }} />
                  )}
                  {item.quantity > 1 && (
                    <div className="tcg-card-quantity-tag">x{item.quantity}</div>
                  )}

                  {/* Rarity badge (shared tier system, matches Storage view) */}
                  <span style={{
                    position: 'absolute',
                    top: '6px',
                    left: '6px',
                    fontSize: '0.55rem',
                    fontWeight: 900,
                    padding: '2px 4px',
                    borderRadius: '3px',
                    zIndex: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
                    ...getRarityBadgeStyle(item.rarity)
                  }}>
                    {getRarityBadgeLabel(item.rarity)}
                  </span>

                  {/* Overlay Tags */}
                  <div style={{
                    position: 'absolute',
                    bottom: '6px',
                    left: '6px',
                    right: '6px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '4px',
                    pointerEvents: 'none'
                  }}>
                    <span style={{
                      fontSize: '0.6rem',
                      fontWeight: 800,
                      padding: '2px 5px',
                      borderRadius: '3px',
                      background: 'rgba(0, 0, 0, 0.75)',
                      color: '#fff',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      textTransform: 'uppercase'
                    }}>
                      {item.condition === 'Near Mint' ? 'NM' :
                       item.condition === 'Lightly Played' ? 'LP' :
                       item.condition === 'Moderately Played' ? 'MP' :
                       item.condition === 'Heavily Played' ? 'HP' : 'DMG'}
                    </span>
                    {item.printing !== 'Normal' && (
                      <span style={{
                        fontSize: '0.6rem',
                        fontWeight: 800,
                        padding: '2px 5px',
                        borderRadius: '3px',
                        ...getPrintingBadgeStyle(item.printing),
                        border: '1px solid rgba(255, 255, 255, 0.2)'
                      }}>
                        {getPrintingBadgeLabel(item.printing)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="tcg-card-info">
                  <div className="tcg-card-name">{getCardDisplayName(item.name, item.language)}</div>
                  <div className="tcg-card-meta">
                    <span style={{ fontSize: '0.7rem' }}>{item.set_name} • #{item.number}</span>
                    <span className="tcg-card-price">${formatPrice(item.price_trend)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* Traditional List Table View */
        <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowY: 'auto' }}>
            <table className="collection-table" style={{ minWidth: 0 }}>
              <thead>
                <tr>
                  <th>Card</th>
                  <th style={{ width: '70px', textAlign: 'right' }}>Qty / Value</th>
                </tr>
              </thead>
              <tbody>
                {displayCards.map((item) => {
                  const selected = selectedIds.has(item.entry_id);
                  return (
                  <tr key={item.entry_id} style={selected ? { background: 'rgba(255,71,71,0.12)' } : undefined}>
                    <td>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        {selectMode && (
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleSelect(item.entry_id)}
                            style={{ width: '18px', height: '18px', flexShrink: 0, cursor: 'pointer' }}
                          />
                        )}
                        <div
                          onClick={() => activateCard(item)}
                          {...pressHandlers(item.entry_id)}
                          style={{ position: 'relative', width: '36px', height: '50px', flexShrink: 0, overflow: 'hidden', borderRadius: '4px', cursor: 'pointer', touchAction: 'pan-y', ...getCardRarityBorder(item.rarity) }}
                        >
                          <img src={item.image_url} alt={item.name} className="collection-row-thumbnail" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '4px' }} draggable={false} />
                          {getFoilOverlayClass(item.printing) && (
                            <div className={getFoilOverlayClass(item.printing)} style={{ borderRadius: '4px' }} />
                          )}
                        </div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div onClick={() => activateCard(item)} {...pressHandlers(item.entry_id)} style={{ fontWeight: 700, color: '#fff', fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}>{getCardDisplayName(item.name, item.language)}</div>
                          <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                            <span>{item.set_name} • #{item.number}</span>
                            <span style={{ fontSize: '0.55rem', fontWeight: 800, padding: '1px 3px', borderRadius: '3px', flexShrink: 0, ...getRarityBadgeStyle(item.rarity) }}>
                              {getRarityBadgeLabel(item.rarity)}
                            </span>
                          </div>
                          <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                            {item.printing} • {item.condition}
                          </div>
                          {!selectMode && (
                            <div style={{ display: 'flex', gap: '0.35rem', marginTop: '2px' }}>
                              <button className="btn btn-secondary btn-icon-only" style={{ width: '18px', height: '18px', padding: 0, borderRadius: '3px' }} onClick={() => openEdit(item)} title="Edit">
                                <Edit2 size={9} />
                              </button>
                              <button className="btn btn-danger btn-icon-only" style={{ width: '18px', height: '18px', padding: 0, borderRadius: '3px' }} onClick={() => handleDelete(item.entry_id, item.name)} title="Delete">
                                <Trash2 size={9} />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', verticalAlign: 'top', paddingTop: '0.6rem' }}>
                      {item.quantity > 1 && (
                        <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.85rem' }}>x{item.quantity}</div>
                      )}
                      <div style={{ fontSize: '0.7rem', color: 'var(--accent-yellow)', fontWeight: 600 }}>${formatPrice(item.price_trend)}</div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Card Detail Inspector Modal (Private Authorized View) */}
      <CardInspectorModal
        card={inspectorCard}
        startInEdit={inspectorStartEdit}
        onClose={() => { setInspectorCard(null); setInspectorStartEdit(false); }}
        onUpdate={onUpdate}
        showToast={showToast}
        onViewStorage={handleViewStorage}
      />
    </div>
  );
}

export default CollectionList;
