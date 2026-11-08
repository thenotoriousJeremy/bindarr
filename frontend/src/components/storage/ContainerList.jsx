import { useState, useRef } from 'react';
import { Plus, Minus, Trash2, MoreVertical, Settings, RefreshCw, Lock, LayoutGrid, Upload, BookOpen, GalleryHorizontal } from 'lucide-react';
import { useT } from '../../utils/i18n';

// The Storage header: which container is open (and creating/importing one),
// the view switches, Select / Arrange, and the container's kebab menu. Below it,
// the bulk bar for cards selected inside the open container. All state that
// outlives the header stays in LocationManager and comes in as props.
export default function ContainerList({
  locations, activeLocationId, setActiveLocationId, selectedLoc, compartments, cardsByCompartment, cardsInActiveLocation,
  isBinderType, isCustom, filingMode, moveMode, setMoveMode, setPickedEntryId,
  containerViewMode, setContainerViewMode, viewMode, containerCardScale, setContainerCardScale, storage,
  setShowCreate, handleContainerImportFile, handleToggleContainerLock, handleAddCompartment, handleRemoveCompartment,
  startResort, openContainerSettings, handleDeleteLocation,
}) {
  const { t } = useT();
  const containerImportInput = useRef(null);
  const [showKebabMenu, setShowKebabMenu] = useState(false);

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <select
            className="select-control"
            value={activeLocationId || ''}
            onChange={(e) => setActiveLocationId(parseInt(e.target.value, 10))}
            style={{ fontSize: '1rem', fontWeight: 'bold', padding: '0.3rem', width: 'auto', minWidth: '150px' }}
          >
            <option value="" disabled>{t('loc.selectContainer')}</option>
            {locations.map(loc => <option key={loc.id} value={loc.id}>{loc.locked ? '🔒 ' : ''}{loc.name} ({loc.type})</option>)}
          </select>
          <button type="button" className="btn btn-secondary btn-icon-only" onClick={() => setShowCreate(s => !s)} style={{ width: '28px', height: '28px', padding: 0 }} title={t('loc.createContainer')}>
            <Plus size={14} />
          </button>
          <button type="button" className="btn btn-secondary btn-icon-only" onClick={() => containerImportInput.current?.click()} style={{ width: '28px', height: '28px', padding: 0 }} title={t('loc.importContainer')}>
            <Upload size={14} />
          </button>
          <input ref={containerImportInput} type="file" accept=".txt,text/plain" onChange={handleContainerImportFile} style={{ display: 'none' }} />
          {selectedLoc && !!selectedLoc.locked && (
            <button type="button" onClick={handleToggleContainerLock} title={t('loc.lockedBadgeHint')} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.62rem', fontWeight: 800, padding: '0.15rem 0.45rem', borderRadius: '999px', cursor: 'pointer', background: 'rgba(255,193,7,0.15)', border: '1px solid var(--accent-yellow)', color: 'var(--accent-yellow)' }}>
              <Lock size={11} /> Locked
            </button>
          )}
        </div>

        {selectedLoc && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          {!filingMode && !moveMode && (
            <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
              <button
                type="button"
                className={`btn btn-icon-only ${containerViewMode === 'layout' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setContainerViewMode('layout')}
                aria-pressed={containerViewMode === 'layout'}
                style={{ borderRadius: 'var(--radius-sm)', padding: '0.25rem 0.35rem', width: '28px', height: '24px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                title={t(isBinderType ? 'loc.viewPages' : 'loc.viewRows')}
                aria-label={t(isBinderType ? 'loc.viewPages' : 'loc.viewRows')}
              >
                {isBinderType ? <BookOpen size={13} /> : <GalleryHorizontal size={13} />}
              </button>
              <button
                type="button"
                className={`btn btn-icon-only ${containerViewMode === 'overview' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setContainerViewMode('overview')}
                aria-pressed={containerViewMode === 'overview'}
                style={{ borderRadius: 'var(--radius-sm)', padding: '0.25rem 0.35rem', width: '28px', height: '24px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                title={t('loc.viewAllCards')}
                aria-label={t('loc.viewAllCards')}
              >
                <LayoutGrid size={13} />
              </button>
            </div>
          )}
          {viewMode === 'overview' && (
            <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
              <button
                type="button"
                className="btn btn-icon-only btn-secondary"
                disabled={containerCardScale <= 0.6}
                onClick={() => setContainerCardScale(scale => Math.max(0.6, +(scale - 0.2).toFixed(1)))}
                aria-label={t('loc.decreaseCardScale')}
                title={t('loc.decreaseCardScale')}
                style={{ borderRadius: 'var(--radius-sm)', padding: '0.25rem 0.35rem', width: '28px', height: '24px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <Minus size={13} />
              </button>
              <button
                type="button"
                className="btn btn-icon-only btn-secondary"
                disabled={containerCardScale >= 2.5}
                onClick={() => setContainerCardScale(scale => Math.min(2.5, +(scale + 0.2).toFixed(1)))}
                aria-label={t('loc.increaseCardScale')}
                title={t('loc.increaseCardScale')}
                style={{ borderRadius: 'var(--radius-sm)', padding: '0.25rem 0.35rem', width: '28px', height: '24px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <Plus size={13} />
              </button>
            </div>
          )}
          {!filingMode && !moveMode && (selectedLoc.total_cards || 0) > 0 && (
            <button
              type="button"
              className={`btn ${storage.selectMode ? 'btn-primary' : 'btn-secondary'}`}
              disabled={!!selectedLoc.locked}
              onClick={() => (storage.selectMode ? storage.exitSelectMode() : storage.setSelectMode(true))}
              style={{ fontSize: '0.7rem', padding: '0.3rem 0.6rem' }}
              title={t(selectedLoc.locked ? 'loc.lockedSelectHint' : 'loc.selectHint')}
            >
              {t(storage.selectMode ? 'bulk.done' : 'collection.select')}
            </button>
          )}
          {!filingMode && !storage.selectMode && isCustom && (
            <button
              type="button"
              className={`btn ${moveMode ? 'btn-primary' : 'btn-secondary'}`}
              disabled={!!selectedLoc.locked}
              onClick={() => { setMoveMode(m => !m); setPickedEntryId(null); }}
              style={{ fontSize: '0.7rem', padding: '0.3rem 0.6rem' }}
              title={t(selectedLoc.locked ? 'loc.lockedArrangeHint' : 'loc.arrangeHint')}
            >
              {t(moveMode ? 'loc.doneArranging' : 'loc.arrange')}
            </button>
          )}
          <div className="kebab-menu">
            <button className="kebab-menu-button" onClick={() => setShowKebabMenu(s => !s)}>
              <MoreVertical size={16} color="var(--text-secondary)" />
            </button>
            {showKebabMenu && (
              <div className="kebab-dropdown">
                <button className="kebab-item" disabled={!!selectedLoc.locked} onClick={() => { setShowKebabMenu(false); handleAddCompartment(); }}>
                  <Plus size={14} /> {t(isBinderType ? 'loc.addPage' : 'loc.addCompartment')}
                </button>
                <button className="kebab-item" 
                        disabled={!!selectedLoc.locked || compartments.length <= 1 || (cardsByCompartment.get(compartments[compartments.length-1]?.id) || []).length > 0} 
                        onClick={() => { setShowKebabMenu(false); handleRemoveCompartment(compartments[compartments.length-1].id); }}
                        title={t(selectedLoc.locked ? 'loc.containerLockedShort' : 'loc.removeLastHint')}
                >
                  <Trash2 size={14} /> {t(isBinderType ? 'loc.removeLastPage' : 'loc.removeLastCompartment')}
                </button>
                <button className="kebab-item" onClick={() => { setShowKebabMenu(false); startResort(); }} disabled={!!selectedLoc.locked || (selectedLoc.total_cards || 0) === 0}>
                  <RefreshCw size={14} /> Re-sort Container
                </button>
                <button className="kebab-item" onClick={() => { setShowKebabMenu(false); handleToggleContainerLock(); }} title={t('loc.lockKebabHint')}>
                  <Lock size={14} /> {t(selectedLoc.locked ? 'loc.unlockContainer' : 'loc.lockContainer')}
                </button>
                <button className="kebab-item" disabled={!!selectedLoc.locked} onClick={() => {
                  setShowKebabMenu(false);
                  openContainerSettings();
                }}>
                  <Settings size={14} /> Container Settings
                </button>
                <button className="kebab-item" disabled={!!selectedLoc.locked} onClick={() => { setShowKebabMenu(false); handleDeleteLocation(selectedLoc.id, selectedLoc.name); }} style={{ color: 'var(--accent-red)' }}>
                  <Trash2 size={14} /> Delete Container
                </button>
              </div>
            )}
          </div>
          </div>
        )}
      </div>

      {storage.selectMode && (
        <div className="glass-panel" style={{ padding: '0.6rem 0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', background: 'rgba(255,71,71,0.08)' }}>
          <span style={{ fontWeight: 800, color: 'var(--text-strong)', fontSize: '0.8rem' }}>{storage.selectedIds.size} selected</span>
          <button className="btn btn-secondary" style={{ fontSize: '0.68rem', padding: '0.25rem 0.5rem' }} onClick={() => storage.setSelectedIds(new Set(cardsInActiveLocation.map(c => c.entry_id)))}>Select all ({cardsInActiveLocation.length})</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.68rem', padding: '0.25rem 0.5rem' }} onClick={() => storage.setSelectedIds(new Set())}>{t('bulk.clear')}</button>
          <div style={{ width: '1px', height: '20px', background: 'var(--border-glass)' }} />
          <button
            className="btn btn-primary"
            style={{ fontSize: '0.68rem', padding: '0.25rem 0.6rem' }}
            disabled={!storage.selectedIds.size}
            onClick={() => storage.runBulk('move', null, t('loc.confirmRemoveFromStorage', { count: storage.selectedIds.size }))}
          >
            {t('loc.removeFromStorage')}
          </button>
          <button
            className="btn btn-danger"
            style={{ fontSize: '0.68rem', padding: '0.25rem 0.6rem' }}
            disabled={!storage.selectedIds.size}
            onClick={() => storage.runBulk('delete', null, t('loc.confirmDeleteFromCollection', { count: storage.selectedIds.size }))}
          >
            {t('common.delete')}
          </button>
          <button className="btn btn-secondary" style={{ fontSize: '0.68rem', padding: '0.25rem 0.5rem', marginLeft: 'auto' }} onClick={storage.exitSelectMode}>{t('bulk.done')}</button>
        </div>
      )}
    </>
  );
}
