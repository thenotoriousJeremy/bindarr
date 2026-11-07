import { Lock, Edit3 } from 'lucide-react';
import CompartmentView from '../CompartmentView';
import BoxMap from '../BoxMap';
import { displayName } from '../../utils/languages';
import { useT } from '../../utils/i18n';

// A box's row layout: the row picker and its rename / rules / lock controls,
// the open row's coverflow, and the box map kept in step with it.
export default function BoxViewPanel({
  compartments, cardsByCompartment, selectedLoc, setsList,
  activeCompartmentId, setActiveCompartmentId, boxSeek, boxCursor, setBoxCursor, seekBox,
  handleAddCompartment, handleRenameCompartment, handleSetCapacity, handleRemoveCompartment,
  handleToggleCompartmentLock, openCompartmentRules,
  setInspectorCard, handleDeleteCard, handleMoveCard,
  currentRecSpot, recCard, focusEntryId, storage,
  moveMode, pickedEntryId, handlePickCard, handlePlaceSlot,
}) {
  const { t } = useT();
  if (compartments.length === 0) return <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('loc.noCompartments')}</p>;

  const activeComp = compartments.find(c => c.id === activeCompartmentId) || compartments[0];
  if (!activeComp) return null;
  const activeCompIdx = compartments.findIndex(c => c.id === activeComp.id);
  const activeCompRuleCount = Array.isArray(activeComp.assignedFilters) ? activeComp.assignedFilters.length : (activeComp.rule_config ? 1 : 0);
  const activeAcceptsLabel = activeCompRuleCount > 0 ? `Rules (${activeCompRuleCount})` : 'Accepts All';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div key={activeComp.id} className="row-flash" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', background: 'rgba(0,0,0,0.1)', padding: '0.4rem 0.6rem', borderRadius: 'var(--radius-sm)', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <button className="btn btn-secondary btn-icon-only" disabled={activeCompIdx <= 0} onClick={() => setActiveCompartmentId(compartments[activeCompIdx - 1]?.id)} style={{ width: '24px', height: '24px', padding: 0 }}>
            &larr;
          </button>
          <select
            className="select-control"
            value={activeComp.id}
            onChange={(e) => {
              if (e.target.value === '__add_new__') {
                handleAddCompartment();
              } else {
                setActiveCompartmentId(parseInt(e.target.value, 10));
              }
            }}
            style={{ fontSize: '0.8rem', padding: '0.2rem 0.4rem' }}
          >
            {compartments.map(c => <option key={c.id} value={c.id}>{c.display_label}</option>)}
            <option value="__add_new__" disabled={!!selectedLoc.locked}>+ {t('loc.addRow')}</option>
          </select>
          <button className="btn btn-secondary btn-icon-only" disabled={activeCompIdx >= compartments.length - 1} onClick={() => setActiveCompartmentId(compartments[activeCompIdx + 1]?.id)} style={{ width: '24px', height: '24px', padding: 0 }}>
            &rarr;
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              const newLabel = window.prompt(t('loc.promptRename', { name: activeComp.display_label }), activeComp.label || '');
              if (newLabel !== null) handleRenameCompartment(activeComp.id, newLabel);
            }}
            title={t('loc.renameRow')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', fontSize: '0.6rem', padding: '0.2rem 0.5rem' }}
          >
            <Edit3 size={11} /> {t('common.rename')}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => openCompartmentRules(activeComp)}
            title={t('compartment.acceptsHintRow')}
            style={{ fontSize: '0.6rem', padding: '0.2rem 0.5rem', ...(activeCompRuleCount > 0 ? { borderColor: 'var(--accent-red)', color: 'var(--text-strong)' } : {}) }}
          >
            {activeAcceptsLabel}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => handleToggleCompartmentLock(activeComp.id, !activeComp.locked)}
            disabled={!!selectedLoc.locked}
            title={t(selectedLoc.locked ? 'compartment.lockContainerRow' : activeComp.locked ? 'compartment.lockedHintRow' : 'compartment.lockHintRow')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', fontSize: '0.6rem', padding: '0.2rem 0.5rem', opacity: selectedLoc.locked ? 0.5 : 1, ...((activeComp.locked || selectedLoc.locked) ? { borderColor: 'var(--accent-yellow)', color: 'var(--accent-yellow)' } : {}) }}
          >
            <Lock size={12} /> {t(activeComp.locked ? 'compartment.locked' : 'compartment.lock')}
          </button>
        </div>
      </div>
      
      <CompartmentView 
        hideHeader={true}
        compartment={activeComp}
        cards={cardsByCompartment.get(activeComp.id) || []}
        locationType={selectedLoc.type}
        sortOrder={selectedLoc.sort_order}
        setsList={setsList}
        moveTargets={compartments}
        onRename={(label) => handleRenameCompartment(activeComp.id, label)}
        onSetCapacity={(cap) => handleSetCapacity(activeComp.id, cap)}
        onRemove={() => handleRemoveCompartment(activeComp.id)}
        onToggleLock={() => handleToggleCompartmentLock(activeComp.id, !activeComp.locked)}
        containerLocked={!!selectedLoc.locked}
        onCardClick={setInspectorCard}
        onDeleteCard={handleDeleteCard}
        onMoveCard={handleMoveCard}
        recommendedSpot={currentRecSpot && currentRecSpot.compartment_id === activeComp.id ? {
          index: Math.floor(currentRecSpot.position / 1000) - 1,
          image_url: recCard?.image_url,
          name: recCard ? displayName(recCard) : undefined,
          set_name: recCard?.set_name,
          card: recCard
        } : null}
        focusEntryId={focusEntryId}
        targetActiveIndex={currentRecSpot && currentRecSpot.compartment_id === activeComp.id ? Math.floor(currentRecSpot.position / 1000) - 1 : null}
        canRemove={compartments.length > 1 && (cardsByCompartment.get(activeComp.id) || []).length === 0}
        selectMode={storage.selectMode}
        selectedIds={storage.selectedIds}
        onCardLongPress={storage.arm}
        onCardToggle={storage.toggleSelect}
        onEditRules={openCompartmentRules}
        placementMode={moveMode}
        pickedEntryId={pickedEntryId}
        onPickCard={handlePickCard}
        onPlaceSlot={handlePlaceSlot}
        seekTo={boxSeek}
        onActiveSlotChange={(compartmentId, slot) => setBoxCursor({ compartmentId, slot })}
      />

      <BoxMap
        compartments={compartments}
        cardsByCompartment={cardsByCompartment}
        sortOrder={selectedLoc.sort_order}
        setsList={setsList}
        activeCompartmentId={activeComp.id}
        activeSlot={boxCursor && boxCursor.compartmentId === activeComp.id ? boxCursor.slot : null}
        recommended={currentRecSpot ? { compartmentId: currentRecSpot.compartment_id, index: Math.floor(currentRecSpot.position / 1000) - 1 } : null}
        onSeek={seekBox}
      />
    </div>
  );
}
