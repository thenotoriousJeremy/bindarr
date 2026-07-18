import { useState, useEffect } from 'react';
import { Plus, Trash2, X, ChevronLeft, Play, BarChart2, Search, LogOut, PackageCheck, LayoutGrid, List, Download, Upload, Eye, Filter, CheckCircle, AlertTriangle, Layers, Zap, Swords, Gamepad2, SlidersHorizontal, ArrowRight, FolderPlus, FileText } from 'lucide-react';
import { ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';
import { shuffleArray } from '../utils/shuffle';
import { translateJapaneseName } from '../utils/langHelper';
import CheckoutWizardModal from './CheckoutWizardModal';
import { useBackGuard } from '../utils/useBackGuard';

// Basic Energy (Pokémon) & Basic Lands (MTG) are exempt from the "max 4 of a card" deck rule.
const isBasicEnergyOrLand = (card, game = 'pokemon') => {
  if (!card) return false;
  if (game === 'mtg' || card.game === 'mtg') {
    const subs = card.subtypes || [];
    const basicTypes = ['Basic', 'Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes'];
    return (subs.includes('Land') || card.supertype === 'Land') && basicTypes.some(t => subs.includes(t) || card.name === t);
  }
  return card.supertype === 'Energy' && (!card.subtypes || !card.subtypes.includes('Special'));
};

// Total copies of a card (matched by name) already in a deck's card list.
const deckCountByName = (deckCards, name) =>
  (deckCards || []).filter(c => c.name === name).reduce((s, c) => s + c.quantity, 0);

function DeckBuilder({ showToast }) {
  const [decks, setDecks] = useState([]);
  const [activeDeck, setActiveDeck] = useState(null);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState('list'); // 'list' or 'detail'
  
  // Deck View & Display Modes
  const [cardDisplayMode, setCardDisplayMode] = useState('list'); // 'list' | 'grid'
  const [previewCard, setPreviewCard] = useState(null);

  // Deck Creation States & Constants
  const POKEMON_FORMATS = ['Standard', 'Expanded', 'GLC (Gym Leader Challenge)', 'Unlimited', 'Retro'];
  const MTG_FORMATS = ['Commander / EDH', 'Standard', 'Modern', 'Pioneer', 'Legacy', 'Vintage', 'Pauper'];
  const DECK_CATEGORIES = ['Competitive', 'Casual', 'Tournament', 'Theorycraft', 'Proxy', 'Trade'];
  const DECK_ACCENT_COLORS = [
    { name: 'Gold', hex: '#eab308' },
    { name: 'Red', hex: '#ef4444' },
    { name: 'Blue', hex: '#3b82f6' },
    { name: 'Green', hex: '#10b981' },
    { name: 'Purple', hex: '#a855f7' },
    { name: 'Slate', hex: '#64748b' },
    { name: 'Pink', hex: '#ec4899' },
    { name: 'Orange', hex: '#f97316' },
  ];

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newDeckName, setNewDeckName] = useState('');
  const [newDeckDesc, setNewDeckDesc] = useState('');
  const [newDeckGame, setNewDeckGame] = useState('pokemon'); // 'pokemon' | 'mtg'
  const [newDeckFormat, setNewDeckFormat] = useState('Standard');
  const [newDeckCategory, setNewDeckCategory] = useState('Competitive');
  const [newDeckAccentColor, setNewDeckAccentColor] = useState('#eab308');
  const [newDeckTargetSize, setNewDeckTargetSize] = useState(60);
  const [newDeckImportText, setNewDeckImportText] = useState('');
  const [showImportDecklistArea, setShowImportDecklistArea] = useState(false);
  
  // Card Search States inside editor
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [deckSearchGame, setDeckSearchGame] = useState('pokemon'); // 'pokemon' | 'mtg'

  // Deck Selection Menu Controls
  const [deckSearchTerm, setDeckSearchTerm] = useState('');
  const [deckGameFilter, setDeckGameFilter] = useState('all'); // 'all' | 'pokemon' | 'mtg'
  const [deckStatusFilter, setDeckStatusFilter] = useState('all'); // 'all' | 'ready' | 'in_progress' | 'in_play'
  const [deckSortBy, setDeckSortBy] = useState('created_desc'); // 'created_desc' | 'created_asc' | 'name_asc' | 'cards_desc'
  const [deckSelectionViewMode, setDeckSelectionViewMode] = useState('table'); // 'grid' | 'table'

  // Draw Simulator States
  const [showSimulator, setShowSimulator] = useState(false);
  const [simulatorDeck, setSimulatorDeck] = useState([]);
  const [hand, setHand] = useState([]);
  const [prizeCards, setPrizeCards] = useState([]);
  const [mulliganCount, setMulliganCount] = useState(0);

  // Import / Export Modals
  const [showImportModal, setShowImportModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [importText, setImportText] = useState('');
  const [importComparison, setImportComparison] = useState(null);
  const [comparingImport, setComparingImport] = useState(false);

  // Checkout States
  const [checkingOut, setCheckingOut] = useState(false);
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);
  const [checkoutLocations, setCheckoutLocations] = useState([]);
  const [checkoutMode, setCheckoutMode] = useState('checkout'); // 'checkout' | 'checkin'
  const [checkoutDeckId, setCheckoutDeckId] = useState(null); // deck the open modal acts on

  // True while an add/qty write is in flight. Blocks overlapping clicks that
  // would otherwise each compute a new quantity from the same stale render and
  // clobber one another (last-writer-wins on the server upsert).
  const [savingCard, setSavingCard] = useState(false);

  useBackGuard(showCreateModal, () => setShowCreateModal(false));
  useBackGuard(showSimulator, () => setShowSimulator(false));

  useEffect(() => {
    fetchDecks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        body: JSON.stringify({ 
          name: newDeckName, 
          description: newDeckDesc, 
          game: newDeckGame,
          format: newDeckFormat,
          category: newDeckCategory,
          accent_color: newDeckAccentColor,
          target_size: newDeckTargetSize,
          decklist_text: newDeckImportText
        })
      });

      if (response.ok) {
        showToast('Deck created successfully!');
        setNewDeckName('');
        setNewDeckDesc('');
        setNewDeckGame('pokemon');
        setNewDeckFormat('Standard');
        setNewDeckCategory('Competitive');
        setNewDeckAccentColor('#eab308');
        setNewDeckTargetSize(60);
        setNewDeckImportText('');
        setShowImportDecklistArea(false);
        setShowCreateModal(false);
        fetchDecks();
      } else {
        showToast('Failed to create deck.');
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
        // Default the card search to this deck's game.
        setDeckSearchGame(data.game || 'pokemon');
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
    if (!activeDeck || savingCard) return;

    // Find if card already exists in deck
    const existing = activeDeck.cards.find(c => c.id === card.id);
    const newQty = existing ? existing.quantity + 1 : 1;

    setSavingCard(true);
    try {
      const response = await fetch(`/api/decks/${activeDeck.id}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_id: card.id, quantity: newQty })
      });

      if (response.ok) {
        showToast(`Added ${card.name} to deck`);
        // Refresh details locally
        await loadDeckDetails(activeDeck.id);
      } else {
        showToast('Failed to add card.');
      }
    } catch (err) {
      console.error(err);
      showToast('Failed to add card.');
    } finally {
      setSavingCard(false);
    }
  };

  const handleUpdateCardQty = async (cardId, newQty) => {
    if (!activeDeck || savingCard) return;

    // Guard against NaN/garbage from a manual quantity input before it reaches
    // the server as an invalid quantity.
    if (!Number.isFinite(newQty)) return;

    if (newQty <= 0) {
      handleRemoveCard(cardId);
      return;
    }

    // Check limits on increment
    const card = activeDeck.cards.find(c => c.id === cardId);
    if (card && newQty > card.quantity) {
      if (newQty > (card.owned_qty || 0)) {
        showToast(`You only own ${card.owned_qty} copies of ${card.name}.`);
        return;
      }
      
      if (!isBasicEnergyOrLand(card, activeDeck.game) && deckCountByName(activeDeck.cards, card.name) >= 4) {
        showToast(`Cannot have more than 4 copies of ${card.name}.`);
        return;
      }
    }

    setSavingCard(true);
    try {
      const response = await fetch(`/api/decks/${activeDeck.id}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_id: cardId, quantity: newQty })
      });

      if (response.ok) {
        await loadDeckDetails(activeDeck.id);
      } else {
        showToast('Failed to update quantity.');
      }
    } catch (err) {
      console.error(err);
      showToast('Failed to update quantity.');
    } finally {
      setSavingCard(false);
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
      } else {
        showToast('Failed to remove card.');
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

  const handleSearchCards = async (e, forceBrowse = false) => {
    if (e) e.preventDefault();
    try {
      setSearching(true);
      if (forceBrowse || !searchQuery.trim()) {
        const res = await fetch(`/api/collection?game=${deckSearchGame}`);
        if (res.ok) {
          const data = await res.json();
          const mapped = data.map(item => ({
            id: item.card_id,
            name: item.name,
            set_name: item.set_name,
            number: item.number || item.collector_number || item.card_number || '',
            image_url: item.image_url,
            owned_qty: item.quantity || 1,
            supertype: item.supertype,
            subtypes: item.subtypes,
            types: item.types,
            colors: item.colors,
            cmc: item.cmc
          }));
          setSearchResults(mapped);
        }
      } else {
        const finalQuery = deckSearchGame === 'mtg' ? searchQuery : (translateJapaneseName(searchQuery) || searchQuery);
        const response = await fetch(`/api/search?name=${encodeURIComponent(finalQuery)}&scope=collection&game=${deckSearchGame}`);
        if (response.ok) {
          const data = await response.json();
          setSearchResults(data);
        } else {
          showToast(response.status === 429 ? 'Rate limit reached. Try again shortly.' : 'Search failed.');
        }
      }
    } catch (err) {
      console.error(err);
      showToast('Search failed.');
    } finally {
      setSearching(false);
    }
  };

  // --- CHECKOUT / RETURN ---
  const handleCheckout = async (deck = null) => {
    const targetDeck = deck || activeDeck;
    if (!targetDeck) return;
    try {
      setCheckingOut(true);
      const res = await fetch(`/api/decks/${targetDeck.id}/checkout`, { method: 'PUT' });
      if (res.ok) {
        showToast(`🎮 "${targetDeck.name}" is now checked out for play!`);
        if (activeDeck && activeDeck.id === targetDeck.id) {
          setActiveDeck(prev => ({ ...prev, checked_out: 1, checked_out_at: new Date().toISOString() }));
        }
        fetchDecks();

        const locRes = await fetch(`/api/decks/${targetDeck.id}/locations`);
        if (locRes.ok) {
          const locData = await locRes.json();
          setCheckoutLocations(locData);
          setCheckoutMode('checkout');
          setCheckoutDeckId(targetDeck.id);
          setShowCheckoutModal(true);
        }
      } else {
        const errData = await res.json().catch(() => null);
        if (errData && errData.details && errData.details.length > 0) {
          showToast(`Checkout Failed: ${errData.details[0]}${errData.details.length > 1 ? ` (+${errData.details.length - 1} more)` : ''}`);
        } else {
          showToast(errData?.error || 'Failed to check out deck.');
        }
      }
    } catch (err) {
      console.error(err);
      showToast('Error checking out deck.');
    } finally {
      setCheckingOut(false);
    }
  };

  const handleReturn = async (deck = null) => {
    const targetDeck = deck || activeDeck;
    if (!targetDeck) return;
    try {
      setCheckingOut(true);
      // Capture where each card lives before flipping the flag, so the check-in
      // guide can show where to return them (cards stay in their slots either
      // way, but fetch first to be safe).
      const locRes = await fetch(`/api/decks/${targetDeck.id}/locations`);
      const locData = locRes.ok ? await locRes.json() : null;
      const res = await fetch(`/api/decks/${targetDeck.id}/return`, { method: 'PUT' });
      if (res.ok) {
        showToast(`📦 "${targetDeck.name}" returned to storage.`);
        if (activeDeck && activeDeck.id === targetDeck.id) {
          setActiveDeck(prev => ({ ...prev, checked_out: 0, checked_out_at: null }));
        }
        fetchDecks();
        if (locData) {
          setCheckoutLocations(locData);
          setCheckoutMode('checkin');
          setCheckoutDeckId(targetDeck.id);
          setShowCheckoutModal(true);
        }
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

  // Closing the guide via X / back = cancel: revert the toggle we just committed
  // by calling the opposite endpoint. (Done button keeps the status.)
  const handleCheckoutCancel = async () => {
    const id = checkoutDeckId;
    setShowCheckoutModal(false);
    if (!id) return;
    const undo = checkoutMode === 'checkout' ? 'return' : 'checkout';
    try {
      const res = await fetch(`/api/decks/${id}/${undo}`, { method: 'PUT' });
      if (!res.ok) { showToast('Failed to undo.'); return; }
      if (activeDeck && activeDeck.id === id) {
        const back = checkoutMode === 'checkout';
        setActiveDeck(prev => ({ ...prev, checked_out: back ? 0 : 1, checked_out_at: back ? null : new Date().toISOString() }));
      }
      fetchDecks();
      showToast(checkoutMode === 'checkout' ? 'Checkout canceled.' : 'Return canceled.');
    } catch (err) {
      console.error(err);
      showToast('Failed to undo.');
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
    if (activeDeck?.game !== 'mtg' && shuffled.length >= 13) {
      setPrizeCards(shuffled.slice(7, 13));
    } else {
      setPrizeCards([]);
    }
    setMulliganCount(0);
    setShowSimulator(true);
  };

  const handleMulligan = () => {
    const shuffled = shuffleArray(simulatorDeck);
    const nextMulligan = mulliganCount + 1;
    const drawCount = Math.max(1, 7 - nextMulligan);
    setSimulatorDeck(shuffled);
    setHand(shuffled.slice(0, drawCount));
    if (activeDeck?.game !== 'mtg' && shuffled.length >= drawCount + 6) {
      setPrizeCards(shuffled.slice(drawCount, drawCount + 6));
    }
    setMulliganCount(nextMulligan);
  };

  const handleDrawCard = () => {
    // Deck is laid out as [hand][prizes][rest]; hand grows by drawing from rest.
    const nextIndex = prizeCards.length + hand.length;
    if (nextIndex >= simulatorDeck.length) {
      showToast('No cards left in the deck!');
      return;
    }
    setHand([...hand, simulatorDeck[nextIndex]]);
  };

  // --- EXPORT & IMPORT LOGIC ---
  const handleExportDeckText = () => {
    if (!activeDeck) return '';
    return activeDeck.cards.map(c => `${c.quantity} ${c.name} (${c.set_code || c.set_name || ''}) #${c.number || ''}`.trim()).join('\n');
  };

  const handleCopyExportText = () => {
    const text = handleExportDeckText();
    navigator.clipboard.writeText(text)
      .then(() => showToast('Deck copied to clipboard!'))
      .catch(() => showToast('Copy failed.'));
  };

  const handleCompareImport = async () => {
    if (!importText.trim() || !activeDeck) return;
    setComparingImport(true);
    const lines = importText.split('\n').map(l => l.trim()).filter(Boolean);
    const results = [];

    for (const line of lines) {
      const match = line.match(/^(\d+)x?\s+(.+)$/i);
      if (!match) continue;
      const qty = parseInt(match[1], 10);
      const rawName = match[2].replace(/\s*\([^)]*\)/g, '').replace(/#\d+/g, '').trim();

      try {
        const res = await fetch(`/api/search?name=${encodeURIComponent(rawName)}&scope=collection&game=${activeDeck.game || 'pokemon'}`);
        if (res.ok) {
          const cards = await res.json();
          if (cards.length > 0) {
            const card = cards[0];
            const owned = card.owned_qty || 0;
            const inDeck = activeDeck.cards.find(c => c.id === card.id)?.quantity || 0;
            results.push({
              rawName,
              requestedQty: qty,
              ownedQty: owned,
              inDeckQty: inDeck,
              card: card,
              status: owned >= qty ? 'full' : owned > 0 ? 'partial' : 'missing'
            });
          } else {
            results.push({
              rawName,
              requestedQty: qty,
              ownedQty: 0,
              inDeckQty: 0,
              card: null,
              status: 'missing'
            });
          }
        }
      } catch (err) {
        console.error(err);
      }
    }
    setImportComparison(results);
    setComparingImport(false);
  };

  const handleImportDeck = async () => {
    if (!activeDeck) return;
    const itemsToImport = importComparison
      ? importComparison.filter(item => item.card && item.ownedQty > 0)
      : [];

    if (itemsToImport.length === 0 && !importText.trim()) return;

    let addedCount = 0;
    
    if (importComparison) {
      for (const item of itemsToImport) {
        try {
          const addQty = Math.min(item.requestedQty, item.ownedQty);
          await fetch(`/api/decks/${activeDeck.id}/cards`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ card_id: item.card.id, quantity: addQty })
          });
          addedCount++;
        } catch (err) {
          console.error(err);
        }
      }
    } else {
      const lines = importText.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const match = line.match(/^(\d+)x?\s+(.+)$/i);
        if (!match) continue;
        const qty = parseInt(match[1], 10);
        const rawName = match[2].replace(/\s*\([^)]*\)/g, '').replace(/#\d+/g, '').trim();

        try {
          const res = await fetch(`/api/search?name=${encodeURIComponent(rawName)}&scope=collection&game=${activeDeck.game || 'pokemon'}`);
          if (res.ok) {
            const cards = await res.json();
            if (cards.length > 0) {
              await fetch(`/api/decks/${activeDeck.id}/cards`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ card_id: cards[0].id, quantity: qty })
              });
              addedCount++;
            }
          }
        } catch (err) {
          console.error(err);
        }
      }
    }

    if (addedCount > 0) {
      showToast(`Imported ${addedCount} card species into deck!`);
      await loadDeckDetails(activeDeck.id);
      setImportText('');
      setImportComparison(null);
      setShowImportModal(false);
    } else {
      showToast('No matching cards found in your collection.');
    }
  };

  // The game the active deck is built for (legacy decks default to Pokémon).
  const deckGame = activeDeck?.game || 'pokemon';

  // MTG card-type buckets, read off the parsed type line stored in subtypes.
  const MTG_MAIN_TYPES = ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Battle', 'Land'];
  const mtgCardType = (card) => {
    const subs = card.subtypes || [];
    for (const t of MTG_MAIN_TYPES) if (subs.includes(t)) return t;
    return 'Other';
  };
  const cardGroup = (card) => {
    if (deckGame === 'mtg') return mtgCardType(card);
    let type = card.supertype || 'Pokémon';
    if (type === 'Pokemon') type = 'Pokémon';
    return ['Pokémon', 'Trainer', 'Energy'].includes(type) ? type : 'Pokémon';
  };

  // Groups order based on game
  const GROUP_ORDER = deckGame === 'mtg'
    ? ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Battle', 'Land', 'Other']
    : ['Pokémon', 'Trainer', 'Energy', 'Other'];

  // --- CHART DATA GENERATION ---
  const getSupertypeChartData = () => {
    if (!activeDeck) return [];
    const counts = {};
    activeDeck.cards.forEach(c => {
      const g = cardGroup(c);
      counts[g] = (counts[g] || 0) + c.quantity;
    });
    return Object.keys(counts).map(key => ({ name: key, value: counts[key] })).filter(d => d.value > 0);
  };

  const getManaCurveData = () => {
    if (!activeDeck) return [];
    const counts = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7+': 0 };
    activeDeck.cards.forEach(c => {
      const val = c.cmc !== undefined && c.cmc !== null
        ? c.cmc
        : (c.convertedEnergyCost !== undefined && c.convertedEnergyCost !== null ? c.convertedEnergyCost : null);
      if (val !== null) {
        const bucket = val >= 7 ? '7+' : String(Math.floor(val));
        if (counts[bucket] !== undefined) counts[bucket] += c.quantity;
      }
    });
    return Object.keys(counts).map(cost => ({ cost, count: counts[cost] }));
  };

  const getEnergyChartData = () => {
    if (!activeDeck) return [];
    const map = {};
    if (deckGame === 'mtg') {
      // Color and Land type distribution
      activeDeck.cards.forEach(c => {
        const subs = c.subtypes || [];
        const isLand = subs.includes('Land') || c.supertype === 'Land' || cardGroup(c) === 'Land';
        if (isLand) {
          const basicLandTypes = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
          const foundType = basicLandTypes.find(t => subs.includes(t) || c.name.includes(t));
          const label = foundType ? `Land (${foundType})` : 'Land (Nonbasic)';
          map[label] = (map[label] || 0) + c.quantity;
        } else {
          const colors = c.colors || c.types || [];
          if (colors.length === 0) {
            map['Colorless'] = (map['Colorless'] || 0) + c.quantity;
          } else {
            colors.forEach(col => {
              const colorName = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' }[col] || col;
              map[colorName] = (map[colorName] || 0) + c.quantity;
            });
          }
        }
      });
      return Object.keys(map).map(key => ({ name: key, value: map[key] }));
    }
    activeDeck.cards.forEach(c => {
      if (c.supertype === 'Energy') {
        const name = c.name.replace(/\s*Energy/i, '').trim() || 'Special';
        map[name] = (map[name] || 0) + c.quantity;
      } else if (c.types && c.types.length > 0) {
        c.types.forEach(t => { map[t] = (map[t] || 0) + c.quantity; });
      }
    });
    return Object.keys(map).map(key => ({ name: key, value: map[key] }));
  };

  const totalDeckCardsCount = activeDeck ? activeDeck.cards.reduce((sum, c) => sum + c.quantity, 0) : 0;
  const targetDeckCardsCount = activeDeck?.target_size || 60;
  const supertypeData = getSupertypeChartData();
  const energyData = getEnergyChartData();
  const manaCurveData = getManaCurveData();

  const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

  // --- SELECTION MENU METRICS & FILTERING ---
  const totalDecksCount = decks.length;
  const pokemonDecksCount = decks.filter(d => (d.game || 'pokemon') === 'pokemon').length;
  const mtgDecksCount = decks.filter(d => d.game === 'mtg').length;

  const filteredDecks = decks.filter(deck => {
    const q = deckSearchTerm.trim().toLowerCase();
    const matchesSearch = !q ||
      deck.name.toLowerCase().includes(q) ||
      (deck.description && deck.description.toLowerCase().includes(q));

    const deckGameVal = deck.game || 'pokemon';
    const matchesGame = deckGameFilter === 'all' || deckGameVal === deckGameFilter;

    let matchesStatus = true;
    if (deckStatusFilter === 'ready') matchesStatus = deck.total_cards === (deck.target_size || 60);
    else if (deckStatusFilter === 'in_progress') matchesStatus = (deck.total_cards || 0) < (deck.target_size || 60);
    else if (deckStatusFilter === 'in_play') matchesStatus = !!deck.checked_out;

    return matchesSearch && matchesGame && matchesStatus;
  }).sort((a, b) => {
    if (deckSortBy === 'name_asc') return a.name.localeCompare(b.name);
    if (deckSortBy === 'cards_desc') return (b.total_cards || 0) - (a.total_cards || 0);
    if (deckSortBy === 'created_asc') return new Date(a.created_at) - new Date(b.created_at);
    return new Date(b.created_at) - new Date(a.created_at);
  });

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      
      {/* 1. SELECTION MENU VIEW OF ALL DECKS */}
      {viewMode === 'list' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          
          {/* Top Banner Header & Primary Action */}
          <div className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', padding: '1.25rem 1.5rem', background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.7), rgba(15, 23, 42, 0.8))', border: '1px solid rgba(255, 255, 255, 0.1)' }}>
            <div>
              <h2 style={{ fontSize: '1.4rem', color: 'var(--text-strong)', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
                <Layers size={22} style={{ color: 'var(--accent-yellow)' }} />
                Deck Vault
              </h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
                Manage, construct, test, and check out your custom competitive decks.
              </p>
            </div>
            <button 
              className="btn btn-primary" 
              onClick={() => setShowCreateModal(true)}
              style={{ padding: '0.6rem 1.25rem', fontSize: '0.9rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem', boxShadow: '0 4px 14px rgba(234, 179, 8, 0.25)' }}
            >
              <Plus size={18} /> Create New Deck
            </button>
          </div>

          {/* Search, Filters, Sorting & View Toolbar */}
          <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '1rem 1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
              
              {/* Search input */}
              <div style={{ position: 'relative', flex: '1 1 240px', minWidth: '220px' }}>
                <Search size={16} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  className="input-control"
                  placeholder="Filter decks by name or description..."
                  value={deckSearchTerm}
                  onChange={e => setDeckSearchTerm(e.target.value)}
                  style={{ paddingLeft: '2.25rem', width: '100%', fontSize: '0.85rem' }}
                />
                {deckSearchTerm && (
                  <button
                    className="btn btn-secondary btn-icon-only"
                    onClick={() => setDeckSearchTerm('')}
                    style={{ position: 'absolute', right: '0.4rem', top: '50%', transform: 'translateY(-50%)', width: '20px', height: '20px', padding: 0, fontSize: '0.7rem' }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>

              {/* Game Tabs */}
              <div className="sub-nav-tabs" style={{ margin: 0, background: 'rgba(0,0,0,0.25)', padding: '3px', borderRadius: 'var(--radius-sm)' }}>
                {[
                  ['all', 'All Decks', totalDecksCount],
                  ['pokemon', 'Pokémon', pokemonDecksCount],
                  ['mtg', 'MTG', mtgDecksCount]
                ].map(([val, label, count]) => (
                  <button
                    key={val}
                    type="button"
                    className={`sub-nav-tab ${deckGameFilter === val ? 'active' : ''}`}
                    onClick={() => setDeckGameFilter(val)}
                    style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}
                  >
                    <span>{label}</span>
                    <span style={{ fontSize: '0.65rem', background: deckGameFilter === val ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: '10px' }}>
                      {count}
                    </span>
                  </button>
                ))}
              </div>

            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', paddingTop: '0.5rem', borderTop: '1px solid var(--border-glass)' }}>
              
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                {/* Status Filter */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Filter size={14} style={{ color: 'var(--text-muted)' }} />
                  <select
                    className="select-control"
                    value={deckStatusFilter}
                    onChange={e => setDeckStatusFilter(e.target.value)}
                    style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', height: 'auto' }}
                  >
                    <option value="all">All Statuses</option>
                    <option value="ready">Battle Ready (60 Cards)</option>
                    <option value="in_progress">Building (&lt; 60 Cards)</option>
                    <option value="in_play">Currently In Play 🎮</option>
                  </select>
                </div>

                {/* Sort Order */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <SlidersHorizontal size={14} style={{ color: 'var(--text-muted)' }} />
                  <select
                    className="select-control"
                    value={deckSortBy}
                    onChange={e => setDeckSortBy(e.target.value)}
                    style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', height: 'auto' }}
                  >
                    <option value="created_desc">Newest First</option>
                    <option value="created_asc">Oldest First</option>
                    <option value="name_asc">Name (A-Z)</option>
                    <option value="cards_desc">Most Cards</option>
                  </select>
                </div>
              </div>

              {/* View Mode Toggle: Grid vs Table */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '3px', background: 'rgba(0,0,0,0.3)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                <button
                  type="button"
                  className={`btn ${deckSelectionViewMode === 'grid' ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ padding: '0.25rem 0.55rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                  onClick={() => setDeckSelectionViewMode('grid')}
                  title="Grid view"
                >
                  <LayoutGrid size={13} /> Grid
                </button>
                <button
                  type="button"
                  className={`btn ${deckSelectionViewMode === 'table' ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ padding: '0.25rem 0.55rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                  onClick={() => setDeckSelectionViewMode('table')}
                  title="Table view"
                >
                  <List size={13} /> Table
                </button>
              </div>

            </div>
          </div>

          {/* Decks Display Section */}
          {loading ? (
            <div className="spinner" style={{ margin: '3rem auto' }}></div>
          ) : filteredDecks.length === 0 ? (
            <div className="glass-panel" style={{ textAlign: 'center', padding: '3.5rem 1.5rem', color: 'var(--text-secondary)' }}>
              <Layers size={36} style={{ color: 'var(--text-muted)', marginBottom: '0.75rem', opacity: 0.5 }} />
              <h3 style={{ color: 'var(--text-strong)', fontSize: '1.05rem', marginBottom: '0.25rem' }}>No decks match your filter</h3>
              <p style={{ fontSize: '0.85rem' }}>Try adjusting your search query, game filter, or status filter.</p>
              {(deckSearchTerm || deckGameFilter !== 'all' || deckStatusFilter !== 'all') && (
                <button
                  className="btn btn-secondary"
                  style={{ marginTop: '1rem', fontSize: '0.8rem' }}
                  onClick={() => { setDeckSearchTerm(''); setDeckGameFilter('all'); setDeckStatusFilter('all'); }}
                >
                  Clear Filters
                </button>
              )}
            </div>
          ) : deckSelectionViewMode === 'grid' ? (
            /* --- GRID VIEW --- */
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1.25rem' }}>
              {filteredDecks.map(deck => {
                const deckGameVal = deck.game || 'pokemon';
                const isMtg = deckGameVal === 'mtg';
                const targetSize = deck.target_size || 60;
                const totalCards = deck.total_cards || 0;
                const isComplete = totalCards >= targetSize;
                const percent = Math.min(100, Math.round((totalCards / targetSize) * 100));
                const accentColor = deck.accent_color || (isMtg ? '#ef4444' : '#eab308');

                return (
                  <div
                    key={deck.id}
                    className="glass-panel"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      gap: '1rem',
                      padding: '1.25rem',
                      border: deck.checked_out
                        ? '1px solid rgba(234,179,8,0.5)'
                        : `1px solid ${accentColor}40`,
                      position: 'relative',
                      overflow: 'hidden',
                      cursor: 'pointer',
                      transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
                      background: isMtg
                        ? 'linear-gradient(145deg, rgba(211,32,42,0.06), rgba(15,23,42,0.65))'
                        : 'linear-gradient(145deg, rgba(234,179,8,0.06), rgba(15,23,42,0.65))'
                    }}
                    onClick={() => loadDeckDetails(deck.id)}
                    onMouseEnter={e => {
                      e.currentTarget.style.transform = 'translateY(-3px)';
                      e.currentTarget.style.boxShadow = `0 12px 30px ${accentColor}25`;
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.transform = 'none';
                      e.currentTarget.style.boxShadow = 'none';
                    }}
                  >
                    {/* Top Accent Line */}
                    <div style={{
                      position: 'absolute', top: 0, left: 0, right: 0, height: '3px',
                      background: deck.checked_out
                        ? 'linear-gradient(90deg, #eab308, #f59e0b)'
                        : `linear-gradient(90deg, ${accentColor}, ${accentColor}cc)`
                    }} />

                    {/* In Play Banner */}
                    {deck.checked_out ? (
                      <div style={{
                        marginTop: '4px',
                        background: 'linear-gradient(90deg, rgba(234,179,8,0.9), rgba(245,158,11,0.85))',
                        padding: '4px 10px',
                        borderRadius: '4px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        fontSize: '0.65rem',
                        fontWeight: 800,
                        color: '#000',
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase'
                      }}>
                        <Gamepad2 size={12} />
                        <span>Currently In Play</span>
                        {deck.checked_out_at && (
                          <span style={{ marginLeft: 'auto', opacity: 0.8, fontWeight: 600 }}>
                            since {new Date(deck.checked_out_at).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    ) : null}

                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                            <h3 style={{ color: 'var(--text-strong)', fontSize: '1.15rem', fontWeight: 800, margin: 0, letterSpacing: '-0.01em' }}>
                              {deck.name}
                            </h3>
                            <span style={{
                              fontSize: '0.6rem',
                              fontWeight: 800,
                              textTransform: 'uppercase',
                              letterSpacing: '0.05em',
                              padding: '0.1rem 0.45rem',
                              borderRadius: '4px',
                              background: isMtg ? 'rgba(239,68,68,0.15)' : 'rgba(234,179,8,0.15)',
                              color: isMtg ? '#f87171' : 'var(--accent-yellow)',
                              border: isMtg ? '1px solid rgba(239,68,68,0.3)' : '1px solid rgba(234,179,8,0.3)',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '3px'
                            }}>
                              {isMtg ? <Swords size={10} /> : <Zap size={10} />}
                              {isMtg ? 'MTG' : 'Pokémon'}
                            </span>

                            {deck.format && (
                              <span style={{
                                fontSize: '0.6rem',
                                fontWeight: 700,
                                padding: '0.1rem 0.4rem',
                                borderRadius: '4px',
                                background: 'rgba(255,255,255,0.06)',
                                color: 'var(--text-secondary)',
                                border: '1px solid var(--border-glass)'
                              }}>
                                {deck.format}
                              </span>
                            )}

                            {deck.category && (
                              <span style={{
                                fontSize: '0.6rem',
                                fontWeight: 700,
                                padding: '0.1rem 0.4rem',
                                borderRadius: '4px',
                                background: 'rgba(59, 130, 246, 0.12)',
                                color: '#60a5fa',
                                border: '1px solid rgba(59, 130, 246, 0.25)'
                              }}>
                                {deck.category}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Status Badge */}
                        <span style={{
                          fontSize: '0.7rem',
                          fontWeight: 700,
                          padding: '0.2rem 0.5rem',
                          borderRadius: '12px',
                          backgroundColor: isComplete ? 'rgba(74, 222, 128, 0.15)' : 'rgba(59, 130, 246, 0.15)',
                          color: isComplete ? '#4ade80' : '#60a5fa',
                          border: isComplete ? '1px solid rgba(74, 222, 128, 0.3)' : '1px solid rgba(59, 130, 246, 0.3)',
                          whiteSpace: 'nowrap'
                        }}>
                          {isComplete ? 'Ready' : 'Building'}
                        </span>
                      </div>

                      <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', marginTop: '0.6rem', minHeight: '34px', lineHeight: '1.4' }}>
                        {deck.description || 'No description provided.'}
                      </p>
                    </div>

                    {/* Progress Bar & Details */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', background: 'rgba(0,0,0,0.2)', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem' }}>
                        <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>Card Capacity</span>
                        <span style={{ color: isComplete ? '#4ade80' : 'var(--text-strong)', fontWeight: 700 }}>
                          {totalCards} / {targetSize} Cards ({percent}%)
                        </span>
                      </div>
                      <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden' }}>
                        <div style={{
                          height: '100%',
                          width: `${percent}%`,
                          background: isComplete
                            ? 'linear-gradient(90deg, #4ade80, #22c55e)'
                            : 'linear-gradient(90deg, #3b82f6, #6366f1)',
                          borderRadius: '3px',
                          transition: 'width 0.3s ease'
                        }} />
                      </div>
                    </div>

                    {/* Card Footer Actions */}
                    <div style={{ borderTop: '1px solid var(--border-glass)', paddingTop: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                        Created {new Date(deck.created_at).toLocaleDateString()}
                      </span>

                      <div style={{ display: 'flex', gap: '0.4rem' }}>
                        {deck.checked_out ? (
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px', border: '1px solid rgba(234,179,8,0.4)', color: '#eab308' }}
                            onClick={(e) => { e.stopPropagation(); handleReturn(deck); }}
                            disabled={checkingOut}
                          >
                            <PackageCheck size={12} /> Return
                          </button>
                        ) : (
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                            onClick={(e) => { e.stopPropagation(); handleCheckout(deck); }}
                            disabled={checkingOut}
                          >
                            <LogOut size={12} /> Checkout
                          </button>
                        )}

                        <button
                          className="btn btn-primary"
                          style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                          onClick={(e) => { e.stopPropagation(); loadDeckDetails(deck.id); }}
                        >
                          Open <ArrowRight size={12} />
                        </button>

                        <button
                          className="btn btn-danger btn-icon-only"
                          style={{ padding: '0.3rem' }}
                          onClick={(e) => { e.stopPropagation(); handleDeleteDeck(deck.id, deck.name); }}
                          title="Delete Deck"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>

                  </div>
                );
              })}
            </div>
          ) : (
            /* --- TABLE VIEW --- */
            <div className="glass-panel" style={{ overflowX: 'auto', padding: 0 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-glass)', background: 'rgba(0,0,0,0.2)', color: 'var(--text-secondary)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    <th style={{ padding: '0.75rem 1rem' }}>Game & Format</th>
                    <th style={{ padding: '0.75rem 1rem' }}>Deck Name & Description</th>
                    <th style={{ padding: '0.75rem 1rem' }}>Capacity</th>
                    <th style={{ padding: '0.75rem 1rem' }}>Status</th>
                    <th style={{ padding: '0.75rem 1rem' }}>Created</th>
                    <th style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDecks.map(deck => {
                    const isMtg = (deck.game || 'pokemon') === 'mtg';
                    const targetSize = deck.target_size || 60;
                    const totalCards = deck.total_cards || 0;
                    const isComplete = totalCards >= targetSize;
                    const percent = Math.min(100, Math.round((totalCards / targetSize) * 100));
                    const accentColor = deck.accent_color || (isMtg ? '#ef4444' : '#eab308');

                    return (
                      <tr
                        key={deck.id}
                        style={{ borderBottom: '1px solid var(--border-glass)', cursor: 'pointer', transition: 'background 0.15s' }}
                        onClick={() => loadDeckDetails(deck.id)}
                        onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <td style={{ padding: '0.75rem 1rem' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: accentColor, display: 'inline-block' }} />
                              <span style={{
                                fontSize: '0.65rem',
                                fontWeight: 800,
                                padding: '0.15rem 0.45rem',
                                borderRadius: '4px',
                                background: isMtg ? 'rgba(239,68,68,0.15)' : 'rgba(234,179,8,0.15)',
                                color: isMtg ? '#f87171' : 'var(--accent-yellow)',
                                border: isMtg ? '1px solid rgba(239,68,68,0.3)' : '1px solid rgba(234,179,8,0.3)',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '3px'
                              }}>
                                {isMtg ? <Swords size={10} /> : <Zap size={10} />}
                                {isMtg ? 'MTG' : 'Pokémon'}
                              </span>
                            </div>
                            {deck.format && (
                              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                                {deck.format}
                              </span>
                            )}
                          </div>
                        </td>
                        <td style={{ padding: '0.75rem 1rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{deck.name}</span>
                            {deck.category && (
                              <span style={{ fontSize: '0.6rem', fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: 'rgba(59,130,246,0.12)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.25)' }}>
                                {deck.category}
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                            {deck.description || 'No description'}
                          </div>
                        </td>
                        <td style={{ padding: '0.75rem 1rem', width: '160px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: isComplete ? '#4ade80' : 'var(--text-strong)' }}>
                              {totalCards} / {targetSize} Cards
                            </div>
                            <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: `${percent}%`, background: isComplete ? '#4ade80' : '#3b82f6' }} />
                            </div>
                          </div>
                        </td>
                        <td style={{ padding: '0.75rem 1rem' }}>
                          {deck.checked_out ? (
                            <span style={{ fontSize: '0.7rem', fontWeight: 800, padding: '2px 8px', borderRadius: '10px', background: 'rgba(234,179,8,0.15)', color: '#eab308', border: '1px solid rgba(234,179,8,0.4)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                              <Gamepad2 size={11} /> In Play
                            </span>
                          ) : isComplete ? (
                            <span style={{ fontSize: '0.7rem', fontWeight: 800, padding: '2px 8px', borderRadius: '10px', background: 'rgba(74, 222, 128, 0.15)', color: '#4ade80', border: '1px solid rgba(74, 222, 128, 0.3)' }}>
                              Ready
                            </span>
                          ) : (
                            <span style={{ fontSize: '0.7rem', fontWeight: 800, padding: '2px 8px', borderRadius: '10px', background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)', border: '1px solid var(--border-glass)' }}>
                              Building
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '0.75rem 1rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          {new Date(deck.created_at).toLocaleDateString()}
                        </td>
                        <td style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end' }} onClick={e => e.stopPropagation()}>
                            {deck.checked_out ? (
                              <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', color: '#eab308' }} onClick={() => handleReturn(deck)} disabled={checkingOut}>
                                Return
                              </button>
                            ) : (
                              <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={() => handleCheckout(deck)} disabled={checkingOut}>
                                Checkout
                              </button>
                            )}
                            <button className="btn btn-primary" style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem' }} onClick={() => loadDeckDetails(deck.id)}>
                              Open
                            </button>
                            <button className="btn btn-danger btn-icon-only" style={{ padding: '0.25rem' }} onClick={() => handleDeleteDeck(deck.id, deck.name)}>
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

        </div>
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
                <h2 style={{ fontSize: '1.25rem', color: 'var(--text-strong)', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  {activeDeck.name}
                  <span style={{ fontSize: '0.8rem', color: totalDeckCardsCount === targetDeckCardsCount ? 'var(--type-grass)' : 'var(--accent-yellow)', fontWeight: 600 }}>
                    ({totalDeckCardsCount}/{targetDeckCardsCount} cards)
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
                {!!activeDeck.checked_out && activeDeck.checked_out_at && (
                  <p style={{ color: '#eab308', fontSize: '0.7rem', marginTop: '2px' }}>
                    Checked out since {new Date(activeDeck.checked_out_at).toLocaleString()}
                  </p>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                className="btn btn-secondary"
                onClick={() => setShowExportModal(true)}
                style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                title="Export deck list as text"
              >
                <Download size={14} /> Export
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setShowImportModal(true)}
                style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                title="Import cards from text"
              >
                <Upload size={14} /> Import
              </button>
              {/* Checkout / Return button */}
              {activeDeck.checked_out ? (
                <button
                  className="btn btn-secondary"
                  onClick={() => handleReturn(activeDeck)}
                  disabled={checkingOut}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', border: '1px solid rgba(234,179,8,0.4)', color: '#eab308' }}
                >
                  <PackageCheck size={14} /> Return to Storage
                </button>
              ) : (
                <button
                  className="btn btn-secondary"
                  onClick={() => handleCheckout(activeDeck)}
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
          {!!activeDeck.checked_out && (
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
                  These cards are physically out of storage. Click &quot;Return to Storage&quot; when you&apos;re done playing to mark them as back in storage.
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
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <h3 style={{ fontSize: '0.95rem', color: 'var(--text-strong)', margin: 0 }}>Add Cards to Deck</h3>
                    <div className="sub-nav-tabs" style={{ margin: 0 }}>
                      {[['pokemon', 'Pokémon'], ['mtg', 'MTG']].map(([val, label]) => (
                        <button
                          key={val}
                          type="button"
                          className={`sub-nav-tab ${deckSearchGame === val ? 'active' : ''}`}
                          style={{ padding: '0.3rem 0.7rem', fontSize: '0.75rem' }}
                          onClick={() => setDeckSearchGame(val)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <form onSubmit={handleSearchCards} style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      type="text"
                      className="input-control"
                      placeholder="Search card name (or click Browse)..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button type="submit" className="btn btn-primary" style={{ padding: '0.5rem 1rem' }} title="Search">
                      <Search size={16} />
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={(e) => handleSearchCards(e, true)} style={{ padding: '0.5rem 0.9rem', fontSize: '0.75rem', whiteSpace: 'nowrap' }} title="Browse all owned cards in collection">
                      Browse Collection
                    </button>
                  </form>

                  {/* Search Results list */}
                  {searching ? (
                    <div className="spinner" style={{ margin: '1rem auto' }}></div>
                  ) : searchResults.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '1rem', maxHeight: '240px', overflowY: 'auto', background: 'rgba(0,0,0,0.15)', padding: '0.5rem', borderRadius: 'var(--radius-sm)' }}>
                      {searchResults.map(card => {
                          const existingInDeck = activeDeck?.cards.find(c => c.id === card.id);
                          const qtyInDeck = existingInDeck ? existingInDeck.quantity : 0;
                          const ownedQty = card.owned_qty || 0;
                          const isAtMaxOwned = qtyInDeck >= ownedQty;
                          const isAtRuleMax = !isBasicEnergyOrLand(card, deckGame) && deckCountByName(activeDeck?.cards, card.name) >= 4;
                          const disabledAdd = savingCard || isAtMaxOwned || isAtRuleMax;

                          return (
                            <div key={card.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.35rem 0.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', border: '1px solid var(--border-glass)' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }} onClick={() => setPreviewCard(card)}>
                                <img src={card.image_url} alt={card.name} style={{ width: '24px', height: '33px', objectFit: 'cover', borderRadius: '2px' }} />
                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                  <span style={{ fontSize: '0.8rem', color: 'var(--text-strong)' }}>{card.name} ({card.set_name} • #{card.number})</span>
                                  <span style={{ fontSize: '0.65rem', color: isAtMaxOwned ? 'var(--accent-red)' : 'var(--text-secondary)' }}>Owned: {ownedQty} | In Deck: {qtyInDeck}</span>
                                </div>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                <button className="btn btn-secondary btn-icon-only" style={{ padding: '0.2rem' }} onClick={() => setPreviewCard(card)} title="Preview Card Art">
                                  <Eye size={12} />
                                </button>
                                <button className="btn btn-primary btn-icon-only" style={{ padding: '0.2rem' }} disabled={disabledAdd} onClick={() => handleAddCardToDeck(card)} title={isAtRuleMax ? "4-copy limit reached" : isAtMaxOwned ? "Not enough owned copies" : "Add to deck"}>
                                  <Plus size={12} />
                                </button>
                              </div>
                            </div>
                          );
                      })}
                    </div>
                  )}
                </div>

                {/* Deck Cards Header & Display Mode Toggle */}
                <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <h3 style={{ fontSize: '1rem', color: 'var(--text-strong)', borderLeft: '3px solid var(--accent-red)', paddingLeft: '0.5rem', margin: 0 }}>
                      Deck Cards ({totalDeckCardsCount} / {targetDeckCardsCount})
                    </h3>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                      <button
                        type="button"
                        className={`btn ${cardDisplayMode === 'list' ? 'btn-primary' : 'btn-secondary'}`}
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                        onClick={() => setCardDisplayMode('list')}
                      >
                        <List size={12} /> List
                      </button>
                      <button
                        type="button"
                        className={`btn ${cardDisplayMode === 'grid' ? 'btn-primary' : 'btn-secondary'}`}
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                        onClick={() => setCardDisplayMode('grid')}
                      >
                        <LayoutGrid size={12} /> Grid
                      </button>
                    </div>
                  </div>
                  
                  {activeDeck.cards.length === 0 ? (
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem 0' }}>This deck is currently empty. Use the search bar above to add cards.</p>
                  ) : (
                    GROUP_ORDER.map(supertype => {
                      const list = activeDeck.cards.filter(c => {
                        return cardGroup(c).toLowerCase() === supertype.toLowerCase();
                      });
                      if (list.length === 0) return null;
                      const sum = list.reduce((total, c) => total + c.quantity, 0);

                      return (
                        <div key={supertype} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                          <h4 style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.25rem', display: 'flex', justifyContent: 'space-between' }}>
                            <span>{supertype}s</span>
                            <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{sum}</span>
                          </h4>

                          {/* 1. COMPACT LIST VIEW */}
                          {cardDisplayMode === 'list' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                              {list.map(card => (
                                <div key={card.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.01)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }} onClick={() => setPreviewCard(card)}>
                                    <img src={card.image_url} alt={card.name} style={{ width: '32px', height: '44px', objectFit: 'cover', borderRadius: '2px' }} />
                                    <div>
                                      <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-strong)' }}>{card.name}</div>
                                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{card.set_name} • #{card.number}</div>
                                    </div>
                                  </div>

                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: '4px', border: '1px solid var(--border-glass)' }}>
                                      <button
                                        className={`btn ${card.quantity === 1 ? 'btn-danger' : 'btn-secondary'} btn-icon-only`}
                                        style={{ width: '22px', height: '22px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                                        disabled={savingCard}
                                        onClick={() => handleUpdateCardQty(card.id, card.quantity - 1)}
                                        title={card.quantity === 1 ? 'Remove from deck' : 'Decrease quantity'}
                                      >
                                        {card.quantity === 1 ? <Trash2 size={11} /> : '-'}
                                      </button>
                                      <span style={{ padding: '0 0.4rem', fontSize: '0.85rem', fontWeight: 700, minWidth: '18px', textAlign: 'center', color: 'var(--text-strong)' }}>{card.quantity}</span>
                                      <button
                                        className="btn btn-secondary btn-icon-only"
                                        style={{ width: '22px', height: '22px', padding: 0 }}
                                        disabled={savingCard || card.quantity >= (card.owned_qty || 0) || (!isBasicEnergyOrLand(card, deckGame) && deckCountByName(activeDeck.cards, card.name) >= 4)}
                                        onClick={() => handleUpdateCardQty(card.id, card.quantity + 1)}
                                      >
                                        +
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* 2. VISUAL CARD GRID VIEW */}
                          {cardDisplayMode === 'grid' && (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '0.75rem' }}>
                              {list.map(card => (
                                <div key={card.id} style={{ position: 'relative', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--border-glass)', background: 'rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column', transition: 'transform 0.15s' }}>
                                  <div style={{ position: 'relative', width: '100%', aspectRatio: 0.718, cursor: 'pointer' }} onClick={() => setPreviewCard(card)}>
                                    <img src={card.image_url} alt={card.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                    <span style={{ position: 'absolute', top: '4px', right: '4px', background: 'rgba(0,0,0,0.85)', color: 'var(--accent-yellow)', fontSize: '0.75rem', fontWeight: 800, padding: '1px 6px', borderRadius: '10px', border: '1px solid var(--accent-yellow)' }}>
                                      x{card.quantity}
                                    </span>
                                  </div>
                                  <div style={{ padding: '4px', display: 'flex', justifyContent: 'center', background: 'rgba(0,0,0,0.5)' }}>
                                    <div style={{ display: 'flex', gap: '2px' }}>
                                      <button className={`btn ${card.quantity === 1 ? 'btn-danger' : 'btn-secondary'} btn-icon-only`} style={{ width: '20px', height: '20px', fontSize: '0.7rem', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }} disabled={savingCard} onClick={() => handleUpdateCardQty(card.id, card.quantity - 1)} title={card.quantity === 1 ? 'Remove from deck' : 'Decrease quantity'}>
                                        {card.quantity === 1 ? <Trash2 size={10} /> : '-'}
                                      </button>
                                      <button className="btn btn-secondary btn-icon-only" style={{ width: '20px', height: '20px', fontSize: '0.7rem', padding: 0 }} disabled={savingCard || card.quantity >= (card.owned_qty || 0) || (!isBasicEnergyOrLand(card, deckGame) && deckCountByName(activeDeck.cards, card.name) >= 4)} onClick={() => handleUpdateCardQty(card.id, card.quantity + 1)}>+</button>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}

                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Right Column: Statistics, Mana Curve & Deck Health */}
              <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                
                {/* Deck Health & Summary Status */}
                <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <h3 style={{ fontSize: '0.95rem', color: 'var(--text-strong)', margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {totalDeckCardsCount === targetDeckCardsCount ? (
                      <CheckCircle size={15} style={{ color: 'var(--type-grass)' }} />
                    ) : (
                      <AlertTriangle size={15} style={{ color: 'var(--accent-yellow)' }} />
                    )}
                    Deck Health & Rules
                  </h3>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', fontSize: '0.8rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
                      <span>Target Deck Size:</span>
                      <strong style={{ color: totalDeckCardsCount === targetDeckCardsCount ? 'var(--type-grass)' : 'var(--text-strong)' }}>{totalDeckCardsCount}/{targetDeckCardsCount} Cards</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
                      <span>Unique Cards:</span>
                      <strong style={{ color: 'var(--text-strong)' }}>{activeDeck.cards.length} {deckGame === 'mtg' ? 'titles' : 'species'}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
                      <span>{deckGame === 'mtg' ? 'Basic Lands Exemptions:' : 'Basic Energy Exemptions:'}</span>
                      <strong style={{ color: 'var(--accent-yellow)' }}>
                        {activeDeck.cards.filter(c => isBasicEnergyOrLand(c, deckGame)).reduce((s, c) => s + c.quantity, 0)} {deckGame === 'mtg' ? 'basic lands' : 'basic energy'}
                      </strong>
                    </div>
                  </div>
                </div>

                {/* Bar Chart: Mana / Energy Cost Curve */}
                {manaCurveData.some(d => d.count > 0) && (
                  <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <h3 style={{ fontSize: '0.95rem', color: 'var(--text-strong)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <BarChart2 size={14} style={{ color: '#3b82f6' }} /> Energy / Mana Cost Curve
                    </h3>
                    <div style={{ width: '100%', height: '180px' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={manaCurveData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
                          <XAxis dataKey="cost" stroke="var(--text-muted)" fontSize={10} tickLine={false} />
                          <YAxis stroke="var(--text-muted)" fontSize={10} tickLine={false} />
                          <Tooltip contentStyle={{ background: 'rgba(0,0,0,0.8)', border: '1px solid var(--border-glass)', borderRadius: '4px', fontSize: '0.8rem', color: 'var(--text-strong)' }} />
                          <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

                {/* Pie Chart: Supertypes */}
                {supertypeData.length > 0 && (
                  <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <h3 style={{ fontSize: '0.95rem', color: 'var(--text-strong)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
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
                          <Tooltip contentStyle={{ background: 'rgba(0,0,0,0.8)', border: '1px solid var(--border-glass)', borderRadius: '4px', fontSize: '0.8rem', color: 'var(--text-strong)' }} />
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
                    <h3 style={{ fontSize: '0.95rem', color: 'var(--text-strong)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <BarChart2 size={14} style={{ color: 'var(--accent-yellow)' }} /> {deckGame === 'mtg' ? 'Color & Land Distribution' : 'Energy Type Distribution'}
                    </h3>
                    <div style={{ width: '100%', height: '220px' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={energyData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
                          <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={10} tickLine={false} />
                          <YAxis stroke="var(--text-muted)" fontSize={10} tickLine={false} />
                          <Tooltip contentStyle={{ background: 'rgba(0,0,0,0.8)', border: '1px solid var(--border-glass)', borderRadius: '4px', fontSize: '0.8rem', color: 'var(--text-strong)' }} />
                          <Bar dataKey="value" fill="var(--accent-yellow)" radius={[4, 4, 0, 0]}>
                            {energyData.map((entry, idx) => {
                              const colorMap = {
                                'White': '#fef08a', 'Blue': '#3b82f6', 'Black': '#475569', 'Red': '#ef4444', 'Green': '#10b981', 'Colorless': '#cbd5e1',
                                'Land (Plains)': '#fef08a', 'Land (Island)': '#60a5fa', 'Land (Swamp)': '#475569', 'Land (Mountain)': '#f87171', 'Land (Forest)': '#4ade80', 'Land (Nonbasic)': '#d97706',
                                'Grass': '#4ade80', 'Fire': '#f87171', 'Water': '#60a5fa', 'Lightning': '#facc15', 'Psychic': '#c084fc', 'Fighting': '#f97316', 'Darkness': '#475569', 'Metal': '#94a3b8', 'Dragon': '#a855f7', 'Fairy': '#f472b6'
                              };
                              return <Cell key={`cell-${idx}`} fill={colorMap[entry.name] || 'var(--accent-yellow)'} />;
                            })}
                          </Bar>
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
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
          <div className="glass-panel" style={{ maxWidth: '480px', width: '100%', padding: '1.75rem', position: 'relative', border: '1px solid rgba(255,255,255,0.15)' }}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => setShowCreateModal(false)} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
              <X size={16} />
            </button>

            <h3 style={{ fontSize: '1.25rem', color: 'var(--text-strong)', fontWeight: 800, marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <FolderPlus size={20} style={{ color: 'var(--accent-yellow)' }} />
              Create New Deck
            </h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
              Set up a deck profile to start adding cards and simulating opening hands.
            </p>

            <form onSubmit={handleCreateDeck} style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem', maxHeight: '80vh', overflowY: 'auto', paddingRight: '0.25rem' }}>
              
              {/* Game System Selection */}
              <div className="form-group">
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.4rem', display: 'block' }}>Game System</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                  <div
                    onClick={() => {
                      setNewDeckGame('pokemon');
                      setNewDeckFormat('Standard');
                      setNewDeckTargetSize(60);
                    }}
                    style={{
                      padding: '0.75rem',
                      borderRadius: 'var(--radius-sm)',
                      border: newDeckGame === 'pokemon' ? '2px solid var(--accent-yellow)' : '1px solid var(--border-glass)',
                      background: newDeckGame === 'pokemon' ? 'rgba(234, 179, 8, 0.12)' : 'rgba(0, 0, 0, 0.2)',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '0.3rem',
                      transition: 'all 0.15s'
                    }}
                  >
                    <Zap size={22} style={{ color: newDeckGame === 'pokemon' ? 'var(--accent-yellow)' : 'var(--text-muted)' }} />
                    <span style={{ fontSize: '0.85rem', fontWeight: 700, color: newDeckGame === 'pokemon' ? 'var(--accent-yellow)' : 'var(--text-secondary)' }}>Pokémon TCG</span>
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>60 Cards Standard</span>
                  </div>

                  <div
                    onClick={() => {
                      setNewDeckGame('mtg');
                      setNewDeckFormat('Commander / EDH');
                      setNewDeckTargetSize(100);
                    }}
                    style={{
                      padding: '0.75rem',
                      borderRadius: 'var(--radius-sm)',
                      border: newDeckGame === 'mtg' ? '2px solid #ef4444' : '1px solid var(--border-glass)',
                      background: newDeckGame === 'mtg' ? 'rgba(239, 68, 68, 0.12)' : 'rgba(0, 0, 0, 0.2)',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '0.3rem',
                      transition: 'all 0.15s'
                    }}
                  >
                    <Swords size={22} style={{ color: newDeckGame === 'mtg' ? '#ef4444' : 'var(--text-muted)' }} />
                    <span style={{ fontSize: '0.85rem', fontWeight: 700, color: newDeckGame === 'mtg' ? '#ef4444' : 'var(--text-secondary)' }}>Magic (MTG)</span>
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Constructed / Commander</span>
                  </div>
                </div>
              </div>

              {/* Format & Target Size Row */}
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.75rem' }}>
                <div className="form-group">
                  <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>Format</label>
                  <select
                    className="input-control"
                    value={newDeckFormat}
                    onChange={(e) => {
                      const selectedFmt = e.target.value;
                      setNewDeckFormat(selectedFmt);
                      if (selectedFmt.includes('Commander')) setNewDeckTargetSize(100);
                      else if (selectedFmt.includes('Standard') || selectedFmt.includes('Expanded') || selectedFmt.includes('GLC') || selectedFmt.includes('Modern') || selectedFmt.includes('Pioneer')) setNewDeckTargetSize(60);
                    }}
                    style={{ fontSize: '0.85rem' }}
                  >
                    {(newDeckGame === 'pokemon' ? POKEMON_FORMATS : MTG_FORMATS).map(fmt => (
                      <option key={fmt} value={fmt} style={{ background: '#1e293b', color: '#fff' }}>{fmt}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>Target Size</label>
                  <input
                    type="number"
                    min="1"
                    max="300"
                    className="input-control"
                    value={newDeckTargetSize}
                    onChange={(e) => setNewDeckTargetSize(parseInt(e.target.value, 10) || 60)}
                    style={{ fontSize: '0.85rem' }}
                  />
                </div>
              </div>

              {/* Deck Name */}
              <div className="form-group">
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>Deck Name</label>
                <input 
                  type="text" 
                  className="input-control" 
                  placeholder="e.g. Charizard ex Engine or Atarka Red..." 
                  value={newDeckName} 
                  onChange={(e) => setNewDeckName(e.target.value)}
                  required 
                  autoFocus
                />
              </div>

              {/* Category Pills */}
              <div className="form-group">
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.4rem', display: 'block' }}>Deck Category</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                  {DECK_CATEGORIES.map(cat => {
                    const isSelected = newDeckCategory === cat;
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setNewDeckCategory(cat)}
                        style={{
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          padding: '0.3rem 0.65rem',
                          borderRadius: '12px',
                          border: isSelected ? '1px solid var(--accent-yellow)' : '1px solid var(--border-glass)',
                          background: isSelected ? 'rgba(234, 179, 8, 0.2)' : 'rgba(0,0,0,0.2)',
                          color: isSelected ? 'var(--accent-yellow)' : 'var(--text-secondary)',
                          cursor: 'pointer',
                          transition: 'all 0.15s'
                        }}
                      >
                        {cat}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Deck Accent Color */}
              <div className="form-group">
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.4rem', display: 'block' }}>Vault Accent Color</label>
                <div style={{ display: 'flex', itemsAlign: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {DECK_ACCENT_COLORS.map(c => {
                    const isSelected = newDeckAccentColor === c.hex;
                    return (
                      <div
                        key={c.hex}
                        onClick={() => setNewDeckAccentColor(c.hex)}
                        title={c.name}
                        style={{
                          width: '26px',
                          height: '26px',
                          borderRadius: '50%',
                          backgroundColor: c.hex,
                          cursor: 'pointer',
                          border: isSelected ? '2px solid #ffffff' : '2px solid transparent',
                          boxShadow: isSelected ? `0 0 10px ${c.hex}` : 'none',
                          transform: isSelected ? 'scale(1.15)' : 'scale(1)',
                          transition: 'all 0.15s'
                        }}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Description (Optional) */}
              <div className="form-group">
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>Description (Optional)</label>
                <textarea
                  className="input-control"
                  style={{ minHeight: '65px', resize: 'vertical', fontSize: '0.85rem' }}
                  placeholder="Strategy notes, engine ideas, or format details..."
                  value={newDeckDesc}
                  onChange={(e) => setNewDeckDesc(e.target.value)}
                />
              </div>

              {/* Quick Decklist Importer Toggle */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowImportDecklistArea(!showImportDecklistArea)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent-yellow)',
                    fontSize: '0.8rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: 0
                  }}
                >
                  <FileText size={14} />
                  {showImportDecklistArea ? 'Hide Quick Import Decklist' : '+ Quick Import Decklist (Optional)'}
                </button>

                {showImportDecklistArea && (
                  <div style={{ marginTop: '0.5rem' }}>
                    <textarea
                      className="input-control"
                      style={{ minHeight: '90px', fontFamily: 'monospace', fontSize: '0.8rem', whiteSpace: 'pre' }}
                      placeholder={`Paste decklist (e.g. \n4 Charizard ex\n2 Pidgeot ex\n1 Forest Seal Stone)`}
                      value={newDeckImportText}
                      onChange={(e) => setNewDeckImportText(e.target.value)}
                    />
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', display: 'block', marginTop: '0.2rem' }}>
                      Cards found in your catalog will be added automatically to this deck upon creation.
                    </span>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowCreateModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 2, fontWeight: 700 }}>Create Deck</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* B. Draw Hand Simulator Modal */}
      {showSimulator && (
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
          <div className="glass-panel" style={{ maxWidth: '1000px', width: '100%', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem', position: 'relative' }}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => setShowSimulator(false)} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
              <X size={16} />
            </button>

            <div>
              <h3 style={{ fontSize: '1.25rem', color: 'var(--text-strong)', margin: 0 }}>Opening Hand Simulator</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.2rem' }}>
                Test your deck consistency. Shuffled deck. Mulligan count: <strong style={{ color: 'var(--accent-red)' }}>{mulliganCount}</strong>. Hand size: <strong>{hand.length}</strong> cards.
              </p>
            </div>

            {/* Hand Area */}
            <div style={{ 
              background: 'rgba(0,0,0,0.4)', 
              minHeight: '220px', 
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
                    position: 'relative',
                    cursor: 'pointer'
                  }} onClick={() => setPreviewCard(card)}>
                    <img src={card.image_url} alt={card.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                ))
              )}
            </div>

            {/* Prize Cards Area (Pokémon decks) */}
            {prizeCards.length > 0 && (
              <div>
                <h4 style={{ fontSize: '0.85rem', color: 'var(--accent-yellow)', margin: '0 0 0.5rem 0' }}>Prize Cards (6 Cards)</h4>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {prizeCards.map((pCard, pIdx) => (
                    <div key={pIdx} style={{ width: '70px', height: '98px', borderRadius: '4px', background: 'linear-gradient(135deg, #1e293b, #0f172a)', border: '1px dashed var(--accent-yellow)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem', color: 'var(--accent-yellow)', fontWeight: 700 }}>
                      Prize #{pIdx + 1}
                    </div>
                  ))}
                </div>
              </div>
            )}

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

      {/* C. Export Modal */}
      {showExportModal && (
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
          <div className="glass-panel" style={{ maxWidth: '500px', width: '100%', padding: '1.75rem', position: 'relative' }}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => setShowExportModal(false)} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
              <X size={16} />
            </button>
            <h3 style={{ fontSize: '1.2rem', color: 'var(--text-strong)', marginBottom: '0.5rem' }}>Export Decklist</h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>Standard deck text format ready for sharing or PTCGO / MTGA import.</p>
            <textarea
              readOnly
              className="input-control"
              style={{ width: '100%', height: '220px', fontFamily: 'monospace', fontSize: '0.8rem', resize: 'vertical' }}
              value={handleExportDeckText()}
            />
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowExportModal(false)}>Close</button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleCopyExportText}>Copy to Clipboard</button>
            </div>
          </div>
        </div>
      )}

      {/* D. Import Modal with Collection Comparison */}
      {showImportModal && (
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
          <div className="glass-panel" style={{ maxWidth: '600px', width: '100%', padding: '1.75rem', position: 'relative', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => { setShowImportModal(false); setImportComparison(null); }} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
              <X size={16} />
            </button>
            <h3 style={{ fontSize: '1.2rem', color: 'var(--text-strong)', marginBottom: '0.5rem' }}>Import & Compare with Collection</h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>Paste decklist lines (e.g. <code>4 Pikachu</code> or <code>2 Lightning Energy</code>):</p>
            
            <textarea
              className="input-control"
              style={{ width: '100%', minHeight: '120px', maxHeight: '180px', fontFamily: 'monospace', fontSize: '0.8rem', resize: 'vertical' }}
              placeholder={`4 Pikachu\n2 Ultra Ball\n1 Boss's Orders`}
              value={importText}
              onChange={e => { setImportText(e.target.value); setImportComparison(null); }}
            />

            {/* Comparison results table */}
            {comparingImport ? (
              <div style={{ padding: '1.5rem', textAlign: 'center' }}>
                <div className="spinner" style={{ margin: '0 auto 0.5rem auto' }}></div>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Comparing against your collection...</span>
              </div>
            ) : importComparison && (
              <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1, overflowY: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  <span>Collection Availability Breakdown:</span>
                  <span style={{ color: 'var(--accent-yellow)', fontWeight: 700 }}>
                    {importComparison.filter(i => i.status === 'full').length}/{importComparison.length} species fully owned
                  </span>
                </div>
                <div style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '180px', overflowY: 'auto' }}>
                  {importComparison.map((item, idx) => (
                    <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem', padding: '0.25rem 0.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                      <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{item.rawName}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>Req: {item.requestedQty}</span>
                        <span style={{
                          padding: '2px 6px',
                          borderRadius: '10px',
                          fontWeight: 700,
                          fontSize: '0.65rem',
                          background: item.status === 'full' ? 'rgba(74, 222, 128, 0.15)' : item.status === 'partial' ? 'rgba(234, 179, 8, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                          color: item.status === 'full' ? 'var(--type-grass)' : item.status === 'partial' ? 'var(--accent-yellow)' : 'var(--accent-red)',
                          border: item.status === 'full' ? '1px solid rgba(74, 222, 128, 0.3)' : item.status === 'partial' ? '1px solid rgba(234, 179, 8, 0.3)' : '1px solid rgba(239, 68, 68, 0.3)'
                        }}>
                          {item.status === 'full' ? `Owned (${item.ownedQty})` : item.status === 'partial' ? `Partial (${item.ownedQty}/${item.requestedQty})` : `Missing (0)`}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => { setShowImportModal(false); setImportComparison(null); }}>Cancel</button>
              {!importComparison ? (
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleCompareImport} disabled={!importText.trim()}>Compare with Collection</button>
              ) : (
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleImportDeck}>Import Matched Cards</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* E. High-Res Card Art Preview Popover */}
      {previewCard && (
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setPreviewCard(null)}>
          <div className="glass-panel" style={{ maxWidth: '340px', padding: '1rem', position: 'relative', textAlign: 'center', animation: 'draw-card-anim 0.25s ease-out forwards' }} onClick={e => e.stopPropagation()}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => setPreviewCard(null)} style={{ position: 'absolute', top: '0.5rem', right: '0.5rem', borderRadius: '50%', zIndex: 10 }}>
              <X size={16} />
            </button>
            <img
              src={previewCard.image_url}
              alt={previewCard.name}
              style={{ width: '100%', borderRadius: '10px', boxShadow: '0 8px 24px rgba(0,0,0,0.6)' }}
            />
            <h4 style={{ color: 'var(--text-strong)', margin: '0.75rem 0 0.25rem 0', fontSize: '1rem' }}>{previewCard.name}</h4>
            <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '0.75rem' }}>
              {previewCard.set_name} • #{previewCard.number} ({previewCard.rarity || 'Common'})
            </p>
          </div>
        </div>
      )}

      {/* Checkout Locator Modal */}
      {showCheckoutModal && (
        <CheckoutWizardModal
          locationsData={checkoutLocations}
          mode={checkoutMode}
          onCancel={handleCheckoutCancel}
          onClose={() => setShowCheckoutModal(false)}
        />
      )}

    </div>
  );
}

export default DeckBuilder;
