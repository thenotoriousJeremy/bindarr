import { useState } from 'react';
import { Download } from 'lucide-react';
import { useT } from '../utils/i18n';
import { saveFile } from '../utils/saveFile';

// Download exactly the collection rows a filtered view is showing, as the same
// CSV the full export in Settings writes (POST /api/export). `entryIds` may be
// a function so the ids are read at click time, not on every render.
export default function ExportShownButton({ entryIds, showToast, style }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const ids = typeof entryIds === 'function' ? entryIds() : entryIds;
    if (!ids || ids.length === 0) { showToast && showToast(t('lists.exportNothing')); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_ids: ids }),
      });
      if (!res.ok) { showToast && showToast(t('settings.errExport')); return; }
      await saveFile(await res.blob(), 'bindarr_collection_filtered.csv');
    } catch (err) {
      console.error(err);
      showToast && showToast(t('settings.errExportGeneric'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button type="button" className="btn btn-secondary" onClick={run} disabled={busy} title={t('lists.exportShownHint')}
      style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem', ...style }}>
      <Download size={13} /> {t('lists.exportShown')}
    </button>
  );
}
