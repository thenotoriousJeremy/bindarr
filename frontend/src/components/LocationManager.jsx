import React, { useState, useEffect } from 'react';
import { MapPin, Plus, Trash2, Library, BookOpen, Layers, Archive, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { getCardDisplayName } from '../utils/langHelper';

const POKEMON_TYPE_ORDER = {
  'Grass': 1,
  'Fire': 2,
  'Water': 3,
  'Lightning': 4,
  'Psychic': 5,
  'Fighting': 6,
  'Darkness': 7,
  'Metal': 8,
  'Fairy': 9,
  'Dragon': 10,
  'Colorless': 11,
  'Unknown': 100
};

const PRINTING_ORDER = {
  'Normal': 1,
  'Reverse Holofoil': 2,
  'Holofoil': 3,
  '1st Edition': 4,
  'Promo': 5
};

function LocationManager({ statsTrigger, onUpdate, showToast, selectedLocationId, setSelectedLocationId, setSelectedCardFilter, setActiveTab }) {
  const isMobile = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeLocationId, setActiveLocationId] = useState(null);
  const [locationCards, setLocationCards] = useState([]);

  // Collection Organizer state upgrades
  const [activeMoveCard, setActiveMoveCard] = useState(null);
  const [showCreateAdvanced, setShowCreateAdvanced] = useState(false);
  const [showEditAdvanced, setShowEditAdvanced] = useState(false);
  const [createAdvancedConfig, setCreateAdvancedConfig] = useState({});
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(true);
  const [activeCardIndex, setActiveCardIndex] = useState(0);
  const [cardCarouselTouchStart, setCardCarouselTouchStart] = useState(null);
  const [cardCarouselTouchEnd, setCardCarouselTouchEnd] = useState(null);
  
  // Form states for creating a location
  const [name, setName] = useState('');
  const [type, setType] = useState('Binder');
  const [description, setDescription] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [sortOrder, setSortOrder] = useState('custom');
  const [maxPages, setMaxPages] = useState(30);
  const [pageStyle, setPageStyle] = useState('3x3');
  const [maxRows, setMaxRows] = useState(3);
  const [maxCapacity, setMaxCapacity] = useState(1000);

  // Form states for editing a location
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState('Binder');
  const [editSortOrder, setEditSortOrder] = useState('custom');
  const [editMaxPages, setEditMaxPages] = useState(30);
  const [editPageStyle, setEditPageStyle] = useState('3x3');
  const [editMaxRows, setEditMaxRows] = useState(3);
  const [editMaxCapacity, setEditMaxCapacity] = useState(1000);

  // Binder Grid Visualizer states
  const [viewMode, setViewMode] = useState('grid'); // Defaults to 'grid' (no list view)
  const [selectedPage, setSelectedPage] = useState(1);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [targetSlot, setTargetSlot] = useState(null);
  const [inspectedSlot, setInspectedSlot] = useState(null);
  const [isFlipping, setIsFlipping] = useState(false);
  
  // Unsorted Cards states
  const [unsortedCards, setUnsortedCards] = useState([]);
  const [unsortedSearch, setUnsortedSearch] = useState('');
  const [unsortedSortOrder, setUnsortedSortOrder] = useState('name-asc');
  const [newBoxRowName, setNewBoxRowName] = useState('');
  const [unsortedViewMode, setUnsortedViewMode] = useState('list'); // 'list' or 'assistant'
  const [assistantIndex, setAssistantIndex] = useState(0);
  const [unsortedDateFilter, setUnsortedDateFilter] = useState('all');
  const [carouselTouchStartIndex, setCarouselTouchStartIndex] = useState(0);
  
  // Touch Swiping states
  const [touchStart, setTouchStart] = useState(null);
  const [touchEnd, setTouchEnd] = useState(null);
  
  // Quick Add Form states
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedCard, setSelectedCard] = useState(null);
  const [quickQty, setQuickQty] = useState(1);
  const [quickCond, setQuickCond] = useState('Near Mint');
  const [quickPrint, setQuickPrint] = useState('Normal');
  const [quickLang, setQuickLang] = useState('English');
  const [quickPrice, setQuickPrice] = useState(0);

  useEffect(() => {
    fetchLocations();
  }, [statsTrigger]);

  useEffect(() => {
    if (selectedLocationId) {
      setActiveLocationId(selectedLocationId);
      if (setSelectedLocationId) {
        setSelectedLocationId(null);
      }
    }
  }, [selectedLocationId]);

  useEffect(() => {
    fetchLocationCards(activeLocationId);
  }, [activeLocationId, statsTrigger, locations]);

  // ==========================================
  // ADVANCED CONFIGURATION & UTILITY HELPERS
  // ==========================================
  const parseAdvancedConfig = (loc) => {
    if (!loc || !loc.description) return {};
    try {
      const desc = loc.description.trim();
      if (desc.startsWith('{') && desc.endsWith('}')) {
        return JSON.parse(desc);
      }
    } catch (err) {
      console.error('Error parsing location config', err);
    }
    return {};
  };

  const handleSaveAdvancedConfig = async (updatedConfig) => {
    if (!selectedLoc) return;
    try {
      const res = await fetch(`/api/locations/${selectedLoc.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: JSON.stringify(updatedConfig)
        })
      });
      if (res.ok) {
        showToast('Advanced configurations saved!');
        fetchLocations();
      } else {
        showToast('Failed to save configurations.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error saving configurations.');
    }
  };

  // ==========================================
  // CLICK-TO-MOVE / TAP-TO-PLACE HANDLERS
  // ==========================================
  const handleCardSelectForMove = (card) => {
    if (activeMoveCard?.entry_id === card.entry_id) {
      setActiveMoveCard(null);
    } else {
      setActiveMoveCard(card);
      showToast(`Selected ${card.name}. Tap a destination slot or row to place.`);
    }
  };

  const handlePlaceCardInSlot = async (pageNum, slotNum) => {
    if (!activeMoveCard) return;

    const sourceCard = activeMoveCard;
    const getPageNum = (str) => parseInt((str || '').replace(/\D/g, ''), 10) || 0;
    const getSlotNum = (str) => parseInt((str || '').replace(/\D/g, ''), 10) || 0;
    const targetCard = locationCards.find(c => getPageNum(c.sub_location_1) === pageNum && getSlotNum(c.sub_location_2) === slotNum);

    if (targetCard) {
      // SWAP cards
      try {
        const res1 = await fetch(`/api/collection/${sourceCard.entry_id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location_id: activeLocationId,
            sub_location_1: `Page ${pageNum}`,
            sub_location_2: `Slot ${slotNum}`,
            quantity: sourceCard.quantity,
            condition: sourceCard.condition,
            printing: sourceCard.printing,
            language: sourceCard.language,
            purchase_price: sourceCard.purchase_price || 0,
            list_type: sourceCard.list_type || 'collection',
            is_trade: sourceCard.is_trade || 0
          })
        });

        const res2 = await fetch(`/api/collection/${targetCard.entry_id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location_id: sourceCard.location_id ? sourceCard.location_id : null,
            sub_location_1: sourceCard.sub_location_1 ? sourceCard.sub_location_1 : null,
            sub_location_2: sourceCard.sub_location_2 ? sourceCard.sub_location_2 : null,
            quantity: targetCard.quantity,
            condition: targetCard.condition,
            printing: targetCard.printing,
            language: targetCard.language,
            purchase_price: targetCard.purchase_price || 0,
            list_type: targetCard.list_type || 'collection',
            is_trade: targetCard.is_trade || 0
          })
        });

        if (res1.ok && res2.ok) {
          showToast(`Swapped ${sourceCard.name} and ${targetCard.name}!`);
          setActiveMoveCard(null);
          fetchLocations();
          fetchLocationCards(activeLocationId);
          onUpdate();
        } else {
          showToast('Failed to swap cards.');
        }
      } catch (err) {
        console.error(err);
        showToast('Error swapping cards.');
      }
    } else {
      // Move card to empty slot
      try {
        const response = await fetch(`/api/collection/${sourceCard.entry_id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location_id: activeLocationId,
            sub_location_1: `Page ${pageNum}`,
            sub_location_2: `Slot ${slotNum}`,
            quantity: sourceCard.quantity,
            condition: sourceCard.condition,
            printing: sourceCard.printing,
            language: sourceCard.language,
            purchase_price: sourceCard.purchase_price || 0,
            list_type: sourceCard.list_type || 'collection',
            is_trade: sourceCard.is_trade || 0
          })
        });
        if (response.ok) {
          showToast(`Moved ${sourceCard.name} to Page ${pageNum} Slot ${slotNum}`);
          setActiveMoveCard(null);
          fetchLocations();
          fetchLocationCards(activeLocationId);
          onUpdate();
        } else {
          showToast('Failed to move card.');
        }
      } catch (err) {
        console.error(err);
        showToast('Error moving card.');
      }
    }
  };

  const handleRelocateCardToContainer = async (cardEntryId, targetLoc) => {
    try {
      const resCards = await fetch(`/api/locations/${targetLoc.id}/cards`);
      let targetCards = [];
      if (resCards.ok) {
        targetCards = await resCards.json();
      }

      let sub1 = '', sub2 = '';
      if (targetLoc.type === 'Binder' || targetLoc.type === 'Toploader Binder') {
        const pocketsCount = targetLoc.page_style === '2x2' ? 4 : targetLoc.page_style === '3x4' ? 12 : 9;
        const maxP = targetLoc.max_pages || 30;
        const occupied = new Set(targetCards.map(c => {
          const p = parseInt((c.sub_location_1 || '').replace(/\D/g, ''), 10) || 0;
          const s = parseInt((c.sub_location_2 || '').replace(/\D/g, ''), 10) || 0;
          return `${p}-${s}`;
        }));

        let found = false;
        for (let p = 1; p <= maxP; p++) {
          for (let s = 1; s <= pocketsCount; s++) {
            if (!occupied.has(`${p}-${s}`)) {
              sub1 = `Page ${p}`;
              sub2 = `Slot ${s}`;
              found = true;
              break;
            }
          }
          if (found) break;
        }
        if (!found) {
          sub1 = 'Page 1';
          sub2 = 'Slot 1';
        }
      } else if (targetLoc.type === 'Box' || targetLoc.type === 'Toploader Box' || targetLoc.type === 'Graded Slab Box' || targetLoc.type === 'Display Shelf / Stand') {
        sub1 = 'Row 1';
        const cardsInRow1 = targetCards.filter(c => c.sub_location_1 === 'Row 1');
        sub2 = String(cardsInRow1.length + 1);
      }

      const sourceCard = locationCards.find(c => c.entry_id == cardEntryId) || unsortedCards.find(c => c.entry_id == cardEntryId);
      const cardName = sourceCard ? sourceCard.name : 'Card';

      const res = await fetch(`/api/collection/${cardEntryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: targetLoc.id,
          sub_location_1: sub1,
          sub_location_2: sub2,
          quantity: sourceCard ? sourceCard.quantity : 1,
          condition: sourceCard ? sourceCard.condition : 'NM',
          printing: sourceCard ? sourceCard.printing : 'Standard',
          language: sourceCard ? sourceCard.language : 'English',
          purchase_price: sourceCard ? (sourceCard.purchase_price || 0) : 0,
          list_type: sourceCard ? (sourceCard.list_type || 'collection') : 'collection',
          is_trade: sourceCard ? (sourceCard.is_trade || 0) : 0
        })
      });

      if (res.ok) {
        showToast(`Moved ${cardName} to ${targetLoc.name} (${sub1}, ${sub2})`);
        setActiveMoveCard(null);
        setActiveLocationId(targetLoc.id);
        fetchLocations();
        onUpdate();
      } else {
        showToast('Failed to relocate card.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error relocating card.');
    }
  };

  const handlePlaceCardInBoxRow = async (cardEntryId, rowName) => {
    const entryId = parseInt(cardEntryId, 10);
    if (!entryId) return;
    
    const sourceCard = locationCards.find(c => c.entry_id === entryId) || 
                       unsortedCards.find(c => c.entry_id === entryId);
    if (!sourceCard) return;

    const existingInRow = locationCards.filter(c => c.sub_location_1 === rowName);
    const targetSeq = existingInRow.length + 1;
    
    await moveCardToLocation(entryId, activeLocationId, rowName, `Section ${targetSeq}`);
    setActiveMoveCard(null);
  };

  const handleUpdateQuantity = async (cardEntryId, newQty) => {
    try {
      const card = locationCards.find(c => c.entry_id === cardEntryId) || 
                   unsortedCards.find(c => c.entry_id === cardEntryId);
      if (!card) return;

      const res = await fetch(`/api/collection/${cardEntryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: card.location_id,
          sub_location_1: card.sub_location_1,
          sub_location_2: card.sub_location_2,
          quantity: newQty,
          condition: card.condition,
          printing: card.printing,
          language: card.language,
          purchase_price: card.purchase_price || 0,
          list_type: card.list_type || 'collection',
          is_trade: card.is_trade || 0
        })
      });

      if (res.ok) {
        showToast(`Quantity updated to ${newQty}`);
        setActiveMoveCard(prev => prev ? { ...prev, quantity: newQty } : null);
        fetchLocationCards(activeLocationId);
        onUpdate();
      } else {
        showToast('Failed to update quantity.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error updating quantity.');
    }
  };



  // ==========================================
  // COLLAPSIBLE ADVANCED CONFIGURATIONS MENU
  // ==========================================
  const renderAdvancedConfigAccordion = (isCreation = false, configToUse = null, onConfigChange = null) => {
    const activeConfig = configToUse || (selectedLoc ? parseAdvancedConfig(selectedLoc) : {});
    
    const updateVal = (key, val) => {
      const updated = { ...activeConfig, [key]: val };
      if (isCreation) {
        onConfigChange(updated);
      } else {
        handleSaveAdvancedConfig(updated);
      }
    };

    const updateEnergyRange = (type, pageNum) => {
      const currentRanges = activeConfig.energyRanges || {
        'Grass': 1, 'Fire': 4, 'Water': 7, 'Lightning': 10, 'Psychic': 13,
        'Fighting': 16, 'Darkness': 19, 'Metal': 22, 'Dragon': 25, 'Colorless': 27, 'Trainers': 29
      };
      const updatedRanges = { ...currentRanges, [type]: parseInt(pageNum, 10) || 1 };
      updateVal('energyRanges', updatedRanges);
    };

    const updateAlphaGroup = (idx, rangeStr) => {
      const currentGroups = activeConfig.alphabetGroups || ["A-C", "D-F", "G-I", "J-L", "M-O", "P-R", "S-U", "V-Z"];
      const updatedGroups = [...currentGroups];
      updatedGroups[idx] = rangeStr;
      updateVal('alphabetGroups', updatedGroups);
    };

    const currentType = isCreation ? type : (selectedLoc?.type || 'Binder');
    const currentSort = isCreation ? sortOrder : (selectedLoc?.sort_order || 'name-asc');

    return (
      <div style={{ marginTop: '0.5rem', width: '100%', display: 'flex', flexDirection: 'column' }}>
        <div 
          className="advanced-config-header"
          onClick={() => isCreation ? setShowCreateAdvanced(!showCreateAdvanced) : setShowEditAdvanced(!showEditAdvanced)}
        >
          <span>⚙️ Advanced Sorting Customizations</span>
          <span style={{ fontSize: '0.6rem' }}>{(isCreation ? showCreateAdvanced : showEditAdvanced) ? '▲' : '▼'}</span>
        </div>
        
        {((isCreation && showCreateAdvanced) || (!isCreation && showEditAdvanced)) && (
          <div className="advanced-config-content">
            {currentSort === 'price-desc' && (
              <>
                <span style={{ fontSize: '0.6rem', color: 'var(--accent-red)', fontWeight: 800, textTransform: 'uppercase' }}>Value Boundaries</span>
                <div className="advanced-config-row">
                  <label>High-Value Tier ($)</label>
                  <input 
                    type="number" 
                    className="input-control"
                    value={activeConfig.priceHigh !== undefined ? activeConfig.priceHigh : 20}
                    onChange={(e) => updateVal('priceHigh', parseFloat(e.target.value) || 20)}
                  />
                </div>
                <div className="advanced-config-row">
                  <label>Mid-Value Tier ($)</label>
                  <input 
                    type="number" 
                    className="input-control"
                    value={activeConfig.priceMid !== undefined ? activeConfig.priceMid : 5}
                    onChange={(e) => updateVal('priceMid', parseFloat(e.target.value) || 5)}
                  />
                </div>
              </>
            )}

            {currentSort === 'type-name' && (currentType === 'Binder' || currentType === 'Toploader Binder') && (
              <>
                <span style={{ fontSize: '0.6rem', color: 'var(--accent-red)', fontWeight: 800, textTransform: 'uppercase' }}>Energy Starting Pages</span>
                {['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Dragon', 'Colorless', 'Trainers'].map((t) => {
                  const currentRanges = activeConfig.energyRanges || {
                    'Grass': 1, 'Fire': 4, 'Water': 7, 'Lightning': 10, 'Psychic': 13,
                    'Fighting': 16, 'Darkness': 19, 'Metal': 22, 'Dragon': 25, 'Colorless': 27, 'Trainers': 29
                  };
                  return (
                    <div className="advanced-config-row" key={t}>
                      <label>{t} Page</label>
                      <input 
                        type="number" 
                        className="input-control"
                        min="1"
                        max={isCreation ? maxPages : (selectedLoc?.max_pages || 30)}
                        value={currentRanges[t] || 1}
                        onChange={(e) => updateEnergyRange(t, e.target.value)}
                      />
                    </div>
                  );
                })}
              </>
            )}

            {currentSort === 'name-asc' && (
              <>
                <span style={{ fontSize: '0.6rem', color: 'var(--accent-red)', fontWeight: 800, textTransform: 'uppercase' }}>Alphabet Buckets (A-Z)</span>
                {Array.from({ length: 8 }).map((_, idx) => {
                  const defaultGroups = ["A-C", "D-F", "G-I", "J-L", "M-O", "P-R", "S-U", "V-Z"];
                  const currentGroups = activeConfig.alphabetGroups || defaultGroups;
                  return (
                    <div className="advanced-config-row" key={idx}>
                      <label>Group {idx + 1}</label>
                      <input 
                        type="text" 
                        className="input-control"
                        placeholder="e.g. A-C"
                        value={currentGroups[idx] || ''}
                        onChange={(e) => updateAlphaGroup(idx, e.target.value.toUpperCase())}
                      />
                    </div>
                  );
                })}
              </>
            )}

            {currentType === 'Deck Box' && (
              <>
                <span style={{ fontSize: '0.6rem', color: 'var(--accent-red)', fontWeight: 800, textTransform: 'uppercase' }}>Deck Limit Settings</span>
                <div className="advanced-config-row">
                  <label>Target Deck Size</label>
                  <input 
                    type="number" 
                    className="input-control"
                    min="1"
                    value={activeConfig.targetDeckSize || 60}
                    onChange={(e) => updateVal('targetDeckSize', parseInt(e.target.value, 10) || 60)}
                  />
                </div>
              </>
            )}

            <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)', fontStyle: 'italic', marginTop: '0.2rem', lineHeight: 1.2 }}>
              These custom thresholds set the targets suggested by the Sorting Assistant mode.
            </div>
          </div>
        )}
      </div>
    );
  };

  // ==========================================
  // CUSTOM PREMIUM CONTAINER VISUALIZERS
  // ==========================================
  // ==========================================
  // CUSTOM PREMIUM COVER FLOW CARD BROWSING
  // ==========================================
  const renderCardCoverFlow = () => {
    if (locationCards.length === 0) {
      return (
        <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem' }}>
          <p>This container is currently empty. Go to Search or Scanner to add cards to this location!</p>
        </div>
      );
    }

    const activeIdx = Math.max(0, Math.min(activeCardIndex, locationCards.length - 1));
    const activeCard = locationCards[activeIdx];

    const handlePrevCard = () => {
      setActiveCardIndex((prev) => (prev - 1 + locationCards.length) % locationCards.length);
    };

    const handleNextCard = () => {
      setActiveCardIndex((prev) => (prev + 1) % locationCards.length);
    };

    const handleWheelCard = (e) => {
      if (e.deltaX > 40 || e.deltaY > 40) {
        handleNextCard();
      } else if (e.deltaX < -40 || e.deltaY < -40) {
        handlePrevCard();
      }
    };

    return (
      <div 
        style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', alignItems: 'center', width: '100%', outline: 'none' }}
        tabIndex="0"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') handlePrevCard();
          if (e.key === 'ArrowRight') handleNextCard();
        }}
      >
        {/* Cover Flow track */}
        <div 
          className="coverflow-container"
          onWheel={handleWheelCard}
          onTouchStart={(e) => {
            setCardCarouselTouchStart(e.touches[0].clientX);
            setCarouselTouchStartIndex(activeCardIndex);
          }}
          onTouchMove={(e) => {
            if (cardCarouselTouchStart === null) return;
            const currentX = e.touches[0].clientX;
            const diff = cardCarouselTouchStart - currentX;
            const step = 25; // Dragging 25px shifts 1 card
            const shift = Math.round(diff / step);
            let targetIdx = carouselTouchStartIndex + shift;
            if (targetIdx < 0) targetIdx = 0;
            if (targetIdx >= locationCards.length) targetIdx = locationCards.length - 1;
            setActiveCardIndex(targetIdx);
          }}
          onTouchEnd={() => {
            setCardCarouselTouchStart(null);
          }}
          style={{ height: '240px', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', position: 'relative' }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const cardId = e.dataTransfer.getData('card_entry_id');
            const defaultRow = activeCard ? (activeCard.sub_location_1 || 'Row 1') : 'Row 1';
            handleDropToBoxRow(cardId, defaultRow);
          }}
          onClick={() => {
            if (activeMoveCard) {
              const defaultRow = activeCard ? (activeCard.sub_location_1 || 'Row 1') : 'Row 1';
              handlePlaceCardInBoxRow(activeMoveCard.entry_id, defaultRow);
            }
          }}
        >
          <button type="button" className="coverflow-nav-btn left-btn" onClick={(e) => { e.stopPropagation(); handlePrevCard(); }} style={{ zIndex: 10 }}><ChevronLeft size={18} /></button>
          
          <div className="coverflow-track" style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', perspective: '1000px', transformStyle: 'preserve-3d' }}>
            {locationCards.map((card, idx) => {
              const isActive = idx === activeIdx;
              let offset = idx - activeIdx;
              const absOffset = Math.abs(offset);
              
              if (absOffset > 3) return null;

              const rotateY = offset * -28; 
              const translateZ = absOffset * -90; 
              const translateX = offset * 90; 
              const scale = isActive ? 1.0 : 0.75;
              const opacity = absOffset > 2 ? 0.2 : 1 - (absOffset * 0.35);

              const isSelected = activeMoveCard?.entry_id === card.entry_id;

              return (
                <div
                  key={card.entry_id}
                  className={`coverflow-card ${isSelected ? 'card-move-selecting' : ''}`}
                  style={{
                    position: 'absolute',
                    width: '120px',
                    aspectRatio: 0.718,
                    transform: `translateX(${translateX}px) translateZ(${translateZ}px) rotateY(${rotateY}deg) scale(${scale})`,
                    opacity: opacity,
                    transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
                    pointerEvents: absOffset > 1.2 ? 'none' : 'auto',
                    cursor: 'pointer',
                    boxShadow: isActive ? '0 10px 25px rgba(0,0,0,0.5), 0 0 10px rgba(255, 71, 71, 0.3)' : '0 5px 12px rgba(0,0,0,0.3)',
                    borderRadius: '8px',
                    overflow: 'hidden',
                    border: isSelected ? '2px solid var(--accent-yellow)' : isActive ? '1px solid rgba(255,255,255,0.2)' : '1px solid rgba(255,255,255,0.08)'
                  }}
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (isActive) {
                      if (activeMoveCard) {
                        // Swap box coordinates directly
                        try {
                          const res1 = await fetch(`/api/collection/${activeMoveCard.entry_id}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              location_id: selectedLoc.id,
                              sub_location_1: card.sub_location_1,
                              sub_location_2: card.sub_location_2,
                              quantity: activeMoveCard.quantity,
                              condition: activeMoveCard.condition,
                              printing: activeMoveCard.printing,
                              language: activeMoveCard.language,
                              purchase_price: activeMoveCard.purchase_price || 0,
                              is_trade: activeMoveCard.is_trade || 0,
                              list_type: activeMoveCard.list_type || 'collection'
                            })
                          });
                          const res2 = await fetch(`/api/collection/${card.entry_id}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              location_id: activeMoveCard.location_id || null,
                              sub_location_1: activeMoveCard.sub_location_1 || '',
                              sub_location_2: activeMoveCard.sub_location_2 || '',
                              quantity: card.quantity,
                              condition: card.condition,
                              printing: card.printing,
                              language: card.language,
                              purchase_price: card.purchase_price || 0,
                              is_trade: card.is_trade || 0,
                              list_type: card.list_type || 'collection'
                            })
                          });
                          if (res1.ok && res2.ok) {
                            showToast(`Swapped positions!`);
                            setActiveMoveCard(null);
                            fetchLocations();
                            fetchLocationCards(selectedLoc.id);
                            onUpdate();
                          } else {
                            showToast('Failed to swap positions.');
                          }
                        } catch (err) {
                          console.error(err);
                          showToast('Error swapping positions.');
                        }
                      } else {
                        setActiveMoveCard(card);
                        showToast(`Selected ${card.name} for relocation. Tap a destination slot, row, or Unsorted to place.`);
                      }
                    } else {
                      setActiveCardIndex(idx);
                    }
                  }}
                >
                  <img src={card.image_url} alt={card.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  {/* Shiny holo overlay */}
                  {((card.printing || '').toLowerCase().includes('holo') || (card.printing || '').toLowerCase().includes('foil')) && (
                    <div style={{
                      position: 'absolute',
                      top: 0, left: 0, right: 0, bottom: 0,
                      background: 'linear-gradient(135deg, rgba(255,255,255,0.2) 0%, rgba(255,255,255,0) 50%, rgba(255,255,255,0.1) 100%)',
                      pointerEvents: 'none',
                      zIndex: 2,
                      mixBlendMode: 'overlay',
                      borderRadius: '8px'
                    }} />
                  )}
                  <div style={{
                    position: 'absolute',
                    bottom: 0, left: 0, right: 0,
                    background: 'rgba(0,0,0,0.85)',
                    padding: '4px',
                    fontSize: '0.65rem',
                    textAlign: 'center',
                    color: '#fff',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    fontWeight: 600
                  }}>
                    {card.quantity > 1 ? `x${card.quantity}` : card.name}
                  </div>
                </div>
              );
            })}
          </div>

          <button type="button" className="coverflow-nav-btn right-btn" onClick={(e) => { e.stopPropagation(); handleNextCard(); }} style={{ zIndex: 10 }}><ChevronRight size={18} /></button>
        </div>

        {/* Focused Card Details & Compartment Settings */}
        {activeCard && (
          <div className="glass-panel" style={{ width: '100%', maxWidth: '480px', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', border: '1px solid var(--border-glass)' }}>
            <div style={{ display: 'flex', gap: '0.85rem', alignItems: 'center' }}>
              <img src={activeCard.image_url} alt={activeCard.name} style={{ width: '60px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 4px 8px rgba(0,0,0,0.3)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <h4 style={{ color: '#fff', fontSize: '0.9rem', margin: 0, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {getCardDisplayName(activeCard.name, activeCard.language)}
                </h4>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  {activeCard.set_name} • #{activeCard.number} ({activeCard.rarity})
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  Printing: {activeCard.printing} • Condition: {activeCard.condition}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '0.9rem', color: 'var(--accent-yellow)', fontWeight: 800 }}>
                  ${(activeCard.price_trend || 0).toFixed(2)}
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  Spent: ${((activeCard.purchase_price || 0) * activeCard.quantity).toFixed(2)}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '0.75rem', flexWrap: 'wrap' }}>
              {/* Quantity Adjuster */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Qty:</span>
                <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(0,0,0,0.3)', borderRadius: '4px', border: '1px solid var(--border-glass)', padding: '2px' }}>
                  <button 
                    type="button"
                    className="btn btn-secondary btn-icon-only"
                    onClick={async () => {
                      if (activeCard.quantity <= 1) return;
                      const res = await fetch(`/api/collection/${activeCard.entry_id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ...activeCard, quantity: activeCard.quantity - 1 })
                      });
                      if (res.ok) {
                        fetchLocationCards(activeLocationId);
                        onUpdate();
                      }
                    }}
                    style={{ width: '20px', height: '20px', padding: 0 }}
                  >
                    -
                  </button>
                  <span style={{ width: '24px', textAlign: 'center', fontSize: '0.75rem', fontWeight: 700, color: '#fff' }}>{activeCard.quantity}</span>
                  <button 
                    type="button"
                    className="btn btn-secondary btn-icon-only"
                    onClick={async () => {
                      const res = await fetch(`/api/collection/${activeCard.entry_id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ...activeCard, quantity: activeCard.quantity + 1 })
                      });
                      if (res.ok) {
                        fetchLocationCards(activeLocationId);
                        onUpdate();
                      }
                    }}
                    style={{ width: '20px', height: '20px', padding: 0 }}
                  >
                    +
                  </button>
                </div>
              </div>

              {/* Compartment/Row assignment for boxes */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flex: 1, minWidth: '110px' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Row:</span>
                <input 
                  type="text"
                  className="input-control"
                  style={{ fontSize: '0.75rem', padding: '0.2rem 0.4rem', height: '24px' }}
                  placeholder="e.g. Row 1"
                  value={activeCard.sub_location_1 || ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    setLocationCards(prev => prev.map((c, i) => i === activeIdx ? { ...c, sub_location_1: val } : c));
                  }}
                  onBlur={async (e) => {
                    await fetch(`/api/collection/${activeCard.entry_id}`, {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ ...activeCard, sub_location_1: e.target.value })
                    });
                    fetchLocationCards(activeLocationId);
                  }}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flex: 1, minWidth: '110px' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Section:</span>
                <input 
                  type="text"
                  className="input-control"
                  style={{ fontSize: '0.75rem', padding: '0.2rem 0.4rem', height: '24px' }}
                  placeholder="e.g. Section 1"
                  value={activeCard.sub_location_2 || ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    setLocationCards(prev => prev.map((c, i) => i === activeIdx ? { ...c, sub_location_2: val } : c));
                  }}
                  onBlur={async (e) => {
                    await fetch(`/api/collection/${activeCard.entry_id}`, {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ ...activeCard, sub_location_2: e.target.value })
                    });
                    fetchLocationCards(activeLocationId);
                  }}
                />
              </div>

              {/* Quick Actions */}
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <button
                  type="button"
                  className={`btn ${activeMoveCard?.entry_id === activeCard.entry_id ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => {
                    if (activeMoveCard?.entry_id === activeCard.entry_id) {
                      setActiveMoveCard(null);
                    } else {
                      setActiveMoveCard(activeCard);
                      showToast(`Selected ${activeCard.name} for relocation.`);
                    }
                  }}
                  style={{ fontSize: '0.7rem', padding: '0.3rem 0.6rem', height: '26px' }}
                >
                  {activeMoveCard?.entry_id === activeCard.entry_id ? 'Moving...' : 'Move'}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={async () => {
                    if (window.confirm(`Unsort ${activeCard.name} (move back to Unsorted)?`)) {
                      await moveCardToLocation(activeCard.entry_id, null, '', '');
                      showToast(`Unsorted ${activeCard.name}`);
                      fetchLocationCards(activeLocationId);
                      onUpdate();
                    }
                  }}
                  style={{ fontSize: '0.7rem', padding: '0.3rem 0.6rem', height: '26px' }}
                >
                  Unsort
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  const fetchLocations = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/locations');
      if (response.ok) {
        const data = await response.json();
        setLocations(data);
        if (data.length > 0 && !activeLocationId) {
          // Auto select first location
          setActiveLocationId(data[0].id);
        }
      }
    } catch (err) {
      console.error(err);
      showToast('Error loading physical storage locations.');
    } finally {
      setLoading(false);
    }
  };

  const fetchLocationCards = async (locId) => {
    try {
      const response = await fetch('/api/collection');
      if (response.ok) {
        const allCards = await response.json();
        
        // Unsorted cards: location_id is null or empty
        const unsorted = allCards.filter(c => !c.location_id);
        setUnsortedCards(unsorted);

        if (!locId) {
          setLocationCards([]);
          return;
        }

        // Filter by selected location id
        const filtered = allCards.filter(c => c.location_id === locId);
        
        // Sort cards depending on type
        const loc = locations.find(l => l.id === locId);
        if (loc && loc.type === 'Binder') {
          // Sort by Page and Slot numerically
          filtered.sort((a, b) => {
            const pageA = parseInt((a.sub_location_1 || '').replace(/\D/g, ''), 10) || 0;
            const pageB = parseInt((b.sub_location_1 || '').replace(/\D/g, ''), 10) || 0;
            if (pageA !== pageB) return pageA - pageB;
            
            const slotA = parseInt((a.sub_location_2 || '').replace(/\D/g, ''), 10) || 0;
            const slotB = parseInt((b.sub_location_2 || '').replace(/\D/g, ''), 10) || 0;
            return slotA - slotB;
          });
        } else {
          // Sort by Row (sub1) and Category (sub2)
          filtered.sort((a, b) => {
            const rowA = a.sub_location_1 || '';
            const rowB = b.sub_location_1 || '';
            const compareRows = rowA.localeCompare(rowB, undefined, { numeric: true });
            if (compareRows !== 0) return compareRows;
            
            const secA = a.sub_location_2 || '';
            const secB = b.sub_location_2 || '';
            return secA.localeCompare(secB);
          });
        }
        
        setLocationCards(filtered);
      }
    } catch (err) {
      console.error(err);
      showToast('Error loading cards.');
    }
  };

  // Double page flip helper
  const handleTurnPage = (newPage) => {
    setIsFlipping(true);
    setSelectedPage(newPage);
    setTimeout(() => {
      setIsFlipping(false);
    }, 350);
  };

  // Touch Swipe handlers for swiping between binder pages like a book
  const handleTouchStart = (e) => {
    setTouchStart(e.targetTouches[0].clientX);
  };
  const handleTouchMove = (e) => {
    setTouchEnd(e.targetTouches[0].clientX);
  };
  const handleTouchEnd = () => {
    if (!touchStart || !touchEnd) return;
    const distance = touchStart - touchEnd;
    const leftPage = 2 * Math.floor((selectedPage - 1) / 2) + 1;
    if (distance > 60) {
      // Swipe Left -> next page pair
      if (leftPage < 29) handleTurnPage(leftPage + 2);
    } else if (distance < -60) {
      // Swipe Right -> prev page pair
      if (leftPage > 1) handleTurnPage(leftPage - 2);
    }
    setTouchStart(null);
    setTouchEnd(null);
  };

  // Drag and Drop handlers for relocating cards in the grid
  const handleDragStart = (e, card) => {
    e.dataTransfer.setData('card_entry_id', card.entry_id.toString());
  };

  const moveCardToLocation = async (cardEntryId, locationId, sub1, sub2) => {
    try {
      const targetCard = unsortedCards.find(c => c.entry_id == cardEntryId) || 
                         locationCards.find(c => c.entry_id == cardEntryId);
      if (!targetCard) return;

      const response = await fetch(`/api/collection/${cardEntryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: locationId,
          sub_location_1: sub1,
          sub_location_2: sub2,
          quantity: targetCard.quantity,
          condition: targetCard.condition,
          printing: targetCard.printing,
          language: targetCard.language,
          purchase_price: targetCard.purchase_price || 0,
          is_trade: targetCard.is_trade || 0,
          list_type: targetCard.list_type || 'collection'
        })
      });

      if (response.ok) {
        showToast(`Moved ${targetCard.name} successfully!`);
        fetchLocations();
        fetchLocationCards(activeLocationId);
        onUpdate();
      } else {
        showToast('Failed to relocate card.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error moving card.');
    }
  };

  const autoSortContainerCards = async (orderMode) => {
    if (locationCards.length === 0) return;
    
    if (!window.confirm(`Are you sure you want to auto-sort all cards in this container by "${orderMode}"? This will overwrite their current page/row coordinates.`)) {
      return;
    }

    try {
      showToast('Sorting container...');
      const sorted = [...locationCards];
      if (orderMode === 'name-asc') {
        sorted.sort((a, b) => a.name.localeCompare(b.name));
      } else if (orderMode === 'price-desc') {
        sorted.sort((a, b) => (b.price_trend || 0) - (a.price_trend || 0));
      } else if (orderMode === 'set-number') {
        sorted.sort((a, b) => {
          const setA = a.set_name || '';
          const setB = b.set_name || '';
          const cmp = setA.localeCompare(setB);
          if (cmp !== 0) return cmp;
          const numA = parseInt(a.number || '0', 10) || 0;
          const numB = parseInt(b.number || '0', 10) || 0;
          return numA - numB;
        });
      } else if (orderMode === 'type-name') {
        sorted.sort((a, b) => {
          const typeA = (a.types && a.types[0]) || 'Unknown';
          const typeB = (b.types && b.types[0]) || 'Unknown';
          const orderA = POKEMON_TYPE_ORDER[typeA] || 50;
          const orderB = POKEMON_TYPE_ORDER[typeB] || 50;
          if (orderA !== orderB) return orderA - orderB;
          return a.name.localeCompare(b.name);
        });
      } else if (orderMode === 'set-number-printing') {
        sorted.sort((a, b) => {
          const setA = a.set_name || '';
          const setB = b.set_name || '';
          const cmpSet = setA.localeCompare(setB);
          if (cmpSet !== 0) return cmpSet;

          const numA = parseInt(a.number || '0', 10) || 0;
          const numB = parseInt(b.number || '0', 10) || 0;
          if (numA !== numB) return numA - numB;

          const cmpNum = (a.number || '').localeCompare(b.number || '');
          if (cmpNum !== 0) return cmpNum;

          const printA = PRINTING_ORDER[a.printing] || 10;
          const printB = PRINTING_ORDER[b.printing] || 10;
          if (printA !== printB) return printA - printB;

          return a.name.localeCompare(b.name);
        });
      }

      const pocketsCount = selectedLoc.page_style === '2x2' ? 4 : selectedLoc.page_style === '3x4' ? 12 : 9;
      const maxPages = selectedLoc.max_pages || 30;
      const maxBinderCapacity = maxPages * pocketsCount;

      const maxRows = selectedLoc.max_rows || 3;
      const maxBoxCapacity = maxRows * 40; // 40 cards per row max

      let excessCount = 0;

      const updates = sorted.map((card, index) => {
        let sub1 = card.sub_location_1;
        let sub2 = card.sub_location_2;
        let locId = selectedLoc.id;

        if (selectedLoc.type === 'Binder' || selectedLoc.type === 'Toploader Binder') {
          if (index < maxBinderCapacity) {
            const page = Math.floor(index / pocketsCount) + 1;
            const slot = (index % pocketsCount) + 1;
            sub1 = `Page ${page}`;
            sub2 = `Slot ${slot}`;
          } else {
            locId = null; // Unsort excess
            sub1 = '';
            sub2 = '';
            excessCount++;
          }
        } else if (selectedLoc.type === 'Box' || selectedLoc.type === 'Toploader Box' || selectedLoc.type === 'Graded Slab Box' || selectedLoc.type === 'Display Shelf / Stand') {
          if (index < maxBoxCapacity) {
            const rowNum = Math.floor(index / 40) + 1;
            const seq = (index % 40) + 1;
            sub1 = `Row ${rowNum}`;
            sub2 = String(seq);
          } else {
            locId = null; // Unsort excess
            sub1 = '';
            sub2 = '';
            excessCount++;
          }
        } else {
          sub1 = 'Compartment 1';
          sub2 = `Slot ${index + 1}`;
        }

        return {
          entry_id: card.entry_id,
          location_id: locId,
          sub_location_1: sub1,
          sub_location_2: sub2,
          quantity: card.quantity,
          condition: card.condition,
          printing: card.printing,
          language: card.language,
          purchase_price: card.purchase_price || 0,
          is_trade: card.is_trade || 0,
          list_type: card.list_type || 'collection'
        };
      });

      await Promise.all(updates.map(up => 
        fetch(`/api/collection/${up.entry_id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(up)
        })
      ));

      if (excessCount > 0) {
        showToast(`Auto-sorted! ${excessCount} excess cards moved to Unsorted Pile.`);
      } else {
        showToast('Container auto-sorted successfully!');
      }

      fetchLocations();
      fetchLocationCards(selectedLoc.id);
      onUpdate();
    } catch (err) {
      console.error(err);
      showToast('Error auto-sorting container.');
    }
  };

  const handleDrop = async (e, targetSlot, targetPageNum = selectedPage) => {
    e.preventDefault();
    const entryId = parseInt(e.dataTransfer.getData('card_entry_id'), 10);
    if (!entryId) return;
    const sourceCard = locationCards.find(c => c.entry_id === entryId) || 
                       unsortedCards.find(c => c.entry_id === entryId);
    if (!sourceCard) return;

    const getPageNum = (str) => parseInt((str || '').replace(/\D/g, ''), 10) || 0;
    const getSlotNum = (str) => parseInt((str || '').replace(/\D/g, ''), 10) || 0;
    const targetCard = locationCards.find(c => getPageNum(c.sub_location_1) === targetPageNum && getSlotNum(c.sub_location_2) === targetSlot);

    if (targetCard) {
      try {
        const res1 = await fetch(`/api/collection/${sourceCard.entry_id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location_id: activeLocationId,
            sub_location_1: `Page ${targetPageNum}`,
            sub_location_2: `Slot ${targetSlot}`,
            quantity: sourceCard.quantity,
            condition: sourceCard.condition,
            printing: sourceCard.printing,
            language: sourceCard.language,
            purchase_price: sourceCard.purchase_price || 0,
            list_type: sourceCard.list_type || 'collection',
            is_trade: sourceCard.is_trade || 0
          })
        });

        const res2 = await fetch(`/api/collection/${targetCard.entry_id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location_id: sourceCard.location_id ? sourceCard.location_id : null,
            sub_location_1: sourceCard.sub_location_1 ? sourceCard.sub_location_1 : null,
            sub_location_2: sourceCard.sub_location_2 ? sourceCard.sub_location_2 : null,
            quantity: targetCard.quantity,
            condition: targetCard.condition,
            printing: targetCard.printing,
            language: targetCard.language,
            purchase_price: targetCard.purchase_price || 0,
            list_type: targetCard.list_type || 'collection',
            is_trade: targetCard.is_trade || 0
          })
        });

        if (res1.ok && res2.ok) {
          showToast(`Relocated cards successfully!`);
          fetchLocations();
          fetchLocationCards(activeLocationId);
          onUpdate();
        } else {
          showToast('Failed to swap cards.');
        }
      } catch (err) {
        console.error(err);
        showToast('Error swapping cards.');
      }
    } else {
      try {
        const response = await fetch(`/api/collection/${sourceCard.entry_id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location_id: activeLocationId,
            sub_location_1: `Page ${targetPageNum}`,
            sub_location_2: `Slot ${targetSlot}`,
            quantity: sourceCard.quantity,
            condition: sourceCard.condition,
            printing: sourceCard.printing,
            language: sourceCard.language,
            purchase_price: sourceCard.purchase_price || 0,
            list_type: sourceCard.list_type || 'collection',
            is_trade: sourceCard.is_trade || 0
          })
        });
        if (response.ok) {
          showToast(`Moved ${sourceCard.name} to Page ${targetPageNum} Slot ${targetSlot}`);
          fetchLocations();
          fetchLocationCards(activeLocationId);
          onUpdate();
        } else {
          showToast('Failed to move card.');
        }
      } catch (err) {
        console.error(err);
        showToast('Error moving card.');
      }
    }
  };

  const handleDropToBoxRow = async (cardEntryId, rowName) => {
    const entryId = parseInt(cardEntryId, 10);
    if (!entryId) return;

    const sourceCard = locationCards.find(c => c.entry_id === entryId) || 
                       unsortedCards.find(c => c.entry_id === entryId);
    if (!sourceCard) return;

    const existingInRow = locationCards.filter(c => c.sub_location_1 === rowName);
    const targetSeq = existingInRow.length + 1;
    
    await moveCardToLocation(entryId, selectedLoc.id, rowName, `Section ${targetSeq}`);
  };



  const handleQuickSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    try {
      setSearching(true);
      const response = await fetch(`/api/search?name=${encodeURIComponent(searchQuery)}`);
      if (response.ok) {
        const data = await response.json();
        setSearchResults(data);
      }
    } catch (err) {
      console.error(err);
      showToast('Search failed.');
    } finally {
      setSearching(false);
    }
  };

  const handleQuickAddSubmit = async (e) => {
    e.preventDefault();
    if (!selectedCard) return;

    try {
      const response = await fetch('/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_id: selectedCard.id,
          quantity: parseInt(quickQty, 10),
          condition: quickCond,
          printing: quickPrint,
          language: quickLang,
          purchase_price: parseFloat(quickPrice) || 0,
          location_id: activeLocationId,
          sub_location_1: `Page ${selectedPage}`,
          sub_location_2: `Slot ${targetSlot}`
        })
      });

      if (response.ok) {
        showToast(`Added ${selectedCard.name} to Page ${selectedPage}, Slot ${targetSlot}`);
        setShowQuickAdd(false);
        setSelectedCard(null);
        setSearchQuery('');
        setSearchResults([]);
        // Refresh cards
        fetchLocationCards(activeLocationId);
        onUpdate();
      } else {
        showToast('Failed to add card.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error saving card.');
    }
  };

  const handleCreateLocation = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!name) return;

    const finalDescription = Object.keys(createAdvancedConfig).length > 0 
      ? JSON.stringify(createAdvancedConfig) 
      : description;

    try {
      const response = await fetch('/api/locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          name, 
          type, 
          description: finalDescription,
          sort_order: sortOrder,
          max_pages: (type === 'Binder' || type === 'Toploader Binder') ? parseInt(maxPages, 10) : 30,
          page_style: (type === 'Binder' || type === 'Toploader Binder') ? pageStyle : '3x3',
          max_rows: (type === 'Box' || type === 'Toploader Box' || type === 'Graded Slab Box' || type === 'Display Shelf / Stand') ? parseInt(maxRows, 10) : 3,
          max_capacity: (type !== 'Binder' && type !== 'Toploader Binder' && type !== 'Box' && type !== 'Toploader Box' && type !== 'Graded Slab Box' && type !== 'Display Shelf / Stand') ? parseInt(maxCapacity, 10) : 1000
        })
      });

      if (response.ok) {
        const data = await response.json();
        showToast('Storage container created successfully!');
        setName('');
        setDescription('');
        setCreateAdvancedConfig({});
        setShowCreateAdvanced(false);
        setIsAdding(false);
        onUpdate();
        setActiveLocationId(data.id);
      } else {
        showToast('Failed to create storage container.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error connecting to backend.');
    }
  };

  const handleDeleteLocation = async (locId, locName) => {
    if (!window.confirm(`Are you sure you want to delete "${locName}"? Any cards stored inside will be marked as "Unassigned" and not deleted.`)) {
      return;
    }

    try {
      const response = await fetch(`/api/locations/${locId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        showToast(`Deleted storage container "${locName}".`);
        setIsEditing(false);
        onUpdate();
        if (activeLocationId === locId) {
          const remaining = locations.filter(l => l.id !== locId);
          setActiveLocationId(remaining.length > 0 ? remaining[0].id : null);
        }
      } else {
        showToast('Failed to delete container.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error deleting container.');
    }
  };

  const handleUpdateLocation = async () => {
    if (!editName) return;
    try {
      const response = await fetch(`/api/locations/${selectedLoc.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editName,
          type: editType,
          sort_order: editSortOrder,
          max_pages: (editType === 'Binder' || editType === 'Toploader Binder') ? parseInt(editMaxPages, 10) : 30,
          page_style: (editType === 'Binder' || editType === 'Toploader Binder') ? editPageStyle : '3x3',
          max_rows: (editType === 'Box' || editType === 'Toploader Box' || editType === 'Graded Slab Box' || editType === 'Display Shelf / Stand') ? parseInt(editMaxRows, 10) : 3,
          max_capacity: (editType !== 'Binder' && editType !== 'Toploader Binder' && editType !== 'Box' && editType !== 'Toploader Box' && editType !== 'Graded Slab Box' && editType !== 'Display Shelf / Stand') ? parseInt(editMaxCapacity, 10) : 1000
        })
      });

      if (response.ok) {
        showToast('Storage container settings updated!');
        setIsEditing(false);
        fetchLocations();
        if (editSortOrder !== 'custom' && editSortOrder !== selectedLoc.sort_order) {
          await autoSortContainerCards(editSortOrder);
        }
      } else {
        showToast('Failed to update storage container.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error updating storage container.');
    }
  };

  const findNextRecommendedSlot = (card) => {
    if (!selectedLoc) return null;
    
    const config = parseAdvancedConfig(selectedLoc);
    const sortingPref = selectedLoc.sort_order || 'name-asc';

    const getPageNum = (str) => parseInt((str || '').replace(/\D/g, ''), 10) || 0;
    const getSlotNum = (str) => parseInt((str || '').replace(/\D/g, ''), 10) || 0;

    const occupied = new Set();
    if (selectedLoc.type === 'Binder' || selectedLoc.type === 'Toploader Binder') {
      locationCards.forEach(c => {
        const p = getPageNum(c.sub_location_1);
        const s = getSlotNum(c.sub_location_2);
        if (p > 0 && s > 0) {
          occupied.add(`${p}-${s}`);
        }
      });
    }

    if (selectedLoc.type === 'Binder' || selectedLoc.type === 'Toploader Binder') {
      const pocketsCount = selectedLoc.page_style === '2x2' ? 4 : selectedLoc.page_style === '3x4' ? 12 : 9;
      const maxP = selectedLoc.max_pages || 30;
      
      let targetStartPage = 1;
      let targetEndPage = maxP;
      let isHoloPrioritized = false;

      if (card) {
        if (sortingPref === 'type-name') {
          const energyRanges = config.energyRanges || {
            'Grass': 1, 'Fire': 4, 'Water': 7, 'Lightning': 10, 'Psychic': 13,
            'Fighting': 16, 'Darkness': 19, 'Metal': 22, 'Dragon': 25, 'Colorless': 27, 'Trainers': 29
          };
          const cardType = (card.types && card.types[0]) || 'Colorless';
          const isTrainer = card.supertype === 'Trainer' || card.set_name?.toLowerCase().includes('trainer');
          const typeKey = isTrainer ? 'Trainers' : cardType;
          
          targetStartPage = energyRanges[typeKey] || 1;
          const nextStartPage = Object.values(energyRanges)
            .filter(v => v > targetStartPage)
            .sort((a, b) => a - b)[0] || (maxP + 1);
          targetEndPage = Math.min(maxP, nextStartPage - 1);
        } 
        else if (sortingPref === 'name-asc') {
          const defaultAlphaGroups = ["A-C", "D-F", "G-I", "J-L", "M-O", "P-R", "S-U", "V-Z"];
          const customAlphaGroups = config.alphabetGroups || defaultAlphaGroups;
          
          const firstChar = card.name ? card.name.charAt(0).toUpperCase() : 'A';
          let groupIdx = 0;
          customAlphaGroups.forEach((group, idx) => {
            if (!group) return;
            const parts = group.split('-');
            const start = parts[0] || 'A';
            const end = parts[1] || 'Z';
            if (firstChar >= start && firstChar <= end) {
              groupIdx = idx;
            }
          });
          
          const pagesPerGroup = Math.max(1, Math.floor(maxP / customAlphaGroups.length));
          targetStartPage = 1 + groupIdx * pagesPerGroup;
          targetEndPage = Math.min(maxP, targetStartPage + pagesPerGroup - 1);
        }
        else if (sortingPref === 'price-desc') {
          const thresholdHigh = parseFloat(config.priceHigh) || 20;
          const thresholdMid = parseFloat(config.priceMid) || 5;
          const cardPrice = parseFloat(card.price_trend) || 0;

          if (cardPrice >= thresholdHigh) {
            targetStartPage = 1;
            targetEndPage = 1;
          } else if (cardPrice >= thresholdMid) {
            targetStartPage = 2;
            targetEndPage = Math.min(5, maxP);
          } else {
            targetStartPage = Math.min(6, maxP);
            targetEndPage = maxP;
          }
        }
        else if (sortingPref === 'set-number') {
          const sameSetCards = locationCards.filter(c => c.set_name === card.set_name);
          if (sameSetCards.length > 0) {
            const pages = sameSetCards.map(c => getPageNum(c.sub_location_1)).filter(p => p > 0);
            if (pages.length > 0) {
              targetStartPage = Math.min(...pages);
              targetEndPage = Math.max(...pages);
            }
          } else {
            const pageOccupancies = {};
            locationCards.forEach(c => {
              const p = getPageNum(c.sub_location_1);
              if (p > 0) {
                pageOccupancies[p] = (pageOccupancies[p] || 0) + 1;
              }
            });
            for (let p = 1; p <= maxP; p++) {
              if (!pageOccupancies[p]) {
                targetStartPage = p;
                targetEndPage = p;
                break;
              }
            }
          }
        }
      }

      for (let p = targetStartPage; p <= targetEndPage; p++) {
        for (let s = 1; s <= pocketsCount; s++) {
          if (!occupied.has(`${p}-${s}`)) {
            return { sub1: `Page ${p}`, sub2: `Slot ${s}`, label: `Page ${p}, Slot ${s}` };
          }
        }
      }
      
      for (let p = 1; p <= maxP; p++) {
        for (let s = 1; s <= pocketsCount; s++) {
          if (!occupied.has(`${p}-${s}`)) {
            return { sub1: `Page ${p}`, sub2: `Slot ${s}`, label: `Page ${p}, Slot ${s} (Fallback)` };
          }
        }
      }
      return null;
    } 
    else if (selectedLoc.type === 'Box' || selectedLoc.type === 'Toploader Box') {
      let recommendedRow = newBoxRowName || 'Row 1';

      if (card) {
        if (sortingPref === 'type-name') {
          const cardType = (card.types && card.types[0]) || 'Colorless';
          const isTrainer = card.supertype === 'Trainer' || card.set_name?.toLowerCase().includes('trainer');
          const typeKey = isTrainer ? 'Trainer' : cardType;
          
          const existingRows = Array.from(new Set([
            'Row 1', 'Row 2', 'Row 3',
            ...locationCards.map(c => c.sub_location_1 || 'Row 1')
          ]));
          
          const matchedRow = existingRows.find(r => r.toLowerCase().includes(typeKey.toLowerCase()));
          if (matchedRow) {
            recommendedRow = matchedRow;
          }
        }
        else if (sortingPref === 'name-asc') {
          const firstChar = card.name ? card.name.charAt(0).toUpperCase() : 'A';
          const existingRows = Array.from(new Set([
            'Row 1', 'Row 2', 'Row 3',
            ...locationCards.map(c => c.sub_location_1 || 'Row 1')
          ])).sort();

          if (existingRows.length > 0) {
            const charsPerRow = Math.max(1, Math.floor(26 / existingRows.length));
            const charCode = firstChar.charCodeAt(0) - 65; 
            const rowIdx = Math.min(existingRows.length - 1, Math.floor(charCode / charsPerRow));
            recommendedRow = existingRows[rowIdx];
          }
        }
        else if (sortingPref === 'price-desc') {
          const thresholdHigh = parseFloat(config.priceHigh) || 20;
          const thresholdMid = parseFloat(config.priceMid) || 5;
          const cardPrice = parseFloat(card.price_trend) || 0;
          
          const existingRows = Array.from(new Set([
            'Row 1', 'Row 2', 'Row 3',
            ...locationCards.map(c => c.sub_location_1 || 'Row 1')
          ])).sort();

          if (existingRows.length >= 3) {
            if (cardPrice >= thresholdHigh) recommendedRow = existingRows[0]; 
            else if (cardPrice >= thresholdMid) recommendedRow = recommendedRow = existingRows[1]; 
            else recommendedRow = existingRows[2]; 
          }
        }
        else if (sortingPref === 'set-number') {
          const sameSetCards = locationCards.filter(c => c.set_name === card.set_name);
          if (sameSetCards.length > 0 && sameSetCards[0].sub_location_1) {
            recommendedRow = sameSetCards[0].sub_location_1;
          } else {
            const existingRows = Array.from(new Set([
              ...locationCards.map(c => c.sub_location_1)
            ])).filter(Boolean);
            const matchedRow = existingRows.find(r => r.toLowerCase().includes((card.set_name || '').toLowerCase()));
            if (matchedRow) {
              recommendedRow = matchedRow;
            }
          }
        }
      }

      const existingInRow = locationCards.filter(c => c.sub_location_1 === recommendedRow);
      const nextSeq = existingInRow.length + 1;
      return { sub1: recommendedRow, sub2: `Section ${nextSeq}`, label: `${recommendedRow}, Section ${nextSeq}` };
    } 
    else {
      if (selectedLoc.type === 'Deck Box') {
        const targetDeckSize = parseInt(config.targetDeckSize, 10) || 60;
        const currentCount = locationCards.reduce((acc, c) => acc + c.quantity, 0);
        if (currentCount >= targetDeckSize) {
          return { sub1: 'Compartment 1', sub2: `Slot ${locationCards.length + 1}`, label: `Slot ${locationCards.length + 1} (DECK EXCEEDS TARGET SIZE)` };
        }
      }

      const count = locationCards.length + 1;
      return { sub1: 'Compartment 1', sub2: `Slot ${count}`, label: `Slot ${count}` };
    }
  };

  const selectedLoc = locations.find(l => l.id === activeLocationId);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: `1fr ${isRightSidebarOpen ? '320px' : '0px'}`, gap: isRightSidebarOpen ? '1.25rem' : '0', height: 'calc(100vh - 120px)', minHeight: '650px', transition: 'grid-template-columns 0.3s ease' }} className="storage-workspace-grid">
      {/* Column 2: visual Container contents (Center) */}
      <div className="location-main-content-col" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', height: '100%', minWidth: 0 }}>
        {selectedLoc && (
          <div className="glass-panel" style={{ flex: 1, padding: '0.8rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', minHeight: 0, overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.4rem', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  {selectedLoc.type === 'Binder' || selectedLoc.type === 'Toploader Binder' ? <BookOpen size={20} style={{ color: 'var(--accent-red)' }} /> : selectedLoc.type === 'Box' || selectedLoc.type === 'Toploader Box' || selectedLoc.type === 'Graded Slab Box' ? <Archive size={20} style={{ color: 'var(--accent-red)' }} /> : <Layers size={20} style={{ color: 'var(--accent-red)' }} />}
                  <select
                    value={activeLocationId || ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val) setActiveLocationId(parseInt(val, 10));
                    }}
                    className="select-control title-dropdown"
                    style={{ 
                      fontSize: '1.25rem', 
                      fontWeight: 850, 
                      background: 'rgba(255,255,255,0.04)', 
                      border: '1px solid var(--border-glass)', 
                      borderRadius: 'var(--radius-sm)', 
                      color: '#fff', 
                      cursor: 'pointer', 
                      padding: '2px 8px', 
                      height: '34px' 
                    }}
                  >
                    {locations.map(loc => (
                      <option key={loc.id} value={loc.id} style={{ background: '#1e1c18', color: '#fff' }}>
                        {loc.name} ({loc.type})
                      </option>
                    ))}
                  </select>

                  <button 
                    type="button"
                    className="btn btn-secondary btn-icon-only" 
                    onClick={() => setIsAdding(true)}
                    style={{ width: '26px', height: '26px', padding: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    title="Create New Container"
                  >
                    <Plus size={14} />
                  </button>

                  <button 
                    type="button"
                    className="btn btn-secondary btn-icon-only" 
                    onClick={() => {
                      setEditName(selectedLoc.name);
                      setEditType(selectedLoc.type);
                      setEditSortOrder(selectedLoc.sort_order || 'custom');
                      setEditMaxPages(selectedLoc.max_pages || 30);
                      setEditPageStyle(selectedLoc.page_style || '3x3');
                      setEditMaxRows(selectedLoc.max_rows || 3);
                      setEditMaxCapacity(selectedLoc.max_capacity || 1000);
                      setIsEditing(true);
                    }}
                    style={{ width: '26px', height: '26px', padding: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem' }}
                    title="Edit Container Settings"
                  >
                    ⚙️
                  </button>
                </div>
                <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', marginTop: '0.3rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
                    {selectedLoc.type} • {selectedLoc.type === 'Binder' || selectedLoc.type === 'Toploader Binder' ? `${selectedLoc.max_pages || 30} pages (${selectedLoc.page_style || '3x3'})` : `${selectedLoc.max_rows || 3} rows`} • Value: <strong style={{ color: 'var(--accent-yellow)' }}>${locationCards.reduce((acc, curr) => acc + (curr.quantity * (curr.price_trend || 0)), 0).toFixed(2)}</strong>
                  </span>
                </div>
              </div>
            </div>

            {selectedLoc.type === 'Binder' && viewMode === 'grid' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', background: 'rgba(255,255,255,0.02)', padding: '0.5rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', width: 'fit-content' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Binder Page:</span>
                <select 
                  className="select-control" 
                  value={selectedPage} 
                  onChange={(e) => setSelectedPage(parseInt(e.target.value, 10))}
                  style={{ width: '100px', padding: '0.2rem 0.4rem', fontSize: '0.8rem' }}
                >
                  {Array.from({ length: selectedLoc.max_pages || 30 }, (_, i) => i + 1).map(p => (
                    <option key={p} value={p}>Page {p}</option>
                  ))}
                </select>
              </div>
            )}

            {(selectedLoc.type !== 'Binder' && selectedLoc.type !== 'Toploader Binder' && locationCards.length === 0) ? (
              <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem' }}>
                <p>This container is currently empty. Go to Search or Scanner to add cards to this location, or drag/place cards here!</p>
              </div>
            ) : (selectedLoc.type === 'Binder' || selectedLoc.type === 'Toploader Binder') ? (
              /* Binder Double Page Book Visualizer (Left & Right Pages side-by-side) */
              (() => {
                const leftPageNum = 2 * Math.floor((selectedPage - 1) / 2) + 1;
                const rightPageNum = leftPageNum + 1;

                const renderBinderPageGrid = (pageNum, sideClass) => {
                  const pocketsCols = selectedLoc.page_style === '2x2' ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)';
                  const pocketsCount = selectedLoc.page_style === '2x2' ? 4 : selectedLoc.page_style === '3x4' ? 12 : 9;

                  return (
                    <div className={sideClass} style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '0.35rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span style={{ fontSize: '0.75rem', fontWeight: 850, color: 'var(--text-secondary)', letterSpacing: '0.05em' }}>PAGE {pageNum}</span>
                              {sideClass === 'binder-page-left' ? (
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-icon-only"
                                  onClick={() => handleTurnPage(leftPageNum - 2)}
                                  disabled={leftPageNum === 1}
                                  style={{ width: '20px', height: '20px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.04)' }}
                                  title="Previous Page"
                                >
                                  <ChevronLeft size={12} />
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-icon-only"
                                  onClick={() => handleTurnPage(leftPageNum + 2)}
                                  disabled={leftPageNum + 1 >= (selectedLoc.max_pages || 30)}
                                  style={{ width: '20px', height: '20px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.04)' }}
                                  title="Next Page"
                                >
                                  <ChevronRight size={12} />
                                </button>
                              )}
                            </div>
                            <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                              {locationCards.filter(c => getPageNum(c.sub_location_1) === pageNum).length} Card(s)
                            </span>
                          </div>

                          <div style={{
                            display: 'grid',
                            gridTemplateColumns: pocketsCols,
                            gap: '0.4rem',
                            background: 'rgba(0,0,0,0.25)',
                            padding: '0.4rem',
                            borderRadius: 'var(--radius-sm)',
                            boxShadow: 'inset 0 4px 15px rgba(0,0,0,0.6)'
                          }}>
                            {Array.from({ length: pocketsCount }, (_, i) => i + 1).map(slotNum => {
                          const slotCards = locationCards.filter(c => getPageNum(c.sub_location_1) === pageNum && getSlotNum(c.sub_location_2) === slotNum);
                          const card = slotCards[0];
                          const isTargetable = !!activeMoveCard;

                          const rowsCount = selectedLoc.page_style === '2x2' ? 2 : selectedLoc.page_style === '3x4' ? 4 : 3;
                          const maxSlotHeight = `calc((100vh - 290px) / ${rowsCount})`;

                          return (
                            <div 
                              key={slotNum} 
                              onDragOver={(e) => e.preventDefault()}
                              onDrop={(e) => handleDrop(e, slotNum, pageNum)}
                              onClick={() => {
                                if (activeMoveCard) {
                                  handlePlaceCardInSlot(pageNum, slotNum);
                                }
                              }}
                              className={isTargetable ? 'slot-move-targetable' : ''}
                              style={{ 
                                aspectRatio: 0.718, 
                                maxHeight: maxSlotHeight,
                                border: card ? '1px solid rgba(255,255,255,0.1)' : isTargetable ? '2px dashed var(--accent-yellow)' : '2px dashed var(--border-glass)',
                                borderRadius: 'var(--radius-sm)',
                                background: card ? 'transparent' : isTargetable ? 'rgba(234, 179, 8, 0.08)' : 'rgba(0,0,0,0.3)',
                                display: 'flex',
                                flexDirection: 'column',
                                justifyContent: 'center',
                                alignItems: 'center',
                                position: 'relative',
                                overflow: 'hidden',
                                cursor: (card || isTargetable) ? 'pointer' : 'default',
                                padding: '2px',
                                boxShadow: card ? '0 5px 12px rgba(0,0,0,0.45)' : 'none',
                                transition: 'all 0.2s ease'
                              }}
                            >
                              {/* Slot Label */}
                              <span style={{ position: 'absolute', top: '4px', left: '6px', fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 800, zIndex: 10 }}>#{slotNum}</span>

                              {/* Stack Count Badge */}
                              {slotCards.length > 1 && (
                                <span style={{
                                  position: 'absolute',
                                  top: '4px',
                                  right: '6px',
                                  background: 'var(--accent-red)',
                                  color: '#fff',
                                  fontSize: '0.6rem',
                                  fontWeight: 800,
                                  padding: '1px 4px',
                                  borderRadius: '4px',
                                  zIndex: 10,
                                  boxShadow: '0 2px 4px rgba(0,0,0,0.4)',
                                  border: '1px solid rgba(255,255,255,0.1)'
                                }}>
                                  +{slotCards.length - 1} More
                                </span>
                              )}

                              {card ? (
                                <div 
                                  draggable={!isMobile}
                                  onDragStart={(e) => handleDragStart(e, card)}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (activeMoveCard) {
                                      handlePlaceCardInSlot(pageNum, slotNum);
                                    } else {
                                      setActiveMoveCard(card);
                                      showToast(`Selected ${card.name} for relocation. Tap a destination slot, row, or Unsorted to place.`);
                                    }
                                  }}
                                  style={{ width: '100%', height: '100%', position: 'relative', cursor: 'pointer' }}
                                  title={activeMoveCard ? "Click to swap/relocate" : "Click to view stack / Drag to relocate"}
                                >
                                  <img src={card.image_url} alt={card.name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '4px' }} />
                                  {/* Shiny holo overlay */}
                                  {((card.printing || '').toLowerCase().includes('holo') || (card.printing || '').toLowerCase().includes('foil')) && (
                                    <div style={{
                                      position: 'absolute',
                                      top: 0, left: 0, right: 0, bottom: 0,
                                      background: 'linear-gradient(135deg, rgba(255,255,255,0.2) 0%, rgba(255,255,255,0) 50%, rgba(255,255,255,0.1) 100%)',
                                      pointerEvents: 'none',
                                      zIndex: 2,
                                      mixBlendMode: 'overlay',
                                      borderRadius: '4px'
                                    }} />
                                  )}
                                  <div style={{
                                    position: 'absolute',
                                    bottom: 0, left: 0, right: 0,
                                    background: 'rgba(0,0,0,0.85)',
                                    backdropFilter: 'blur(1px)',
                                    padding: '3.5px',
                                    textAlign: 'center',
                                    fontSize: '0.65rem',
                                    color: '#fff',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    fontWeight: 600,
                                    borderBottomLeftRadius: '4px',
                                    borderBottomRightRadius: '4px'
                                  }}>
                                    {getCardDisplayName(card.name, card.language)} (x{card.quantity})
                                  </div>
                                </div>
                              ) : (
                                !activeMoveCard ? (
                                  <button 
                                    className="btn btn-secondary btn-icon-only" 
                                    style={{ borderRadius: '50%', width: '28px', height: '28px', padding: 0 }}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setTargetSlot(slotNum);
                                      handleTurnPage(pageNum);
                                      setShowQuickAdd(true);
                                    }}
                                  >
                                    <Plus size={12} />
                                  </button>
                                ) : (
                                  <span style={{ fontSize: '0.9rem', color: 'var(--accent-yellow)', opacity: 0.65 }} title="Click to place card here">🎯</span>
                                )
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                };

                const getPageNum = (str) => parseInt((str || '').replace(/\D/g, ''), 10) || 0;
                const getSlotNum = (str) => parseInt((str || '').replace(/\D/g, ''), 10) || 0;

                return (
                  <div 
                    style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'center', 
                      gap: '1rem', 
                      width: '100%', 
                      margin: '0 auto',
                      userSelect: 'none'
                    }}
                    onTouchStart={handleTouchStart}
                    onTouchMove={handleTouchMove}
                    onTouchEnd={handleTouchEnd}
                  >
                    {/* Book Container displaying Left & Right Pages */}
                    <div className={`binder-page-container ${isFlipping ? 'page-flip-effect' : ''}`} style={{ flex: 1, width: '100%' }}>
                      {/* Left Page (Odd Page) */}
                      {renderBinderPageGrid(leftPageNum, 'binder-page-left')}

                      {/* Binder Spine Metal Rings */}
                      <div className="binder-spine"></div>

                      {/* Right Page (Even Page) */}
                      {rightPageNum <= (selectedLoc.max_pages || 30) && renderBinderPageGrid(rightPageNum, 'binder-page-right')}
                    </div>
                  </div>
                );
              })()
            ) : (
              /* Cover Flow cards visualizer for all other containers */
              renderCardCoverFlow()
            )}
          </div>
        )}
      </div>

      {/* Column 3: Unsorted Cards Sidebar Panel (Right) */}
      <div 
        className="location-unsorted-col"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => handleDrop(e, null)}
        onClick={() => {
          if (activeMoveCard) {
            moveCardToLocation(activeMoveCard.entry_id, null, '', '');
            showToast(`Moved ${activeMoveCard.name} back to Unsorted Pile`);
            setActiveMoveCard(null);
          }
        }}
        style={{ 
          display: isRightSidebarOpen ? 'flex' : 'none', 
          flexDirection: 'column', 
          gap: '1rem', 
          height: '100%', 
          overflowY: 'auto',
          borderLeft: '1px solid var(--border-glass)',
          paddingLeft: '0.75rem',
          background: 'rgba(0,0,0,0.1)',
          borderRadius: 'var(--radius-sm)',
          padding: '0.5rem',
          cursor: activeMoveCard ? 'pointer' : 'default'
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 850, color: 'var(--text-secondary)', letterSpacing: '0.05em' }}>UNSORTED CARDS</span>
            <span style={{ fontSize: '0.65rem', background: 'var(--accent-red)', color: '#fff', padding: '1px 6px', borderRadius: '10px', fontWeight: 700 }}>
              {unsortedCards.length} left
            </span>
          </div>
          <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Drag cards here from storage to unsort them</span>
          
          <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: '4px', border: '1px solid var(--border-glass)', marginTop: '0.25rem' }}>
            <button 
              type="button" 
              onClick={() => setUnsortedViewMode('list')} 
              className={`btn ${unsortedViewMode === 'list' ? 'btn-primary' : 'btn-secondary'}`}
              style={{ fontSize: '0.6rem', padding: '0.2rem 0.5rem', flex: 1, borderRadius: '2px' }}
            >
              List View
            </button>
            <button 
              type="button" 
              onClick={() => setUnsortedViewMode('assistant')} 
              className={`btn ${unsortedViewMode === 'assistant' ? 'btn-primary' : 'btn-secondary'}`}
              style={{ fontSize: '0.6rem', padding: '0.2rem 0.5rem', flex: 1, borderRadius: '2px' }}
            >
              Assistant Mode
            </button>
          </div>
        </div>

        {unsortedCards.length > 0 ? (
          unsortedViewMode === 'assistant' ? (
            (() => {
              let queue = [...unsortedCards].filter(c => {
                const matchesSearch = c.name.toLowerCase().includes(unsortedSearch.toLowerCase()) || 
                                     (c.set_name || '').toLowerCase().includes(unsortedSearch.toLowerCase());
                if (!matchesSearch) return false;

                if (unsortedDateFilter === 'today') {
                  const todayMidnight = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
                  const addedTime = c.added_at ? new Date(c.added_at).getTime() : Date.now();
                  return addedTime >= todayMidnight;
                }
                if (unsortedDateFilter === 'yesterday') {
                  const todayMidnight = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
                  const yesterdayMidnight = todayMidnight - 24 * 60 * 60 * 1000;
                  const addedTime = c.added_at ? new Date(c.added_at).getTime() : Date.now();
                  return addedTime >= yesterdayMidnight && addedTime < todayMidnight;
                }
                if (unsortedDateFilter === 'week') {
                  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
                  const addedTime = c.added_at ? new Date(c.added_at).getTime() : Date.now();
                  return addedTime >= sevenDaysAgo;
                }
                return true;
              });

              queue.sort((a, b) => {
                if (unsortedSortOrder === 'scanned-desc') {
                  const timeA = a.added_at ? new Date(a.added_at).getTime() : 0;
                  const timeB = b.added_at ? new Date(b.added_at).getTime() : 0;
                  if (timeA !== timeB) return timeB - timeA;
                  return b.entry_id - a.entry_id;
                }
                if (unsortedSortOrder === 'scanned-asc') {
                  const timeA = a.added_at ? new Date(a.added_at).getTime() : 0;
                  const timeB = b.added_at ? new Date(b.added_at).getTime() : 0;
                  if (timeA !== timeB) return timeA - timeB;
                  return a.entry_id - b.entry_id;
                }
                if (unsortedSortOrder === 'name-asc') {
                  return a.name.localeCompare(b.name);
                }
                if (unsortedSortOrder === 'price-desc') {
                  return (b.price_trend || 0) - (a.price_trend || 0);
                }
                if (unsortedSortOrder === 'set-number') {
                  const cmp = (a.set_name || '').localeCompare(b.set_name || '');
                  if (cmp !== 0) return cmp;
                  return (parseInt(a.number || '0') || 0) - (parseInt(b.number || '0') || 0);
                }
                if (unsortedSortOrder === 'type-name') {
                  const typeA = (a.types && a.types[0]) || 'Unknown';
                  const typeB = (b.types && b.types[0]) || 'Unknown';
                  const orderA = POKEMON_TYPE_ORDER[typeA] || 50;
                  const orderB = POKEMON_TYPE_ORDER[typeB] || 50;
                  if (orderA !== orderB) return orderA - orderB;
                  return a.name.localeCompare(b.name);
                }
                if (unsortedSortOrder === 'set-number-printing') {
                  const setA = a.set_name || '';
                  const setB = b.set_name || '';
                  const cmpSet = setA.localeCompare(setB);
                  if (cmpSet !== 0) return cmpSet;

                  const numA = parseInt(a.number || '0', 10) || 0;
                  const numB = parseInt(b.number || '0', 10) || 0;
                  if (numA !== numB) return numA - numB;

                  const cmpNum = (a.number || '').localeCompare(b.number || '');
                  if (cmpNum !== 0) return cmpNum;

                  const printA = PRINTING_ORDER[a.printing] || 10;
                  const printB = PRINTING_ORDER[b.printing] || 10;
                  if (printA !== printB) return printA - printB;

                  return a.name.localeCompare(b.name);
                }
                return 0;
              });

              if (unsortedDateFilter === 'batch10') {
                queue = queue.slice(0, 10);
              } else if (unsortedDateFilter === 'batch50') {
                queue = queue.slice(0, 50);
              }

              let idx = assistantIndex;
              if (idx >= queue.length) {
                idx = Math.max(0, queue.length - 1);
              }
              const card = queue[idx];
              if (!card) {
                return (
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center', marginTop: '1rem', fontStyle: 'italic' }}>
                    No matches.
                  </div>
                );
              }

              const recommended = findNextRecommendedSlot(card);

              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem' }}>
                    <input 
                      type="text" 
                      className="input-control" 
                      placeholder="Search queue..." 
                      value={unsortedSearch}
                      onChange={(e) => {
                        setUnsortedSearch(e.target.value);
                        setAssistantIndex(0);
                      }}
                      style={{ padding: '0.3rem 0.5rem', fontSize: '0.75rem' }}
                    />
                    <div style={{ display: 'flex', gap: '0.4rem' }}>
                      <select 
                        className="select-control" 
                        value={unsortedSortOrder}
                        onChange={(e) => {
                          setUnsortedSortOrder(e.target.value);
                          setAssistantIndex(0);
                        }}
                        style={{ padding: '0.3rem 0.5rem', fontSize: '0.7rem', flex: 1 }}
                      >
                        <option value="name-asc">A-Z Alphabetical</option>
                        <option value="scanned-desc">Scanned (Newest First)</option>
                        <option value="scanned-asc">Scanned (Oldest First)</option>
                        <option value="price-desc">Value (High-Low)</option>
                        <option value="set-number">Set & Number</option>
                        <option value="set-number-printing">Set, Number & Printing</option>
                        <option value="type-name">Energy Type</option>
                      </select>
                      <select 
                        className="select-control" 
                        value={unsortedDateFilter}
                        onChange={(e) => {
                          setUnsortedDateFilter(e.target.value);
                          setAssistantIndex(0);
                        }}
                        style={{ padding: '0.3rem 0.5rem', fontSize: '0.7rem', flex: 1 }}
                      >
                        <option value="all">All Unsorted</option>
                        <option value="today">Scanned Today</option>
                        <option value="yesterday">Scanned Yesterday</option>
                        <option value="week">Scanned This Week</option>
                        <option value="batch10">Latest Batch (10)</option>
                        <option value="batch50">Latest Batch (50)</option>
                      </select>
                    </div>
                  </div>

                  <div className="glass-panel" style={{ padding: '0.6rem', display: 'flex', gap: '0.65rem', border: '1px solid var(--border-glass-hover)', background: 'rgba(255, 255, 255, 0.02)', alignItems: 'flex-start' }}>
                    <img src={card.image_url} alt={card.name} style={{ width: '65px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: '4px', boxShadow: '0 4px 10px rgba(0,0,0,0.5)', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                      <div>
                        <h4 style={{ color: '#fff', fontSize: '0.8rem', margin: 0, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{getCardDisplayName(card.name, card.language)}</h4>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{card.set_name} • #{card.number}</div>
                      </div>
                      
                      <div style={{ display: 'flex', gap: '8px', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
                        <div>Cond: <strong style={{ color: '#fff' }}>{card.condition}</strong></div>
                        <div>Value: <strong style={{ color: 'var(--accent-yellow)' }}>${(card.price_trend || 0).toFixed(2)}</strong></div>
                      </div>

                      {recommended ? (
                        <div style={{ background: 'rgba(255, 71, 71, 0.05)', border: '1px solid rgba(255, 71, 71, 0.15)', padding: '0.4rem', borderRadius: '4px', display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'center' }}>
                          <span style={{ fontSize: '0.55rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Recommended Target</span>
                          <strong style={{ fontSize: '0.75rem', color: 'var(--accent-red)' }}>{recommended.label}</strong>
                          
                          <button 
                            type="button" 
                            className="btn btn-primary"
                            onClick={async () => {
                              await moveCardToLocation(card.entry_id, selectedLoc.id, recommended.sub1, recommended.sub2);
                              showToast(`Placed ${card.name} in ${recommended.label}`);
                              if (idx >= queue.length - 1) {
                                setAssistantIndex(0);
                              }
                            }}
                            style={{ width: '100%', marginTop: '3px', fontSize: '0.65rem', padding: '0.25rem', height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                          >
                            Place Card Here
                          </button>
                        </div>
                      ) : (
                        <div style={{ fontSize: '0.65rem', color: 'var(--accent-red)', fontStyle: 'italic' }}>
                          Container full / none active.
                        </div>
                      )}

                      <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                        <button 
                          type="button" 
                          className="btn btn-secondary" 
                          onClick={() => setAssistantIndex(prev => Math.max(0, prev - 1))}
                          disabled={idx === 0}
                          style={{ flex: 1, fontSize: '0.65rem', padding: '0.2rem 0', height: '22px' }}
                        >
                          Prev
                        </button>
                        <span style={{ flex: 1.5, textAlign: 'center', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
                          {idx + 1}/{queue.length}
                        </span>
                        <button 
                          type="button" 
                          className="btn btn-secondary" 
                          onClick={() => setAssistantIndex(prev => (prev + 1) % queue.length)}
                          style={{ flex: 1, fontSize: '0.65rem', padding: '0.2rem 0', height: '22px' }}
                        >
                          Skip
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()
          ) : (
            <>
            {/* Sorting & Search */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <input 
                type="text" 
                className="input-control" 
                placeholder="Search unsorted..." 
                value={unsortedSearch}
                onChange={(e) => setUnsortedSearch(e.target.value)}
                style={{ padding: '0.3rem 0.5rem', fontSize: '0.75rem' }}
              />
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <select 
                  className="select-control" 
                  value={unsortedSortOrder}
                  onChange={(e) => setUnsortedSortOrder(e.target.value)}
                  style={{ padding: '0.3rem 0.5rem', fontSize: '0.7rem', flex: 1 }}
                >
                  <option value="name-asc">A-Z Alphabetical</option>
                  <option value="scanned-desc">Scanned (Newest First)</option>
                  <option value="scanned-asc">Scanned (Oldest First)</option>
                  <option value="price-desc">Value (High-Low)</option>
                  <option value="set-number">Set & Number</option>
                  <option value="set-number-printing">Set, Number & Printing</option>
                  <option value="type-name">Energy Type</option>
                </select>
                <select 
                  className="select-control" 
                  value={unsortedDateFilter}
                  onChange={(e) => setUnsortedDateFilter(e.target.value)}
                  style={{ padding: '0.3rem 0.5rem', fontSize: '0.7rem', flex: 1 }}
                >
                  <option value="all">All Unsorted</option>
                  <option value="today">Scanned Today</option>
                  <option value="yesterday">Scanned Yesterday</option>
                  <option value="week">Scanned This Week</option>
                  <option value="batch10">Latest Batch (10)</option>
                  <option value="batch50">Latest Batch (50)</option>
                </select>
              </div>
            </div>

            {/* Unsorted scroll list */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', overflowY: 'auto', flex: 1 }}>
              {(() => {
                let filteredUnsorted = [...unsortedCards].filter(c => {
                  const matchesSearch = c.name.toLowerCase().includes(unsortedSearch.toLowerCase()) || 
                                       (c.set_name || '').toLowerCase().includes(unsortedSearch.toLowerCase());
                  if (!matchesSearch) return false;

                  if (unsortedDateFilter === 'today') {
                    const todayMidnight = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
                    const addedTime = c.added_at ? new Date(c.added_at).getTime() : Date.now();
                    return addedTime >= todayMidnight;
                  }
                  if (unsortedDateFilter === 'yesterday') {
                    const todayMidnight = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
                    const yesterdayMidnight = todayMidnight - 24 * 60 * 60 * 1000;
                    const addedTime = c.added_at ? new Date(c.added_at).getTime() : Date.now();
                    return addedTime >= yesterdayMidnight && addedTime < todayMidnight;
                  }
                  if (unsortedDateFilter === 'week') {
                    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
                    const addedTime = c.added_at ? new Date(c.added_at).getTime() : Date.now();
                    return addedTime >= sevenDaysAgo;
                  }
                  return true;
                });

                filteredUnsorted.sort((a, b) => {
                  if (unsortedSortOrder === 'scanned-desc') {
                    const timeA = a.added_at ? new Date(a.added_at).getTime() : 0;
                    const timeB = b.added_at ? new Date(b.added_at).getTime() : 0;
                    if (timeA !== timeB) return timeB - timeA;
                    return b.entry_id - a.entry_id;
                  }
                  if (unsortedSortOrder === 'scanned-asc') {
                    const timeA = a.added_at ? new Date(a.added_at).getTime() : 0;
                    const timeB = b.added_at ? new Date(b.added_at).getTime() : 0;
                    if (timeA !== timeB) return timeA - timeB;
                    return a.entry_id - b.entry_id;
                  }
                  if (unsortedSortOrder === 'name-asc') {
                    return a.name.localeCompare(b.name);
                  }
                  if (unsortedSortOrder === 'price-desc') {
                    return (b.price_trend || 0) - (a.price_trend || 0);
                  }
                  if (unsortedSortOrder === 'set-number') {
                    const cmp = (a.set_name || '').localeCompare(b.set_name || '');
                    if (cmp !== 0) return cmp;
                    return (parseInt(a.number || '0') || 0) - (parseInt(b.number || '0') || 0);
                  }
                  if (unsortedSortOrder === 'type-name') {
                    const typeA = (a.types && a.types[0]) || 'Unknown';
                    const typeB = (b.types && b.types[0]) || 'Unknown';
                    const orderA = POKEMON_TYPE_ORDER[typeA] || 50;
                    const orderB = POKEMON_TYPE_ORDER[typeB] || 50;
                    if (orderA !== orderB) return orderA - orderB;
                    return a.name.localeCompare(b.name);
                  }
                  if (unsortedSortOrder === 'set-number-printing') {
                    const setA = a.set_name || '';
                    const setB = b.set_name || '';
                    const cmpSet = setA.localeCompare(setB);
                    if (cmpSet !== 0) return cmpSet;

                    const numA = parseInt(a.number || '0', 10) || 0;
                    const numB = parseInt(b.number || '0', 10) || 0;
                    if (numA !== numB) return numA - numB;

                    const cmpNum = (a.number || '').localeCompare(b.number || '');
                    if (cmpNum !== 0) return cmpNum;

                    const printA = PRINTING_ORDER[a.printing] || 10;
                    const printB = PRINTING_ORDER[b.printing] || 10;
                    if (printA !== printB) return printA - printB;

                    return a.name.localeCompare(b.name);
                  }
                  return 0;
                });

                if (unsortedDateFilter === 'batch10') {
                  filteredUnsorted = filteredUnsorted.slice(0, 10);
                } else if (unsortedDateFilter === 'batch50') {
                  filteredUnsorted = filteredUnsorted.slice(0, 50);
                }

                if (filteredUnsorted.length === 0) {
                  return (
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center', marginTop: '1rem', fontStyle: 'italic' }}>
                      No matches found.
                    </div>
                  );
                }

                return filteredUnsorted.map((card) => {
                  const isSelected = activeMoveCard?.entry_id === card.entry_id;
                  return (
                    <div 
                      key={card.entry_id}
                      draggable
                      onDragStart={(e) => handleDragStart(e, card)}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCardSelectForMove(card);
                      }}
                      className={isSelected ? 'card-move-selecting' : ''}
                      style={{ 
                        display: 'flex', 
                        gap: '0.5rem', 
                        alignItems: 'center', 
                        background: 'rgba(255,255,255,0.02)', 
                        padding: '0.4rem', 
                        borderRadius: 'var(--radius-sm)', 
                        border: isSelected ? '1.5px solid var(--accent-yellow)' : '1px solid var(--border-glass)',
                        cursor: 'pointer'
                      }}
                      title={`${card.name} - Click to select & move / Drag to relocate`}
                    >
                      <img src={card.image_url} alt={card.name} style={{ width: '36px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: '3px' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: '#fff', fontSize: '0.75rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {getCardDisplayName(card.name, card.language)}
                        </div>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {card.set_name} • #{card.number}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--accent-yellow)', fontWeight: 700 }}>x{card.quantity}</div>
                        <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>${(card.price_trend || 0).toFixed(2)}</div>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
            </>
          )
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', flex: 1, color: 'var(--text-secondary)', textAlign: 'center', padding: '1rem' }}>
            <span style={{ fontSize: '2rem' }}>🎉</span>
            <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#fff' }}>All Sorted!</span>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Every card in your collection has been successfully assigned to a location.</span>
          </div>
        )}
      </div>

      {/* Quick Add Card to Binder Slot Modal */}
      {showQuickAdd && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999, padding: '1rem' }}>
          <div className="glass-panel" style={{ maxWidth: '480px', width: '100%', padding: '1.75rem', position: 'relative' }}>
            <button 
              className="btn btn-secondary btn-icon-only" 
              onClick={() => {
                setShowQuickAdd(false);
                setSelectedCard(null);
                setSearchQuery('');
                setSearchResults([]);
              }} 
              style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}
            >
              <X size={16} />
            </button>
            
            <h3 style={{ fontSize: '1.2rem', color: '#fff', marginBottom: '0.2rem' }}>Insert Card to Binder Slot</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: '1.25rem' }}>
              Assigning card directly to <strong>Page {selectedPage}</strong>, <strong>Slot {targetSlot}</strong>.
            </p>

            {/* Step 1: Search */}
            {!selectedCard ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <form onSubmit={handleQuickSearch} style={{ display: 'flex', gap: '0.5rem' }}>
                  <input 
                    type="text" 
                    className="input-control" 
                    placeholder="Search card by name..." 
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button type="submit" className="btn btn-primary" disabled={searching}>Search</button>
                </form>

                {searching ? (
                  <div className="spinner" style={{ margin: '1rem auto' }}></div>
                ) : searchResults.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '180px', overflowY: 'auto', background: 'rgba(0,0,0,0.15)', padding: '0.5rem', borderRadius: 'var(--radius-sm)' }}>
                    {searchResults.map(card => (
                      <div 
                        key={card.id} 
                        className="search-row-item" 
                        onClick={() => {
                          setSelectedCard(card);
                          setQuickPrice(0);
                        }}
                        style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.35rem 0.5rem', background: 'rgba(255,255,255,0.01)', borderRadius: '4px', border: '1px solid var(--border-glass)', cursor: 'pointer' }}
                      >
                        <img src={card.image_url} alt={card.name} style={{ width: '24px', height: '33px', objectFit: 'cover', borderRadius: '2px' }} />
                        <span style={{ fontSize: '0.8rem', color: '#fff' }}>{card.name} ({card.set_name} • #{card.number})</span>
                      </div>
                    ))}
                  </div>
                ) : searchQuery && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center' }}>No cards found.</div>
                )}
              </div>
            ) : (
              /* Step 2: Configure & Submit */
              <form onSubmit={handleQuickAddSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', background: 'rgba(255, 255, 255, 0.02)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                  <img src={selectedCard.image_url} alt={selectedCard.name} style={{ width: '60px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: '4px' }} />
                  <div>
                    <div style={{ fontSize: '0.9rem', color: '#fff', fontWeight: 700 }}>{selectedCard.name}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{selectedCard.set_name} • #{selectedCard.number}</div>
                    <button 
                      type="button" 
                      className="btn btn-secondary" 
                      style={{ fontSize: '0.7rem', padding: '0.1rem 0.4rem', marginTop: '0.35rem' }}
                      onClick={() => setSelectedCard(null)}
                    >
                      Change Card
                    </button>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem' }}>
                  <div className="form-group">
                    <label>Quantity</label>
                    <input 
                      type="number" 
                      className="input-control" 
                      min="1" 
                      value={quickQty} 
                      onChange={(e) => setQuickQty(e.target.value)} 
                      required 
                    />
                  </div>
                  <div className="form-group">
                    <label>Purchase Price ($)</label>
                    <input 
                      type="number" 
                      step="0.01" 
                      className="input-control" 
                      value={quickPrice} 
                      onChange={(e) => setQuickPrice(e.target.value)} 
                    />
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem' }}>
                  <div className="form-group">
                    <label>Condition</label>
                    <select className="select-control" value={quickCond} onChange={(e) => setQuickCond(e.target.value)}>
                      <option value="Near Mint">Near Mint</option>
                      <option value="Lightly Played">Lightly Played</option>
                      <option value="Moderately Played">Moderately Played</option>
                      <option value="Heavily Played">Heavily Played</option>
                      <option value="Damaged">Damaged</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Printing</label>
                    <select className="select-control" value={quickPrint} onChange={(e) => setQuickPrint(e.target.value)}>
                      <option value="Normal">Normal</option>
                      <option value="Holofoil">Holofoil</option>
                      <option value="Reverse Holofoil">Reverse Holofoil</option>
                      <option value="1st Edition">1st Edition</option>
                      <option value="Promo">Promo</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Language</label>
                    <select className="select-control" value={quickLang} onChange={(e) => setQuickLang(e.target.value)}>
                      <option value="English">English</option>
                      <option value="Japanese">Japanese</option>
                      <option value="German">German</option>
                      <option value="French">French</option>
                      <option value="Spanish">Spanish</option>
                      <option value="Italian">Italian</option>
                    </select>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                  <button 
                    type="button" 
                    className="btn btn-secondary" 
                    style={{ flex: 1 }}
                    onClick={() => {
                      setShowQuickAdd(false);
                      setSelectedCard(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="btn btn-primary" style={{ flex: 2 }}>Insert Card</button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {activeMoveCard && (
        <div style={{
          position: 'fixed',
          bottom: '1rem',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'calc(100% - 2rem)',
          maxWidth: '480px',
          background: 'rgba(20,18,16,0.95)',
          backdropFilter: 'blur(10px)',
          border: '1.5px solid var(--accent-red)',
          borderRadius: 'var(--radius-md)',
          padding: '0.6rem 0.8rem',
          display: 'flex',
          gap: '0.75rem',
          alignItems: 'center',
          boxShadow: '0 10px 30px rgba(0,0,0,0.8)',
          zIndex: 99999
        }}>
          <div style={{ position: 'relative', width: '42px', aspectRatio: 0.718, flexShrink: 0, cursor: 'pointer' }} onClick={() => {
            setSelectedCardFilter(activeMoveCard.name);
            setActiveTab('collection');
          }} title="Click to view in collection list">
            <img src={activeMoveCard.image_url} alt={activeMoveCard.name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.1)' }} />
            {/* Shiny holo overlay */}
            {((activeMoveCard.printing || '').toLowerCase().includes('holo') || (activeMoveCard.printing || '').toLowerCase().includes('foil')) && (
              <div style={{
                position: 'absolute',
                top: 0, left: 0, right: 0, bottom: 0,
                background: 'linear-gradient(135deg, rgba(255,255,255,0.2) 0%, rgba(255,255,255,0) 50%, rgba(255,255,255,0.1) 100%)',
                pointerEvents: 'none',
                zIndex: 2,
                mixBlendMode: 'overlay',
                borderRadius: '4px'
              }} />
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div 
              onClick={() => {
                setSelectedCardFilter(activeMoveCard.name);
                setActiveTab('collection');
              }}
              style={{ fontWeight: 800, color: '#fff', fontSize: '0.8rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted' }}
              title="Click to view in collection list"
            >
              {getCardDisplayName(activeMoveCard.name, activeMoveCard.language)}
            </div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {activeMoveCard.set_name} • {activeMoveCard.condition}
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '2px' }}>
              <span style={{ fontSize: '0.65rem', color: 'var(--accent-yellow)', fontWeight: 700 }}>Val: ${(activeMoveCard.price_trend || 0).toFixed(2)}</span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flexShrink: 0, alignItems: 'flex-end' }}>
            {/* Qty Adjustment */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '3px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-glass)', borderRadius: '4px', padding: '1px 3px' }}>
              <button
                type="button"
                onClick={async (e) => {
                  e.stopPropagation();
                  if (activeMoveCard.quantity > 1) {
                    await handleUpdateQuantity(activeMoveCard.entry_id, activeMoveCard.quantity - 1);
                  }
                }}
                style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 900, padding: '0 4px', height: '18px', display: 'flex', alignItems: 'center' }}
              >
                -
              </button>
              <span style={{ color: '#fff', fontSize: '0.7rem', fontWeight: 800, minWidth: '14px', textAlign: 'center' }}>{activeMoveCard.quantity}</span>
              <button
                type="button"
                onClick={async (e) => {
                  e.stopPropagation();
                  await handleUpdateQuantity(activeMoveCard.entry_id, activeMoveCard.quantity + 1);
                }}
                style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 900, padding: '0 4px', height: '18px', display: 'flex', alignItems: 'center' }}
              >
                +
              </button>
            </div>

            <div style={{ display: 'flex', gap: '4px' }}>
              <button 
                type="button" 
                className="btn btn-secondary" 
                onClick={async (e) => {
                  e.stopPropagation();
                  await moveCardToLocation(activeMoveCard.entry_id, null, '', '');
                  showToast(`Moved ${activeMoveCard.name} to Unsorted Pile`);
                  setActiveMoveCard(null);
                  onUpdate();
                }}
                style={{ fontSize: '0.65rem', padding: '2px 6px', minHeight: '20px', height: '20px' }}
              >
                Unsort
              </button>
              <button 
                type="button" 
                className="btn btn-danger" 
                onClick={async (e) => {
                  e.stopPropagation();
                  if (window.confirm(`Delete ${activeMoveCard.name} from collection?`)) {
                    const res = await fetch(`/api/collection/${activeMoveCard.entry_id}`, { method: 'DELETE' });
                    if (res.ok) {
                      showToast(`Removed ${activeMoveCard.name}`);
                      setActiveMoveCard(null);
                      onUpdate();
                    }
                  }
                }}
                style={{ fontSize: '0.65rem', padding: '2px 6px', minHeight: '20px', height: '20px' }}
              >
                Delete
              </button>
              <button 
                type="button" 
                className="btn btn-secondary" 
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveMoveCard(null);
                }}
                style={{ fontSize: '0.65rem', padding: '2px 6px', minHeight: '20px', height: '20px' }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {isAdding && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.85)',
          backdropFilter: 'blur(5px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 99999,
          padding: '1rem'
        }}>
          <div className="glass-panel" style={{ width: '100%', maxWidth: '400px', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', border: '1px solid var(--accent-red)', boxShadow: '0 20px 40px rgba(0,0,0,0.8)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.4rem', marginBottom: '0.25rem' }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 850, color: '#fff', letterSpacing: '0.05em' }}>CREATE STORAGE CONTAINER</span>
              <button 
                type="button" 
                onClick={() => setIsAdding(false)} 
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <X size={16} />
              </button>
            </div>
            
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '2px' }}>Container Name</label>
              <input 
                type="text" 
                className="input-control" 
                placeholder="e.g. Vintage Binder, Deck Box A" 
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem' }}
              />
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '2px' }}>Container Type</label>
              <select 
                className="select-control" 
                value={type} 
                onChange={(e) => setType(e.target.value)}
                style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem' }}
              >
                <option value="Binder">Binder</option>
                <option value="Box">Storage Box</option>
                <option value="Toploader Box">Toploader Box</option>
                <option value="Deck Box">Deck Box</option>
                <option value="Tin / Case">Tin / Case</option>
                <option value="Graded Slab Box">Graded Slab Box</option>
                <option value="Toploader Binder">Toploader Binder</option>
                <option value="Display Shelf / Stand">Display Shelf / Stand</option>
                <option value="Other">Other</option>
              </select>
            </div>

            {/* Binder-specific fields */}
            {(type === 'Binder' || type === 'Toploader Binder') && (
              <>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '2px' }}>Binder Pages</label>
                  <input 
                    type="number" 
                    className="input-control" 
                    value={maxPages} 
                    onChange={(e) => setMaxPages(parseInt(e.target.value, 10) || 30)} 
                    min="1" max="100"
                    style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem' }}
                  />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '2px' }}>Pockets Style</label>
                  <select 
                    className="select-control" 
                    value={pageStyle} 
                    onChange={(e) => setPageStyle(e.target.value)}
                    style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem' }}
                  >
                    <option value="2x2">2x2 Layout (4 pocket)</option>
                    <option value="3x3">3x3 Layout (9 pocket)</option>
                    <option value="3x4">3x4 Layout (12 pocket)</option>
                  </select>
                </div>
              </>
            )}

            {/* Box-specific fields */}
            {(type === 'Box' || type === 'Toploader Box' || type === 'Graded Slab Box' || type === 'Display Shelf / Stand') && (
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '2px' }}>Rows / Shelves Count</label>
                <input 
                  type="number" 
                  className="input-control" 
                  value={maxRows} 
                  onChange={(e) => setMaxRows(parseInt(e.target.value, 10) || 3)} 
                  min="1" max="20"
                  style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem' }}
                />
              </div>
            )}

            {/* Capacity-specific fields */}
            {type !== 'Binder' && type !== 'Toploader Binder' && type !== 'Box' && type !== 'Toploader Box' && type !== 'Graded Slab Box' && type !== 'Display Shelf / Stand' && (
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '2px' }}>Max Capacity (Cards)</label>
                <input 
                  type="number" 
                  className="input-control" 
                  value={maxCapacity} 
                  onChange={(e) => setMaxCapacity(parseInt(e.target.value, 10) || 1000)} 
                  min="10"
                  style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem' }}
                />
              </div>
            )}

            {/* Persistent Preferred Sorting Method */}
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '2px' }}>Sorting Style</label>
              <select 
                className="select-control" 
                value={sortOrder} 
                onChange={(e) => setSortOrder(e.target.value)}
                style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem' }}
              >
                <option value="custom">Custom Sort</option>
                <option value="name-asc">Alphabetical A-Z</option>
                <option value="price-desc">Value (High-Low)</option>
                <option value="set-number">Set & Number</option>
                <option value="set-number-printing">Set, Number & Printing</option>
                <option value="type-name">Energy Type</option>
              </select>
            </div>

            {/* Advanced configurations accordion during creation */}
            {renderAdvancedConfigAccordion(true, createAdvancedConfig, setCreateAdvancedConfig)}

            <button 
              type="button" 
              className="btn btn-primary" 
              onClick={handleCreateLocation} 
              style={{ width: '100%', fontSize: '0.75rem', padding: '0.45rem', marginTop: '0.25rem' }}
            >
              Create
            </button>
          </div>
        </div>
      )}

      {/* Edit Location Modal Overlay */}
      {isEditing && selectedLoc && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.85)',
          backdropFilter: 'blur(8px)',
          zIndex: 1000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1rem'
        }}>
          <div className="glass-panel" style={{
            width: '100%',
            maxWidth: '350px',
            padding: '1.25rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.8rem',
            border: '1.5px solid var(--border-glass-hover)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem' }}>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 800, color: '#fff', margin: 0 }}>Edit Container</h3>
              <button 
                type="button" 
                onClick={() => setIsEditing(false)} 
                style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
              >
                <X size={16} />
              </button>
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '2px' }}>Name</label>
              <input 
                type="text" 
                className="input-control" 
                value={editName} 
                onChange={(e) => setEditName(e.target.value)} 
                style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem' }}
                placeholder="Container Name..."
              />
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '2px' }}>Container Type</label>
              <select 
                className="select-control" 
                value={editType} 
                onChange={(e) => setEditType(e.target.value)}
                style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem' }}
              >
                <option value="Binder">Binder</option>
                <option value="Box">Storage Box</option>
                <option value="Toploader Box">Toploader Box</option>
                <option value="Deck Box">Deck Box</option>
                <option value="Tin / Case">Tin / Case</option>
                <option value="Graded Slab Box">Graded Slab Box</option>
                <option value="Toploader Binder">Toploader Binder</option>
                <option value="Display Shelf / Stand">Display Shelf / Stand</option>
                <option value="Other">Other</option>
              </select>
            </div>

            {/* Binder-specific fields */}
            {(editType === 'Binder' || editType === 'Toploader Binder') && (
              <>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '2px' }}>Binder Pages</label>
                  <input 
                    type="number" 
                    className="input-control" 
                    value={editMaxPages} 
                    onChange={(e) => setEditMaxPages(parseInt(e.target.value, 10) || 30)} 
                    min="1" max="100"
                    style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem' }}
                  />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '2px' }}>Pockets Style</label>
                  <select 
                    className="select-control" 
                    value={editPageStyle} 
                    onChange={(e) => setEditPageStyle(e.target.value)}
                    style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem' }}
                  >
                    <option value="2x2">2x2 Layout (4 pocket)</option>
                    <option value="3x3">3x3 Layout (9 pocket)</option>
                    <option value="3x4">3x4 Layout (12 pocket)</option>
                  </select>
                </div>
              </>
            )}

            {/* Box-specific fields */}
            {(editType === 'Box' || editType === 'Toploader Box' || editType === 'Graded Slab Box' || editType === 'Display Shelf / Stand') && (
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '2px' }}>Rows / Shelves Count</label>
                <input 
                  type="number" 
                  className="input-control" 
                  value={editMaxRows} 
                  onChange={(e) => setEditMaxRows(parseInt(e.target.value, 10) || 3)} 
                  min="1" max="20"
                  style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem' }}
                />
              </div>
            )}

            {/* Capacity-specific fields */}
            {editType !== 'Binder' && editType !== 'Toploader Binder' && editType !== 'Box' && editType !== 'Toploader Box' && editType !== 'Graded Slab Box' && editType !== 'Display Shelf / Stand' && (
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '2px' }}>Max Capacity (Cards)</label>
                <input 
                  type="number" 
                  className="input-control" 
                  value={editMaxCapacity} 
                  onChange={(e) => setEditMaxCapacity(parseInt(e.target.value, 10) || 1000)} 
                  min="10"
                  style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem' }}
                />
              </div>
            )}

            {/* Sorting style settings */}
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '2px' }}>Sorting Style (Preferred)</label>
              <select 
                className="select-control" 
                value={editSortOrder} 
                onChange={(e) => setEditSortOrder(e.target.value)}
                style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem' }}
              >
                <option value="custom">Custom Sort</option>
                <option value="name-asc">Alphabetical A-Z</option>
                <option value="price-desc">Value (High-Low)</option>
                <option value="set-number">Set & Number</option>
                <option value="set-number-printing">Set, Number & Printing</option>
                <option value="type-name">Energy Type</option>
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.5rem' }}>
              <button 
                type="button" 
                className="btn btn-primary" 
                onClick={handleUpdateLocation} 
                style={{ width: '100%', fontSize: '0.75rem', padding: '0.45rem' }}
              >
                Save Settings
              </button>
              <button 
                type="button" 
                className="btn btn-danger" 
                onClick={() => handleDeleteLocation(selectedLoc.id, selectedLoc.name)} 
                style={{ width: '100%', fontSize: '0.75rem', padding: '0.45rem' }}
              >
                Delete Container
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default LocationManager;
