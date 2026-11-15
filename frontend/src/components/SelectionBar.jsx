import { useT } from '../utils/i18n';

const BAR_BUTTON = { fontSize: '0.72rem', padding: '0.3rem 0.6rem' };

// The sticky bar shown while cards are being picked (Collection, Add Cards'
// search, Browse): how many are selected, Select all and Clear, then the
// screen's own actions as children. `selectExtras` sits between Select all and
// Clear (Browse's "Select missing"); `onDone` adds the trailing Done button.
// .bulk-action-bar compacts it on a phone.
export default function SelectionBar({ count, total, onSelectAll, onClear, onDone, selectExtras, children }) {
  const { t } = useT();
  return (
    <div className="glass-panel bulk-action-bar" style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', position: 'sticky', top: '0.5rem', zIndex: 30 }}>
      <span style={{ fontWeight: 800, color: 'var(--text-strong)', fontSize: '0.85rem' }}>{t('bulk.selected', { count })}</span>
      <button type="button" className="btn btn-secondary" style={BAR_BUTTON} onClick={onSelectAll}>{t('bulk.selectAll', { count: total })}</button>
      {selectExtras}
      <button type="button" className="btn btn-secondary" style={BAR_BUTTON} onClick={onClear}>{t('bulk.clear')}</button>
      {children}
      {onDone && (
        <button type="button" className="btn btn-secondary" style={{ ...BAR_BUTTON, marginLeft: 'auto' }} onClick={onDone}>{t('bulk.done')}</button>
      )}
    </div>
  );
}

// A thin rule between groups of actions in the bar.
export function BarDivider() {
  return <div aria-hidden="true" style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />;
}
