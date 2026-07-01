import React, { useState, useEffect } from 'react';
import { MapPin, Plus, Trash2, Library, BookOpen, Layers, Archive, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { getCardDisplayName } from '../utils/langHelper';

function LocationManager({ statsTrigger, onUpdate, showToast }) {
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeLocationId, setActiveLocationId] = useState(null);
  const [locationCards, setLocationCards] = useState([]);
  
  // Form states for creating a location
  const [name, setName] = useState('');
  const [type, setType] = useState('Binder');
  const [description, setDescription] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  // Binder Grid Visualizer states
  const [viewMode, setViewMode] = useState('list'); // 'list' (table) or 'grid' (3x3 layout)
  const [selectedPage, setSelectedPage] = useState(1);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [targetSlot, setTargetSlot] = useState(null);
  const [inspectedSlot, setInspectedSlot] = useState(null);
  const [isFlipping, setIsFlipping] = useState(false);
  
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
    if (activeLocationId) {
      fetchLocationCards(activeLocationId);
    } else {
      setLocationCards([]);
    }
  }, [activeLocationId, statsTrigger]);

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

  const handleDrop = async (e, targetSlot, targetPageNum = selectedPage) => {
    e.preventDefault();
    const entryId = parseInt(e.dataTransfer.getData('card_entry_id'), 10);
    if (!entryId) return;

    const sourceCard = locationCards.find(c => c.entry_id === entryId);
    if (!sourceCard) return;

    // Check if target slot is occupied to swap
    const getPageNum = (str) => parseInt((str || '').replace(/\D/g, ''), 10) || 0;
    const getSlotNum = (str) => parseInt((str || '').replace(/\D/g, ''), 10) || 0;
    const targetCard = locationCards.find(c => getPageNum(c.sub_location_1) === targetPageNum && getSlotNum(c.sub_location_2) === targetSlot);

    if (targetCard) {
      // SWAP Slots!
      try {
        const res1 = await fetch(`/api/collection/${sourceCard.entry_id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location_id: sourceCard.location_id,
            sub_location_1: `Page ${targetPageNum}`,
            sub_location_2: `Slot ${targetSlot}`,
            quantity: sourceCard.quantity,
            condition: sourceCard.condition,
            printing: sourceCard.printing,
            language: sourceCard.language,
            purchase_price: sourceCard.purchase_price,
            list_type: sourceCard.list_type,
            is_trade: sourceCard.is_trade
          })
        });

        const res2 = await fetch(`/api/collection/${targetCard.entry_id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location_id: targetCard.location_id,
            sub_location_1: sourceCard.sub_location_1,
            sub_location_2: sourceCard.sub_location_2,
            quantity: targetCard.quantity,
            condition: targetCard.condition,
            printing: targetCard.printing,
            language: targetCard.language,
            purchase_price: targetCard.purchase_price,
            list_type: targetCard.list_type,
            is_trade: targetCard.is_trade
          })
        });

        if (res1.ok && res2.ok) {
          showToast(`Swapped slots of ${sourceCard.name} and ${targetCard.name}`);
          fetchLocationCards(activeLocationId);
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
            location_id: sourceCard.location_id,
            sub_location_1: `Page ${targetPageNum}`,
            sub_location_2: `Slot ${targetSlot}`,
            quantity: sourceCard.quantity,
            condition: sourceCard.condition,
            printing: sourceCard.printing,
            language: sourceCard.language,
            purchase_price: sourceCard.purchase_price,
            list_type: sourceCard.list_type,
            is_trade: sourceCard.is_trade
          })
        });
        if (response.ok) {
          showToast(`Moved ${sourceCard.name} to Page ${targetPageNum} Slot ${targetSlot}`);
          fetchLocationCards(activeLocationId);
        } else {
          showToast('Failed to move card.');
        }
      } catch (err) {
        console.error(err);
        showToast('Error moving card.');
      }
    }
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
    e.preventDefault();
    if (!name) return;

    try {
      const response = await fetch('/api/locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type, description })
      });

      if (response.ok) {
        const data = await response.json();
        showToast('Storage container created successfully!');
        setName('');
        setDescription('');
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
        onUpdate();
        if (activeLocationId === locId) {
          setActiveLocationId(locations.length > 1 ? locations.find(l => l.id !== locId).id : null);
        }
      } else {
        showToast('Failed to delete container.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error deleting container.');
    }
  };

  const selectedLoc = locations.find(l => l.id === activeLocationId);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem' }}>
      {/* Location Manager Title Panel */}
      <div className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <MapPin size={22} style={{ color: 'var(--accent-red)' }} />
            Physical Card Storage Coordinator
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
            Track and search exactly where your physical cards reside in your real-world binders, boxes, and folders.
          </p>
        </div>
        <button 
          className="btn btn-primary" 
          onClick={() => setIsAdding(!isAdding)}
        >
          <Plus size={16} />
          {isAdding ? 'Close Form' : 'New Storage Container'}
        </button>
      </div>

      {/* Add New Container Form */}
      {isAdding && (
        <div className="glass-panel" style={{ borderLeft: '3px solid var(--accent-red)' }}>
          <h3 style={{ fontSize: '1rem', color: '#fff', marginBottom: '1rem' }}>Create Storage Container</h3>
          <form onSubmit={handleCreateLocation} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '1rem' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Container Name</label>
                <input 
                  type="text" 
                  className="input-control" 
                  placeholder="e.g. Master Binder, Neo Era Box, Bulk Row A" 
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Container Type</label>
                <select className="select-control" value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="Binder">Binder</option>
                  <option value="Box">Storage Box</option>
                  <option value="Other">Other / Shelf</option>
                </select>
              </div>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Description / Notes</label>
              <input 
                type="text" 
                className="input-control" 
                placeholder="e.g. Blue Ultra Pro 9-Pocket Binder for Scarlet & Violet era cards." 
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary" style={{ alignSelf: 'flex-end', padding: '0.5rem 1.5rem' }}>
              Create Container
            </button>
          </form>
        </div>
      )}

      {/* Main Containers Layout */}
      <div className="location-split-layout">
        {/* Left Side: Container Tabs (Vertical Sidebar on Desktop) */}
        <div className="location-sidebar">
          {locations.map((loc) => {
            const isActive = loc.id === activeLocationId;
            return (
              <div 
                key={loc.id} 
                className="glass-panel"
                onClick={() => setActiveLocationId(loc.id)}
                style={{ 
                  padding: '1rem', 
                  cursor: 'pointer',
                  border: isActive ? '1.5px solid var(--accent-red)' : '1px solid var(--border-glass)',
                  background: isActive ? 'rgba(255, 71, 71, 0.05)' : 'var(--bg-glass)',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: '0.5rem',
                  width: '100%'
                }}
              >
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ 
                      fontSize: '0.65rem', 
                      background: 'rgba(255,255,255,0.05)', 
                      padding: '2px 6px', 
                      borderRadius: '4px',
                      color: 'var(--text-secondary)',
                      fontWeight: 700,
                      textTransform: 'uppercase'
                    }}>
                      {loc.type}
                    </span>
                    {loc.name !== 'Unsorted Pile' && (
                      <button 
                        className="btn btn-danger btn-icon-only" 
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteLocation(loc.id, loc.name);
                        }}
                        style={{ padding: '2px', border: 'none', background: 'transparent' }}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                  <h4 style={{ color: '#fff', fontSize: '0.95rem', marginTop: '0.5rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', margin: 0 }}>{loc.name}</h4>
                  <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', margin: '0.2rem 0 0 0' }}>{loc.description || 'No description'}</p>
                </div>
                <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--accent-yellow)', borderTop: '1px solid var(--border-glass)', paddingTop: '0.5rem' }}>
                  {loc.total_cards || 0} Card(s) stored
                </div>
              </div>
            );
          })}
        </div>

        {/* Right Side: Container Contents */}
        {selectedLoc && (
          <div className="glass-panel" style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <h3 style={{ color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
                  {selectedLoc.type === 'Binder' ? <BookOpen size={18} /> : selectedLoc.type === 'Box' ? <Archive size={18} /> : <Layers size={18} />}
                  {selectedLoc.name} Contents
                </h3>
                
                {selectedLoc.type === 'Binder' && (
                  <div style={{ display: 'flex', background: 'rgba(0,0,0,0.25)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                    <button 
                      type="button"
                      className={`btn ${viewMode === 'list' ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setViewMode('list')}
                      style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem', borderRadius: 'var(--radius-sm)' }}
                    >
                      Table List
                    </button>
                    <button 
                      type="button"
                      className={`btn ${viewMode === 'grid' ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setViewMode('grid')}
                      style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem', borderRadius: 'var(--radius-sm)' }}
                    >
                      Visual 3x3 Page
                    </button>
                  </div>
                )}
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>TOTAL CONTAINER VALUE</div>
                <div style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--accent-yellow)' }}>
                  ${locationCards.reduce((acc, curr) => acc + (curr.quantity * (curr.price_trend || 0)), 0).toFixed(2)}
                </div>
              </div>
            </div>

            {selectedLoc.type === 'Binder' && viewMode === 'grid' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.25rem', background: 'rgba(255,255,255,0.02)', padding: '0.5rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', width: 'fit-content' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Binder Page:</span>
                <select 
                  className="select-control" 
                  value={selectedPage} 
                  onChange={(e) => setSelectedPage(parseInt(e.target.value, 10))}
                  style={{ width: '100px', padding: '0.2rem 0.4rem', fontSize: '0.8rem' }}
                >
                  {Array.from({ length: 30 }, (_, i) => i + 1).map(p => (
                    <option key={p} value={p}>Page {p}</option>
                  ))}
                </select>
              </div>
            )}

            {locationCards.length === 0 && viewMode === 'list' ? (
              <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem' }}>
                <p>This container is currently empty. Go to Search or Scanner to add cards to this location!</p>
              </div>
            ) : selectedLoc.type === 'Binder' && viewMode === 'grid' ? (
              /* Binder Double Page Book Visualizer (Left & Right Pages side-by-side) */
              (() => {
                const leftPageNum = 2 * Math.floor((selectedPage - 1) / 2) + 1;
                const rightPageNum = leftPageNum + 1;

                const renderBinderPageGrid = (pageNum, sideClass) => {
                  return (
                    <div className={sideClass} style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '0.35rem' }}>
                        <span style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--text-secondary)', letterSpacing: '0.05em' }}>PAGE {pageNum}</span>
                        <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                          {locationCards.filter(c => getPageNum(c.sub_location_1) === pageNum).length} Card(s)
                        </span>
                      </div>

                      <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(3, 1fr)',
                        gap: '0.75rem',
                        background: 'rgba(0,0,0,0.25)',
                        padding: '0.85rem',
                        borderRadius: 'var(--radius-sm)',
                        boxShadow: 'inset 0 4px 15px rgba(0,0,0,0.6)'
                      }}>
                        {Array.from({ length: 9 }, (_, i) => i + 1).map(slotNum => {
                          const slotCards = locationCards.filter(c => getPageNum(c.sub_location_1) === pageNum && getSlotNum(c.sub_location_2) === slotNum);
                          const card = slotCards[0];

                          return (
                            <div 
                              key={slotNum} 
                              onDragOver={(e) => e.preventDefault()}
                              onDrop={(e) => handleDrop(e, slotNum, pageNum)}
                              style={{ 
                                aspectRatio: 0.718, 
                                border: card ? '1px solid rgba(255,255,255,0.1)' : '2px dashed var(--border-glass)',
                                borderRadius: 'var(--radius-sm)',
                                background: card ? 'transparent' : 'rgba(0,0,0,0.3)',
                                display: 'flex',
                                flexDirection: 'column',
                                justifyContent: 'center',
                                alignItems: 'center',
                                position: 'relative',
                                overflow: 'hidden',
                                cursor: card ? 'pointer' : 'default',
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
                                  draggable="true"
                                  onDragStart={(e) => handleDragStart(e, card)}
                                  onClick={() => setInspectedSlot({ page: pageNum, slot: slotNum, cards: slotCards })}
                                  style={{ width: '100%', height: '100%', position: 'relative', cursor: 'pointer' }}
                                  title="Click to view stack / Drag to relocate"
                                >
                                  <img src={card.image_url} alt={card.name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '4px' }} />
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
                                <button 
                                  className="btn btn-secondary btn-icon-only" 
                                  style={{ borderRadius: '50%', width: '28px', height: '28px', padding: 0 }}
                                  onClick={() => {
                                    setTargetSlot(slotNum);
                                    handleTurnPage(pageNum);
                                    setShowQuickAdd(true);
                                  }}
                                >
                                  <Plus size={12} />
                                </button>
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
                    {/* Book Left Page Turner */}
                    <button
                      type="button"
                      className="btn btn-secondary btn-icon-only"
                      onClick={() => handleTurnPage(leftPageNum - 2)}
                      disabled={leftPageNum === 1}
                      style={{
                        borderRadius: '50%',
                        width: '38px',
                        height: '38px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid var(--border-glass)',
                        cursor: leftPageNum === 1 ? 'default' : 'pointer',
                        opacity: leftPageNum === 1 ? 0.3 : 1,
                        transition: 'all 0.2s ease',
                        flexShrink: 0
                      }}
                      title="Previous Pages"
                    >
                      <ChevronLeft size={18} />
                    </button>

                    {/* Book Container displaying Left & Right Pages */}
                    <div className={`binder-page-container ${isFlipping ? 'page-flip-effect' : ''}`}>
                      {/* Left Page (Odd Page) */}
                      {renderBinderPageGrid(leftPageNum, 'binder-page-left')}

                      {/* Binder Spine Metal Rings */}
                      <div className="binder-spine"></div>

                      {/* Right Page (Even Page) */}
                      {rightPageNum <= 30 && renderBinderPageGrid(rightPageNum, 'binder-page-right')}
                    </div>

                    {/* Book Right Page Turner */}
                    <button
                      type="button"
                      className="btn btn-secondary btn-icon-only"
                      onClick={() => handleTurnPage(leftPageNum + 2)}
                      disabled={leftPageNum === 29}
                      style={{
                        borderRadius: '50%',
                        width: '38px',
                        height: '38px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid var(--border-glass)',
                        cursor: leftPageNum === 29 ? 'default' : 'pointer',
                        opacity: leftPageNum === 29 ? 0.3 : 1,
                        transition: 'all 0.2s ease',
                        flexShrink: 0
                      }}
                      title="Next Pages"
                    >
                      <ChevronRight size={18} />
                    </button>
                  </div>
                );
              })()
            ) : (
              /* Traditional coordinates Table List */
              <div className="collection-table-wrapper">
                <table className="collection-table">
                  <thead>
                    <tr>
                      <th>Physical Location</th>
                      <th>Card Details</th>
                      <th>Condition / Printing</th>
                      <th>Quantity</th>
                      <th>Price / Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {locationCards.map((card) => (
                      <tr key={card.entry_id}>
                        <td style={{ fontWeight: 700, color: 'var(--accent-red)' }}>
                          {selectedLoc.type === 'Binder' ? (
                            <span>{card.sub_location_1 || 'Unassigned Page'} • {card.sub_location_2 || 'Unassigned Slot'}</span>
                          ) : (
                            <span>{card.sub_location_1 || 'Unassigned Row'} • {card.sub_location_2 || 'Unassigned Divider'}</span>
                          )}
                        </td>
                        <td>
                          <div className="collection-card-row-info">
                            <img src={card.image_url} alt={card.name} className="collection-row-thumbnail" />
                            <div>
                              <div style={{ fontWeight: 700, color: '#fff' }}>{getCardDisplayName(card.name, card.language)}</div>
                              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                {card.set_name} • #{card.number} ({card.rarity})
                              </div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <div style={{ fontSize: '0.85rem', color: '#fff' }}>{card.condition}</div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{card.printing} • {card.language}</div>
                        </td>
                        <td style={{ fontWeight: 600 }}>x{card.quantity}</td>
                        <td>
                          <div style={{ fontWeight: 600, color: 'var(--accent-yellow)' }}>${(card.price_trend || 0).toFixed(2)}</div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            Spent: ${((card.purchase_price || 0) * card.quantity).toFixed(2)}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
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

      {/* Visual Slot Inspector Modal Overlay */}
      {inspectedSlot && (
        <div 
          className="modal-backdrop" 
          onClick={() => setInspectedSlot(null)}
          style={{
            position: 'fixed',
            top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.7)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1100
          }}
        >
          <div 
            className="glass-panel" 
            onClick={(e) => e.stopPropagation()} 
            style={{ 
              width: '420px', 
              maxWidth: '92%', 
              padding: '1.25rem',
              boxShadow: 'var(--shadow-glow)',
              border: '1px solid var(--border-glass-hover)',
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.6rem' }}>
              <div>
                <h3 style={{ color: '#fff', fontSize: '1rem', margin: 0 }}>Binder Page {inspectedSlot.page} • Slot {inspectedSlot.slot}</h3>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Contains {inspectedSlot.cards.length} card(s)</span>
              </div>
              <button 
                className="btn btn-secondary btn-icon-only" 
                onClick={() => setInspectedSlot(null)} 
                style={{ borderRadius: '50%', width: '26px', height: '26px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <X size={14} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', maxHeight: '280px', overflowY: 'auto', paddingRight: '0.2rem' }}>
              {inspectedSlot.cards.map((card) => (
                <div key={card.entry_id} style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', background: 'rgba(255, 255, 255, 0.02)', padding: '0.4rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                  <img src={card.image_url} alt={card.name} style={{ width: '38px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.08)' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.8rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{getCardDisplayName(card.name, card.language)}</div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {card.printing} • {card.condition} • {card.language}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.2rem' }}>
                    <span style={{ fontWeight: 800, color: 'var(--accent-yellow)', fontSize: '0.8rem' }}>x{card.quantity}</span>
                    <button 
                      className="btn btn-danger" 
                      onClick={async () => {
                        if (window.confirm(`Delete ${card.name} from this slot?`)) {
                          try {
                            const res = await fetch(`/api/collection/${card.entry_id}`, { method: 'DELETE' });
                            if (res.ok) {
                              showToast(`Removed ${card.name}`);
                              onUpdate();
                              fetchLocationCards(activeLocationId);
                              
                              const updatedCards = inspectedSlot.cards.filter(c => c.entry_id !== card.entry_id);
                              if (updatedCards.length === 0) {
                                setInspectedSlot(null);
                              } else {
                                setInspectedSlot(prev => ({
                                  ...prev,
                                  cards: updatedCards
                                }));
                              }
                            } else {
                              showToast('Failed to delete card.');
                            }
                          } catch (err) {
                            console.error(err);
                            showToast('Error deleting card.');
                          }
                        }
                      }}
                      style={{ fontSize: '0.6rem', padding: '2px 5px', border: 'none', borderRadius: 'var(--radius-xs)', minHeight: '18px' }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
              <button 
                type="button" 
                className="btn btn-secondary" 
                onClick={() => setInspectedSlot(null)}
                style={{ flex: 1, fontSize: '0.75rem', padding: '0.4rem 0' }}
              >
                Close
              </button>
              <button 
                type="button" 
                className="btn btn-primary" 
                onClick={() => {
                  setTargetSlot(inspectedSlot.slot);
                  setInspectedSlot(null);
                  setShowQuickAdd(true);
                }}
                style={{ flex: 2, fontSize: '0.75rem', padding: '0.4rem 0' }}
              >
                + Add Card Here
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default LocationManager;
