import { memo } from 'react';
import Modal from '../Modal';
import { getCardDisplayName } from '../../utils/langHelper';
import { useT } from '../../utils/i18n';

// The card just auto-added was scanned again: a second copy, or the same one?
// Moved out of CameraScanner unchanged and memoized.
function DupConfirmModal({
  dismissDupConfirm, dupConfirmCard, addLanguage, setDupQty, dupQty,
  resolvedDupIdRef, setDupConfirmCard, autoAddCard, showToast, setAutoScan,
}) {
  const { t } = useT();
  return (
    <Modal
      onClose={dismissDupConfirm}
      label={t('scan.sameCardAgain')}
      closeOnBackdrop={false}
      overlayClassName="modal-backdrop"
      overlayStyle={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.85)',
        backdropFilter: 'blur(5px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1100,
        padding: '1rem'
      }}
      className="glass-panel animate-fade-in scan-confirm-modal" style={{ maxWidth: '420px', width: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column', gap: '1.25rem', alignItems: 'center', textAlign: 'center', border: '1px solid var(--accent-yellow)' }}>
        <div>
          <span style={{ fontSize: '0.75rem', color: 'var(--accent-yellow)', textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 800 }}>{t('scan.sameCardAgain')}</span>
          <h3 style={{ fontSize: '1.25rem', color: 'var(--text-strong)', margin: '0.25rem 0 0.5rem 0' }}>{getCardDisplayName(dupConfirmCard.name, addLanguage(dupConfirmCard), dupConfirmCard.printed_name)}</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: 0 }}>{dupConfirmCard.set_name} • #{dupConfirmCard.number}</p>
        </div>

        <img src={dupConfirmCard.image_url} alt={getCardDisplayName(dupConfirmCard.name, addLanguage(dupConfirmCard), dupConfirmCard.printed_name)} style={{ width: '110px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: '6px', boxShadow: 'var(--shadow-glow)' }} />

        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>
          {t('scan.repeatHint')}
        </p>

        {/* Quantity stepper: number of ADDITIONAL copies to add now. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setDupQty(q => Math.max(1, q - 1))}
            style={{ width: '36px', padding: '0.35rem 0', fontSize: '1rem', fontWeight: 800 }}
          >−</button>
          <span style={{ minWidth: '2.5rem', fontSize: '1.4rem', fontWeight: 900, color: 'var(--text-strong)' }}>{dupQty}</span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setDupQty(q => Math.min(99, q + 1))}
            style={{ width: '36px', padding: '0.35rem 0', fontSize: '1rem', fontWeight: 800 }}
          >+</button>
        </div>

        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              const card = dupConfirmCard;
              const qty = dupQty;
              // Mark handled so the same card lingering in frame won't re-prompt.
              resolvedDupIdRef.current = card.id;
              setDupConfirmCard(null);
              autoAddCard(card, qty);
            }}
            style={{ width: '100%', fontSize: '0.85rem', padding: '0.55rem 0' }}
          >
            Add {dupQty} more {dupQty === 1 ? 'copy' : 'copies'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              resolvedDupIdRef.current = dupConfirmCard.id;
              setDupConfirmCard(null);
              showToast(t('scan.discardedRepeat'));
            }}
            style={{ width: '100%', fontSize: '0.8rem', padding: '0.45rem 0' }}
          >
            Discard — same card, keep scanning
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              resolvedDupIdRef.current = dupConfirmCard.id;
              setDupConfirmCard(null);
              setAutoScan(false);
              showToast(t('scan.secondPhoto'));
            }}
            style={{ width: '100%', fontSize: '0.8rem', padding: '0.45rem 0' }}
          >
            Done — that was another photo of the same card
          </button>
        </div>
    </Modal>
  );
}

export default memo(DupConfirmModal);
