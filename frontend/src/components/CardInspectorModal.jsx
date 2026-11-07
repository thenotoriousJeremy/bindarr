import { useState, useEffect, useRef } from 'react';
import { X, MapPin, Trash2, Star, Maximize2, ExternalLink, Search, Layers, RefreshCw, FlipHorizontal2 } from 'lucide-react';
import { getCardDisplayName } from '../utils/langHelper';
import { translatedName, setCode, isEnglish, langCode } from '../utils/languages';
import { formatPrice, priceText } from '../utils/formatPrice';
import { resolveCardPrice } from '../utils/resolveCardPrice';
import { tcgplayerUrl, cardmarketUrl, searchUrl, priceSource, noLinkReason } from '../utils/marketplaceLinks';
import CardImage from './CardImage';
import CardImageZoom from './CardImageZoom';
import CardEntryFields from './CardEntryFields';
import PriceHistoryChart from './PriceHistoryChart';
import AddToDeckSelect from './AddToDeckSelect';
import CardArtEditor from './CardArtEditor';
import { useBackGuard } from '../utils/useBackGuard';
import { useT } from '../utils/i18n';

// MTG color identity pip colors (WUBRG), approximating the printed mana colors.
const MTG_COLOR_BG = {
  White: '#f8f6d8', Blue: '#0e68ab', Black: '#2b2422', Red: '#d3202a', Green: '#00733e'
};
const MTG_COLOR_FG = {
  White: '#3a3520', Blue: '#fff', Black: '#fff', Red: '#fff', Green: '#fff'
};

function getSlotNumber(c) {
  if (!c) return null;
  if (c.slot != null) return c.slot;
  if (c.slot_number != null) return c.slot_number;
  if (c.__slotNumber != null) return c.__slotNumber;
  if (typeof c.position === 'number') {
    if (c.position >= 1000) return Math.floor(c.position / 1000);
    return Math.floor(c.position) + 1;
  }
  return null;
}

// Shared card detail popup used by Dashboard, CollectionList and LocationManager.
// Self-contained: owns its edit form (PUT) and delete (DELETE) so every screen
// gets the same rich view + edit without duplicating the form. onUpdate() lets
// the parent refetch after a change. onViewStorage is optional (hidden if absent).
function CardInspectorModal({ card, onClose, onUpdate, onDeleted, showToast, onViewStorage, startInEdit = false }) {
  const { t } = useT();
  const [mode, setMode] = useState('view');
  const [locations, setLocations] = useState([]);
  const [q, setQ] = useState(1);
  const [condition, setCondition] = useState('Near Mint');
  const [printing, setPrinting] = useState('Normal');
  const [language, setLanguage] = useState('English');
  const [purchasePrice, setPurchasePrice] = useState(0);
  const [locationId, setLocationId] = useState('');
  const [isTrade, setIsTrade] = useState(0);
  const [favorite, setFavorite] = useState(0);
  const [listType, setListType] = useState('collection');
  const [notes, setNotes] = useState('');
  const [grader, setGrader] = useState('Raw');
  const [grade, setGrade] = useState('');
  const [certNumber, setCertNumber] = useState('');
  const [marketValue, setMarketValue] = useState('');
  const [fetchingValue, setFetchingValue] = useState(false);
  const [localizedCard, setLocalizedCard] = useState(null);
  const [prevTargetId, setPrevTargetId] = useState(card?.entry_id || card?.id || null);
  const [isFullScreen, setIsFullScreen] = useState(false);
  // Showing the back face of a double-faced Magic card (#103).
  const [showBack, setShowBack] = useState(false);
  // Other printings of this card, for re-filing a copy saved under the wrong set.
  const [printings, setPrintings] = useState(null);
  const [findingPrintings, setFindingPrintings] = useState(false);
  const hasToggledRef = useRef(false);

  useBackGuard(isFullScreen, () => setIsFullScreen(false));

  const targetEntryId = card?.entry_id || card?.id;
  if (targetEntryId !== prevTargetId) {
    setPrevTargetId(targetEntryId);
    if (localizedCard) setLocalizedCard(null);
    // A new card opens on its front, not on whichever side the last one was left.
    if (showBack) setShowBack(false);
  }

  const activeCard = card ? (localizedCard || card) : null;
  const flipped = showBack && !!activeCard?.image_url_back;
  // The back face as a card of its own for CardImage. No id on purpose: contributed
  // art is keyed by card id and is front art, so it must not cover the back.
  const faceCard = flipped
    ? { name: activeCard.name, game: activeCard.game, image_url: activeCard.image_url_back }
    : activeCard;

  useEffect(() => {
    fetch('/api/locations')
      .then(r => r.ok ? r.json() : [])
      .then(setLocations)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!card) return;
    setLocalizedCard(null);
    setPrintings(null);
    hasToggledRef.current = false;
    setMode(startInEdit ? 'edit' : 'view');
    setQ(card.quantity ?? 1);
    setCondition(card.condition || 'Near Mint');
    setPrinting(card.printing || 'Normal');
    setLanguage(card.language || 'English');
    setPurchasePrice(card.purchase_price || 0);
    setLocationId(card.location_id || '');
    setIsTrade(card.is_trade ? 1 : 0);
    setFavorite(card.favorite ? 1 : 0);
    setListType(card.list_type || 'collection');
    setNotes(card.notes || '');
    setGrader(card.grader || 'Raw');
    setGrade(card.grade == null ? '' : String(card.grade));
    setCertNumber(card.cert_number || '');
    setMarketValue(card.market_value == null ? '' : String(card.market_value));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset form only when the entry changes, not on every card mutation
  }, [targetEntryId, startInEdit]);

  const handleLanguageChange = async (newLang) => {
    setLanguage(newLang);
    if (!activeCard) return;
    try {
      const cardId = activeCard.card_id || activeCard.id;
      const resp = await fetch(`/api/cards/${encodeURIComponent(cardId)}/printing?lang=${encodeURIComponent(newLang)}&game=${activeCard.game || activeCard.supertype || ''}`);
      if (resp.ok) {
        const localized = await resp.json();
        if (localized && localized.id) {
          const updated = {
            ...(card || {}),
            ...localized,
            card_id: localized.id,
            language: newLang,
          };
          if (card) {
            Object.assign(card, updated);
          }
          setLocalizedCard(updated);
        }
      }
    } catch (e) {
      console.warn('Could not switch to localized printing:', e);
    }
  };

  const handleClose = () => {
    if (hasToggledRef.current && onUpdate) {
      onUpdate();
    }
    onClose && onClose();
  };

  useBackGuard(!!card, handleClose);

  if (!card || !activeCard) return null;

  const handleSave = async (e) => {
    e.preventDefault();
    if (!targetEntryId) return;
    const qNum = Math.max(1, parseInt(q, 10) || 1);
    try {
      const res = await fetch(`/api/collection/${targetEntryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Sent only when actually changed. The server reads quantity as the
          // absolute number of copies owned and adds or removes rows to match,
          // and some screens open this popup on a single row whose quantity is
          // not the whole stack — so an untouched field must not be able to
          // trim copies the user never asked to lose.
          ...(qNum !== (card.quantity ?? 1) ? { quantity: qNum } : {}),
          condition,
          printing,
          language,
          purchase_price: parseFloat(purchasePrice) || 0,
          location_id: locationId ? parseInt(locationId, 10) : null,
          list_type: listType,
          is_trade: isTrade ? 1 : 0,
          favorite: favorite ? 1 : 0,
          notes,
          grader,
          grade: grade === '' ? null : parseFloat(grade),
          cert_number: certNumber.trim() || null,
          // Only when it actually changed. A value just fetched from the provider is
          // already saved with that provider recorded as its source; sending it back
          // untouched would relabel it as hand-typed and exempt it from a refresh.
          ...(marketValue !== (card.market_value == null ? '' : String(card.market_value))
            ? { market_value: marketValue === '' ? null : parseFloat(marketValue) }
            : {})
        })
      });
      if (res.ok) {
        card.quantity = qNum;
        card.condition = condition;
        card.printing = printing;
        card.language = language;
        card.purchase_price = parseFloat(purchasePrice) || 0;
        card.location_id = locationId ? parseInt(locationId, 10) : null;
        card.list_type = listType;
        card.is_trade = isTrade ? 1 : 0;
        card.favorite = favorite ? 1 : 0;
        card.notes = notes;
        card.grader = grader;
        card.grade = grade === '' ? null : parseFloat(grade);
        card.cert_number = certNumber.trim() || null;
        card.market_value = marketValue === '' ? null : parseFloat(marketValue);
        // The server resolves this per printing on the next fetch; mirror it here so
        // a screen still holding this object does not show the old printing's price.
        card.price_trend = resolveCardPrice(card, printing);
        showToast && showToast(t('inspector.entryUpdated'));
        onUpdate && onUpdate();
        onClose();
      } else {
        // The server's own words when it has any: a duplicate cert number names the
        // card already holding it, which a generic failure toast would throw away
        // and leave the user re-typing a number that was never the problem.
        const body = await res.json().catch(() => null);
        showToast && showToast(body?.error || t('inspector.errUpdate'));
      }
    } catch (err) {
      console.error(err);
      showToast && showToast(t('inspector.errEdit'));
    }
  };

  // Ask the graded-price provider what this slab is worth and drop the answer into
  // the field. One card, one request, because the free tier is metered per day —
  // so this is a button the owner presses, never a sweep.
  const handleFetchValue = async () => {
    if (!targetEntryId) return;
    setFetchingValue(true);
    try {
      const res = await fetch(`/api/collection/${targetEntryId}/market-value/fetch`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setMarketValue(String(data.market_value));
        card.market_value = data.market_value;
        showToast && showToast(t('inspector.valueFetched', { basis: data.basis }));
      } else {
        // The provider's refusals name what to do instead ("enter it by hand", "check
        // the key in Settings"), which a generic failure toast would throw away.
        showToast && showToast(data.error || t('inspector.errFetchValue'));
      }
    } catch (err) {
      console.error(err);
      showToast && showToast(t('common.errBackend'));
    } finally {
      setFetchingValue(false);
    }
  };

  const handleQuickToggle = async (field, value) => {
    if (!targetEntryId) return;
    const nextFavorite = field === 'favorite' ? (value ? 1 : 0) : (favorite ? 1 : 0);
    const nextIsTrade = field === 'is_trade' ? (value ? 1 : 0) : (isTrade ? 1 : 0);
    const nextListType = field === 'list_type' ? value : listType;

    // Optimistic UI & prop object updates
    if (field === 'is_trade') { setIsTrade(nextIsTrade); card.is_trade = nextIsTrade; }
    if (field === 'favorite') { setFavorite(nextFavorite); card.favorite = nextFavorite; }
    if (field === 'list_type') { setListType(nextListType); card.list_type = nextListType; }

    // Only the toggled flags. Quantity and placement are deliberately absent:
    // a favourite/trade toggle must never change how many copies you own or
    // where they live, and sending quantity here reconciles the whole stack.
    const payload = {
      list_type: nextListType,
      is_trade: nextIsTrade,
      favorite: nextFavorite
    };

    try {
      const res = await fetch(`/api/collection/${targetEntryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        hasToggledRef.current = true;
        showToast && showToast(t('inspector.cardUpdated'));
      } else {
        // revert on fail
        if (field === 'is_trade') { setIsTrade(isTrade); card.is_trade = isTrade; }
        if (field === 'favorite') { setFavorite(favorite); card.favorite = favorite; }
        if (field === 'list_type') { setListType(listType); card.list_type = listType; }
        showToast && showToast(t('inspector.errUpdate'));
      }
    } catch (err) {
      console.error(err);
      if (field === 'is_trade') { setIsTrade(isTrade); card.is_trade = isTrade; }
      if (field === 'favorite') { setFavorite(favorite); card.favorite = favorite; }
      if (field === 'list_type') { setListType(listType); card.list_type = listType; }
      showToast && showToast(t('inspector.errUpdateGeneric'));
    }
  };

  const handleAddToDeck = async (deckId) => {
    if (!targetEntryId || !deckId) return;
    try {
      const res = await fetch('/api/collection/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_ids: [targetEntryId], action: 'add_to_deck', value: deckId })
      });
      const data = await res.json().catch(() => ({}));
      showToast && showToast(res.ok ? (data.message || t('inspector.addedToDeck')) : (data.error || t('inspector.errAddDeck')));
    } catch (err) {
      console.error(err);
      showToast && showToast(t('inspector.errAddDeckGeneric'));
    }
  };

  // "Change printing" after the fact: the same all-printings search the scanner's
  // picker runs, narrowed to this card's own name because the server only accepts
  // another printing of the same card.
  const sameName = (a, b) => {
    const names = (c) => [c.name, c.printed_name].filter(Boolean).map(n => String(n).trim().toLowerCase());
    return names(a).some(n => names(b).includes(n));
  };
  const findOtherPrintings = async () => {
    if (findingPrintings) return;
    setFindingPrintings(true);
    try {
      const p = new URLSearchParams({
        game: activeCard.game || 'pokemon',
        lang: langCode(activeCard.language || 'English'),
        name: activeCard.name,
        prints: '1',
        scope: 'internet',
      });
      const res = await fetch(`/api/search?${p.toString()}`);
      const found = (res.ok ? await res.json() : [])
        .filter(c => c.id !== activeCard.card_id && sameName(c, activeCard));
      if (found.length === 0) showToast && showToast(t('scan.noOtherPrintings'));
      setPrintings(found.length ? found : null);
    } catch {
      showToast && showToast(t('scan.noOtherPrintings'));
    } finally {
      setFindingPrintings(false);
    }
  };

  const handleChangePrinting = async (picked) => {
    if (!targetEntryId) return;
    try {
      const res = await fetch(`/api/collection/${targetEntryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_id: picked.id })
      });
      if (res.ok) {
        showToast && showToast(t('inspector.entryUpdated'));
        onUpdate && onUpdate();
        onClose();
      } else {
        const body = await res.json().catch(() => null);
        showToast && showToast(body?.error || t('inspector.errUpdate'));
      }
    } catch (err) {
      console.error(err);
      showToast && showToast(t('inspector.errUpdateGeneric'));
    }
  };

  const handleDelete = async () => {
    if (!targetEntryId) return;
    if (!window.confirm(t('collection.confirmDeleteCard', { name: card.name }))) return;
    try {
      const res = await fetch(`/api/collection/${targetEntryId}`, { method: 'DELETE' });
      if (res.ok) {
        showToast && showToast(t('collection.cardRemoved', { name: card.name }));
        onDeleted && onDeleted(targetEntryId);
        onUpdate && onUpdate();
        onClose();
      } else {
        showToast && showToast(t('collection.errDelete'));
      }
    } catch (err) {
      console.error(err);
      showToast && showToast(t('common.errBackend'));
    }
  };

  // Resolved against the printing selected RIGHT NOW, not the one that was saved
  // when this row was fetched. `card.price_trend` arrives from the server already
  // resolved for the stored printing, so rendering it directly meant switching
  // Normal to Reverse Holofoil in the form changed nothing on screen — the number
  // only caught up after a save and a refetch, which reads as "prices don't
  // respond to the foil type". Same resolution order as the server.
  const displayPrice = resolveCardPrice(activeCard, printing);

  return (
    <div className="modal-overlay" style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.75)',
      backdropFilter: 'blur(8px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 999
    }} onClick={handleClose}>
      <div className={`glass-panel card-inspector ${mode === 'edit' ? 'mode-edit' : ''}`} onClick={(e) => e.stopPropagation()}>
        <button className="btn btn-secondary btn-icon-only" onClick={handleClose} style={{
          position: 'absolute',
          top: '1rem',
          right: '1rem',
          borderRadius: '50%',
          zIndex: 10
        }}>
          <X size={16} />
        </button>

        {/* Left side: Main Card Image Focus */}
        <div className="ci-image-col" style={{ flex: '1 1 260px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div
            className="ci-image-wrap"
            onClick={() => setIsFullScreen(true)}
            title={t('inspector.zoomHint')}
            style={{ position: 'relative', width: '100%', maxWidth: '300px', cursor: 'pointer' }}
          >
            {/* CardImage, not a bare <img>: this was the last call site still
                reading card.image_url directly, so contributed art uploaded
                through the editor below was never shown in the very view that
                uploads it, and a card with no provider art rendered as a broken
                image icon here alone. */}
            <CardImage
              card={faceCard}
              style={{
                width: '100%',
                aspectRatio: 0.718,
                objectFit: 'cover',
                borderRadius: 'var(--radius-md)',
                boxShadow: '0 12px 36px rgba(0,0,0,0.6), 0 0 20px rgba(255,255,255,0.05)',
                transition: 'transform 0.2s ease'
              }}
            />
            <div style={{
              position: 'absolute',
              bottom: '0.6rem',
              right: '0.6rem',
              background: 'rgba(0,0,0,0.65)',
              backdropFilter: 'blur(6px)',
              padding: '0.25rem 0.5rem',
              borderRadius: 'var(--radius-sm)',
              color: '#fff',
              fontSize: '0.65rem',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
              pointerEvents: 'none',
              border: '1px solid rgba(255,255,255,0.15)'
            }}>
              <Maximize2 size={12} />
              <span>{t('inspector.fullScreen')}</span>
            </div>
            {activeCard.image_url_back && (
              <button
                type="button"
                className="btn btn-secondary btn-icon-only"
                // The art itself opens full screen; flipping must not.
                onClick={(e) => { e.stopPropagation(); setShowBack(b => !b); }}
                aria-label={t('inspector.flipCard')}
                aria-pressed={flipped}
                title={t('inspector.flipCard')}
                style={{ position: 'absolute', bottom: '0.6rem', left: '0.6rem', borderRadius: '50%' }}
              >
                <FlipHorizontal2 size={16} />
              </button>
            )}
          </div>
          <CardArtEditor
            card={activeCard}
            hasProviderArt={!!activeCard.image_url}
            showToast={showToast}
            onChanged={onUpdate}
          />
        </div>

        {/* Right side: Information / Edit */}
        <div className="ci-info-col" style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: '1.25rem', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
              {activeCard.list_type === 'wishlist' && (
                <span style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', padding: '0.2rem 0.5rem', borderRadius: '4px', backgroundColor: 'rgba(6, 182, 212, 0.15)', color: '#06b6d4', border: '1px solid rgba(6, 182, 212, 0.3)' }}>
                  {t('inspector.wishlistItem')}
                </span>
              )}
              {activeCard.is_trade === 1 && (
                <span style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', padding: '0.2rem 0.5rem', borderRadius: '4px', backgroundColor: 'rgba(74, 222, 128, 0.15)', color: 'var(--type-grass)', border: '1px solid rgba(74, 222, 128, 0.3)' }}>
                  {t('inspector.forTrade')}
                </span>
              )}
            </div>

            <h3 style={{ fontSize: '1.65rem', color: 'var(--text-strong)', fontWeight: 800, lineHeight: 1.15, marginBottom: '0.25rem' }}>
              {getCardDisplayName(activeCard.name, language, activeCard.printed_name, activeCard.game || activeCard.supertype)}
            </h3>
            {/* The English name when the provider gives us one for this printing
                (Magic always does). Nothing is shown for a Japan-only Pokémon
                card — no provider has an English name for it. */}
            {translatedName(activeCard) && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', fontWeight: 500, marginBottom: '0.25rem' }}>
                {translatedName(activeCard)}
              </p>
            )}
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', fontWeight: 500 }}>
              {activeCard.set_name}
              {/* Set code alongside the native set name: it reads the same in every
                  language, so it is the part you can search or quote. The collector
                  number is already spelled out just after, so only the code here. */}
              {!isEnglish(language) && setCode(activeCard) && (
                <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}> ({setCode(activeCard)})</span>
              )}
              {(activeCard.number || activeCard.collector_number || activeCard.card_number) ? ` • #${activeCard.number || activeCard.collector_number || activeCard.card_number}` : ''}{activeCard.rarity ? ` • ${activeCard.rarity}` : ''} • {t('inspector.owned', { count: activeCard.quantity ?? 1 })}
            </p>

            {/* MTG cards: show color pips + type line (Pokémon energy types are
                already conveyed via the type-glow styling elsewhere). */}
            {(activeCard.supertype === 'MTG' || activeCard.game === 'mtg') && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                {(Array.isArray(activeCard.types) ? activeCard.types : []).map(color => (
                  <span key={color} className={`mtg-color-pip mtg-color-${color.toLowerCase()}`} style={{
                    fontSize: '0.6rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em',
                    padding: '0.15rem 0.45rem', borderRadius: '999px',
                    background: MTG_COLOR_BG[color] || 'rgba(255,255,255,0.1)',
                    color: MTG_COLOR_FG[color] || '#fff', border: '1px solid rgba(0,0,0,0.2)'
                  }}>{color}</span>
                ))}
                {(!activeCard.types || activeCard.types.length === 0) && (
                  <span style={{ fontSize: '0.6rem', fontWeight: 800, textTransform: 'uppercase', padding: '0.15rem 0.45rem', borderRadius: '999px', background: 'rgba(180,180,180,0.25)', color: '#eee' }}>{t('inspector.colorless')}</span>
                )}
                {Array.isArray(activeCard.subtypes) && activeCard.subtypes.length > 0 && (
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{activeCard.subtypes.join(' ')}</span>
                )}
              </div>
            )}
          </div>

          {mode === 'edit' ? (
            <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {listType === 'wishlist' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(74,222,128,0.1)', padding: '0.6rem 0.9rem', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(74,222,128,0.2)' }}>
                  <input type="checkbox" checked={listType === 'collection'} onChange={(e) => setListType(e.target.checked ? 'collection' : 'wishlist')} id="markOwned" style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                  <label htmlFor="markOwned" style={{ cursor: 'pointer', margin: 0, fontWeight: 700, color: 'var(--type-grass)', fontSize: '0.85rem' }}>
                    {t('inspector.markObtained')}
                  </label>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(255,255,255,0.02)', padding: '0.6rem 0.9rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                  <input type="checkbox" checked={isTrade === 1} onChange={(e) => setIsTrade(e.target.checked ? 1 : 0)} id="isTrade" style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                  <label htmlFor="isTrade" style={{ cursor: 'pointer', margin: 0, fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.85rem' }}>
                    {t('inspector.listedInTrade')}
                  </label>
                </div>
              )}

              <CardEntryFields
                game={activeCard.game || activeCard.supertype}
                quantity={q} purchasePrice={purchasePrice} condition={condition} printing={printing} language={language}
                onQuantity={setQ} onPurchasePrice={setPurchasePrice} onCondition={setCondition} onPrinting={setPrinting} onLanguage={handleLanguageChange}
                grader={grader} grade={grade} certNumber={certNumber}
                onGrader={setGrader} onGrade={setGrade} onCertNumber={setCertNumber}
              />

              {/* What this copy is worth, when the card's market price is not it —
                  a slab, a signed card, a misprint. Everything that adds up money
                  (net worth, set totals, the top-valuable list) reads this instead
                  once it is set. Empty means "use the card's price" again. */}
              <div className="form-group">
                <label htmlFor="copy-value">{t('inspector.copyValue')}</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input
                    id="copy-value"
                    type="number" inputMode="decimal" min="0" step="0.01"
                    className="input-control"
                    style={{ flex: 1 }}
                    value={marketValue}
                    onChange={(e) => setMarketValue(e.target.value)}
                    placeholder={formatPrice(displayPrice)}
                  />
                  {grader !== 'Raw' && (
                    <button
                      type="button" className="btn btn-secondary" onClick={handleFetchValue} disabled={fetchingValue}
                      style={{ whiteSpace: 'nowrap', fontSize: '0.75rem' }}
                    >
                      {fetchingValue ? t('common.loading') : t('inspector.fetchGradedValue')}
                    </button>
                  )}
                </div>
                <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: '0.3rem', lineHeight: 1.4 }}>
                  {t('inspector.copyValueHint')}
                </div>
              </div>

              <div className="form-group">
                <label>{t('inspector.storageContainer')}</label>
                <select className="select-control" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">{t('bulk.unassignedPile')}</option>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>{loc.name} ({loc.type})</option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label>{t('nav.notes')}</label>
                <textarea
                  className="input-control"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={t('inspector.notesPlaceholder')}
                  rows={3}
                  style={{ resize: 'vertical', fontFamily: 'inherit' }}
                />
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.25rem' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setMode('view')} style={{ flex: 1 }}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 2 }}>{t('inspector.saveChanges')}</button>
              </div>
            </form>
          ) : (
            <>
              {/* Price Panel */}
              <div style={{ borderTop: '1px solid var(--border-glass)', borderBottom: '1px solid var(--border-glass)', padding: '0.75rem 0', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem' }}>
                <div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 700 }}>{t('inspector.marketPrice')}</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--accent-yellow)', marginTop: '0.15rem' }}>
                    {priceText(displayPrice, activeCard.price_currency)}
                  </div>
                  {/* Say where a non-English price came from and in what currency —
                      it is Cardmarket's EUR figure rendered with the app's $. */}
                  {priceSource(activeCard) && (
                    <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                      {t('inspector.priceVia', { source: priceSource(activeCard).name, currency: priceSource(activeCard).currency })}
                    </div>
                  )}
                  {/* Every price source this app has — TCGplayer, Scryfall,
                      Cardmarket — quotes RAW singles. None of them price slabs, and
                      a PSA 10 is worth a multiple of its raw copy. So for a graded
                      copy the number above is either a value set on this copy, or it
                      is the raw price and says so. Inventing a grade multiplier
                      would be worse than either: confidently wrong. */}
                  {activeCard.market_value > 0 ? (
                    <div style={{ fontSize: '0.62rem', color: 'var(--accent-yellow)', marginTop: '0.1rem', lineHeight: 1.35 }}>
                      {activeCard.market_value_source && activeCard.market_value_source !== 'manual'
                        ? t('inspector.valueFromProvider', { source: activeCard.market_value_source })
                        : t('inspector.valueFromYou')}
                    </div>
                  ) : activeCard.grader && activeCard.grader !== 'Raw' && (
                    <div style={{ fontSize: '0.62rem', color: 'var(--accent-yellow)', marginTop: '0.1rem', lineHeight: 1.35 }}>
                      {t('inspector.priceRawOnly')}
                    </div>
                  )}
                  {/* Printings are priced separately; conditions are not, by anyone
                      Bindarr talks to — TCGplayer, Scryfall and Cardmarket all quote
                      a Near Mint copy. Saying so beats letting a played card show a
                      NM price with nothing to explain it, and beats inventing a
                      condition multiplier, which would be a made-up number wearing
                      the same styling as a real one. */}
                  {!(activeCard.market_value > 0) && condition && condition !== 'Near Mint' && (
                    <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: '0.1rem', lineHeight: 1.35 }}>
                      {t('inspector.priceNearMintOnly', { condition })}
                    </div>
                  )}
                </div>
                <div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 700 }}>{t('inspector.purchaseValue')}</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-strong)', marginTop: '0.15rem' }}>
                    {priceText(activeCard.purchase_price)}
                  </div>
                </div>
              </div>

              {/* Marketplace links. "View on TCGplayer" now means the card's own
                  product page and nothing else — it used to fall back to a name
                  search wearing the same label, which for a Japanese printing
                  reliably found nothing.

                  A search is still offered, as its own action with its own words, so
                  the reader can tell which of the two they are about to get. */}
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {tcgplayerUrl(activeCard) && (
                  <a
                    href={tcgplayerUrl(activeCard)} target="_blank" rel="noopener noreferrer"
                    className="btn btn-secondary"
                    style={{ flex: 1, minWidth: '140px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', fontSize: '0.75rem' }}
                  >
                    <ExternalLink size={13} /> {t('inspector.viewOnTcgplayer')}
                  </a>
                )}
                {cardmarketUrl(activeCard) && (
                  <a
                    href={cardmarketUrl(activeCard)} target="_blank" rel="noopener noreferrer"
                    className="btn btn-secondary"
                    style={{ flex: 1, minWidth: '140px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', fontSize: '0.75rem' }}
                  >
                    <ExternalLink size={13} /> Cardmarket
                  </a>
                )}
                {/* Only shown when there is no direct link — as a fallback the reader
                    chooses, not a substitute presented as the real thing. */}
                {!tcgplayerUrl(activeCard) && !cardmarketUrl(activeCard) && searchUrl(activeCard) && (
                  <a
                    href={searchUrl(activeCard)} target="_blank" rel="noopener noreferrer"
                    className="btn btn-secondary"
                    style={{ flex: 1, minWidth: '140px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', fontSize: '0.75rem' }}
                  >
                    <Search size={13} /> {t('inspector.searchTcgplayer')}
                  </a>
                )}
              </div>
              {noLinkReason(activeCard) && (
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                  {noLinkReason(activeCard)}
                </div>
              )}

              {/* Price History Area Chart */}
              <PriceHistoryChart cardId={activeCard.card_id || activeCard.id} currency={activeCard.price_currency} height={100} defaultRange="30d" />

              {/* Specifications Details Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem 1rem', background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-glass)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem' }}>
                {/* A slab reports its grade where a raw card reports its condition:
                    they answer the same question, and showing 'Near Mint' for a
                    PSA 9 states an opinion the grader already overruled. */}
                {activeCard.grader && activeCard.grader !== 'Raw' ? (
                  <div><span style={{ color: 'var(--text-muted)' }}>{t('inspector.specGrade')}</span> <span style={{ color: 'var(--accent-yellow)', fontWeight: 700 }}>{activeCard.grader}{activeCard.grade != null ? ` ${activeCard.grade}` : ''}</span></div>
                ) : (
                  <div><span style={{ color: 'var(--text-muted)' }}>{t('inspector.specCondition')}</span> <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{activeCard.condition}</span></div>
                )}
                {activeCard.cert_number && (
                  <div><span style={{ color: 'var(--text-muted)' }}>{t('inspector.specCert')}</span> <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{activeCard.cert_number}</span></div>
                )}
                <div><span style={{ color: 'var(--text-muted)' }}>{t('inspector.specPrinting')}</span> <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{activeCard.printing}</span></div>
                <div><span style={{ color: 'var(--text-muted)' }}>{t('inspector.specLanguage')}</span> <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{activeCard.language}</span></div>
                <div><span style={{ color: 'var(--text-muted)' }}>{t('inspector.specSupertype')}</span> <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{activeCard.supertype}</span></div>
              </div>

              {/* Right card, wrong set: re-file this copy under another printing. */}
              {printings ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    {t('scan.allPrintings', { n: printings.length, name: activeCard.name })}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))', gap: '0.6rem', maxHeight: '280px', overflowY: 'auto', padding: '0.25rem' }}>
                    {printings.map(p => (
                      <div key={p.id} className="tcg-card" onClick={() => handleChangePrinting(p)} style={{ cursor: 'pointer' }}>
                        <div className="tcg-card-inner" style={{ border: '1px solid var(--border-glass-hover)' }}>
                          <CardImage card={p} className="tcg-card-image" />
                        </div>
                        <div className="tcg-card-info" style={{ textAlign: 'center', marginTop: '0.35rem' }}>
                          <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-primary)' }}>#{p.number}</div>
                          <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>{p.set_name}</div>
                          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--accent-yellow)' }}>{priceText(p.price_trend, p.price_currency)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPrintings(null)}>{t('common.cancel')}</button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={findOtherPrintings}
                  disabled={findingPrintings}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem' }}
                >
                  {findingPrintings ? <RefreshCw size={14} className="spin" /> : <Layers size={14} />}
                  <span>{findingPrintings ? t('scan.fetchingCandidates') : t('scan.changePrinting')}</span>
                </button>
              )}

              {/* Storage Container details (clickable to view in storage) */}
              {activeCard.list_type !== 'wishlist' && (
                <div 
                  onClick={() => onViewStorage && activeCard.list_type !== 'wishlist' && onViewStorage(activeCard)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    background: 'rgba(255, 71, 71, 0.03)', padding: '0.65rem 0.75rem',
                    borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)',
                    fontSize: '0.75rem', cursor: onViewStorage ? 'pointer' : 'default',
                    transition: 'background 0.2s'
                  }}
                  title={onViewStorage ? t('inspector.viewInStorage') : undefined}
                >
                  <MapPin size={14} style={{ color: 'var(--accent-red)', flexShrink: 0 }} />
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    <span style={{ color: 'var(--text-muted)' }}>{t('inspector.locationLabel')} </span>
                    <strong style={{ color: 'var(--text-strong)' }}>
                      {activeCard.location_name ? `${activeCard.location_name}${activeCard.location_type ? ` (${activeCard.location_type})` : ''}` : t('bulk.unassignedPile')}
                    </strong>
                    {activeCard.location_name && activeCard.compartment_display_label && (
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {` • ${activeCard.compartment_display_label}`}
                        {getSlotNumber(activeCard) !== null ? ` • ${t('wizard.slot', { slot: getSlotNumber(activeCard) })}` : ''}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {activeCard.notes && (
                <div style={{ background: 'rgba(0,0,0,0.15)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.75rem', fontSize: '0.8rem', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {activeCard.notes}
                </div>
              )}

              {/* Main Actions Row: Edit Card + Icon buttons for Favorite & Delete */}
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => setMode('edit')}>
                  {t('inspector.editCard')}
                </button>

                <AddToDeckSelect
                  onAdd={handleAddToDeck}
                  placeholder={t('inspector.addToDeck')}
                  style={{ fontSize: '0.8rem', padding: '0.45rem 0.5rem', maxWidth: '140px' }}
                />

                {activeCard.list_type === 'wishlist' && (
                  <button 
                    className="btn btn-secondary" 
                    style={{ backgroundColor: 'rgba(74,222,128,0.2)', color: 'var(--type-grass)', border: '1px solid rgba(74,222,128,0.3)', padding: '0 0.75rem', fontSize: '0.8rem' }} 
                    onClick={() => handleQuickToggle('list_type', 'collection')}
                    title={t('bulk.moveToCollection')}
                  >
                    {t('inspector.obtained')}
                  </button>
                )}

                <button
                  type="button"
                  className={`btn ${favorite === 1 ? 'btn-primary' : 'btn-secondary'} btn-icon-only`}
                  style={{ borderRadius: 'var(--radius-sm)', padding: '0.6rem', ...(favorite === 1 ? { backgroundColor: 'rgba(250,204,21,0.2)', color: '#facc15', border: '1px solid rgba(250,204,21,0.3)' } : {}) }}
                  onClick={() => handleQuickToggle('favorite', favorite === 1 ? 0 : 1)}
                  title={t(favorite === 1 ? 'inspector.unfavorite' : 'inspector.favorite')}
                >
                  <Star size={16} fill={favorite === 1 ? '#facc15' : 'none'} />
                </button>

                <button
                  type="button"
                  className="btn btn-danger btn-icon-only"
                  style={{ borderRadius: 'var(--radius-sm)', padding: '0.6rem' }}
                  onClick={handleDelete}
                  title={t('inspector.deleteCard')}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {isFullScreen && (
        <CardImageZoom card={faceCard} onClose={() => setIsFullScreen(false)} />
      )}
    </div>
  );
}

export default CardInspectorModal;
