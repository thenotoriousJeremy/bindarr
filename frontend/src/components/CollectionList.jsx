import { useState, useEffect, useMemo } from 'react';
import { Search, Trash2, Edit2, LayoutGrid, List, SlidersHorizontal, X, MousePointerClick } from 'lucide-react';
import { getCardDisplayName, translateJapaneseName } from '../utils/langHelper';
import { formatPrice, priceText } from '../utils/formatPrice';
import { CONDITIONS, PRINTINGS, GRADERS } from '../utils/cardOptions';
import { getPrintingBadgeLabel, getPrintingBadgeStyle, getFoilOverlayClass } from '../utils/cardPrinting';
import { getCardRarityBorder, getRarityBadgeLabel, getRarityBadgeStyle } from '../utils/cardRarity';
import { sortCardsByOrder } from '../utils/cardSort';
import { useMultiSelect } from '../utils/useMultiSelect';
import { defaultGameFilter, gameOptions, isGameEnabled, showGamePicker } from '../utils/games';
import { useT } from '../utils/i18n';
import CardInspectorModal from './CardInspectorModal';
import AddToDeckSelect from './AddToDeckSelect';
import PackPriceSplitter from './PackPriceSplitter';
import CardImage from './CardImage';
import MultiSelectDropdown from './MultiSelectDropdown';

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
  'rarity-desc': [{ by: 'rarity', dir: 'desc' }, { by: 'name', dir: 'asc' }],
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

function CollectionList({ statsTrigger, onUpdate, showToast, selectedCardFilter, setSelectedCardFilter, onNavigate, setSelectedLocationId, setFocusEntryId }) {
  const { t } = useT();
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
  // '' | 'pokemon' | 'mtg'. Falls back to a visible game if the Settings default
  // has since been hidden.
  const [gameFilter, setGameFilter] = useState(() => (isGameEnabled(localStorage.getItem('default_game')) ? localStorage.getItem('default_game') : defaultGameFilter()));
  const [locationFilter, setLocationFilter] = useState([]);
  const [rarityFilter, setRarityFilter] = useState([]);
  const [conditionFilter, setConditionFilter] = useState([]);
  const [graderFilter, setGraderFilter] = useState([]);
  const [printingFilter, setPrintingFilter] = useState([]);
  const [setFilter, setSetFilter] = useState([]);
  const [typeFilter, setTypeFilter] = useState([]);
  const [supertypeFilter, setSupertypeFilter] = useState([]);
  const [cmcFilter, setCmcFilter] = useState([]);
  const [languageFilter, setLanguageFilter] = useState([]);
  const [minPriceFilter, setMinPriceFilter] = useState('');
  const [maxPriceFilter, setMaxPriceFilter] = useState('');
  const [sortBy, setSortBy] = useState('added-newest');
  const [tradeOnly, setTradeOnly] = useState(false);
  const [favoriteOnly, setFavoriteOnly] = useState(false);

  // Stacking state (default to stacked)
  const [stackCards, setStackCards] = useState(true);
  const [stackByCondition, setStackByCondition] = useState(false);
  const [stackByPrinting, setStackByPrinting] = useState(false);

  // Multi-select / bulk actions — shared long-press + /api/collection/bulk logic.
  const {
    selectMode, setSelectMode, selectedIds, setSelectedIds, toggleSelect, selectAt, clearSelection, exitSelectMode,
    bulkMoveTarget, setBulkMoveTarget, pressHandlers, longPressFired, runBulk,
  } = useMultiSelect({ showToast, onChanged: () => { onUpdate(); fetchCollection(); } });

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
      showToast(t('collection.errLoad'));
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
    if (!window.confirm(t('collection.confirmDeleteCard', { name: cardName }))) {
      return;
    }

    try {
      const response = await fetch(`/api/collection/${entryId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        showToast(t('collection.cardRemoved', { name: cardName }));
        onUpdate();
      } else {
        showToast(t('collection.errDelete'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('common.errBackend'));
    }
  };

  const openEdit = (item) => {
    setInspectorCard(item);
    setInspectorStartEdit(true);
  };

  // Tap: swallowed if a long-press just armed selection; otherwise toggle (in
  // select mode) or open the inspector.
  const activateCard = (item, event) => {
    if (longPressFired.current) { longPressFired.current = false; return; }
    if (selectMode) selectAt(item.entry_id, displayCards.map(i => i.entry_id), event?.shiftKey);
    else { setInspectorCard(item); setInspectorStartEdit(false); }
  };

  const handleViewStorage = (card) => {
    setInspectorCard(null);
    if (setSelectedLocationId) {
      setSelectedLocationId(card.location_id || 'unsorted');
    }
    if (setFocusEntryId) {
      setFocusEntryId(card.entry_id || card.id);
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

  const activeFilterCount =
    [locationFilter, rarityFilter, conditionFilter, graderFilter, printingFilter,
    setFilter, typeFilter, supertypeFilter, cmcFilter, languageFilter]
      .filter(v => v.length > 0).length
    + (gameFilter !== '' ? 1 : 0)
    + (minPriceFilter !== '' ? 1 : 0)
    + (maxPriceFilter !== '' ? 1 : 0)
    + (tradeOnly ? 1 : 0)
    + (favoriteOnly ? 1 : 0);

  const clearAllFilters = () => {
    setSearchFilter('');
    setGameFilter('');
    setLocationFilter([]); setRarityFilter([]); setConditionFilter([]); setGraderFilter([]);
    setPrintingFilter([]); setSetFilter([]); setTypeFilter([]); setSupertypeFilter([]);
    setCmcFilter([]); setLanguageFilter([]);
    setMinPriceFilter(''); setMaxPriceFilter('');
    setTradeOnly(false); setFavoriteOnly(false);
  };

  // Filter + sort
  const filteredCollection = useMemo(() => {
    const translatedSearch = searchFilter ? (translateJapaneseName(searchFilter) || searchFilter).toLowerCase() : '';
    // The raw query is matched against the localized name as well as the
    // translated one: a Japanese Magic card is stored under its English `name`,
    // so typing 稲妻 only finds it via printed_name.
    const rawSearch = searchFilter.toLowerCase();
    const result = collection.filter(item => {
      const matchesSearch = item.name.toLowerCase().includes(translatedSearch) ||
                            (item.printed_name || '').toLowerCase().includes(rawSearch) ||
                            (item.set_name || '').toLowerCase().includes(translatedSearch) ||
                            (item.number || '').includes(searchFilter);
      const matchesLocation = locationFilter.length === 0 ? true :
                              locationFilter.some(f => f === 'unassigned' ? !item.location_id : item.location_id == f);
      // "All games" still means only the games the user has chosen to see: a hidden
      // game's cards stay in the collection (and in exports) but are out of view.
      const itemGame = item.game || 'pokemon';
      const matchesGame = gameFilter === '' ? isGameEnabled(itemGame) : itemGame === gameFilter;
      const matchesRarity = rarityFilter.length === 0 ? true : rarityFilter.includes(item.rarity);
      const matchesCondition = conditionFilter.length === 0 ? true : conditionFilter.includes(item.condition);
      const matchesPrinting = printingFilter.length === 0 ? true : printingFilter.includes(item.printing);
      const matchesSet = setFilter.length === 0 ? true : setFilter.includes(item.set_name);
      const matchesType = typeFilter.length === 0 ? true : typeFilter.some(t => (item.types || []).includes(t));
      const matchesSupertype = supertypeFilter.length === 0 ? true : supertypeFilter.includes(item.supertype);
      const matchesCmc = cmcFilter.length === 0 ? true : cmcFilter.includes(String(item.cmc));
      const matchesLanguage = languageFilter.length === 0 ? true : languageFilter.includes(item.language);
      const matchesFavorite = favoriteOnly ? item.favorite === 1 : true;
      // Rows written before grading existed have a NULL grader, which means raw —
      // so the comparison defaults rather than treating NULL as its own category.
      const itemGrader = item.grader || 'Raw';
      const matchesGrader = graderFilter.length === 0 ? true
        : graderFilter.some(f => f === '__graded' ? itemGrader !== 'Raw' : itemGrader === f);

      const price = item.price_trend || 0;
      const matchesMinPrice = minPriceFilter === '' ? true : price >= parseFloat(minPriceFilter);
      const matchesMaxPrice = maxPriceFilter === '' ? true : price <= parseFloat(maxPriceFilter);

      return matchesSearch && matchesGame && matchesLocation && matchesRarity && matchesCondition &&
             matchesPrinting && matchesSet && matchesType && matchesSupertype &&
             matchesCmc && matchesLanguage && matchesFavorite && matchesGrader && matchesMinPrice && matchesMaxPrice;
    });

    if (sortBy === 'qty-desc') {
      result.sort((a, b) => (b.quantity || 0) - (a.quantity || 0));
    } else {
      sortCardsByOrder(result, SORT_CRITERIA[sortBy] || SORT_CRITERIA['added-newest'], undefined, setsList);
    }
    return result;
  }, [collection, searchFilter, gameFilter, locationFilter, rarityFilter, conditionFilter, printingFilter, setFilter, typeFilter, supertypeFilter, cmcFilter, languageFilter, favoriteOnly, graderFilter, minPriceFilter, maxPriceFilter, sortBy, setsList]);

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
            {t('nav.collection')}
          </button>
          <button
            className={`btn ${subTab === 'wishlist' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setSubTab('wishlist')}
            style={{ fontSize: '0.85rem', padding: '0.45rem 1.25rem', borderRadius: 'var(--radius-sm)' }}
          >
            {t('collection.wishlist')}
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          {/* Multi-select toggle (long-press cards is the primary path) */}
          <button
            className={`btn ${selectMode ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            style={{ fontSize: '0.8rem', padding: '0.4rem 0.9rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
            title={t('collection.selectHint')}
          >
            <MousePointerClick size={14} />
            {t(selectMode ? 'bulk.done' : 'collection.select')}
          </button>

          {/* View Toggle */}
          <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
            <button
              className={`btn btn-icon-only ${viewMode === 'gallery' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setViewMode('gallery')}
              style={{ borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.5rem', width: '32px', height: '32px' }}
              title={t('collection.galleryView')}
            >
              <LayoutGrid size={14} />
            </button>
            <button
              className={`btn btn-icon-only ${viewMode === 'list' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setViewMode('list')}
              style={{ borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.5rem', width: '32px', height: '32px' }}
              title={t('collection.listView')}
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
          <Field label={t('collection.searchLabel')}>
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                className="input-control"
                placeholder={t('collection.searchPlaceholder')}
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                style={{ width: '100%', paddingLeft: '2.5rem' }}
              />
              <Search size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            </div>
          </Field>

          <Field label={t('collection.sortBy')}>
            <select className="select-control" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              {['added-newest', 'added-oldest', 'name-asc', 'name-desc', 'price-desc', 'price-asc', 'qty-desc', 'set-asc', 'number-asc', 'type-asc', 'rarity-desc', 'rarity-asc', 'language-asc', 'favorite-first']
                .map(key => <option key={key} value={key}>{t(`collection.sort.${key}`)}</option>)}
            </select>
          </Field>

          <button
            className={`btn ${showFilters ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setShowFilters(s => !s)}
            style={{ padding: '0.5rem 0.9rem', height: '40px', display: 'inline-flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap' }}
          >
            <SlidersHorizontal size={15} />
            {t('collection.filters')}
            {activeFilterCount > 0 && (
              <span style={{ background: 'var(--accent-red)', color: 'var(--text-strong)', fontSize: '0.65rem', fontWeight: 900, borderRadius: '999px', padding: '1px 7px', minWidth: '18px', textAlign: 'center' }}>
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        {showFilters && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border-glass)' }}>
            {/* Selector filters grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.75rem' }}>
              {/* Nothing to filter when only one game is shown. */}
              {showGamePicker() && (
                <Field label={t('collection.fGame')}>
                  <select className="select-control" value={gameFilter} onChange={(e) => setGameFilter(e.target.value)}>
                    <option value="">{t('collection.allGames')}</option>
                    {gameOptions().map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                  </select>
                </Field>
              )}

              <Field label={t('collection.fLocation')}>
                <MultiSelectDropdown
                  label={t('collection.fLocation')}
                  allLabel={t('collection.allLocations')}
                  value={locationFilter}
                  onChange={setLocationFilter}
                  options={[
                    { value: 'unassigned', label: t('bulk.unassignedPile') },
                    ...locations.map(loc => ({ value: loc.id, label: loc.name }))
                  ]}
                />
              </Field>

              <Field label={t('collection.fSet')}>
                <MultiSelectDropdown
                  label={t('collection.fSet')}
                  allLabel={t('collection.allSets')}
                  value={setFilter}
                  onChange={setSetFilter}
                  options={uniqueSets.map(s => ({ value: s, label: s }))}
                />
              </Field>

              <Field label={t('collection.fSupertype')}>
                <MultiSelectDropdown
                  label={t('collection.fSupertype')}
                  allLabel={t('collection.allSupertypes')}
                  value={supertypeFilter}
                  onChange={setSupertypeFilter}
                  options={uniqueSupertypes.map(s => ({ value: s, label: s }))}
                />
              </Field>

              <Field label={t('collection.fType')}>
                <MultiSelectDropdown
                  label={t('collection.fType')}
                  allLabel={t('collection.allTypes')}
                  value={typeFilter}
                  onChange={setTypeFilter}
                  options={uniqueTypes.map(t => ({value: t, label: t}))}
                />
              </Field>

              <Field label={t('collection.fRarity')}>
                <MultiSelectDropdown
                  label={t('collection.fRarity')}
                  allLabel={t('collection.allRarities')}
                  value={rarityFilter}
                  onChange={setRarityFilter}
                  options={uniqueRarities.map(r => ({value: r, label: r}))}
                />
              </Field>

              <Field label={t('card.condition')}>
                <MultiSelectDropdown
                  label={t('card.condition')}
                  allLabel={t('collection.allConditions')}
                  value={conditionFilter}
                  onChange={setConditionFilter}
                  options={CONDITIONS.map(c => ({value: c, label: c}))}
                />
              </Field>

              <Field label={t('card.printing')}>
                <MultiSelectDropdown
                  label={t('card.printing')}
                  allLabel={t('collection.allPrintings')}
                  value={printingFilter}
                  onChange={setPrintingFilter}
                  options={PRINTINGS.map(p => ({value: p, label: p}))}
                />
              </Field>

              {/* 'Any graded' earns its own entry above the per-company options:
                  "show me my slabs" is the question people actually ask, and
                  answering it otherwise means selecting each grader in turn. */}
              <Field label={t('card.grader')}>
                <MultiSelectDropdown
                  label={t('card.grader')}
                  allLabel={t('collection.allGraders')}
                  value={graderFilter}
                  onChange={setGraderFilter}
                  options={[
                    { value: '__graded', label: t('collection.anyGraded') },
                    ...GRADERS.map(g => ({ value: g, label: g === 'Raw' ? t('card.graderRaw') : g }))
                  ]}
                />
              </Field>

              {uniqueCmcs.length > 0 && (
                <Field label={t('collection.fManaValue')}>
                  <MultiSelectDropdown
                    label={t('collection.fManaValue')}
                    allLabel={t('collection.allManaValues')}
                    value={cmcFilter}
                    onChange={setCmcFilter}
                    options={uniqueCmcs.map(c => ({ value: String(c), label: String(c) }))}
                  />
                </Field>
              )}

              <Field label={t('card.language')}>
                <MultiSelectDropdown
                  label={t('card.language')}
                  allLabel={t('collection.allLanguages')}
                  value={languageFilter}
                  onChange={setLanguageFilter}
                  options={uniqueLanguages.map(l => ({ value: l, label: l }))}
                />
              </Field>

              <Field label={t('collection.fMinPrice')}>
                <input type="number" className="input-control" placeholder={t('collection.minPricePlaceholder')} value={minPriceFilter} onChange={(e) => setMinPriceFilter(e.target.value)} />
              </Field>

              <Field label={t('collection.fMaxPrice')}>
                <input type="number" className="input-control" placeholder={t('collection.maxPricePlaceholder')} value={maxPriceFilter} onChange={(e) => setMaxPriceFilter(e.target.value)} />
              </Field>
            </div>

            {/* Options row: stacking + trade + clear */}
            <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--border-glass)', paddingTop: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="checkbox" id="stackCardsOpt" checked={stackCards} onChange={(e) => setStackCards(e.target.checked)} style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                <label htmlFor="stackCardsOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)' }}>
                  {t('collection.stackDuplicates')}
                </label>
              </div>

              {stackCards && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input type="checkbox" id="stackByConditionOpt" checked={stackByCondition} onChange={(e) => setStackByCondition(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                    <label htmlFor="stackByConditionOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {t('collection.splitByCondition')}
                    </label>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input type="checkbox" id="stackByPrintingOpt" checked={stackByPrinting} onChange={(e) => setStackByPrinting(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                    <label htmlFor="stackByPrintingOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {t('collection.splitByPrinting')}
                    </label>
                  </div>
                </>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="checkbox" id="tradeOnlyOpt" checked={tradeOnly} onChange={(e) => setTradeOnly(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                <label htmlFor="tradeOnlyOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--accent-yellow)', fontWeight: 600 }}>
                  {t('collection.tradeOnly')}
                </label>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="checkbox" id="favoriteOnlyOpt" checked={favoriteOnly} onChange={(e) => setFavoriteOnly(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                <label htmlFor="favoriteOnlyOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: '#facc15', fontWeight: 600 }}>
                  {t('collection.favoritesOnly')}
                </label>
              </div>

              {activeFilterCount > 0 && (
                <button className="btn btn-secondary" onClick={clearAllFilters} style={{ marginLeft: 'auto', fontSize: '0.72rem', padding: '0.3rem 0.7rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                  <X size={13} /> {t('collection.clearFilters')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Result summary bar */}
      {!loading && !selectMode && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.85rem', fontSize: '0.78rem', color: 'var(--text-secondary)', flexWrap: 'wrap', gap: '0.5rem' }}>
          <span><strong style={{ color: 'var(--text-strong)' }}>{displayCards.length}</strong> {t('collection.cardUnit', { count: displayCards.length })}</span>
          <span>{t('collection.totalValue')} <strong style={{ color: 'var(--accent-yellow)' }}>{priceText(totalValue)}</strong></span>
        </div>
      )}

      {/* Bulk action bar */}
      {selectMode && (
        <div className="glass-panel" style={{ marginBottom: '1rem', padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', position: 'sticky', top: '0.5rem', zIndex: 30 }}>
          <span style={{ fontWeight: 800, color: 'var(--text-strong)', fontSize: '0.85rem' }}>{t('bulk.selected', { count: selectedIds.size })}</span>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} onClick={() => setSelectedIds(new Set(filteredCollection.map(i => i.entry_id)))}>{t('bulk.selectAll', { count: filteredCollection.length })}</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} onClick={clearSelection}>{t('bulk.clear')}</button>
          <div style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />
          <button className="btn btn-danger" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('delete', null, t('bulk.confirmDelete', { count: selectedIds.size }))}>{t('bulk.delete')}</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('trade', null)}>{t('bulk.markTrade')}</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('untrade', null)}>{t('bulk.untrade')}</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('list_type', subTab === 'wishlist' ? 'collection' : 'wishlist', null)}>{t(subTab === 'wishlist' ? 'bulk.moveToCollection' : 'bulk.moveToWishlist')}</button>
          <div style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />
          <select className="select-control" value="" disabled={!selectedIds.size} onChange={(e) => { if (e.target.value) runBulk('condition', e.target.value); e.target.value = ''; }} style={{ fontSize: '0.72rem', maxWidth: '150px', padding: '0.3rem 0.4rem' }}>
            <option value="">{t('bulk.setCondition')}</option>
            {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="select-control" value="" disabled={!selectedIds.size} onChange={(e) => { if (e.target.value) runBulk('printing', e.target.value); e.target.value = ''; }} style={{ fontSize: '0.72rem', maxWidth: '150px', padding: '0.3rem 0.4rem' }}>
            <option value="">{t('bulk.setPrinting')}</option>
            {PRINTINGS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <div style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />
          <PackPriceSplitter
            entryIds={Array.from(selectedIds)}
            showToast={showToast}
            onApplied={() => { clearSelection(); onUpdate(); fetchCollection(); }}
          />
          <select className="select-control" value={bulkMoveTarget} onChange={(e) => setBulkMoveTarget(e.target.value)} style={{ fontSize: '0.72rem', maxWidth: '170px', padding: '0.3rem 0.4rem' }}>
            <option value="">{t('bulk.moveToContainer')}</option>
            <option value="unassign">{t('bulk.unassignedPile')}</option>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <button className="btn btn-primary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!bulkMoveTarget || !selectedIds.size} onClick={() => runBulk('move', bulkMoveTarget === 'unassign' ? null : bulkMoveTarget)}>{t('bulk.applyMove')}</button>
          <div style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />
          <AddToDeckSelect
            onAdd={(id) => runBulk('add_to_deck', id)}
            disabled={!selectedIds.size}
            style={{ fontSize: '0.72rem', maxWidth: '160px', padding: '0.3rem 0.4rem' }}
          />
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem', marginLeft: 'auto' }} onClick={exitSelectMode}>{t('bulk.done')}</button>
        </div>
      )}

      {loading ? (
        <div className="spinner"></div>
      ) : displayCards.length === 0 ? (
        <div className="glass-panel" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '3rem 1.5rem' }}>
          <p>{t('collection.noMatches')} {t(activeFilterCount > 0 ? 'collection.noMatchesFiltered' : 'collection.noMatchesEmpty')}</p>
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
                onClick={(e) => activateCard(item, e)}
                {...pressHandlers(item.entry_id)}
              >
                <div className="tcg-card-inner" style={{ ...rarityStyle, ...(selected ? { outline: '3px solid var(--accent-red)', outlineOffset: '2px' } : {}) }}>
                  {selectMode && (
                    <div style={{ position: 'absolute', top: '6px', right: '6px', zIndex: 20, width: '22px', height: '22px', borderRadius: '50%', background: selected ? 'var(--accent-red)' : 'rgba(0,0,0,0.6)', border: '2px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-strong)', fontSize: '0.8rem', fontWeight: 900 }}>{selected ? '✓' : ''}</div>
                  )}
                  <CardImage card={item} className="tcg-card-image" loading="lazy" draggable={false} />
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
                    {/* One badge in this slot, not two: a slab's grade replaces the
                        condition rather than sitting beside it, because they answer
                        the same question and the grader's answer is the one that
                        counts. Coloured, because 'PSA 10' in the same grey as 'NM'
                        would bury the distinction that matters most in a grid. */}
                    {item.grader && item.grader !== 'Raw' ? (
                      <span style={{
                        fontSize: '0.6rem',
                        fontWeight: 800,
                        padding: '2px 5px',
                        borderRadius: '3px',
                        background: 'rgba(250, 204, 21, 0.9)',
                        color: '#1a1a1a',
                        border: '1px solid rgba(255, 255, 255, 0.25)',
                        textTransform: 'uppercase'
                      }}>
                        {item.grader}{item.grade != null ? ` ${item.grade}` : ''}
                      </span>
                    ) : (
                      <span style={{
                        fontSize: '0.6rem',
                        fontWeight: 800,
                        padding: '2px 5px',
                        borderRadius: '3px',
                        background: 'rgba(0, 0, 0, 0.75)',
                        color: 'var(--text-strong)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        textTransform: 'uppercase'
                      }}>
                        {item.condition === 'Near Mint' ? 'NM' :
                         item.condition === 'Lightly Played' ? 'LP' :
                         item.condition === 'Moderately Played' ? 'MP' :
                         item.condition === 'Heavily Played' ? 'HP' : 'DMG'}
                      </span>
                    )}
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
                  <div className="tcg-card-name">{getCardDisplayName(item.name, item.language, item.printed_name)}</div>
                  <div className="tcg-card-meta">
                    <span style={{ fontSize: '0.7rem' }}>{item.set_name} • #{item.number}</span>
                    <span className="tcg-card-price">{priceText(item.price_trend, item.price_currency)}</span>
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
                  <th>{t('collection.colCard')}</th>
                  <th style={{ width: '70px', textAlign: 'right' }}>{t('collection.colQtyValue')}</th>
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
                          onClick={(e) => activateCard(item, e)}
                          {...pressHandlers(item.entry_id)}
                          style={{ position: 'relative', width: '36px', height: '50px', flexShrink: 0, overflow: 'hidden', borderRadius: '4px', cursor: 'pointer', touchAction: 'pan-y', ...getCardRarityBorder(item.rarity) }}
                        >
                          <CardImage card={item} className="collection-row-thumbnail" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '4px' }} draggable={false} />
                          {getFoilOverlayClass(item.printing) && (
                            <div className={getFoilOverlayClass(item.printing)} style={{ borderRadius: '4px' }} />
                          )}
                        </div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div onClick={(e) => activateCard(item, e)} {...pressHandlers(item.entry_id)} style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}>{getCardDisplayName(item.name, item.language, item.printed_name)}</div>
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
                              <button className="btn btn-secondary btn-icon-only" style={{ width: '18px', height: '18px', padding: 0, borderRadius: '3px' }} onClick={() => openEdit(item)} title={t('common.edit')}>
                                <Edit2 size={9} />
                              </button>
                              <button className="btn btn-danger btn-icon-only" style={{ width: '18px', height: '18px', padding: 0, borderRadius: '3px' }} onClick={() => handleDelete(item.entry_id, getCardDisplayName(item.name, item.language, item.printed_name))} title={t('common.delete')}>
                                <Trash2 size={9} />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', verticalAlign: 'top', paddingTop: '0.6rem' }}>
                      {item.quantity > 1 && (
                        <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.85rem' }}>x{item.quantity}</div>
                      )}
                      <div style={{ fontSize: '0.7rem', color: 'var(--accent-yellow)', fontWeight: 600 }}>{priceText(item.price_trend, item.price_currency)}</div>
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
