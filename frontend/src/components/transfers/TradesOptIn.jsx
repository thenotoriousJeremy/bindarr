import { ArrowLeftRight } from 'lucide-react';
import { useT } from '../../utils/i18n';

// Shown in the Trades area while the member has not opted in to trading with
// other members (Settings carries the same switch): what turning it on does,
// and the button that does it.
export default function TradesOptIn({ onEnable, busy = false }) {
  const { t } = useT();
  return (
    <section
      className="glass-panel"
      aria-labelledby="trades-opt-in-title"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', padding: '0.85rem 1rem', borderColor: 'var(--accent-blue)' }}
    >
      <div style={{ display: 'flex', gap: '0.65rem', alignItems: 'flex-start', minWidth: 0, flex: '1 1 260px' }}>
        <ArrowLeftRight size={18} aria-hidden="true" style={{ color: 'var(--accent-blue)', flexShrink: 0, marginTop: '0.15rem' }} />
        <div>
          <strong id="trades-opt-in-title" style={{ color: 'var(--text-strong)' }}>{t('transfer.optInTitle')}</strong>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0.25rem 0 0' }}>{t('transfer.optInBody')}</p>
        </div>
      </div>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={onEnable}>
        {t('transfer.optInEnable')}
      </button>
    </section>
  );
}
