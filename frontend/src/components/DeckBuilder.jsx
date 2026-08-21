import { useState, useEffect } from 'react';
import { Plus, Trash2, X, ChevronLeft, Play, BarChart2, Search, LogOut, PackageCheck, LayoutGrid, List, Download, Upload, Eye, Filter, CheckCircle, AlertTriangle, Layers, Zap, Swords, Gamepad2, SlidersHorizontal, ArrowRight, FolderPlus, FileText } from 'lucide-react';
import { ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';
import { shuffleArray } from '../utils/shuffle';
import { translateJapaneseName } from '../utils/langHelper';
import { displayName } from '../utils/languages';
import CheckoutWizardModal from './CheckoutWizardModal';
import { useBackGuard } from '../utils/useBackGuard';
import { buildDeckExport, parseDeckLine } from '../utils/deckText';
import { defaultGame, gameOptions, showGamePicker, isGameEnabled } from '../utils/games';
import CardImage from './CardImage';
import { useT } from '../utils/i18n';

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

// What a new deck starts as for a game. Pulled out because it is now needed in
// the Game System buttons and the initial state, which has to
// match the game the picker opens on.
const newDeckDefaults = (game) => {
  if (game === 'mtg') return { format: 'Commander / EDH', targetSize: 100 };
  if (game === 'lorcana') return { format: 'Core (Constructed)', targetSize: 60 };
  return { format: 'Standard', targetSize: 60 };
};

function DeckBuilder({ showToast }) {
  const { t } = useT();
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
  const LORCANA_FORMATS = ['Core (Constructed)', 'Casual', 'Draft / Sealed'];
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
  const [newDeckGame, setNewDeckGame] = useState(() => defaultGame()); // 'pokemon' | 'mtg'
  const [newDeckFormat, setNewDeckFormat] = useState(() => newDeckDefaults(defaultGame()).format);
  const [newDeckCategory, setNewDeckCategory] = useState('Competitive');
  const [newDeckAccentColor, setNewDeckAccentColor] = useState('#eab308');
  const [newDeckTargetSize, setNewDeckTargetSize] = useState(() => newDeckDefaults(defaultGame()).targetSize);
  const [newDeckImportText, setNewDeckImportText] = useState('');
  const [showImportDecklistArea, setShowImportDecklistArea] = useState(false);
  
  // Card Search States inside editor
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [deckSearchGame, setDeckSearchGame] = useState(() => defaultGame()); // 'pokemon' | 'mtg'

  // Deck Selection Menu Controls
  const [deckSearchTerm, setDeckSearchTerm] = useState('');
  // 'all' | 'pokemon' | 'mtg'. With one game hidden, 'all' would show its decks
  // anyway, so open scoped to the visible game instead.
  const [deckGameFilter, setDeckGameFilter] = useState(() => (showGamePicker() ? 'all' : defaultGame()));
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
  const [exportFormat, setExportFormat] = useState(null); // null = auto by deck game
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
  useBackGuard(!!activeDeck, () => setActiveDeck(null));

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
      showToast(t('deck.errLoadDecks'));
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
        showToast(t('deck.created'));
        setNewDeckName('');
        setNewDeckDesc('');
        setNewDeckGame(defaultGame());
        setNewDeckFormat(newDeckDefaults(defaultGame()).format);
        setNewDeckCategory('Competitive');
        setNewDeckAccentColor('#eab308');
        setNewDeckTargetSize(newDeckDefaults(defaultGame()).targetSize);
        setNewDeckImportText('');
        setShowImportDecklistArea(false);
        setShowCreateModal(false);
        fetchDecks();
      } else {
        showToast(t('deck.errCreate'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('deck.errCreateGeneric'));
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
      showToast(t('deck.errLoadDetails'));
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
        showToast(t('deck.addedCard', { name: displayName(card) }));
        // Refresh details locally
        await loadDeckDetails(activeDeck.id);
      } else {
        const data = await response.json().catch(() => ({}));
        showToast(data.error || 'Failed to add card.');
      }
    } catch (err) {
      console.error(err);
      showToast(t('search.errAddCard'));
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
        showToast(t('deck.errOwnedLimit', { count: card.owned_qty, name: displayName(card) }));
        return;
      }
      
      if (!isBasicEnergyOrLand(card, activeDeck.game) && deckCountByName(activeDeck.cards, card.name) >= 4) {
        showToast(t('deck.errCopyLimit', { count: 4, name: displayName(card) }));
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
        showToast(t('deck.errQuantity'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('deck.errQuantity'));
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
        showToast(t('deck.cardRemoved'));
        loadDeckDetails(activeDeck.id);
      } else {
        showToast(t('loc.errRemoveCard'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('loc.errRemoveCard'));
    }
  };

  const handleDeleteDeck = async (deckId, name) => {
    if (!window.confirm(t('deck.confirmDelete', { name }))) return;

    try {
      const response = await fetch(`/api/decks/${deckId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        showToast(t('deck.deleted'));
        fetchDecks();
      }
    } catch (err) {
      console.error(err);
      showToast(t('deck.errDelete'));
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
          // /api/collection returns one row per physical entry (so N copies of
          // a card = N rows sharing the same card_id). Unlike /api/search
          // (which GROUPs BY card_id server-side), this endpoint doesn't
          // aggregate — grouping here mirrors that so browse-mode results have
          // the same one-row-per-card shape search results already have.
          // Without this, every row for a given card_id gets marked "added"
          // together once any one copy is added, and a second owned copy
          // can't be added at all.
          const byCardId = new Map();
          for (const item of data) {
            const existing = byCardId.get(item.card_id);
            if (existing) {
              existing.owned_qty += item.quantity || 1;
            } else {
              byCardId.set(item.card_id, {
                id: item.card_id,
                name: item.name,
                // Carried through so the picker shows the localized name; `name` stays
                // English because the 4-copy rule counts by it.
                printed_name: item.printed_name,
                set_name: item.set_name,
                number: item.number || item.collector_number || item.card_number || '',
                image_url: item.image_url,
                owned_qty: item.quantity || 1,
                supertype: item.supertype,
                subtypes: item.subtypes,
                types: item.types,
                colors: item.colors,
                cmc: item.cmc
              });
            }
          }
          setSearchResults(Array.from(byCardId.values()));
        }
      } else {
        const finalQuery = deckSearchGame === 'mtg' ? searchQuery : (translateJapaneseName(searchQuery) || searchQuery);
        const response = await fetch(`/api/search?name=${encodeURIComponent(finalQuery)}&scope=collection&game=${deckSearchGame}`);
        if (response.ok) {
          const data = await response.json();
          setSearchResults(data);
        } else {
          showToast(t(response.status === 429 ? 'deck.errRateLimit' : 'deck.errSearch'));
        }
      }
    } catch (err) {
      console.error(err);
      showToast(t('deck.errSearch'));
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
        showToast(t('deck.checkedOut', { name: targetDeck.name }));
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
          showToast(t('deck.errCheckout', { detail: errData.details[0], extra: errData.details.length > 1 ? t('deck.andMore', { count: errData.details.length - 1 }) : '' }));
        } else {
          showToast(errData?.error || 'Failed to check out deck.');
        }
      }
    } catch (err) {
      console.error(err);
      showToast(t('deck.errCheckoutGeneric'));
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
        showToast(t('deck.returned', { name: targetDeck.name }));
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
        showToast(t('deck.errReturn'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('deck.errReturnGeneric'));
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
      if (!res.ok) { showToast(t('deck.errUndo')); return; }
      if (activeDeck && activeDeck.id === id) {
        const back = checkoutMode === 'checkout';
        setActiveDeck(prev => ({ ...prev, checked_out: back ? 0 : 1, checked_out_at: back ? null : new Date().toISOString() }));
      }
      fetchDecks();
      showToast(t(checkoutMode === 'checkout' ? 'deck.checkoutCanceled' : 'deck.returnCanceled'));
    } catch (err) {
      console.error(err);
      showToast(t('deck.errUndo'));
    }
  };

  // --- DRAW SIMULATOR LOGIC ---
  const startSimulator = () => {
    if (!activeDeck || activeDeck.cards.length === 0) {
      showToast(t('deck.errEmptyDeck'));
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
      showToast(t('deck.errNoCardsLeft'));
      return;
    }
    setHand([...hand, simulatorDeck[nextIndex]]);
  };

  // --- EXPORT & IMPORT LOGIC ---
  const effectiveExportFormat = exportFormat || ((activeDeck?.game === 'mtg') ? 'mtga' : 'ptcgl');

  const handleExportDeckText = () => {
    if (!activeDeck) return '';
    return buildDeckExport(activeDeck.cards, effectiveExportFormat);
  };

  const handleCopyExportText = () => {
    const text = handleExportDeckText();
    navigator.clipboard.writeText(text)
      .then(() => showToast(t('deck.copied')))
      .catch(() => showToast(t('deck.errCopy')));
  };

  // Copy the buylist and open TCGplayer Mass Entry — user pastes (their mass
  // entry page has no documented prefill URL param, so clipboard + open is the
  // reliable path).
  const handleOpenMassEntry = () => {
    const text = buildDeckExport(activeDeck?.cards, 'buylist');
    if (!text) { showToast(t('deck.nothingToBuy')); return; }
    const line = (activeDeck?.game === 'mtg') ? 'Magic' : 'Pokemon';
    navigator.clipboard.writeText(text).catch(() => {});
    window.open(`https://www.tcgplayer.com/massentry?productline=${line}`, '_blank', 'noopener');
    showToast(t('deck.buylistCopied'));
  };

  const handleCompareImport = async () => {
    if (!importText.trim() || !activeDeck) return;
    setComparingImport(true);
    const lines = importText.split('\n').map(l => l.trim()).filter(Boolean);
    const results = [];

    for (const line of lines) {
      const parsed = parseDeckLine(line);
      if (!parsed) continue;
      const { qty, name: rawName } = parsed;

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
        const parsed = parseDeckLine(line);
        if (!parsed) continue;
        const { qty, name: rawName } = parsed;

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
      showToast(t('deck.imported', { count: addedCount }));
      await loadDeckDetails(activeDeck.id);
      setImportText('');
      setImportComparison(null);
      setShowImportModal(false);
    } else {
      showToast(t('deck.errNoMatches'));
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
  const LORCANA_MAIN_TYPES = ['Character', 'Action', 'Item', 'Location'];
  const lorcanaCardType = (card) => {
    const supertype = card.supertype || 'Character';
    if (LORCANA_MAIN_TYPES.includes(supertype)) return supertype;
    const subs = card.subtypes || [];
    for (const t of LORCANA_MAIN_TYPES) if (subs.includes(t)) return t;
    return 'Character';
  };
  const cardGroup = (card) => {
    if (deckGame === 'mtg') return mtgCardType(card);
    if (deckGame === 'lorcana') return lorcanaCardType(card);
    let type = card.supertype || 'Pokémon';
    if (type === 'Pokemon') type = 'Pokémon';
    return ['Pokémon', 'Trainer', 'Energy'].includes(type) ? type : 'Pokémon';
  };

  // Groups order based on game
  const GROUP_ORDER = deckGame === 'mtg'
    ? ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Battle', 'Land', 'Other']
    : (deckGame === 'lorcana'
      ? ['Character', 'Action', 'Item', 'Location', 'Other']
      : ['Pokémon', 'Trainer', 'Energy', 'Other']);

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
    if (deckGame === 'lorcana') {
      activeDeck.cards.forEach(c => {
        const inks = Array.isArray(c.types) && c.types.length ? c.types : (c.ink ? [c.ink] : []);
        if (inks.length === 0) {
          map['Colorless'] = (map['Colorless'] || 0) + c.quantity;
        } else {
          inks.forEach(ink => { map[ink] = (map[ink] || 0) + c.quantity; });
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
  const lorcanaDecksCount = decks.filter(d => d.game === 'lorcana').length;

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
                {t('deck.vaultTitle')}
              </h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
                {t('deck.vaultSubtitle')}
              </p>
            </div>
            <button 
              className="btn btn-primary" 
              onClick={() => setShowCreateModal(true)}
              style={{ padding: '0.6rem 1.25rem', fontSize: '0.9rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem', boxShadow: '0 4px 14px rgba(234, 179, 8, 0.25)' }}
            >
              <Plus size={18} /> {t('deck.createDeck')}
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
                  placeholder={t('deck.filterPlaceholder')}
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

              {/* Game Tabs — only the games Settings is showing. */}
              {showGamePicker() && (
              <div className="sub-nav-tabs" style={{ margin: 0, background: 'rgba(0,0,0,0.25)', padding: '3px', borderRadius: 'var(--radius-sm)' }}>
                {[
                  ['all', 'All Decks', totalDecksCount],
                  ...gameOptions().map(g => [g.value, g.short, g.value === 'mtg' ? mtgDecksCount : (g.value === 'lorcana' ? lorcanaDecksCount : pokemonDecksCount)]),
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
              )}

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
                    <option value="all">{t('deck.allStatuses')}</option>
                    <option value="ready">{t('deck.statusBattleReady')}</option>
                    <option value="in_progress">{t('deck.statusBuildingCount')}</option>
                    <option value="in_play">{t('deck.statusInPlayEmoji')}</option>
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
                    <option value="created_desc">{t('deck.sortNewest')}</option>
                    <option value="created_asc">{t('deck.sortOldest')}</option>
                    <option value="name_asc">{t('collection.sort.name-asc')}</option>
                    <option value="cards_desc">{t('deck.sortMostCards')}</option>
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
                  title={t('deck.gridView')}
                >
                  <LayoutGrid size={13} /> Grid
                </button>
                <button
                  type="button"
                  className={`btn ${deckSelectionViewMode === 'table' ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ padding: '0.25rem 0.55rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                  onClick={() => setDeckSelectionViewMode('table')}
                  title={t('deck.tableView')}
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
              <h3 style={{ color: 'var(--text-strong)', fontSize: '1.05rem', marginBottom: '0.25rem' }}>{t('deck.noMatches')}</h3>
              <p style={{ fontSize: '0.85rem' }}>{t('deck.noMatchesHint')}</p>
              {(deckSearchTerm || deckGameFilter !== 'all' || deckStatusFilter !== 'all') && (
                <button
                  className="btn btn-secondary"
                  style={{ marginTop: '1rem', fontSize: '0.8rem' }}
                  onClick={() => { setDeckSearchTerm(''); setDeckGameFilter('all'); setDeckStatusFilter('all'); }}
                >
                  {t('deck.clearFilters')}
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
                        <span>{t('deck.inPlay')}</span>
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
                          {t(isComplete ? 'deck.statusReady' : 'deck.statusBuilding')}
                        </span>
                      </div>

                      <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', marginTop: '0.6rem', minHeight: '34px', lineHeight: '1.4' }}>
                        {deck.description || 'No description provided.'}
                      </p>
                    </div>

                    {/* Progress Bar & Details */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', background: 'rgba(0,0,0,0.2)', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem' }}>
                        <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{t('deck.cardCapacity')}</span>
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
                          title={t('deck.deleteDeck')}
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
                    <th style={{ padding: '0.75rem 1rem' }}>{t('deck.colGameFormat')}</th>
                    <th style={{ padding: '0.75rem 1rem' }}>{t('deck.colNameDesc')}</th>
                    <th style={{ padding: '0.75rem 1rem' }}>{t('deck.colCapacity')}</th>
                    <th style={{ padding: '0.75rem 1rem' }}>{t('admin.colStatus')}</th>
                    <th style={{ padding: '0.75rem 1rem' }}>{t('admin.colCreated')}</th>
                    <th style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>{t('admin.colActions')}</th>
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
                              {t('deck.statusReady')}
                            </span>
                          ) : (
                            <span style={{ fontSize: '0.7rem', fontWeight: 800, padding: '2px 8px', borderRadius: '10px', background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)', border: '1px solid var(--border-glass)' }}>
                              {t('deck.statusBuilding')}
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
                                {t('deck.return')}
                              </button>
                            ) : (
                              <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={() => handleCheckout(deck)} disabled={checkingOut}>
                                {t('deck.checkout')}
                              </button>
                            )}
                            <button className="btn btn-primary" style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem' }} onClick={() => loadDeckDetails(deck.id)}>
                              {t('deck.open')}
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
                title={t('deck.exportHint')}
              >
                <Download size={14} /> Export
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setShowImportModal(true)}
                style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                title={t('deck.importHint')}
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
                <strong>{t('deck.checkedOutBanner')}</strong>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  {t('deck.checkedOutHint')}
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
                    <h3 style={{ fontSize: '0.95rem', color: 'var(--text-strong)', margin: 0 }}>{t('deck.addCardsTitle')}</h3>
                    {showGamePicker() && (
                      <div className="sub-nav-tabs" style={{ margin: 0 }}>
                        {gameOptions().map(({ value, short }) => (
                          <button
                            key={value}
                            type="button"
                            className={`sub-nav-tab ${deckSearchGame === value ? 'active' : ''}`}
                            style={{ padding: '0.3rem 0.7rem', fontSize: '0.75rem' }}
                            onClick={() => setDeckSearchGame(value)}
                          >
                            {short}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <form onSubmit={handleSearchCards} style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      type="text"
                      className="input-control"
                      placeholder={t('deck.searchPlaceholder')}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button type="submit" className="btn btn-primary" style={{ padding: '0.5rem 1rem' }} title={t('shared.search')}>
                      <Search size={16} />
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={(e) => handleSearchCards(e, true)} style={{ padding: '0.5rem 0.9rem', fontSize: '0.75rem', whiteSpace: 'nowrap' }} title={t('deck.browseHint')}>
                      {t('deck.browseCollection')}
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
                                <CardImage card={card} style={{ width: '24px', height: '33px', objectFit: 'cover', borderRadius: '2px' }} />
                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                  <span style={{ fontSize: '0.8rem', color: 'var(--text-strong)' }}>{displayName(card)} ({card.set_name} • #{card.number})</span>
                                  <span style={{ fontSize: '0.65rem', color: isAtMaxOwned ? 'var(--accent-red)' : 'var(--text-secondary)' }}>Owned: {ownedQty} | In Deck: {qtyInDeck}</span>
                                </div>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                <button className="btn btn-secondary btn-icon-only" style={{ padding: '0.2rem' }} onClick={() => setPreviewCard(card)} title={t('deck.previewArt')}>
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
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem 0' }}>{t('deck.emptyDeck')}</p>
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
                                    <CardImage card={card} style={{ width: '32px', height: '44px', objectFit: 'cover', borderRadius: '2px' }} />
                                    <div>
                                      <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-strong)' }}>{displayName(card)}</div>
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
                                        title={t(card.quantity === 1 ? 'deck.removeFromDeck' : 'deck.decreaseQty')}
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
                                    <CardImage card={card} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                    <span style={{ position: 'absolute', top: '4px', right: '4px', background: 'rgba(0,0,0,0.85)', color: 'var(--accent-yellow)', fontSize: '0.75rem', fontWeight: 800, padding: '1px 6px', borderRadius: '10px', border: '1px solid var(--accent-yellow)' }}>
                                      x{card.quantity}
                                    </span>
                                  </div>
                                  <div style={{ padding: '4px', display: 'flex', justifyContent: 'center', background: 'rgba(0,0,0,0.5)' }}>
                                    <div style={{ display: 'flex', gap: '2px' }}>
                                      <button className={`btn ${card.quantity === 1 ? 'btn-danger' : 'btn-secondary'} btn-icon-only`} style={{ width: '20px', height: '20px', fontSize: '0.7rem', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }} disabled={savingCard} onClick={() => handleUpdateCardQty(card.id, card.quantity - 1)} title={t(card.quantity === 1 ? 'deck.removeFromDeck' : 'deck.decreaseQty')}>
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
                    {t('deck.healthTitle')}
                  </h3>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', fontSize: '0.8rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
                      <span>{t('deck.targetDeckSize')}</span>
                      <strong style={{ color: totalDeckCardsCount === targetDeckCardsCount ? 'var(--type-grass)' : 'var(--text-strong)' }}>{totalDeckCardsCount}/{targetDeckCardsCount} {t('deck.cardCapacity')}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
                      <span>{t('deck.uniqueCards')}</span>
                      <strong style={{ color: 'var(--text-strong)' }}>{activeDeck.cards.length} {deckGame === 'mtg' ? t('deck.titlesCount', { count: activeDeck.cards.length }) : t('deck.speciesCount', { count: activeDeck.cards.length })}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
                      <span>{t(deckGame === 'mtg' ? 'deck.basicLands' : 'deck.basicEnergy')}</span>
                      <strong style={{ color: 'var(--accent-yellow)' }}>
                        {activeDeck.cards.filter(c => isBasicEnergyOrLand(c, deckGame)).reduce((s, c) => s + c.quantity, 0)} {deckGame === 'mtg' ? t('deck.basicLandsCount', { count: activeDeck.cards.filter(c => isBasicEnergyOrLand(c, deckGame)).reduce((s, c) => s + c.quantity, 0) }) : t('deck.basicEnergyCount', { count: activeDeck.cards.filter(c => isBasicEnergyOrLand(c, deckGame)).reduce((s, c) => s + c.quantity, 0) })}
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
                      <BarChart2 size={14} style={{ color: 'var(--accent-yellow)' }} /> {t(deckGame === 'mtg' ? 'deck.colorLandDist' : 'dash.typeDistribution')}
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
          <div className="glass-panel" style={{ maxWidth: '480px', width: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '1.75rem', position: 'relative', border: '1px solid rgba(255,255,255,0.15)' }}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => setShowCreateModal(false)} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
              <X size={16} />
            </button>

            <h3 style={{ fontSize: '1.25rem', color: 'var(--text-strong)', fontWeight: 800, marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <FolderPlus size={20} style={{ color: 'var(--accent-yellow)' }} />
              {t('deck.createTitle')}
            </h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
              {t('deck.createSubtitle')}
            </p>

            <form onSubmit={handleCreateDeck} style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem', maxHeight: '80vh', overflowY: 'auto', paddingRight: '0.25rem' }}>
              
              {/* Game System Selection — hidden when only one game is shown, in
                  which case newDeckGame already holds it. */}
              {showGamePicker() && (
              <div className="form-group">
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.4rem', display: 'block' }}>{t('deck.gameSystem')}</label>
                <div style={{ display: 'grid', gridTemplateColumns: `repeat(${gameOptions().length}, 1fr)`, gap: '0.75rem' }}>
                  {isGameEnabled('pokemon') && (
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
                      <span style={{ fontSize: '0.85rem', fontWeight: 700, color: newDeckGame === 'pokemon' ? 'var(--accent-yellow)' : 'var(--text-secondary)' }}>{t('deck.gamePokemonWithSystem')}</span>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{t('deck.standard60')}</span>
                    </div>
                  )}

                  {isGameEnabled('mtg') && (
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
                      <span style={{ fontSize: '0.85rem', fontWeight: 700, color: newDeckGame === 'mtg' ? '#ef4444' : 'var(--text-secondary)' }}>{t('deck.gameMtgWithSystem')}</span>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{t('deck.constructedCommander')}</span>
                    </div>
                  )}

                  {isGameEnabled('lorcana') && (
                    <div
                      onClick={() => {
                        setNewDeckGame('lorcana');
                        setNewDeckFormat('Core (Constructed)');
                        setNewDeckTargetSize(60);
                      }}
                      style={{
                        padding: '0.75rem',
                        borderRadius: 'var(--radius-sm)',
                        border: newDeckGame === 'lorcana' ? '2px solid #a855f7' : '1px solid var(--border-glass)',
                        background: newDeckGame === 'lorcana' ? 'rgba(168, 85, 247, 0.12)' : 'rgba(0, 0, 0, 0.2)',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: '0.3rem',
                        transition: 'all 0.15s'
                      }}
                    >
                      <Layers size={22} style={{ color: newDeckGame === 'lorcana' ? '#a855f7' : 'var(--text-muted)' }} />
                      <span style={{ fontSize: '0.85rem', fontWeight: 700, color: newDeckGame === 'lorcana' ? '#a855f7' : 'var(--text-secondary)' }}>{t('deck.gameLorcanaWithSystem')}</span>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{t('deck.standard60')}</span>
                    </div>
                  )}
                </div>
              </div>
              )}

              {/* Format & Target Size Row */}
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.75rem' }}>
                <div className="form-group">
                  <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>{t('deck.format')}</label>
                  <select
                    className="input-control"
                    value={newDeckFormat}
                    onChange={(e) => {
                      const selectedFmt = e.target.value;
                      setNewDeckFormat(selectedFmt);
                      if (selectedFmt.includes('Commander')) setNewDeckTargetSize(100);
                      else if (selectedFmt.includes('Standard') || selectedFmt.includes('Expanded') || selectedFmt.includes('GLC') || selectedFmt.includes('Modern') || selectedFmt.includes('Pioneer') || selectedFmt.includes('Core')) setNewDeckTargetSize(60);
                    }}
                    style={{ fontSize: '0.85rem' }}
                  >
                    {(newDeckGame === 'pokemon' ? POKEMON_FORMATS : (newDeckGame === 'lorcana' ? LORCANA_FORMATS : MTG_FORMATS)).map(fmt => (
                      <option key={fmt} value={fmt} style={{ background: '#1e293b', color: '#fff' }}>{fmt}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>{t('deck.targetSize')}</label>
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
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>{t('deck.deckName')}</label>
                <input 
                  type="text" 
                  className="input-control" 
                  placeholder={t('deck.namePlaceholder')} 
                  value={newDeckName} 
                  onChange={(e) => setNewDeckName(e.target.value)}
                  required 
                  autoFocus
                />
              </div>

              {/* Category Pills */}
              <div className="form-group">
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.4rem', display: 'block' }}>{t('deck.category')}</label>
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
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.4rem', display: 'block' }}>{t('deck.accentColor')}</label>
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
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>{t('deck.descriptionOptional')}</label>
                <textarea
                  className="input-control"
                  style={{ minHeight: '65px', resize: 'vertical', fontSize: '0.85rem' }}
                  placeholder={t('deck.notesPlaceholder')}
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
                  {showImportDecklistArea ? t('deck.hideQuickImport') : t('deck.showQuickImport')}
                </button>

                {showImportDecklistArea && (
                  <div style={{ marginTop: '0.5rem' }}>
                    <textarea
                      className="input-control"
                      style={{ minHeight: '90px', fontFamily: 'monospace', fontSize: '0.8rem', whiteSpace: 'pre' }}
                      placeholder={t('deck.pasteDecklistPlaceholder')}
                      value={newDeckImportText}
                      onChange={(e) => setNewDeckImportText(e.target.value)}
                    />
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', display: 'block', marginTop: '0.2rem' }}>
                      {t('deck.importOnCreateHint')}
                    </span>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowCreateModal(false)}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 2, fontWeight: 700 }}>{t('deck.createDeck')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* B. Draw Hand Simulator Modal */}
      {showSimulator && (
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
          <div className="glass-panel" style={{ maxWidth: '1000px', width: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem', position: 'relative' }}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => setShowSimulator(false)} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
              <X size={16} />
            </button>

            <div>
              <h3 style={{ fontSize: '1.25rem', color: 'var(--text-strong)', margin: 0 }}>{t('deck.handSimulator')}</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.2rem' }}>
                {t('deck.mulliganCountText', { mulligans: mulliganCount, handSize: hand.length })}
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
                <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{t('deck.noCardsDrawn')}</div>
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
                    <CardImage card={card} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                ))
              )}
            </div>

            {/* Prize Cards Area (Pokémon decks) */}
            {prizeCards.length > 0 && (
              <div>
                <h4 style={{ fontSize: '0.85rem', color: 'var(--accent-yellow)', margin: '0 0 0.5rem 0' }}>{t('deck.prizeCardsPokemon')}</h4>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {prizeCards.map((pCard, pIdx) => (
                    <div key={pIdx} style={{ width: '70px', height: '98px', borderRadius: '4px', background: 'linear-gradient(135deg, #1e293b, #0f172a)', border: '1px dashed var(--accent-yellow)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem', color: 'var(--accent-yellow)', fontWeight: 700 }}>
                      {t('deck.prizeSlot', { n: pIdx + 1 })}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Control buttons */}
            <div style={{ display: 'flex', justifyContent: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" onClick={startSimulator} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                {t('deck.reshuffle')}
              </button>
              <button 
                className="btn btn-secondary" 
                onClick={handleMulligan} 
                style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                disabled={hand.length === 0}
              >
                {t('deck.mulliganDraw', { count: Math.max(1, 7 - (mulliganCount + 1)) })}
              </button>
              <button 
                className="btn btn-primary" 
                onClick={handleDrawCard} 
                style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                disabled={hand.length >= simulatorDeck.length}
              >
                {t('deck.drawOne')}
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
          <div className="glass-panel" style={{ maxWidth: '500px', width: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '1.75rem', position: 'relative' }}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => setShowExportModal(false)} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
              <X size={16} />
            </button>
            <h3 style={{ fontSize: '1.2rem', color: 'var(--text-strong)', marginBottom: '0.5rem' }}>{t('deck.exportTitle')}</h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>{t('deck.exportHintBody')}</p>
            <select
              className="input-control"
              style={{ width: '100%', marginBottom: '1rem', fontSize: '0.85rem' }}
              value={effectiveExportFormat}
              onChange={e => setExportFormat(e.target.value)}
            >
              <option value="ptcgl">{t('deck.formatPtcgl')}</option>
              <option value="mtga">{t('deck.formatMtga')}</option>
              <option value="plain">{t('deck.formatPlain')}</option>
              <option value="buylist">{t('deck.formatBuylist')}</option>
            </select>
            {effectiveExportFormat === 'buylist' && (
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '-0.5rem', marginBottom: '1rem' }}>
                {t('deck.buylistHint')}
              </p>
            )}
            <textarea
              readOnly
              className="input-control"
              style={{ width: '100%', height: '220px', fontFamily: 'monospace', fontSize: '0.8rem', resize: 'vertical' }}
              value={handleExportDeckText()}
            />
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowExportModal(false)}>{t('common.close')}</button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleCopyExportText}>{t('deck.copyClipboard')}</button>
              {effectiveExportFormat === 'buylist' && (
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleOpenMassEntry}>{t('deck.copyOpenTcg')}</button>
              )}
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
            <h3 style={{ fontSize: '1.2rem', color: 'var(--text-strong)', marginBottom: '0.5rem' }}>{t('deck.importTitle')}</h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>{t('deck.pasteDecklistHint')}</p>
            
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
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('deck.comparing')}</span>
              </div>
            ) : importComparison && (
              <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1, overflowY: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  <span>{t('deck.availabilityBreakdown')}</span>
                  <span style={{ color: 'var(--accent-yellow)', fontWeight: 700 }}>
                    {t('deck.fullyOwnedSpecies', { owned: importComparison.filter(i => i.status === 'full').length, total: importComparison.length })}
                  </span>
                </div>
                <div style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '180px', overflowY: 'auto' }}>
                  {importComparison.map((item, idx) => (
                    <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem', padding: '0.25rem 0.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                      <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{item.rawName}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>{t('deck.reqQuantity', { count: item.requestedQty })}</span>
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
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => { setShowImportModal(false); setImportComparison(null); }}>{t('common.cancel')}</button>
              {!importComparison ? (
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleCompareImport} disabled={!importText.trim()}>{t('deck.compare')}</button>
              ) : (
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleImportDeck}>{t('deck.importMatched')}</button>
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
            <CardImage
              card={previewCard}
              style={{ width: '100%', borderRadius: '10px', boxShadow: '0 8px 24px rgba(0,0,0,0.6)' }}
            />
            <h4 style={{ color: 'var(--text-strong)', margin: '0.75rem 0 0.25rem 0', fontSize: '1rem' }}>{displayName(previewCard)}</h4>
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
