import { useDraggable, useDroppable } from '@dnd-kit/core';
import { LayoutGrid, List, MousePointerClick } from 'lucide-react';
import { getFoilOverlayClass, getPrintingBadgeLabel, getPrintingBadgeStyle } from '../../utils/cardPrinting';
import { getCardRarityBorder, getRarityBadgeStyle, getRarityBadgeLabel } from '../../utils/cardRarity';
import { conditionLabel } from '../../utils/cardOptions';
import { displayName } from '../../utils/languages';
import CardImage from '../CardImage';
import VirtualGrid from '../VirtualGrid';
import { useT } from '../../utils/i18n';

// An Unsorted-queue card that can be dragged into a binder pocket. Split in two
// so the hook only mounts when dragging is on — the queue also renders for
// auto-sorted and locked containers, where there is nothing to drag to.
// MouseSensor activates on mousedown, while hold-to-select listens on
// pointerdown, so both sets of listeners can be spread onto the same element.
function ActiveDraggable({ entryId, card, style, children, ...divProps }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: entryId, data: { card } });
  return (
    <div
      ref={setNodeRef}
      style={{ ...style, cursor: 'grab', ...(isDragging ? { opacity: 0.4 } : {}) }}
      {...attributes}
      {...listeners}
      {...divProps}
    >
      {children}
    </div>
  );
}

function DraggableCard({ enabled, entryId, card, children, ...divProps }) {
  if (!enabled) return <div {...divProps}>{children}</div>;
  return <ActiveDraggable entryId={entryId} card={card} {...divProps}>{children}</ActiveDraggable>;
}

// The Unsorted queue as a drop target, so a filed card can be dragged back OUT
// of the binder. Without it the queue is one-way: cards go in by drag and only
// come back by opening the card and clearing its container.
function UnsortedDropZone({ enabled, children }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'unsorted-queue' });
  if (!enabled) return <>{children}</>;
  return (
    <div
      ref={setNodeRef}
      style={{
        // An empty queue is exactly when you most want to drag a card out of the
        // binder, and an empty div is nothing to aim at — so it keeps a target
        // worth of height whether or not there is anything in it.
        minHeight: '90px',
        borderRadius: 'var(--radius-sm)',
        ...(isOver ? { outline: '3px solid var(--accent-green)', outlineOffset: '-3px' } : {}),
      }}
    >
      {children}
    </div>
  );
}

// The Unsorted queue: cards with no container, with search/sort, multi-select
// filing, Sort & File / Auto-file, and (custom-order binders) drag into a
// pocket. Rendered inside LocationManager's DndContext; the queue's state is
// LocationManager's, since filing and locating a card read it too.
export default function UnsortedQueue({
  unsortedCards, locations, activeLocationId, focusEntryId, unsortedGridRef,
  unsortedSearch, setUnsortedSearch, unsortedSort, setUnsortedSort, unsortedViewMode, setUnsortedViewMode,
  unsortedSelectMode, setUnsortedSelectMode, exitUnsortedSelectMode, unsortedSelectedIds, setUnsortedSelectedIds,
  clearUnsortedSelection, unsortedPressHandlers, runUnsortedBulk, unsortedBulkLocation, setUnsortedBulkLocation,
  activateUnsortedCard, startFilingMode, handleApplyAll, moveMode, pickedEntryId, dndEnabled,
}) {
  const { t } = useT();
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: '0.85rem' }}>{t('loc.unsortedCount', { count: unsortedCards.length })}</strong>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <button
            type="button"
            className={`btn ${unsortedSelectMode ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => (unsortedSelectMode ? exitUnsortedSelectMode() : setUnsortedSelectMode(true))}
            style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem', height: '24px' }}
            title={t('loc.toggleMultiSelect')}
          >
            <MousePointerClick size={12} />
            {t(unsortedSelectMode ? 'bulk.done' : 'collection.select')}
          </button>
          <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
            <button
              type="button"
              className={`btn btn-icon-only ${unsortedViewMode === 'grid' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setUnsortedViewMode('grid')}
              style={{ borderRadius: 'var(--radius-sm)', padding: '0.25rem 0.35rem', width: '28px', height: '24px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
              title={t('loc.gridView')}
            >
              <LayoutGrid size={13} />
            </button>
            <button
              type="button"
              className={`btn btn-icon-only ${unsortedViewMode === 'detail' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setUnsortedViewMode('detail')}
              style={{ borderRadius: 'var(--radius-sm)', padding: '0.25rem 0.35rem', width: '28px', height: '24px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
              title={t('loc.detailView')}
            >
              <List size={13} />
            </button>
          </div>
        </div>
      </div>

      {unsortedSelectMode && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', background: 'rgba(0,0,0,0.25)', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', marginTop: '0.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-strong)' }}>{t('bulk.selectedCount', { count: unsortedSelectedIds.size })}</span>
            <div style={{ display: 'flex', gap: '0.3rem' }}>
              <button type="button" className="btn btn-secondary" style={{ fontSize: '0.65rem', padding: '0.15rem 0.4rem' }} onClick={() => setUnsortedSelectedIds(new Set(unsortedCards.map(c => c.entry_id)))}>{t('loc.selectAll')}</button>
              <button type="button" className="btn btn-secondary" style={{ fontSize: '0.65rem', padding: '0.15rem 0.4rem' }} onClick={clearUnsortedSelection}>{t('bulk.clear')}</button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.3rem' }}>
            <select
              className="select-control"
              value={unsortedBulkLocation}
              onChange={(e) => setUnsortedBulkLocation(e.target.value)}
              style={{ fontSize: '0.7rem', padding: '0.25rem 0.4rem', flex: 1, minWidth: 0 }}
            >
              <option value="">{t('loc.fileSelectedTo')}</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!unsortedBulkLocation || !unsortedSelectedIds.size}
              onClick={() => {
                if (!unsortedBulkLocation) return;
                const locObj = locations.find(l => String(l.id) === String(unsortedBulkLocation));
                runUnsortedBulk('move', unsortedBulkLocation, t('loc.confirmBulkFile', { count: unsortedSelectedIds.size, name: locObj?.name || t('loc.containerLower') }));
                setUnsortedBulkLocation('');
              }}
              style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem', fontWeight: 'bold' }}
            >
              {t('loc.file')}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={!unsortedSelectedIds.size}
              onClick={() => runUnsortedBulk('delete', null, t('bulk.confirmDelete', { count: unsortedSelectedIds.size }))}
              style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
            >
              {t('common.delete')}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
        <input
          className="input-control" placeholder={t('loc.searchPlaceholder')} value={unsortedSearch}
          onChange={(e) => setUnsortedSearch(e.target.value)} style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem' }}
        />
        <select className="select-control" value={unsortedSort} onChange={(e) => setUnsortedSort(e.target.value)} style={{ fontSize: '0.7rem', padding: '0.3rem 0.5rem' }}>
          <option value="scanned-desc">{t('collection.sort.scanned-desc')}</option>
          <option value="scanned-asc">{t('collection.sort.scanned-asc')}</option>
          <option value="name-asc">{t('loc.sortAZ')}</option>
          <option value="price-desc">{t('collection.sort.price-desc')}</option>
          <option value="set-number">{t('loc.sortSetNumber')}</option>
        </select>
      </div>

      {unsortedCards.length > 0 && !unsortedSelectMode && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={startFilingMode}
            disabled={!activeLocationId}
            title={t(activeLocationId ? 'loc.fileWalkHint' : 'loc.selectContainerFirst')}
            style={{ fontSize: '0.8rem', padding: '0.45rem', width: '100%' }}
          >
            {t('loc.sortAndFile')}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleApplyAll}
            disabled={!activeLocationId}
            title={t(activeLocationId ? 'loc.autoFileHint' : 'loc.selectContainerFirst')}
            style={{ fontSize: '0.7rem', padding: '0.35rem', width: '100%' }}
          >
            {t('loc.autoFileAll')}
          </button>
        </div>
      )}

      {/* Drop a filed card here to take it back out of the container. */}
      <UnsortedDropZone enabled={dndEnabled}>
      {unsortedViewMode === 'grid' ? (
        /* Only the rows in view are mounted: an Unsorted queue of thousands
           (a big import, a first scan session) otherwise built every tile. */
        <VirtualGrid
          ref={unsortedGridRef}
          items={unsortedCards}
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '0.6rem', marginTop: '0.25rem' }}
          renderItem={(card) => {
            const picked = moveMode && pickedEntryId === card.entry_id;
            const isSelected = unsortedSelectMode && unsortedSelectedIds.has(card.entry_id);
            const isHighlighted = picked || isSelected;
            const rarityBorder = getCardRarityBorder(card.rarity);
            const foilClass = getFoilOverlayClass(card.printing);
            const printingBadgeLabel = getPrintingBadgeLabel(card.printing, t);

            return (
              <DraggableCard
                enabled={dndEnabled}
                entryId={card.entry_id}
                card={card}
                key={card.entry_id}
                id={`card-${card.entry_id}`}
                className={card.entry_id === focusEntryId ? 'focus-flash' : ''}
                {...unsortedPressHandlers(card.entry_id)}
                onClick={() => activateUnsortedCard(card)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  background: isHighlighted ? 'rgba(255, 71, 71, 0.12)' : 'rgba(255, 255, 255, 0.03)',
                  border: isHighlighted ? '2px solid var(--accent-red)' : '1px solid var(--border-glass)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.35rem',
                  position: 'relative',
                  cursor: 'pointer',
                  userSelect: 'none',
                  transition: 'all 0.15s ease-in-out'
                }}
              >
                {/* Card Thumbnail Box */}
                <div
                  style={{
                    position: 'relative',
                    width: '100%',
                    aspectRatio: 0.718,
                    borderRadius: 'var(--radius-sm)',
                    overflow: 'hidden',
                    ...rarityBorder
                  }}
                >
                  <CardImage card={card} loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  {foilClass && <div className={foilClass} style={{ borderRadius: 'var(--radius-sm)' }} />}
                  
                  {/* Selected / Picked checkmark badge */}
                  {isHighlighted && (
                    <div style={{ position: 'absolute', top: '4px', right: '4px', zIndex: 20, width: '20px', height: '20px', borderRadius: '50%', background: 'var(--accent-red)', border: '2px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-strong)', fontSize: '0.75rem', fontWeight: 900 }}>
                      ✓
                    </div>
                  )}

                  {/* Rarity badge */}
                  <span style={{
                    position: 'absolute',
                    top: '4px',
                    left: '4px',
                    fontSize: '0.5rem',
                    fontWeight: 900,
                    padding: '1px 3px',
                    borderRadius: '2px',
                    zIndex: 10,
                    textTransform: 'uppercase',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
                    ...getRarityBadgeStyle(card.rarity)
                  }}>
                    {getRarityBadgeLabel(card.rarity)}
                  </span>

                  {/* Printing badge overlay */}
                  {printingBadgeLabel && (
                    <span style={{
                      position: 'absolute',
                      bottom: '4px',
                      right: '4px',
                      fontSize: '0.5rem',
                      fontWeight: 900,
                      padding: '1px 3px',
                      borderRadius: '2px',
                      zIndex: 10,
                      border: '1px solid rgba(255,255,255,0.2)',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
                      ...getPrintingBadgeStyle(card.printing)
                    }}>
                      {printingBadgeLabel}
                    </span>
                  )}
                </div>

                {/* Card Info */}
                <div style={{ marginTop: '0.35rem', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '0.15rem' }}>
                  <div
                    style={{
                      fontSize: '0.72rem',
                      fontWeight: isHighlighted ? 700 : 600,
                      color: 'var(--text-primary)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }}
                  >
                    {isHighlighted ? '✓ ' : ''}{displayName(card)}
                  </div>
                  <div style={{ fontSize: '0.62rem', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{card.set_name || ''}</span>
                    {card.price_trend > 0 && <span style={{ color: 'var(--accent-yellow)', fontWeight: 600, flexShrink: 0 }}>${card.price_trend.toFixed(2)}</span>}
                  </div>
                </div>
              </DraggableCard>
            );
          }}
        />
      ) : (
        <VirtualGrid
          ref={unsortedGridRef}
          items={unsortedCards}
          style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginTop: '0.25rem' }}
          renderItem={(card) => {
            const picked = moveMode && pickedEntryId === card.entry_id;
            const isSelected = unsortedSelectMode && unsortedSelectedIds.has(card.entry_id);
            const isHighlighted = picked || isSelected;
            const rarityBorder = getCardRarityBorder(card.rarity);
            const foilClass = getFoilOverlayClass(card.printing);
            const printingBadgeLabel = getPrintingBadgeLabel(card.printing, t);

            return (
              <DraggableCard
                enabled={dndEnabled}
                entryId={card.entry_id}
                card={card}
                key={card.entry_id}
                id={`card-${card.entry_id}`}
                className={card.entry_id === focusEntryId ? 'focus-flash' : ''}
                {...unsortedPressHandlers(card.entry_id)}
                onClick={() => activateUnsortedCard(card)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  fontSize: '0.72rem',
                  padding: '0.4rem',
                  background: isHighlighted ? 'rgba(255,71,71,0.18)' : 'rgba(255, 255, 255, 0.02)',
                  border: isHighlighted ? '2px solid var(--accent-red)' : '1px solid var(--border-glass)',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                  userSelect: 'none',
                  transition: 'all 0.15s ease-in-out'
                }}
              >
                <div
                  style={{ position: 'relative', width: '42px', flexShrink: 0, overflow: 'hidden', borderRadius: '4px', ...rarityBorder }}
                >
                  <CardImage card={card} loading="lazy" decoding="async" style={{ width: '100%', aspectRatio: 0.718, objectFit: 'cover', display: 'block' }} />
                  {foilClass && <div className={foilClass} style={{ borderRadius: '4px' }} />}
                  {isHighlighted && (
                    <div style={{ position: 'absolute', inset: 0, background: 'rgba(255, 71, 71, 0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-strong)', fontWeight: 900, fontSize: '0.8rem' }}>
                      ✓
                    </div>
                  )}
                </div>

                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.1rem' }}>
                  <div style={{ fontWeight: isHighlighted ? 700 : 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {isHighlighted ? '✓ ' : ''}{displayName(card)}
                  </div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'flex', gap: '0.4rem', alignItems: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span>{card.set_name || 'Unset'} {card.number ? `#${card.number}` : ''}</span>
                    {card.condition && (
                      <span style={{ padding: '1px 3px', borderRadius: '2px', background: 'rgba(0,0,0,0.4)', fontSize: '0.55rem', fontWeight: 700 }}>
                        {conditionLabel(t, card.condition)}
                      </span>
                    )}
                    {printingBadgeLabel && (
                      <span style={{ padding: '1px 3px', borderRadius: '2px', fontSize: '0.55rem', fontWeight: 700, ...getPrintingBadgeStyle(card.printing) }}>
                        {printingBadgeLabel}
                      </span>
                    )}
                  </div>
                </div>

                {card.price_trend > 0 && (
                  <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--accent-yellow)', flexShrink: 0 }}>
                    ${card.price_trend.toFixed(2)}
                  </span>
                )}
              </DraggableCard>
            );
          }}
        />
      )}

      {unsortedCards.length === 0 && <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontStyle: 'italic', marginTop: '0.5rem' }}>{t('loc.nothingUnsorted')}</p>}
      </UnsortedDropZone>
    </>
  );
}
