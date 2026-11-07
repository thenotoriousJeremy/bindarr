import { useEffect, useState } from 'react';
import { X, RotateCcw, Trash2 } from 'lucide-react';
import CardImage from './CardImage';
import Modal from './Modal';
import { useT } from '../utils/i18n';
import { runUndo, undoResult, parseSqliteUtc, daysLeft } from '../utils/undo';

const TRASH_DAYS = 30;

// Deleted copies, one row per delete (a batch): restore it, or delete it for good.
// Batches older than 30 days are purged by the server.
export default function TrashModal({ onClose, onRestored, showToast }) {
  const { t, locale } = useT();
  const [batches, setBatches] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = async () => {
    try {
      const res = await fetch('/api/collection/trash');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error);
      setBatches(data.batches || []);
    } catch (err) {
      console.error(err);
      showToast(t('trash.errLoad'));
      setBatches([]);
    }
  };

  useEffect(() => {
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const restore = async (batch) => {
    setBusy(batch.batch_id);
    const undo = { kind: 'trash', batch: batch.batch_id };
    const result = await runUndo(undo);
    const { key, values } = undoResult(undo, result);
    showToast(t(key, values));
    setBusy(null);
    if (result.ok) onRestored && onRestored();
    load();
  };

  const remove = async (batchId, confirmMsg) => {
    if (!window.confirm(confirmMsg)) return;
    setBusy(batchId || 'all');
    try {
      const res = await fetch(batchId ? `/api/collection/trash/${encodeURIComponent(batchId)}` : '/api/collection/trash', { method: 'DELETE' });
      showToast(t(res.ok ? 'trash.deleted' : 'trash.errAction'));
    } catch (err) {
      console.error(err);
      showToast(t('trash.errAction'));
    }
    setBusy(null);
    load();
  };

  const dateText = (ts) => {
    const d = parseSqliteUtc(ts);
    return d ? d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  };

  return (
    <Modal onClose={onClose} label={t('trash.title')}
      overlayStyle={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      className="glass-panel" style={{ width: '560px', maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.9rem', background: 'var(--bg-secondary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
          <h3 style={{ margin: 0 }}>{t('trash.title')}</h3>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            {batches && batches.length > 0 && (
              <button className="btn btn-danger" style={{ fontSize: '0.75rem', padding: '0.3rem 0.7rem' }} disabled={!!busy}
                onClick={() => remove(null, t('trash.confirmEmpty'))}>
                {t('trash.emptyAll')}
              </button>
            )}
            <button className="btn btn-secondary btn-icon-only" onClick={onClose} aria-label={t('common.close')} style={{ width: '28px', height: '28px', padding: 0 }}><X size={15} /></button>
          </div>
        </div>
        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('trash.hint', { days: TRASH_DAYS })}</p>

        {batches === null && <div className="spinner" />}
        {batches && batches.length === 0 && (
          <p style={{ margin: 0, color: 'var(--text-muted)', textAlign: 'center', padding: '1.5rem 0' }}>{t('trash.empty')}</p>
        )}
        {batches && batches.map(batch => (
          <div key={batch.batch_id} style={{ border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', padding: '0.7rem', display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}>
              <strong style={{ color: 'var(--text-strong)' }}>{t('trash.batch', { count: batch.count })}</strong>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                {t('trash.deletedOn', { date: dateText(batch.deleted_at) })} · {t('trash.daysLeft', { count: daysLeft(batch.expires_at) })}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
              {batch.cards.map(card => (
                <div key={card.entry_id} title={[card.name, card.set_name, card.number].filter(Boolean).join(' · ')} style={{ width: '42px' }}>
                  <CardImage card={card} alt={card.name || card.card_id} loading="lazy" style={{ width: '42px', borderRadius: '4px', display: 'block' }} />
                </div>
              ))}
              {batch.count > batch.cards.length && (
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{t('trash.more', { count: batch.count - batch.cards.length })}</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '0.3rem 0.7rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
                disabled={!!busy} onClick={() => remove(batch.batch_id, t('trash.confirmDeleteBatch', { count: batch.count }))}>
                <Trash2 size={13} /> {t('trash.deleteForever')}
              </button>
              <button className="btn btn-primary" style={{ fontSize: '0.75rem', padding: '0.3rem 0.7rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
                disabled={!!busy} onClick={() => restore(batch)}>
                <RotateCcw size={13} /> {t('trash.restore')}
              </button>
            </div>
          </div>
        ))}
    </Modal>
  );
}
