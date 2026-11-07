import { useState, useEffect } from 'react';
import { ListChecks, PackagePlus, X } from 'lucide-react';
import { useBackGuard } from '../utils/useBackGuard';
import { useT } from '../utils/i18n';

// Two deck-level actions that live beside the deck builder rather than in it:
// "what's missing" (build or refresh the deck's missing list) and "add this deck
// to my collection" (a bought precon, optionally straight into a container).
export default function DeckListActions({ deck, showToast, onCollectionChanged }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [collectOpen, setCollectOpen] = useState(false);
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('');

  useBackGuard(collectOpen, () => setCollectOpen(false));

  useEffect(() => {
    if (!collectOpen) return;
    fetch('/api/locations').then(r => (r.ok ? r.json() : [])).then(setLocations).catch(() => {});
  }, [collectOpen]);

  const buildMissing = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/decks/${deck.id}/missing-list`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast(data.error || t('lists.errMissing')); return; }
      showToast(data.copies > 0
        ? t('lists.missingBuilt', { count: data.copies })
        : t('lists.missingNone'));
    } catch (err) {
      console.error(err);
      showToast(t('lists.errMissing'));
    } finally {
      setBusy(false);
    }
  };

  const collect = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/decks/${deck.id}/add-to-collection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId ? parseInt(locationId, 10) : null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast(data.error || t('lists.errCollect')); return; }
      showToast(t('lists.collected', { count: data.copies }));
      setCollectOpen(false);
      onCollectionChanged && onCollectionChanged();
    } catch (err) {
      console.error(err);
      showToast(t('lists.errCollect'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className="btn btn-secondary" onClick={buildMissing} disabled={busy} title={t('lists.missingHint')}
        style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
        <ListChecks size={14} /> {t('lists.missingAction')}
      </button>
      <button className="btn btn-secondary" onClick={() => setCollectOpen(true)} disabled={busy} title={t('lists.collectHint')}
        style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
        <PackagePlus size={14} /> {t('lists.collectAction')}
      </button>

      {collectOpen && (
        <div className="modal-overlay" style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'rgba(0,0,0,0.7)' }} onClick={() => setCollectOpen(false)}>
          <div className="glass-panel" style={{ width: '420px', maxWidth: '100%', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>{t('lists.collectTitle', { name: deck.name })}</h3>
              <button className="btn btn-secondary btn-icon-only" onClick={() => setCollectOpen(false)} aria-label={t('common.close')}><X size={15} /></button>
            </div>
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('lists.collectBody')}</p>
            <label className="form-group" style={{ margin: 0 }}>
              {t('inspector.storageContainer')}
              <select className="select-control" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">{t('bulk.unassignedPile')}</option>
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button className="btn btn-secondary" onClick={() => setCollectOpen(false)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" onClick={collect} disabled={busy}>{t('lists.collectConfirm')}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
