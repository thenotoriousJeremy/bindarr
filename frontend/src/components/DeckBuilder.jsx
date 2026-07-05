import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Edit2, X, ChevronLeft, Play, BarChart2, Search, ArrowRight, Eye, LogOut, LogIn, PackageCheck } from 'lucide-react';
import { ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';
import { shuffleArray } from '../utils/shuffle';

function DeckBuilder({ showToast }) {
  const [decks, setDecks] = useState([]);
  const [activeDeck, setActiveDeck] = useState(null);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState('list'); // 'list' or 'detail'
  
  // Deck Creation States
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newDeckName, setNewDeckName] = useState('');
  const [newDeckDesc, setNewDeckDesc] = useState('');
  
  // Card Search States inside editor
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);

  // Draw Simulator States
  const [showSimulator, setShowSimulator] = useState(false);
  const [simulatorDeck, setSimulatorDeck] = useState([]);
  const [hand, setHand] = useState([]);
  const [mulliganCount, setMulliganCount] = useState(0);

  // Checkout States
  const [checkingOut, setCheckingOut] = useState(false);

  useEffect(() => {
    fetchDecks();
  }, []);

  const fetchDecks = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/decks');
      if (response.ok) {
        const data = await response.json();
        setDecks(data);
      }
    } catch (err) {
      console.error(err);
      showToast('Error loading decks.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateDeck = async (e) => {
    e.preventDefault();
    if (!newDeckName.trim()) return;

    try {
      const response = await fetch('/api/decks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newDeckName, description: newDeckDesc })
      });

      if (response.ok) {
        showToast('Deck created successfully!');
        setNewDeckName('');
        setNewDeckDesc('');
        setShowCreateModal(false);
        fetchDecks();
      }
    } catch (err) {
      console.error(err);
      showToast('Error creating deck.');
    }
  };

  const loadDeckDetails = async (deckId) => {
    try {
      setLoading(true);
      const response = await fetch(`/api/decks/${deckId}`);
      if (response.ok) {
        const data = await response.json();
        // Also get checkout status from deck list
        const deckMeta = decks.find(d => d.id === deckId);
        setActiveDeck({ ...data, checked_out: deckMeta?.checked_out || 0, checked_out_at: deckMeta?.checked_out_at || null });
        setViewMode('detail');
      }
    } catch (err) {
      console.error(err);
      showToast('Error loading deck details.');
    } finally {
      setLoading(false);
    }
  };

  const handleAddCardToDeck = async (card) => {
    if (!activeDeck) return;
    
    // Find if card already exists in deck
    const existing = activeDeck.cards.find(c => c.id === card.id);
    const newQty = existing ? existing.quantity + 1 : 1;

    try {
      const response = await fetch(`/api/decks/${activeDeck.id}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_id: card.id, quantity: newQty })
      });

      if (response.ok) {
        showToast(`Added ${card.name} to deck`);
        // Refresh details locally
        loadDeckDetails(activeDeck.id);
      }
    } catch (err) {
      console.error(err);
      showToast('Failed to add card.');
    }
  };

  const handleUpdateCardQty = async (cardId, newQty) => {
    if (!activeDeck) return;

    if (newQty <= 0) {
      handleRemoveCard(cardId);
      return;
    }

    try {
      const response = await fetch(`/api/decks/${activeDeck.id}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_id: cardId, quantity: newQty })
      });

      if (response.ok) {
        loadDeckDetails(activeDeck.id);
      }
    } catch (err) {
      console.error(err);
      showToast('Failed to update quantity.');
    }
  };

  const handleRemoveCard = async (cardId) => {
    if (!activeDeck) return;

    try {
      const response = await fetch(`/api/decks/${activeDeck.id}/cards/${cardId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        showToast('Card removed from deck');
        loadDeckDetails(activeDeck.id);
      }
    } catch (err) {
      console.error(err);
      showToast('Failed to remove card.');
    }
  };

  const handleDeleteDeck = async (deckId, name) => {
    if (!window.confirm(`Are you sure you want to delete deck "${name}"?`)) return;

    try {
      const response = await fetch(`/api/decks/${deckId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        showToast('Deck deleted.');
        fetchDecks();
      }
    } catch (err) {
      console.error(err);
      showToast('Error deleting deck.');
    }
  };

  const handleSearchCards = async (e) => {
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

  // --- CHECKOUT / RETURN ---
  const handleCheckout = async () => {
    if (!activeDeck) return;
    try {
      setCheckingOut(true);
      const res = await fetch(`/api/decks/${activeDeck.id}/checkout`, { method: 'PUT' });
      if (res.ok) {
        showToast(`🎮 "${activeDeck.name}" is now checked out for play!`);
        setActiveDeck(prev => ({ ...prev, checked_out: 1, checked_out_at: new Date().toISOString() }));
        fetchDecks();
      } else {
        showToast('Failed to check out deck.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error checking out deck.');
    } finally {
      setCheckingOut(false);
    }
  };

  const handleReturn = async () => {
    if (!activeDeck) return;
    try {
      setCheckingOut(true);
      const res = await fetch(`/api/decks/${activeDeck.id}/return`, { method: 'PUT' });
      if (res.ok) {
        showToast(`📦 "${activeDeck.name}" returned to storage!`);
        setActiveDeck(prev => ({ ...prev, checked_out: 0, checked_out_at: null }));
        fetchDecks();
      } else {
        showToast('Failed to return deck.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error returning deck.');
    } finally {
      setCheckingOut(false);
    }
  };

  // --- DRAW SIMULATOR LOGIC ---
  const startSimulator = () => {
    if (!activeDeck || activeDeck.cards.length === 0) {
      showToast('Add some cards to the deck first!');
      return;
    }

    // Expand cards into full array based on quantities
    const fullDeck = [];
    activeDeck.cards.forEach(c => {
      for (let i = 0; i < c.quantity; i++) {
        fullDeck.push({ ...c });
      }
    });

    const shuffled = shuffleArray(fullDeck);
    setSimulatorDeck(shuffled);
    setHand(shuffled.slice(0, 7));
    setMulliganCount(0);
    setShowSimulator(true);
  };

  const handleMulligan = () => {
    const shuffled = shuffleArray(simulatorDeck);

    const nextMulligan = mulliganCount + 1;
    const drawCount = Math.max(1, 7 - nextMulligan);
    setSimulatorDeck(shuffled);
    setHand(shuffled.slice(0, drawCount));
    setMulliganCount(nextMulligan);
  };

  const handleDrawCard = () => {
    const currentHandSize = hand.length;
    if (currentHandSize >= simulatorDeck.length) {
      showToast('No cards left in the deck!');
      return;
    }
    const nextCard = simulatorDeck[currentHandSize];
    setHand([...hand, nextCard]);
  };

  // --- CHART DATA GENERATION ---
  const getSupertypeChartData = () => {
    if (!activeDeck) return [];
    const counts = { Pokémon: 0, Trainer: 0, Energy: 0 };
    activeDeck.cards.forEach(c => {
      let type = c.supertype || 'Pokémon';
      if (type === 'Pokemon') type = 'Pokémon';
      if (counts[type] !== undefined) {
        counts[type] += c.quantity;
      } else {
        counts['Pokémon'] += c.quantity;
      }
    });
    return Object.keys(counts).map(key => ({ name: key, value: counts[key] })).filter(d => d.value > 0);
  };

  const getEnergyChartData = () => {
    if (!activeDeck) return [];
    const energyMap = {};
    activeDeck.cards.forEach(c => {
      if (c.supertype === 'Energy') {
        const name = c.name.replace(/\s*Energy/i, '').trim() || 'Special';
        energyMap[name] = (energyMap[name] || 0) + c.quantity;
      } else if (c.types && c.types.length > 0) {
        c.types.forEach(t => {
          energyMap[t] = (energyMap[t] || 0) + c.quantity;
        });
      }
    });
    return Object.keys(energyMap).map(key => ({ name: key, value: energyMap[key] }));
  };

  const totalDeckCardsCount = activeDeck ? activeDeck.cards.reduce((sum, c) => sum + c.quantity, 0) : 0;
  const supertypeData = getSupertypeChartData();
  const energyData = getEnergyChartData();

  const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444'];

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      
      {/* 1. LIST VIEW OF ALL DECKS */}
      {viewMode === 'list' && (
        <>
          <div className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
            <div>
              <h2 style={{ fontSize: '1.25rem', color: '#fff' }}>Pokémon TCG Deck Builder</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Create, analyze, and simulate opening hands for custom 60-card decks.</p>
            </div>
            <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
              <Plus size={16} /> Create Deck
            </button>
          </div>

          {loading ? (
            <div className="spinner"></div>
          ) : decks.length === 0 ? (
            <div className="glass-panel" style={{ textAlign: 'center', padding: '3rem 1.5rem', color: 'var(--text-secondary)' }}>
              <p>No decks created yet. Click "Create Deck" above to begin your first build!</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1.25rem' }}>
              {decks.map(deck => (
                <div key={deck.id} className="glass-panel" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '1rem', border: deck.checked_out ? '1px solid rgba(234,179,8,0.4)' : '1px solid var(--border-glass-hover)', position: 'relative', overflow: 'hidden' }}>
                  
                  {/* In Play Banner */}
                  {deck.checked_out ? (
                    <div style={{
                      position: 'absolute',
                      top: 0, left: 0, right: 0,
                      background: 'linear-gradient(90deg, rgba(234,179,8,0.9), rgba(245,158,11,0.85))',
                      padding: '4px 12px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '0.65rem',
                      fontWeight: 800,
                      color: '#000',
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase'
                    }}>
                      <span>🎮</span>
                      <span>Currently In Play</span>
                      {deck.checked_out_at && (
                        <span style={{ marginLeft: 'auto', opacity: 0.75, fontWeight: 600 }}>
                          since {new Date(deck.checked_out_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  ) : null}

                  <div style={{ marginTop: deck.checked_out ? '28px' : 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <h3 style={{ color: '#fff', fontSize: '1.1rem', margin: 0 }}>{deck.name}</h3>
                      <span style={{ 
                        fontSize: '0.75rem', 
                        fontWeight: 700, 
                        padding: '0.15rem 0.4rem', 
                        borderRadius: '4px',
                        backgroundColor: deck.total_cards === 60 ? 'rgba(74, 222, 128, 0.1)' : 'rgba(255, 255, 255, 0.05)',
                        color: deck.total_cards === 60 ? 'var(--type-grass)' : 'var(--text-secondary)',
                        border: deck.total_cards === 60 ? '1px solid rgba(74, 222, 128, 0.2)' : '1px solid var(--border-glass)'
                      }}>
                        {deck.total_cards}/60 Cards
                      </span>
                    </div>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.5rem', minHeight: '36px' }}>
                      {deck.description || 'No description provided.'}
                    </p>
                  </div>

                  <div style={{ borderTop: '1px solid var(--border-glass)', paddingTop: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Created {new Date(deck.created_at).toLocaleDateString()}</span>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button className="btn btn-secondary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }} onClick={() => loadDeckDetails(deck.id)}>
                        <Edit2 size={12} /> Edit
                      </button>
                      <button className="btn btn-danger btn-icon-only" style={{ padding: '0.35rem' }} onClick={() => handleDeleteDeck(deck.id, deck.name)}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* 2. DECK EDITOR / DETAIL VIEW */}
      {viewMode === 'detail' && activeDeck && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Header */}
          <div className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', position: 'relative', overflow: 'hidden' }}>
            
            {/* Checked out banner */}
            {activeDeck.checked_out ? (
              <div style={{
                position: 'absolute',
                top: 0, left: 0, right: 0,
                height: '4px',
                background: 'linear-gradient(90deg, #eab308, #f59e0b, #eab308)',
                backgroundSize: '200% auto',
                animation: 'shimmer-gold 2s linear infinite'
              }} />
            ) : null}

            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <button className="btn btn-secondary btn-icon-only" onClick={() => { setViewMode('list'); fetchDecks(); }} style={{ borderRadius: '50%' }}>
                <ChevronLeft size={16} />
              </button>
              <div>
                <h2 style={{ fontSize: '1.25rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  {activeDeck.name}
                  <span style={{ fontSize: '0.8rem', color: totalDeckCardsCount === 60 ? 'var(--type-grass)' : 'var(--accent-yellow)', fontWeight: 600 }}>
                    ({totalDeckCardsCount}/60 cards)
                  </span>
                  {activeDeck.checked_out ? (
                    <span style={{
                      fontSize: '0.65rem',
                      background: 'rgba(234,179,8,0.15)',
                      border: '1px solid rgba(234,179,8,0.4)',
                      color: '#eab308',
                      padding: '2px 8px',
                      borderRadius: '12px',
                      fontWeight: 700,
                      letterSpacing: '0.05em',
                      textTransform: 'uppercase',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px'
                    }}>
                      🎮 In Play
                    </span>
                  ) : null}
                </h2>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{activeDeck.description || 'Custom deck build.'}</p>
                {activeDeck.checked_out && activeDeck.checked_out_at && (
                  <p style={{ color: '#eab308', fontSize: '0.7rem', marginTop: '2px' }}>
                    Checked out since {new Date(activeDeck.checked_out_at).toLocaleString()}
                  </p>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {/* Checkout / Return button */}
              {activeDeck.checked_out ? (
                <button
                  className="btn btn-secondary"
                  onClick={handleReturn}
                  disabled={checkingOut}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', border: '1px solid rgba(234,179,8,0.4)', color: '#eab308' }}
                >
                  <PackageCheck size={14} /> Return to Storage
                </button>
              ) : (
                <button
                  className="btn btn-secondary"
                  onClick={handleCheckout}
                  disabled={checkingOut}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                >
                  <LogOut size={14} /> Check Out for Play
                </button>
              )}
              <button className="btn btn-primary" onClick={startSimulator} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <Play size={14} /> Draw Simulator
              </button>
            </div>
          </div>

          {/* Checked out info banner */}
          {activeDeck.checked_out && (
            <div style={{
              background: 'rgba(234,179,8,0.06)',
              border: '1px solid rgba(234,179,8,0.25)',
              borderRadius: 'var(--radius-md)',
              padding: '0.85rem 1.25rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              fontSize: '0.85rem',
              color: '#eab308'
            }}>
              <span style={{ fontSize: '1.25rem' }}>🎮</span>
              <div>
                <strong>This deck is currently checked out for play.</strong>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  These cards are physically out of storage. Click "Return to Storage" when you're done playing to mark them as back in storage.
                </div>
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem', alignItems: 'start' }}>
            <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: '1.5rem' }}>
              
              {/* Left Column: Deck Card List */}
              <div style={{ flex: '2 1 500px', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                
                {/* Search & Quick Add to Deck */}
                <div className="glass-panel">
                  <h3 style={{ fontSize: '0.95rem', color: '#fff', marginBottom: '0.75rem' }}>Add Cards to Deck</h3>
                  <form onSubmit={handleSearchCards} style={{ display: 'flex', gap: '0.5rem' }}>
                    <input 
                      type="text" 
                      className="input-control" 
                      placeholder="Search card name (e.g. Pikachu, Cynthia)..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button type="submit" className="btn btn-primary" style={{ padding: '0.5rem 1.25rem' }}>
                      <Search size={16} />
                    </button>
                  </form>

                  {/* Search Results list */}
                  {searching ? (
                    <div className="spinner" style={{ margin: '1rem auto' }}></div>
                  ) : searchResults.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '1rem', maxHeight: '200px', overflowY: 'auto', background: 'rgba(0,0,0,0.15)', padding: '0.5rem', borderRadius: 'var(--radius-sm)' }}>
                      {searchResults.map(card => (
                        <div key={card.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.35rem 0.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', border: '1px solid var(--border-glass)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <img src={card.image_url} alt={card.name} style={{ width: '24px', height: '33px', objectFit: 'cover', borderRadius: '2px' }} />
                            <span style={{ fontSize: '0.8rem', color: '#fff' }}>{card.name} ({card.set_name} • #{card.number})</span>
                          </div>
                          <button className="btn btn-primary btn-icon-only" style={{ padding: '0.2rem' }} onClick={() => handleAddCardToDeck(card)}>
                            <Plus size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Deck list grouped by supertypes */}
                <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <h3 style={{ fontSize: '1rem', color: '#fff', borderLeft: '3px solid var(--accent-red)', paddingLeft: '0.5rem' }}>Deck Cards</h3>
                  
                  {activeDeck.cards.length === 0 ? (
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem 0' }}>This deck is currently empty. Use the search bar above to add cards.</p>
                  ) : (
                    ['Pokémon', 'Trainer', 'Energy'].map(supertype => {
                      const list = activeDeck.cards.filter(c => {
                        let type = c.supertype || 'Pokémon';
                        if (type === 'Pokemon') type = 'Pokémon';
                        return type.toLowerCase() === supertype.toLowerCase();
                      });
                      if (list.length === 0) return null;

                      const sum = list.reduce((total, c) => total + c.quantity, 0);

                      return (
                        <div key={supertype} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                          <h4 style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.25rem', display: 'flex', justifyContent: 'space-between' }}>
                            <span>{supertype}s</span>
                            <span style={{ color: '#fff', fontWeight: 600 }}>{sum}</span>
                          </h4>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                            {list.map(card => (
                              <div key={card.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.01)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                  <img src={card.image_url} alt={card.name} style={{ width: '32px', height: '44px', objectFit: 'cover', borderRadius: '2px' }} />
                                  <div>
                                    <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#fff' }}>{card.name}</div>
                                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{card.set_name} • #{card.number}</div>
                                  </div>
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                  {/* Qty modifier buttons */}
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: '4px', border: '1px solid var(--border-glass)' }}>
                                    <button 
                                      className="btn btn-secondary btn-icon-only" 
                                      style={{ width: '22px', height: '22px', padding: 0 }}
                                      onClick={() => handleUpdateCardQty(card.id, card.quantity - 1)}
                                    >
                                      -
                                    </button>
                                    <span style={{ padding: '0 0.4rem', fontSize: '0.85rem', fontWeight: 700, minWidth: '18px', textAlign: 'center', color: '#fff' }}>{card.quantity}</span>
                                    <button 
                                      className="btn btn-secondary btn-icon-only" 
                                      style={{ width: '22px', height: '22px', padding: 0 }}
                                      onClick={() => handleUpdateCardQty(card.id, card.quantity + 1)}
                                    >
                                      +
                                    </button>
                                  </div>

                                  <button className="btn btn-danger btn-icon-only" style={{ padding: '0.35rem' }} onClick={() => handleRemoveCard(card.id)}>
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Right Column: Statistics & Analytics Charts */}
              <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                
                {/* Pie Chart: Supertypes */}
                {supertypeData.length > 0 && (
                  <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <h3 style={{ fontSize: '0.95rem', color: '#fff', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <BarChart2 size={14} style={{ color: 'var(--accent-red)' }} /> Supertype Breakdown
                    </h3>
                    <div style={{ width: '100%', height: '180px' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={supertypeData}
                            cx="50%"
                            cy="50%"
                            innerRadius={50}
                            outerRadius={70}
                            paddingAngle={3}
                            dataKey="value"
                          >
                            {supertypeData.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip contentStyle={{ background: 'rgba(0,0,0,0.8)', border: '1px solid var(--border-glass)', borderRadius: '4px', fontSize: '0.8rem', color: '#fff' }} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    {/* Legend */}
                    <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
                      {supertypeData.map((d, index) => (
                        <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem' }}>
                          <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: PIE_COLORS[index % PIE_COLORS.length] }}></div>
                          <span style={{ color: 'var(--text-secondary)' }}>{d.name}: <strong>{d.value}</strong></span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Bar Chart: Energy & Types Distribution */}
                {energyData.length > 0 && (
                  <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <h3 style={{ fontSize: '0.95rem', color: '#fff', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <BarChart2 size={14} style={{ color: 'var(--accent-yellow)' }} /> Energy Type Distribution
                    </h3>
                    <div style={{ width: '100%', height: '220px' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={energyData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
                          <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={10} tickLine={false} />
                          <YAxis stroke="var(--text-muted)" fontSize={10} tickLine={false} />
                          <Tooltip contentStyle={{ background: 'rgba(0,0,0,0.8)', border: '1px solid var(--border-glass)', borderRadius: '4px', fontSize: '0.8rem', color: '#fff' }} />
                          <Bar dataKey="value" fill="var(--accent-yellow)" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}
              </div>

            </div>
          </div>
        </div>
      )}

      {/* --- POPUPS & MODALS --- */}

      {/* A. Create Deck Modal */}
      {showCreateModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999, padding: '1rem' }}>
          <div className="glass-panel" style={{ maxWidth: '450px', width: '100%', padding: '1.75rem', position: 'relative' }}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => setShowCreateModal(false)} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
              <X size={16} />
            </button>
            <h3 style={{ fontSize: '1.2rem', color: '#fff', marginBottom: '1.25rem' }}>Create New Deck</h3>

            <form onSubmit={handleCreateDeck} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="form-group">
                <label>Deck Name</label>
                <input 
                  type="text" 
                  className="input-control" 
                  placeholder="e.g. Charizard Blast..." 
                  value={newDeckName} 
                  onChange={(e) => setNewDeckName(e.target.value)}
                  required 
                />
              </div>

              <div className="form-group">
                <label>Description</label>
                <textarea 
                  className="input-control" 
                  style={{ minHeight: '80px', resize: 'vertical' }}
                  placeholder="e.g. Standard 60-card tournament deck focused on fire energy accelerations..." 
                  value={newDeckDesc} 
                  onChange={(e) => setNewDeckDesc(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowCreateModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 2 }}>Create Deck</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* B. Draw Hand Simulator Modal */}
      {showSimulator && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999, padding: '1rem' }}>
          <div className="glass-panel" style={{ maxWidth: '1000px', width: '100%', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem', position: 'relative' }}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => setShowSimulator(false)} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
              <X size={16} />
            </button>

            <div>
              <h3 style={{ fontSize: '1.25rem', color: '#fff', margin: 0 }}>Opening Hand Simulator</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.2rem' }}>
                Test your deck consistency. Shuffled deck. Mulligan count: <strong style={{ color: 'var(--accent-red)' }}>{mulliganCount}</strong>. Hand size: <strong>{hand.length}</strong> cards.
              </p>
            </div>

            {/* Hand Area */}
            <div style={{ 
              background: 'rgba(0,0,0,0.4)', 
              minHeight: '260px', 
              borderRadius: 'var(--radius-md)', 
              border: '1px solid var(--border-glass)', 
              display: 'flex', 
              flexWrap: 'wrap', 
              justifyContent: 'center', 
              alignItems: 'center', 
              gap: '1rem', 
              padding: '1.5rem' 
            }}>
              {hand.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No cards drawn yet.</div>
              ) : (
                hand.map((card, idx) => (
                  <div key={idx} style={{ 
                    width: '130px', 
                    aspectRatio: 0.718, 
                    borderRadius: '8px', 
                    overflow: 'hidden', 
                    boxShadow: '0 4px 10px rgba(0,0,0,0.5)',
                    animation: 'draw-card-anim 0.3s ease-out forwards',
                    border: '1px solid var(--border-glass)',
                    position: 'relative'
                  }}>
                    <img src={card.image_url} alt={card.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                ))
              )}
            </div>

            {/* Control buttons */}
            <div style={{ display: 'flex', justifyContent: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" onClick={startSimulator} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                Reshuffle & Restart
              </button>
              <button 
                className="btn btn-secondary" 
                onClick={handleMulligan} 
                style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                disabled={hand.length === 0}
              >
                Mulligan (Draw {Math.max(1, 7 - (mulliganCount + 1))})
              </button>
              <button 
                className="btn btn-primary" 
                onClick={handleDrawCard} 
                style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                disabled={hand.length >= simulatorDeck.length}
              >
                Draw 1 Card
              </button>
            </div>

            <style>{`
              @keyframes draw-card-anim {
                from { transform: translateY(30px) scale(0.85); opacity: 0; }
                to { transform: translateY(0) scale(1); opacity: 1; }
              }
              @keyframes shimmer-gold {
                0% { background-position: 0% center; }
                100% { background-position: 200% center; }
              }
            `}</style>
          </div>
        </div>
      )}

    </div>
  );
}

export default DeckBuilder;
