import { X, ChevronDown, ChevronUp } from 'lucide-react';
import CardImage from '../CardImage';
import { printingLabel } from '../../utils/cardOptions';
import { displayName } from '../../utils/languages';
import { onActivateKey } from '../../utils/a11y';
import { useT } from '../../utils/i18n';

// Sort & File / re-sort review walkthrough. The queue, index and every handler
// are LocationManager's; these two only show the card under review and where
// it goes.

// Desktop guide: takes the Unsorted column's place while filing.
export function FilingGuidePanel({ filingQueue, filingIndex, filingReadOnly, setFilingMode, setFilingReadOnly, refreshAll, locateRecommendedSpot, advanceFiling, handleFilingPlaced }) {
  const { t } = useT();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: '0.85rem' }}>{t(filingReadOnly ? 'loc.refileGuide' : 'loc.filingMode')}</strong>
        <button type="button" className="btn btn-secondary btn-icon-only" onClick={() => { setFilingMode(false); setFilingReadOnly(false); refreshAll(); }} style={{ padding: '0.2rem 0.5rem', width: 'auto', fontSize: '0.7rem' }}>
          {t(filingReadOnly ? 'bulk.done' : 'common.cancel')}
        </button>
      </div>
      {filingReadOnly && (
        <div style={{ textAlign: 'center', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
          {t('loc.resortGuideHint')}
        </div>
      )}
      
      <div style={{ textAlign: 'center', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
        {t('loc.filingCardProgress', { current: filingIndex + 1, total: filingQueue.length })}
      </div>
      
      {filingQueue[filingIndex] && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.6rem' }}>
          <CardImage card={filingQueue[filingIndex].entry} style={{ width: 'min(120px, 26vh)', borderRadius: '5px', boxShadow: '0 4px 12px rgba(0,0,0,0.4)' }} />
          
          <div style={{ textAlign: 'center' }}>
            <strong style={{ fontSize: '1rem', display: 'block' }}>{displayName(filingQueue[filingIndex].entry)}</strong>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{filingQueue[filingIndex].entry.set_name} • {printingLabel(t, filingQueue[filingIndex].entry.printing, filingQueue[filingIndex].entry.game)}</span>
          </div>
          
          {(() => {
            const rec = filingQueue[filingIndex].recommended;
            if (!rec) {
              return (
                <div style={{ background: 'rgba(255, 71, 71, 0.15)', border: '1px solid #ff4747', borderRadius: 'var(--radius-sm)', padding: '0.75rem', width: '100%', textAlign: 'center' }}>
                  <strong style={{ fontSize: '0.9rem', color: 'var(--text-strong)' }}>
                    {filingQueue[filingIndex].rejected ? t('loc.rejectedRule') : t('loc.containerFull')}
                  </strong>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                    {t(filingQueue[filingIndex].rejected ? 'loc.skipRejected' : 'loc.skipNoRoom')}
                  </div>
                </div>
              );
            }
            return (
              <div 
                style={{ background: 'rgba(255, 193, 7, 0.15)', border: '1px solid #ffc107', borderRadius: 'var(--radius-sm)', padding: '0.75rem', width: '100%', textAlign: 'center', cursor: 'pointer', transition: 'all 0.2s' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 193, 7, 0.25)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 193, 7, 0.15)'; }}
                role="button"
                tabIndex={0}
                onClick={() => locateRecommendedSpot(rec)}
                onKeyDown={onActivateKey(() => locateRecommendedSpot(rec))}
                title={t('loc.snapToSlot')}
              >
                <div style={{ fontSize: '0.7rem', color: '#ffc107', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 'bold', marginBottom: '0.25rem' }}>{t('loc.clickToLocate')}</div>
                <strong style={{ fontSize: '0.9rem', color: 'var(--text-strong)', display: 'block' }}>{rec.label}</strong>
                <strong style={{ fontSize: '1.2rem', color: '#ffc107', display: 'block', marginTop: '0.25rem' }}>{t('loc.slotNumber', { n: Math.floor(rec.position / 1000) })}</strong>
                {rec.after ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', marginTop: '0.4rem' }}>
                    <CardImage card={rec.after} style={{ width: '26px', borderRadius: '3px' }} />
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{t('loc.fileAfter')} <strong style={{ color: 'var(--text-strong)' }}>{displayName(rec.after)}</strong></span>
                  </div>
                ) : rec.before ? (
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>{t('loc.fileBefore')} <strong style={{ color: 'var(--text-strong)' }}>{displayName(rec.before)}</strong></div>
                ) : (
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>{t('loc.firstInSection')}</div>
                )}
              </div>
            );
          })()}
          
          <div style={{ display: 'flex', gap: '0.5rem', width: '100%', marginTop: '0.5rem' }}>
            <button type="button" className="btn btn-secondary" onClick={advanceFiling} style={{ flex: 1, padding: '0.6rem' }}>
              {t('loc.skip')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!filingQueue[filingIndex].recommended}
              onClick={() => {
                const rec = filingQueue[filingIndex].recommended;
                handleFilingPlaced(filingQueue[filingIndex].entry.entry_id, rec.location_id, rec.compartment_id, rec.position);
              }}
              style={{ flex: 2, padding: '0.6rem', fontSize: '0.9rem', fontWeight: 'bold' }}
            >
              {filingReadOnly ? t('loc.next') : t('loc.placed')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Filing card (mobile): the container shows the blinking slot; this card
// shows what to file, where, and which physical card it goes behind, and
// carries Locate / Placed / Skip. Replaces the full desktop guide so the
// container and the guide share one screen.
export function FilingBar({ filingQueue, filingIndex, filingReadOnly, filingBarCollapsed, setFilingBarCollapsed, setFilingMode, setFilingReadOnly, refreshAll, currentRecSpot, locateRecommendedSpot, advanceFiling, handleFilingPlaced }) {
  const { t } = useT();
  return (
    <div style={{ position: 'fixed', left: 0, right: 0, bottom: 'calc(6rem + max(env(safe-area-inset-bottom, 0px), var(--sab, 0px)))', zIndex: 90, padding: '0 0.6rem' }}>
      <div className="glass-panel" style={{ padding: '0.7rem 0.8rem', display: 'flex', flexDirection: 'column', gap: '0.6rem', background: 'var(--bg-secondary)', boxShadow: '0 -6px 20px rgba(0,0,0,0.5)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, whiteSpace: 'nowrap' }}>
            {t(filingReadOnly ? 'loc.refile' : 'loc.filing')} {filingIndex + 1} / {filingQueue.length}
          </span>
          {filingBarCollapsed && (
            <span style={{ flex: 1, minWidth: 0, fontSize: '0.72rem', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {filingQueue[filingIndex].entry.name}
            </span>
          )}
          <div style={{ display: 'flex', gap: '0.3rem', flexShrink: 0 }}>
            <button type="button" className="btn btn-secondary btn-icon-only" onClick={() => setFilingBarCollapsed(c => !c)} title={t(filingBarCollapsed ? 'loc.expand' : 'loc.collapse')} style={{ width: '26px', height: '26px', padding: 0 }}>
              {filingBarCollapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
            <button type="button" className="btn btn-secondary btn-icon-only" onClick={() => { setFilingMode(false); setFilingReadOnly(false); refreshAll(); }} title={t('loc.exitFiling')} style={{ width: '26px', height: '26px', padding: 0 }}>
              <X size={13} />
            </button>
          </div>
        </div>

        {!filingBarCollapsed && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <CardImage card={filingQueue[filingIndex].entry} style={{ width: '48px', borderRadius: '4px', boxShadow: '0 2px 8px rgba(0,0,0,0.5)', flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '0.95rem', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {filingQueue[filingIndex].entry.name}
            </div>
            <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {filingQueue[filingIndex].entry.set_name} &middot; {printingLabel(t, filingQueue[filingIndex].entry.printing, filingQueue[filingIndex].entry.game)}
            </div>
          </div>
        </div>
        )}

        {currentRecSpot ? (
          <>
            <div
              role="button"
              tabIndex={0}
              onClick={() => locateRecommendedSpot(currentRecSpot)}
              onKeyDown={onActivateKey(() => locateRecommendedSpot(currentRecSpot))}
              title={t('loc.tapToSnap')}
              style={{ background: 'rgba(255,193,7,0.14)', border: '1px solid #ffc107', borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.6rem', cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem' }}>
                <span style={{ fontSize: '0.6rem', color: '#ffc107', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 }}>{t('loc.tapToLocate')}</span>
                <strong style={{ fontSize: '0.95rem', color: '#ffc107', whiteSpace: 'nowrap' }}>Slot {Math.floor(currentRecSpot.position / 1000)}</strong>
              </div>
              {!filingBarCollapsed && (<>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-strong)', fontWeight: 600, marginTop: '0.1rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {currentRecSpot.label}
              </div>
              {currentRecSpot.after ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.4rem' }}>
                  <CardImage card={currentRecSpot.after} style={{ width: '26px', borderRadius: '3px', flexShrink: 0 }} />
                  <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('loc.fileAfter')} <strong style={{ color: 'var(--text-strong)' }}>{currentRecSpot.after.name}</strong></span>
                </div>
              ) : currentRecSpot.before ? (
                <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: '0.4rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t('loc.fileBefore')} <strong style={{ color: 'var(--text-strong)' }}>{currentRecSpot.before.name}</strong></div>
              ) : (
                <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>{t('loc.firstInSection')}</div>
              )}
              </>)}
            </div>

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button type="button" className="btn btn-secondary" onClick={advanceFiling} style={{ flex: 1, padding: '0.55rem', fontSize: '0.8rem' }}>{t('loc.skip')}</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => handleFilingPlaced(filingQueue[filingIndex].entry.entry_id, currentRecSpot.location_id, currentRecSpot.compartment_id, currentRecSpot.position)}
                style={{ flex: 2, padding: '0.55rem', fontSize: '0.85rem', fontWeight: 700 }}
              >
                {filingReadOnly ? 'Next' : 'Placed'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: '0.75rem', color: 'var(--accent-red)', fontWeight: 700, textAlign: 'center' }}>
              {filingQueue[filingIndex].rejected ? "Doesn't fit this container's rule" : 'Container full'}
            </div>
            <button type="button" className="btn btn-secondary" onClick={advanceFiling} style={{ padding: '0.55rem', fontSize: '0.82rem', fontWeight: 700 }}>{t('loc.skip')}</button>
          </>
        )}
      </div>
    </div>
  );
}
