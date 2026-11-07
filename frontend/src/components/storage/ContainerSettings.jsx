import { Plus, X } from 'lucide-react';
import { SortBuilder, FilterBuilder } from '../SortFilterBuilder';
import PageColumnsSelect from '../PageColumnsSelect';
import Modal from '../Modal';
import { useT } from '../../utils/i18n';

// The container's editors: its own settings, one row/page's filing rules, and
// the "apply this capacity to every row?" question. Drafts and the save
// handlers live in LocationManager; these only render them.

// Per-compartment filing-rule editor.
export function CompartmentRulesModal({ rulesComp, setRulesComp, isBinderType, compRuleDraft, setCompRuleDraft, setsList, filterFieldOptions, saveCompartmentRules }) {
  const { t } = useT();
  return (
    <Modal onClose={() => setRulesComp(null)} label={`${rulesComp.display_label}: Accepts`} closeOnBackdrop={false}
      overlayStyle={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      className="glass-panel" style={{ width: '480px', maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', background: 'var(--bg-secondary)' }}>
        <h3 style={{ margin: 0 }}>{rulesComp.display_label}: Accepts</h3>
        <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: 0 }}>
          Rules controlling which cards may be filed into this {isBinderType ? 'page' : 'row'}. No rules = accepts anything the container allows.
        </p>
        <FilterBuilder value={compRuleDraft} onChange={setCompRuleDraft} setsList={setsList} fieldOptions={filterFieldOptions} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button className="btn btn-secondary" onClick={() => setRulesComp(null)}>{t('common.cancel')}</button>
          <button className="btn btn-primary" onClick={saveCompartmentRules}>{t('loc.saveRules')}</button>
        </div>
    </Modal>
  );
}

export function CapacitySyncModal({ capacityUpdatePending, setCapacityUpdatePending, handleSetCapacity }) {
  const { t } = useT();
  return (
    <Modal onClose={() => setCapacityUpdatePending(null)} label={t('loc.syncCapacity')} closeOnBackdrop={false}
      overlayStyle={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      className="glass-panel" style={{ width: '400px', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem', background: 'var(--bg-secondary)' }}>
        <h3 style={{ margin: 0 }}>{t('loc.syncCapacity')}</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>
          Do you want to apply the capacity <strong>{capacityUpdatePending.capacity}</strong> to ALL compartments in this container, or just this specific one?
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
          <button className="btn btn-secondary" onClick={() => { handleSetCapacity(capacityUpdatePending.id, capacityUpdatePending.capacity, false); setCapacityUpdatePending(null); }}>{t('loc.justThisOne')}</button>
          <button className="btn btn-primary" onClick={() => { handleSetCapacity(capacityUpdatePending.id, capacityUpdatePending.capacity, true); setCapacityUpdatePending(null); }}>{t('loc.applyToAll')}</button>
        </div>
    </Modal>
  );
}

export default function ContainerSettingsModal({
  selectedLoc, isBinderType, setsList, filterFieldOptions,
  nameDraft, setNameDraft, countDraft, setCountDraft, capacityDraft, setCapacityDraft,
  columnsDraft, setColumnsDraft, stackingDraft, setStackingDraft, fixedDraft, setFixedDraft,
  sortDraft, setSortDraft, filterDraft, setFilterDraft,
  setShowRulesModal, saveContainerSettings,
}) {
  const { t } = useT();
  return (
    <Modal onClose={() => setShowRulesModal(false)} label={t('loc.containerSettings')} closeOnBackdrop={false}
      overlayStyle={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
      className="glass-panel" style={{ width: '400px', maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem', background: 'var(--bg-secondary)' }}>
        <h3 style={{ margin: 0 }}>{t('loc.containerSettings')}</h3>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
          {t('loc.containerName')}
          <input
            className="input-control"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            placeholder={selectedLoc.name}
            style={{ padding: '0.35rem 0.5rem', fontSize: '0.9rem' }}
          />
        </label>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
            {t(isBinderType ? 'loc.numberOfPages' : 'loc.numberOfRows')}
            <input
              type="number"
              min="1"
              max="500"
              className="input-control"
              value={countDraft}
              onChange={(e) => setCountDraft(e.target.value)}
              style={{ padding: '0.35rem 0.5rem', fontSize: '0.85rem' }}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
            Cards per {isBinderType ? 'page' : 'row'}
            <input
              type="number"
              min="1"
              className="input-control"
              value={capacityDraft}
              onChange={(e) => setCapacityDraft(e.target.value)}
              placeholder={t('loc.varies')}
              style={{ padding: '0.35rem 0.5rem', fontSize: '0.85rem' }}
            />
          </label>
        </div>

        {/* Binders only: a box row is a coverflow, it has no pocket grid. */}
        {isBinderType && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
            {t('loc.pageColumns')}
            <PageColumnsSelect
              value={columnsDraft}
              onChange={setColumnsDraft}
              capacity={capacityDraft}
              style={{ padding: '0.35rem 0.5rem', fontSize: '0.85rem' }}
            />
            <span style={{ color: 'var(--text-muted)', fontSize: '0.68rem', lineHeight: 1.35 }}>{t('loc.pageColumnsHint')}</span>
          </label>
        )}

        {/* Binders only: a box row shows its cards in a coverflow, where a
            shared slot has nothing to show — the pocket grid is what makes a
            stack visible. */}
        {isBinderType && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
            <input
              type="checkbox"
              id="allowStackingOpt"
              checked={stackingDraft}
              onChange={(e) => setStackingDraft(e.target.checked)}
              style={{ width: '16px', height: '16px', cursor: 'pointer', marginTop: '0.1rem', flexShrink: 0 }}
            />
            <label htmlFor="allowStackingOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--text-primary)', lineHeight: 1.35 }}>
              <strong>{t('loc.allowStacking')}</strong>
              <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                {t('loc.allowStackingHint')}
              </span>
            </label>
          </div>
        )}

        {isBinderType && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
              <input
                type="checkbox"
                id="fixedSlotsOpt"
                checked={!!fixedDraft}
                onChange={(e) => setFixedDraft(e.target.checked ? [{ set_id: '', start_slot: 1, max_number: '' }] : null)}
                style={{ width: '16px', height: '16px', cursor: 'pointer', marginTop: '0.1rem', flexShrink: 0 }}
              />
              <label htmlFor="fixedSlotsOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--text-primary)', lineHeight: 1.35 }}>
                <strong>{t('loc.fixedSlots')}</strong>
                <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                  {t('loc.fixedSlotsHint')}
                </span>
              </label>
            </div>
            {fixedDraft && (
              <>
                {fixedDraft.map((row, i) => {
                  const update = (patch) => setFixedDraft(fixedDraft.map((r, j) => (j === i ? { ...r, ...patch } : r)));
                  return (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 4.5rem 4.5rem auto', gap: '0.35rem', alignItems: 'end' }}>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', fontSize: '0.65rem', color: 'var(--text-secondary)', minWidth: 0 }}>
                        {t('loc.fixedSlotsSet')}
                        <select className="select-control" value={row.set_id} onChange={(e) => update({ set_id: e.target.value })} style={{ fontSize: '0.75rem', padding: '0.3rem' }}>
                          <option value="">—</option>
                          {/* A saved set the catalogue no longer lists still shows, rather than reading as unset. */}
                          {row.set_id && !setsList.some(s => s.id === row.set_id) && <option value={row.set_id}>{row.set_id}</option>}
                          {setsList
                            .filter(s => !selectedLoc.game || selectedLoc.game === 'any' || s.game === selectedLoc.game || s.id === row.set_id)
                            .map(s => <option key={s.id} value={s.id}>{s.name} ({s.ptcgo_code || s.id})</option>)}
                        </select>
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
                        {t('loc.fixedSlotsStart')}
                        <input type="number" min="1" className="input-control" value={row.start_slot} onChange={(e) => update({ start_slot: e.target.value })} style={{ fontSize: '0.75rem', padding: '0.3rem' }} />
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
                        {t('loc.fixedSlotsMax')}
                        <input type="number" min="1" className="input-control" value={row.max_number} placeholder={t('loc.fixedSlotsNoMax')} onChange={(e) => update({ max_number: e.target.value })} style={{ fontSize: '0.75rem', padding: '0.3rem' }} />
                      </label>
                      <button type="button" className="btn btn-secondary btn-icon-only" onClick={() => setFixedDraft(fixedDraft.filter((_, j) => j !== i))} title={t('loc.fixedSlotsRemove')} aria-label={t('loc.fixedSlotsRemove')} style={{ width: '28px', height: '28px', padding: 0 }}>
                        <X size={14} />
                      </button>
                    </div>
                  );
                })}
                <button type="button" className="btn btn-secondary" onClick={() => setFixedDraft([...fixedDraft, { set_id: '', start_slot: 1, max_number: '' }])} style={{ alignSelf: 'flex-start', fontSize: '0.72rem', padding: '0.25rem 0.5rem' }}>
                  <Plus size={12} /> {t('loc.fixedSlotsAdd')}
                </button>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.68rem', lineHeight: 1.35 }}>{t('loc.fixedSlotsOverflow')}</span>
              </>
            )}
          </div>
        )}

        <div style={{ background: 'var(--surface-1)', borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.55rem', fontSize: '0.72rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {/* Label only — the count sits in the value beside it, so this is
              not loc.cardsCurrentlyStored, whose sentence carries a {count}
              this row has nowhere to put. */}
          <span style={{ color: 'var(--text-muted)' }}>{t(selectedLoc.allow_stacking ? 'loc.slotsUsedLabel' : 'loc.cardsStoredLabel')}</span>
          <strong style={{ fontSize: '0.9rem', color: 'var(--text-strong)' }}>{selectedLoc.total_cards || 0} / {selectedLoc.total_capacity || 0}</strong>
        </div>

        <div style={{ background: 'rgba(255, 170, 0, 0.1)', border: '1px solid #d97706', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-sm)', fontSize: '0.72rem', color: 'var(--text-primary)', lineHeight: 1.4 }}>
          <strong>{t('loc.reorganizeWarningTitle')}</strong>
          <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem' }}>
            <li>{t('loc.ruleNoteResort', { containerType: isBinderType ? t('loc.binderLower') : t('loc.boxLower') })}</li>
            <li>{t('loc.ruleNoteFilter')}</li>
            <li>{t('loc.ruleNoteCustom')}</li>
            <li>{t('loc.ruleNoteShrink', { unitType: isBinderType ? t('loc.pageLower') : t('loc.rowLower') })}</li>
          </ul>
        </div>

        <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
          {t('loc.sortHint')}
        </span>
        <SortBuilder value={sortDraft} onChange={setSortDraft} />
        <FilterBuilder value={filterDraft} onChange={setFilterDraft} setsList={setsList} fieldOptions={filterFieldOptions} />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
          <button className="btn btn-secondary" onClick={() => setShowRulesModal(false)}>{t('common.cancel')}</button>
          <button className="btn btn-primary" onClick={saveContainerSettings}>{t('admin.saveSettings')}</button>
        </div>
    </Modal>
  );
}
