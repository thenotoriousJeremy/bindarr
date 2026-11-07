import { Image as ImageIcon } from 'lucide-react';
import CompartmentView, { FocusedCardInfo } from '../CompartmentView';
import { binderSpread } from '../../utils/cardOptions';
import { displayName } from '../../utils/languages';
import { useT } from '../../utils/i18n';

// A binder's page layout: the page navigator above it (with the artwork
// button), and the open page or spread with the focused card's details below.
// Page index, handlers and drag state all belong to LocationManager.

export function BinderPageNav({ compartments, activePageIndex, setActivePageIndex, isMobile, selectedLoc, handleAddCompartment, artworkAvailable, setArtworkOpen }) {
  const { t } = useT();
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '1rem', margin: '0.2rem 0', background: 'rgba(0,0,0,0.1)', padding: '0.4rem', borderRadius: 'var(--radius-sm)' }}>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={activePageIndex <= 0}
        onClick={() => setActivePageIndex(prev => {
          if (isMobile) return Math.max(0, prev - 1);
          const { spread } = binderSpread(prev);
          return spread <= 1 ? 0 : (spread - 1) * 2 - 1;
        })}
        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
      >
        {t('loc.prev')}
      </button>
      <select
        className="select-control"
        value={activePageIndex}
        onChange={(e) => {
          if (e.target.value === '__add_new__') {
            handleAddCompartment();
          } else {
            setActivePageIndex(parseInt(e.target.value, 10));
          }
        }}
        style={{ fontSize: '0.75rem', padding: '0.15rem 0.35rem', fontWeight: 600 }}
      >
        {compartments.map((c, idx) => (
          <option key={c.id} value={idx}>
            {c.display_label || t('loc.pageName', { number: idx + 1 })} ({idx + 1}/{compartments.length})
          </option>
        ))}
        <option value="__add_new__" disabled={!!selectedLoc.locked}>+ {t('loc.addPage')}</option>
      </select>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={isMobile
          ? activePageIndex >= compartments.length - 1
          : binderSpread(activePageIndex).spread * 2 + 1 >= compartments.length}
        onClick={() => setActivePageIndex(prev => {
          // Next spread's left page — the opening spread has none, so
          // stepping off page 1 lands on page 2.
          const next = isMobile ? prev + 1 : binderSpread(prev).spread * 2 + 1;
          return next < compartments.length ? next : prev;
        })}
        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
      >
        {t('loc.next')}
      </button>
      {artworkAvailable && <button
        type="button"
        className="btn btn-secondary"
        onClick={() => setArtworkOpen(true)}
        title={t('binderArt.title')}
        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
      >
        <ImageIcon size={14} /> {t('binderArt.open')}
      </button>}
    </div>
  );
}

export default function BinderViewPanel({
  compartments, cardsByCompartment, cardsInActiveLocation, selectedLoc, locations, setsList,
  isMobile, activePageIndex, handleTouchStart, handleTouchEnd,
  handleAddCompartment, handleReorderCompartment, handleMoveCompartmentToBinder, handleRenameCompartment,
  handleSetCapacity, handleRemoveCompartment, handleToggleCompartmentLock, openCompartmentRules,
  setInspectorCard, handleDeleteCard, handleMoveCard,
  currentRecSpot, recCard, focusEntryId, storage,
  moveMode, pickedEntryId, handlePickCard, handlePlaceSlot, dndEnabled,
  binderActiveEntryId, setBinderActiveEntryId, artByPage,
}) {
  const { t } = useT();
  if (compartments.length === 0) return null;
  const pageProps = (c, i) => ({
    compartment: c,
    cards: cardsByCompartment.get(c.id) || [],
    allowStacking: !!selectedLoc.allow_stacking,
    pageColumns: selectedLoc.page_columns,
    sortOrder: selectedLoc.sort_order,
    setsList,
    canRemove: i === compartments.length - 1 && compartments.length > 1 && (cardsByCompartment.get(c.id) || []).length === 0,
    moveTargets: compartments,
    moveTargetLocations: locations.filter(loc => loc.id !== selectedLoc.id && loc.type === 'Binder' && !loc.locked),
    reorderTargets: compartments.filter(page => page.id !== c.id),
    onInsertBefore: () => handleAddCompartment({ before_id: c.id }),
    onInsertAfter: () => handleAddCompartment({ after_id: c.id }),
    onReorderBefore: (targetId) => handleReorderCompartment(c.id, { before_id: targetId }),
    onReorderAfter: (targetId) => handleReorderCompartment(c.id, { after_id: targetId }),
    onMoveToLocation: (targetLocationId) => handleMoveCompartmentToBinder(c.id, targetLocationId),
    onRename: (label) => handleRenameCompartment(c.id, label),
    onSetCapacity: (cap) => handleSetCapacity(c.id, cap),
    onRemove: () => handleRemoveCompartment(c.id),
    onToggleLock: () => handleToggleCompartmentLock(c.id, !c.locked),
    containerLocked: !!selectedLoc.locked,
    onCardClick: setInspectorCard,
    onDeleteCard: handleDeleteCard,
    onMoveCard: handleMoveCard,
    recommendedSpot: currentRecSpot && currentRecSpot.compartment_id === c.id ? {
      index: Math.floor(currentRecSpot.position / 1000) - 1,
      image_url: recCard?.image_url,
      name: recCard ? displayName(recCard) : undefined,
      set_name: recCard?.set_name,
      card: recCard
    } : null,
    focusEntryId,
    selectMode: storage.selectMode,
    selectedIds: storage.selectedIds,
    onCardLongPress: storage.arm,
    onCardToggle: storage.toggleSelect,
    onEditRules: openCompartmentRules,
    placementMode: moveMode,
    pickedEntryId,
    onPickCard: handlePickCard,
    onPlaceSlot: handlePlaceSlot,
    dropEnabled: dndEnabled,
    activeEntryId: binderActiveEntryId,
    onActiveEntryIdChange: setBinderActiveEntryId,
    hideFocusedCardInfo: true,
    artPockets: artByPage.get(c.id) || null
  });

  let binderPages = null;
  if (isMobile) {
    const targetIdx = Math.min(activePageIndex, compartments.length - 1);
    const activePage = compartments[targetIdx];
    if (!activePage) return null;
    binderPages = (
      <div
        className="binder-page-container"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        style={{ touchAction: 'pan-y' }}
      >
        <div className="binder-page-left" style={{ width: '100%' }}>
          <CompartmentView {...pageProps(activePage, targetIdx)} locationType={selectedLoc.type} />
        </div>
      </div>
    );
  } else {
    const { leftIdx, rightIdx } = binderSpread(Math.min(activePageIndex, compartments.length - 1));
    const left = leftIdx >= 0 ? compartments[leftIdx] : null;
    const right = compartments[rightIdx];

    // The missing half of an opening or closing spread still holds
    // its side of the binder, so the page that is there stays on
    // its own side of the spine instead of sliding across it.
    binderPages = (
      <div className="binder-page-container">
        <div className="binder-page-left">
          {left && <CompartmentView {...pageProps(left, leftIdx)} locationType={selectedLoc.type} />}
        </div>
        <div className="binder-spine" />
        <div className="binder-page-right">
          {right && <CompartmentView {...pageProps(right, rightIdx)} locationType={selectedLoc.type} />}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {binderPages}
      {(() => {
        if (!binderActiveEntryId) return null;
        const activeCard = cardsInActiveLocation.find(c => c.entry_id === binderActiveEntryId);
        if (!activeCard) return null;
        const compCards = cardsByCompartment.get(activeCard.compartment_id) || [];
        const slotNumber = compCards.findIndex(c => c.entry_id === binderActiveEntryId) + 1;
        
        const moveSelect = selectedLoc.sort_order === 'custom' && compartments.length > 1 ? (
          <select
            className="select-control"
            value=""
            onChange={(e) => { if (e.target.value) handleMoveCard(activeCard.entry_id, parseInt(e.target.value, 10)); }}
            style={{ fontSize: '0.65rem', padding: '0.15rem 0.3rem', width: '110px', flexShrink: 0 }}
          >
            <option value="">{t('compartment.moveTo')}</option>
            {compartments.filter(t => t.id !== activeCard.compartment_id).map(t => (
              <option key={t.id} value={t.id}>{t.display_label}</option>
            ))}
          </select>
        ) : null;
        
        return <FocusedCardInfo card={activeCard} slotNumber={slotNumber} moveSelect={moveSelect} />;
      })()}
    </div>
  );
}
