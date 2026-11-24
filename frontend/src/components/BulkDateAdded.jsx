import { useState } from 'react';
import { useT } from '../utils/i18n';
import { addedAtFromInput, localInputValue } from '../utils/addedAt';

// One "date added" for every selected copy, in the collection's bulk bar: a
// collection entered long after the cards were bought, or an import that stamped
// every row with the day it ran. The field is the reader's own clock; the server
// takes the instant (POST /api/collection/bulk, action 'added_at'). `onApply`
// is the bar's runBulk, which clears the selection and reports the result.
export default function BulkDateAdded({ onApply, disabled }) {
  const { t } = useT();
  const [value, setValue] = useState('');
  const instant = addedAtFromInput(value);

  // The date stays in the field afterwards, for the next selection it belongs to.
  const apply = () => { if (instant) onApply('added_at', instant); };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
      <label htmlFor="bulk-date-added" style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{t('bulk.dateAdded')}</label>
      <input
        id="bulk-date-added"
        type="datetime-local" className="input-control"
        value={value} max={localInputValue(new Date())} disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        style={{ width: 'auto', fontSize: '0.72rem', padding: '0.3rem 0.4rem' }}
      />
      <button type="button" className="btn btn-primary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={disabled || !instant} onClick={apply}>
        {t('bulk.applyDateAdded')}
      </button>
    </div>
  );
}
