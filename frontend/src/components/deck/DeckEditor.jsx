import { Plus, Trash2, X, ChevronLeft, Play, Search, LogOut, PackageCheck, LayoutGrid, List, Download, Upload, Eye, AlertTriangle, SlidersHorizontal, MapPin, Crown } from 'lucide-react';
import { displayName } from '../../utils/languages';
import ScryfallSyntaxHelp from '../ScryfallSyntaxHelp';
import Modal from '../Modal';
import { onActivateKey } from '../../utils/a11y';
import { gameOptions, showGamePicker } from '../../utils/games';
import CardImage from '../CardImage';
import DeckListActions from '../DeckListActions';
import { useT } from '../../utils/i18n';
import { formatNames, supportsAnyPrinting } from '../../utils/deckRules';
import AnyPrintingField from './AnyPrintingField';
import DeckHealth from './DeckHealth';
import DeckStats from './DeckStats';
import {
  newDeckDefaults, missingCopies, formatCardLocations, locationCollator,
  DECK_CATEGORIES, cardGroup as cardGroupFor, groupOrder,
} from './deckHelpers';

// The open deck: its properties dialog, header and actions, the card search, the
// card list, and the Deck Health and statistics column. All state and handlers are
// DeckBuilder's; this only draws them.
export default function DeckEditor({
  activeDeck, deckGame, deckRules, showToast,
  deckDraft, setDeckDraft, handleSaveDeckProperties,
  openDeck, setShowExportModal, setShowImportModal, loadDeckDetails,
  checkingOut, handleCheckout, handleReturn, startSimulator,
  deckSearchGame, setDeckSearchGame, searchQuery, setSearchQuery, searching, searchResults, handleSearchCards,
  savingCard, atCopyLimit, copyLimitText, handleAddCardToDeck, handleUpdateCardQty, handleToggleCommander,
  cardDisplayMode, setCardDisplayMode, deckCardSortBy, setDeckCardSortBy, deckCardLocations, setPreviewCard,
}) {
  const { t } = useT();
  const hasCommandZone = !!deckRules.commander;
  const cardGroup = (card) => cardGroupFor(deckGame, card);
  const GROUP_ORDER = groupOrder(deckGame);

  const deckCardGroups = activeDeck && deckCardSortBy === 'location'
    ? [{
        name: t('collection.fLocation'),
        cards: [...activeDeck.cards].sort((a, b) => {
          const aLocation = deckCardLocations[a.id]?.find(location => location.location_id);
          const bLocation = deckCardLocations[b.id]?.find(location => location.location_id);
          if (!aLocation) return bLocation ? 1 : displayName(a).localeCompare(displayName(b));
          if (!bLocation) return -1;
          return locationCollator.compare(aLocation.location_name, bLocation.location_name)
            || locationCollator.compare(aLocation.compartment_display || '', bLocation.compartment_display || '')
            || (aLocation.position || 0) - (bLocation.position || 0)
            || displayName(a).localeCompare(displayName(b));
        })
      }]
    : [
        // A deck's commanders head the list, ahead of their card types.
        ...(hasCommandZone ? [{ name: 'Commander', cards: activeDeck?.cards.filter(card => card.is_commander) || [] }] : []),
        ...GROUP_ORDER.map(name => ({
          name,
          cards: activeDeck?.cards.filter(card => !(hasCommandZone && card.is_commander)
            && cardGroup(card).toLowerCase() === name.toLowerCase()) || []
        })),
      ];

  const totalDeckCardsCount = activeDeck ? activeDeck.cards.reduce((sum, c) => sum + c.quantity, 0) : 0;
  const targetDeckCardsCount = activeDeck?.target_size || 60;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Header */}
      {deckDraft && (
        <Modal onClose={() => setDeckDraft(null)} label={t('deck.editProperties')} closeOnBackdrop={false}
          overlayStyle={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'rgba(0,0,0,0.7)' }}
          className="glass-panel" style={{ width: '480px', maxWidth: '100%', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>{t('deck.editProperties')}</h3>
              <button className="btn btn-secondary btn-icon-only" onClick={() => setDeckDraft(null)} aria-label={t('common.close')}><X size={15} /></button>
            </div>
            <label className="form-group" style={{ margin: 0 }}>
              {t('deck.deckName')}
              <input className="input-control" value={deckDraft.name} onChange={(event) => setDeckDraft({ ...deckDraft, name: event.target.value })} />
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.75rem' }}>
              <label className="form-group" style={{ margin: 0 }}>
                {t('deck.format')}
                <select className="input-control" value={deckDraft.format} onChange={(event) => setDeckDraft({ ...deckDraft, format: event.target.value })}>
                  {/* A format saved before the lists existed stays selectable. */}
                  {[...new Set([...formatNames(deckGame), deckDraft.format].filter(Boolean))].map(format => <option key={format} value={format}>{format}</option>)}
                </select>
              </label>
              <label className="form-group" style={{ margin: 0 }}>
                {t('deck.targetSize')}
                <input type="number" min="1" max="300" className="input-control" value={deckDraft.target_size} onChange={(event) => setDeckDraft({ ...deckDraft, target_size: event.target.value })} />
              </label>
            </div>
            {supportsAnyPrinting(deckGame) && (
              <AnyPrintingField t={t} checked={!!deckDraft.any_printing} onChange={(checked) => setDeckDraft({ ...deckDraft, any_printing: checked })} />
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '0.75rem', alignItems: 'end' }}>
              <label className="form-group" style={{ margin: 0 }}>
                {t('deck.category')}
                <select className="input-control" value={deckDraft.category} onChange={(event) => setDeckDraft({ ...deckDraft, category: event.target.value })}>
                  {DECK_CATEGORIES.map(category => <option key={category} value={category}>{category}</option>)}
                </select>
              </label>
              <label className="form-group" style={{ margin: 0 }}>
                {t('deck.accentColor')}
                <input type="color" value={deckDraft.accent_color} onChange={(event) => setDeckDraft({ ...deckDraft, accent_color: event.target.value })} style={{ display: 'block', width: '42px', height: '38px', padding: 0, border: 0, background: 'none' }} />
              </label>
            </div>
            <label className="form-group" style={{ margin: 0 }}>
              {t('deck.descriptionOptional')}
              <textarea className="input-control" style={{ minHeight: '80px', resize: 'vertical' }} value={deckDraft.description} onChange={(event) => setDeckDraft({ ...deckDraft, description: event.target.value })} />
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button className="btn btn-secondary" onClick={() => setDeckDraft(null)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" disabled={!deckDraft.name.trim()} onClick={handleSaveDeckProperties}>{t('deck.saveProperties')}</button>
            </div>
        </Modal>
      )}

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
          <button className="btn btn-secondary btn-icon-only" onClick={() => openDeck(null)} style={{ borderRadius: '50%' }}>
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
            onClick={() => setDeckDraft({
              name: activeDeck.name,
              description: activeDeck.description || '',
              format: activeDeck.format || newDeckDefaults(activeDeck.game).format,
              category: activeDeck.category || 'Competitive',
              accent_color: activeDeck.accent_color || '#eab308',
              target_size: activeDeck.target_size || newDeckDefaults(activeDeck.game).targetSize,
              any_printing: !!activeDeck.any_printing
            })}
            style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
          >
            <SlidersHorizontal size={14} /> {t('deck.editProperties')}
          </button>
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
          <DeckListActions deck={activeDeck} showToast={showToast} onCollectionChanged={() => loadDeckDetails(activeDeck.id)} />
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

      {/* Every level here opts out of min-width:auto (minmax(0, 1fr) on the
          track, minWidth 0 on both columns). Without that, any row's
          min-content (a nowrap warning, the search form) and each chart's
          fixed-px svg width let the columns outgrow the page: on a phone
          the deck list ran off the right edge, and tapping a "+" scrolled
          the clipped page sideways, so the deck appeared to creep left as
          copies were added (#89). The charts also could never shrink back
          once they had measured wide. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '1.5rem', alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: '1.5rem' }}>

          {/* Left Column: Deck Card List */}
          <div style={{ flex: '2 1 500px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            
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
                  // An input's intrinsic width (~20 chars) is otherwise its
                  // flex minimum, which pushed Browse past a phone's edge.
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button type="submit" className="btn btn-primary" style={{ padding: '0.5rem 1rem' }} title={t('shared.search')}>
                  <Search size={16} />
                </button>
                <button type="button" className="btn btn-secondary" onClick={(e) => handleSearchCards(e, true)} style={{ padding: '0.5rem 0.9rem', fontSize: '0.75rem', whiteSpace: 'nowrap' }} title={t('deck.browseHint')}>
                  {t('deck.browseCollection')}
                </button>
              </form>
              {deckSearchGame === 'mtg' && (
                <div style={{ marginTop: '0.5rem' }}><ScryfallSyntaxHelp context="collection" /></div>
              )}

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
                      const isAtRuleMax = atCopyLimit(card);
                      const disabledAdd = savingCard || isAtMaxOwned || isAtRuleMax;

                      return (
                        <div key={card.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.35rem 0.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', border: '1px solid var(--border-glass)', gap: '0.5rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', minWidth: 0, flex: 1 }} role="button" tabIndex={0} onClick={() => setPreviewCard(card)} onKeyDown={onActivateKey(() => setPreviewCard(card))}>
                            <CardImage card={card} style={{ width: '24px', height: '33px', objectFit: 'cover', borderRadius: '2px', flexShrink: 0 }} />
                            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, overflow: 'hidden' }}>
                              <span style={{ fontSize: '0.8rem', color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName(card)} ({card.set_name} • #{card.number})</span>
                              <span style={{ fontSize: '0.65rem', color: isAtMaxOwned ? 'var(--accent-red)' : 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Owned: {ownedQty} | In Deck: {qtyInDeck}</span>
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}>
                            <button className="btn btn-secondary btn-icon-only" style={{ padding: '0.2rem' }} onClick={() => setPreviewCard(card)} title={t('deck.previewArt')}>
                              <Eye size={12} />
                            </button>
                            <button className="btn btn-primary btn-icon-only" style={{ padding: '0.2rem' }} disabled={disabledAdd} onClick={() => handleAddCardToDeck(card)} title={isAtRuleMax ? copyLimitText(card) : isAtMaxOwned ? "Not enough owned copies" : "Add to deck"}>
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
                <select
                  className="select-control"
                  value={deckCardSortBy}
                  onChange={(e) => setDeckCardSortBy(e.target.value)}
                  aria-label={t('collection.sortBy')}
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', height: 'auto' }}
                >
                  <option value="type">{t('deck.sortByType')}</option>
                  <option value="location">{t('collection.fLocation')}</option>
                </select>
              </div>
              
              {activeDeck.cards.length === 0 ? (
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem 0' }}>{t('deck.emptyDeck')}</p>
              ) : (
                deckCardGroups.map(({ name: supertype, cards: list }) => {
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
                            // Wraps so a wide warning drops the controls to their own
                            // line instead of squeezing the name to nothing; the
                            // name's 10rem basis is what decides when to wrap.
                            <div key={card.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0.75rem', background: missingCopies(card) > 0 ? 'rgba(127,29,29,0.16)' : 'rgba(255,255,255,0.01)', borderRadius: 'var(--radius-sm)', border: missingCopies(card) > 0 ? '1px solid var(--accent-red)' : '1px solid var(--border-glass)', gap: '0.6rem' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer', minWidth: 0, flex: '1 1 10rem' }} role="button" tabIndex={0} onClick={() => setPreviewCard(card)} onKeyDown={onActivateKey(() => setPreviewCard(card))}>
                                <CardImage card={card} style={{ width: '32px', height: '44px', objectFit: 'cover', borderRadius: '2px', flexShrink: 0 }} />
                                <div style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                                  <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName(card)}</div>
                                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{card.set_name} • #{card.number}</div>
                                  {deckCardLocations[card.id]?.length > 0 && (
                                    <div title={formatCardLocations(deckCardLocations[card.id])} style={{ display: 'flex', alignItems: 'center', gap: '3px', fontSize: '0.68rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      <MapPin size={11} /> {formatCardLocations(deckCardLocations[card.id])}
                                    </div>
                                  )}
                                </div>
                              </div>

                              {/* The warning names every checked-out deck holding the
                                  card, so it is unbounded: it truncates (full text in
                                  the tooltip) rather than setting the row's width. */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0, marginLeft: 'auto' }}>
                                {missingCopies(card) > 0 && (
                                  <span style={{ color: 'var(--accent-red)', fontSize: '0.7rem', fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: '3px', minWidth: 0, maxWidth: '14rem' }} title={card.locked_decks ? t('deck.unavailableCopiesInDecks', { count: missingCopies(card), decks: card.locked_decks }) : t('deck.unavailableCopies', { count: missingCopies(card) })}>
                                    <AlertTriangle size={13} style={{ flexShrink: 0 }} />
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{card.locked_decks ? t('deck.unavailableCopiesInDecks', { count: missingCopies(card), decks: card.locked_decks }) : t('deck.unavailableCopies', { count: missingCopies(card) })}</span>
                                  </span>
                                )}
                                {hasCommandZone && (
                                  <button
                                    className={`btn ${card.is_commander ? 'btn-primary' : 'btn-secondary'} btn-icon-only`}
                                    style={{ width: '26px', height: '26px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                                    disabled={savingCard}
                                    onClick={() => handleToggleCommander(card)}
                                    title={t(card.is_commander ? 'deck.unsetCommander' : 'deck.setCommander')}
                                    aria-pressed={!!card.is_commander}
                                  >
                                    <Crown size={12} />
                                  </button>
                                )}
                                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: '4px', border: '1px solid var(--border-glass)', flexShrink: 0 }}>
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
                                    disabled={savingCard || card.quantity >= (card.owned_qty || 0) || atCopyLimit(card)}
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
                            <div key={card.id} style={{ position: 'relative', borderRadius: '6px', overflow: 'hidden', border: missingCopies(card) > 0 ? '2px solid var(--accent-red)' : '1px solid var(--border-glass)', background: missingCopies(card) > 0 ? 'rgba(127,29,29,0.16)' : 'rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column', transition: 'transform 0.15s' }}>
                              <div style={{ position: 'relative', width: '100%', aspectRatio: 0.718, cursor: 'pointer' }} role="button" tabIndex={0} onClick={() => setPreviewCard(card)} onKeyDown={onActivateKey(() => setPreviewCard(card))}>
                                <CardImage card={card} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                <span style={{ position: 'absolute', top: '4px', right: '4px', background: 'rgba(0,0,0,0.85)', color: 'var(--accent-yellow)', fontSize: '0.75rem', fontWeight: 800, padding: '1px 6px', borderRadius: '10px', border: '1px solid var(--accent-yellow)' }}>
                                  x{card.quantity}
                                </span>
                                {missingCopies(card) > 0 && (
                                  <span style={{ position: 'absolute', top: '4px', left: '4px', background: 'rgba(127,29,29,0.92)', color: '#fff', fontSize: '0.65rem', fontWeight: 800, padding: '2px 5px', borderRadius: '4px', display: 'inline-flex', alignItems: 'center', gap: '2px' }} title={card.locked_decks || t('deck.unavailableCopies', { count: missingCopies(card) })}>
                                    <AlertTriangle size={10} /> {missingCopies(card)}
                                  </span>
                                )}
                              </div>
                              {deckCardLocations[card.id]?.length > 0 && (
                                <div title={formatCardLocations(deckCardLocations[card.id])} style={{ display: 'flex', alignItems: 'center', gap: '3px', padding: '4px 5px 0', fontSize: '0.65rem', color: 'var(--text-secondary)', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                                  <MapPin size={10} /> <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{formatCardLocations(deckCardLocations[card.id])}</span>
                                </div>
                              )}
                              <div style={{ padding: '4px', display: 'flex', justifyContent: 'center', background: 'rgba(0,0,0,0.5)' }}>
                                <div style={{ display: 'flex', gap: '2px' }}>
                                  <button className={`btn ${card.quantity === 1 ? 'btn-danger' : 'btn-secondary'} btn-icon-only`} style={{ width: '20px', height: '20px', fontSize: '0.7rem', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }} disabled={savingCard} onClick={() => handleUpdateCardQty(card.id, card.quantity - 1)} title={t(card.quantity === 1 ? 'deck.removeFromDeck' : 'deck.decreaseQty')}>
                                    {card.quantity === 1 ? <Trash2 size={10} /> : '-'}
                                  </button>
                                  <button className="btn btn-secondary btn-icon-only" style={{ width: '20px', height: '20px', fontSize: '0.7rem', padding: 0 }} disabled={savingCard || card.quantity >= (card.owned_qty || 0) || atCopyLimit(card)} onClick={() => handleUpdateCardQty(card.id, card.quantity + 1)}>+</button>
                                  {hasCommandZone && (
                                    <button className={`btn ${card.is_commander ? 'btn-primary' : 'btn-secondary'} btn-icon-only`} style={{ width: '20px', height: '20px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }} disabled={savingCard} onClick={() => handleToggleCommander(card)} title={t(card.is_commander ? 'deck.unsetCommander' : 'deck.setCommander')} aria-pressed={!!card.is_commander}>
                                      <Crown size={10} />
                                    </button>
                                  )}
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
          <div style={{ flex: '1 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            
            {/* Deck Health & Summary Status */}
            <DeckHealth activeDeck={activeDeck} deckGame={deckGame} deckRules={deckRules} totalDeckCardsCount={totalDeckCardsCount} targetDeckCardsCount={targetDeckCardsCount} />

            {/* Statistics & charts */}
            <DeckStats activeDeck={activeDeck} deckGame={deckGame} />
          </div>

        </div>
      </div>
    </div>
  );
}
