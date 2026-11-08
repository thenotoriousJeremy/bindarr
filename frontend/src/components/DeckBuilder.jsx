import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { shuffleArray } from '../utils/shuffle';
import { translateJapaneseName, loadNameDictionaries, hasJapaneseText } from '../utils/langHelper';
import { displayName } from '../utils/languages';
import CheckoutWizardModal from './CheckoutWizardModal';
import { syntaxErrorText } from '../utils/scryfallSyntax';
import { useTabParam, setTabParam } from '../utils/router';
import Modal from './Modal';
import { defaultGame, showGamePicker } from '../utils/games';
import CardImage from './CardImage';
import { useT } from '../utils/i18n';
import { rulesFor, copyLimit } from '../utils/deckRules';
import { deckCardUndo, undoToast } from '../utils/undo';
import { apiErrorText } from '../utils/apiError';
import { deckCountByName } from './deck/deckHelpers';
import { useNewDeckForm } from './deck/useNewDeckForm';
import DeckList from './deck/DeckList';
import DeckEditor from './deck/DeckEditor';
import DeckCreateDialog from './deck/DeckCreateDialog';
import DeckSimulatorDialog from './deck/DeckSimulatorDialog';
import DeckExportDialog from './deck/DeckExportDialog';
import DeckImportDialog from './deck/DeckImportDialog';

// The deck builder: owns the deck list, the open deck and every handler that
// changes them, and picks the view the URL asks for. The views and dialogs it
// draws live in ./deck.
function DeckBuilder({ showToast }) {
  const { t } = useT();
  const [decks, setDecks] = useState([]);
  const [activeDeck, setActiveDeck] = useState(null);
  const [loading, setLoading] = useState(true);
  const [decksLoaded, setDecksLoaded] = useState(false);
  const [viewMode, setViewMode] = useState('list'); // 'list' or 'detail'
  // The open deck is in the URL (/decks/:id), so Back/Forward, a reload and a
  // link all open it; the list's clicks and the close button only change the URL.
  const deckParam = useTabParam('deckbuilder');
  const openDeck = (id) => setTabParam('deckbuilder', id);
  
  // Deck View & Display Modes
  const [cardDisplayMode, setCardDisplayMode] = useState('list'); // 'list' | 'grid'
  const [deckCardSortBy, setDeckCardSortBy] = useState('type');
  const [previewCard, setPreviewCard] = useState(null);

  // Deck Creation States (useNewDeckForm; the constants are in deck/deckHelpers).
  const newDeckForm = useNewDeckForm();
  const { setShowCreateModal } = newDeckForm;
  const [deckDraft, setDeckDraft] = useState(null);
  
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
  const [deckCardLocations, setDeckCardLocations] = useState({});

  // True while an add/qty write is in flight. Blocks overlapping clicks that
  // would otherwise each compute a new quantity from the same stale render and
  // clobber one another (last-writer-wins on the server upsert).
  const [savingCard, setSavingCard] = useState(false);


  useEffect(() => {
    fetchDecks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Waits for the deck list, which carries the checkout status loadDeckDetails
  // merges in. A deck that will not load (deleted, someone else's) closes again.
  useEffect(() => {
    if (!decksLoaded) return;
    if (deckParam == null) {
      if (viewMode === 'detail') {
        setViewMode('list');
        setActiveDeck(null);
        fetchDecks();
      }
      return;
    }
    if (viewMode === 'detail' && activeDeck && String(activeDeck.id) === deckParam) return;
    loadDeckDetails(Number(deckParam)).then(ok => {
      if (!ok) setTabParam('deckbuilder', null, { replace: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckParam, decksLoaded]);

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
      setDecksLoaded(true);
    }
  };

  const handleSaveDeckProperties = async () => {
    if (!activeDeck || !deckDraft?.name.trim()) return;
    try {
      const response = await fetch(`/api/decks/${activeDeck.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...deckDraft, target_size: parseInt(deckDraft.target_size, 10) || 60 })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(apiErrorText(t, data, 'deck.errCreateGeneric'));
      setActiveDeck(deck => ({ ...deck, ...deckDraft, name: deckDraft.name.trim(), target_size: parseInt(deckDraft.target_size, 10) || 60 }));
      setDeckDraft(null);
      fetchDecks();
      showToast(data.message);
      // Accepting any printing (or not) changes which copies count as owned.
      if (!!deckDraft.any_printing !== !!activeDeck.any_printing) await loadDeckDetails(activeDeck.id);
    } catch (error) {
      console.error(error);
      showToast(error.message);
    }
  };

  const loadDeckDetails = async (deckId) => {
    try {
      setLoading(true);
      const [response, locationsResponse] = await Promise.all([
        fetch(`/api/decks/${deckId}`),
        fetch(`/api/decks/${deckId}/locations`)
      ]);
      if (response.ok) {
        const data = await response.json();
        const locations = locationsResponse.ok ? await locationsResponse.json() : [];
        setDeckCardLocations(Object.fromEntries(locations.map(({ card_id, locations: cardLocations }) => [card_id, cardLocations])));
        // Also get checkout status from deck list
        const deckMeta = decks.find(d => d.id === deckId);
        setActiveDeck({ ...data, checked_out: deckMeta?.checked_out || 0, checked_out_at: deckMeta?.checked_out_at || null });
        // Default the card search to this deck's game.
        setDeckSearchGame(data.game || 'pokemon');
        setViewMode('detail');
        return true;
      }
      return false;
    } catch (err) {
      console.error(err);
      showToast(t('deck.errLoadDetails'));
      return false;
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
        showToast(apiErrorText(t, data, 'inspector.errAddDeck'));
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
      
      if (atCopyLimit(card)) {
        showToast(copyLimitText(card));
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

  // Mark or unmark a card as the deck's commander. Legality is reported in Deck
  // Health, not enforced: a command zone is built one card at a time.
  const handleToggleCommander = async (card) => {
    if (!activeDeck || savingCard) return;
    setSavingCard(true);
    try {
      const response = await fetch(`/api/decks/${activeDeck.id}/cards/${encodeURIComponent(card.id)}/commander`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commander: !card.is_commander })
      });
      if (response.ok) await loadDeckDetails(activeDeck.id);
      else showToast(t('deck.errCommander'));
    } catch (err) {
      console.error(err);
      showToast(t('deck.errCommander'));
    } finally {
      setSavingCard(false);
    }
  };

  const handleRemoveCard = async (cardId) => {
    if (!activeDeck) return;
    const deckId = activeDeck.id;
    const undo = deckCardUndo(deckId, activeDeck.cards.find(c => c.id === cardId));

    try {
      const response = await fetch(`/api/decks/${activeDeck.id}/cards/${cardId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        showToast(t('deck.cardRemoved'), undoToast(undo, { showToast, t, onDone: () => loadDeckDetails(deckId) }));
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
        // The name maps are fetched on first use; a Japanese query waits for them.
        if (deckSearchGame !== 'mtg' && hasJapaneseText(searchQuery)) await loadNameDictionaries().catch(() => {});
        const finalQuery = deckSearchGame === 'mtg' ? searchQuery : (translateJapaneseName(searchQuery) || searchQuery);
        const response = await fetch(`/api/search?name=${encodeURIComponent(finalQuery)}&scope=collection&game=${deckSearchGame}`);
        if (response.ok) {
          const data = await response.json();
          setSearchResults(data);
        } else {
          // Magic's box takes Scryfall syntax; a query it cannot use says why.
          const body = response.status === 400 ? await response.json().catch(() => ({})) : {};
          showToast(body.code ? syntaxErrorText(t, body) : t(response.status === 429 ? 'deck.errRateLimit' : 'deck.errSearch'));
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
          showToast(apiErrorText(t, errData, 'deck.errCheckoutGeneric'));
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

  // The game the active deck is built for (legacy decks default to Pokémon).
  const deckGame = activeDeck?.game || 'pokemon';
  // The rules its format holds it to — the same table the server enforces. What
  // the deck currently breaks is worked out in Deck Health.
  const deckRules = rulesFor(deckGame, activeDeck?.format);
  // Judged off the deck's own copy of the card when it has one: a search result
  // carries no card text, and the text is what exempts Relentless Rats.
  const limitFor = (card) => copyLimit((activeDeck?.cards || []).find(c => c.name === card.name) || card, deckRules);
  const atCopyLimit = (card) => deckCountByName(activeDeck?.cards, card.name) >= limitFor(card);
  const copyLimitText = (card) => (limitFor(card) === 1
    ? t('deck.errSingleton', { name: displayName(card) })
    : t('deck.errCopyLimit', { count: limitFor(card), name: displayName(card) }));


  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      
      {/* 1. SELECTION MENU VIEW OF ALL DECKS */}
      {viewMode === 'list' && (
        <DeckList
          decks={decks}
          loading={loading}
          checkingOut={checkingOut}
          deckSearchTerm={deckSearchTerm}
          setDeckSearchTerm={setDeckSearchTerm}
          deckGameFilter={deckGameFilter}
          setDeckGameFilter={setDeckGameFilter}
          deckStatusFilter={deckStatusFilter}
          setDeckStatusFilter={setDeckStatusFilter}
          deckSortBy={deckSortBy}
          setDeckSortBy={setDeckSortBy}
          deckSelectionViewMode={deckSelectionViewMode}
          setDeckSelectionViewMode={setDeckSelectionViewMode}
          setShowCreateModal={setShowCreateModal}
          openDeck={openDeck}
          handleCheckout={handleCheckout}
          handleReturn={handleReturn}
          handleDeleteDeck={handleDeleteDeck}
        />
      )}

      {/* 2. DECK EDITOR / DETAIL VIEW */}
      {viewMode === 'detail' && activeDeck && (
        <DeckEditor
          activeDeck={activeDeck}
          deckGame={deckGame}
          deckRules={deckRules}
          showToast={showToast}
          deckDraft={deckDraft}
          setDeckDraft={setDeckDraft}
          handleSaveDeckProperties={handleSaveDeckProperties}
          openDeck={openDeck}
          setShowExportModal={setShowExportModal}
          setShowImportModal={setShowImportModal}
          loadDeckDetails={loadDeckDetails}
          checkingOut={checkingOut}
          handleCheckout={handleCheckout}
          handleReturn={handleReturn}
          startSimulator={startSimulator}
          deckSearchGame={deckSearchGame}
          setDeckSearchGame={setDeckSearchGame}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          searching={searching}
          searchResults={searchResults}
          handleSearchCards={handleSearchCards}
          savingCard={savingCard}
          atCopyLimit={atCopyLimit}
          copyLimitText={copyLimitText}
          handleAddCardToDeck={handleAddCardToDeck}
          handleUpdateCardQty={handleUpdateCardQty}
          handleToggleCommander={handleToggleCommander}
          cardDisplayMode={cardDisplayMode}
          setCardDisplayMode={setCardDisplayMode}
          deckCardSortBy={deckCardSortBy}
          setDeckCardSortBy={setDeckCardSortBy}
          deckCardLocations={deckCardLocations}
          setPreviewCard={setPreviewCard}
        />
      )}

      {/* --- POPUPS & MODALS --- */}

      {/* A. Create Deck Modal */}
      {newDeckForm.showCreateModal && (
        <DeckCreateDialog form={newDeckForm} showToast={showToast} fetchDecks={fetchDecks} />
      )}

      {/* B. Draw Hand Simulator Modal */}
      {showSimulator && (
        <DeckSimulatorDialog
          hand={hand}
          prizeCards={prizeCards}
          mulliganCount={mulliganCount}
          simulatorDeck={simulatorDeck}
          setShowSimulator={setShowSimulator}
          startSimulator={startSimulator}
          handleMulligan={handleMulligan}
          handleDrawCard={handleDrawCard}
          setPreviewCard={setPreviewCard}
        />
      )}

      {/* C. Export Modal */}
      {showExportModal && (
        <DeckExportDialog
          activeDeck={activeDeck}
          exportFormat={exportFormat}
          setExportFormat={setExportFormat}
          setShowExportModal={setShowExportModal}
          showToast={showToast}
        />
      )}

      {/* D. Import Modal with Collection Comparison */}
      {showImportModal && (
        <DeckImportDialog
          activeDeck={activeDeck}
          importText={importText}
          setImportText={setImportText}
          importComparison={importComparison}
          setImportComparison={setImportComparison}
          comparingImport={comparingImport}
          setComparingImport={setComparingImport}
          setShowImportModal={setShowImportModal}
          showToast={showToast}
          loadDeckDetails={loadDeckDetails}
        />
      )}

      {/* E. High-Res Card Art Preview Popover */}
      {previewCard && (
        <Modal onClose={() => setPreviewCard(null)} label={displayName(previewCard)}
          overlayStyle={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          className="glass-panel" style={{ maxWidth: '340px', padding: '1rem', position: 'relative', textAlign: 'center', animation: 'draw-card-anim 0.25s ease-out forwards' }}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => setPreviewCard(null)} aria-label={t('common.close')} style={{ position: 'absolute', top: '0.5rem', right: '0.5rem', borderRadius: '50%', zIndex: 10 }}>
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
        </Modal>
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
