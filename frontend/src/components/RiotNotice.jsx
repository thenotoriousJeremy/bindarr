import { RIOT_NOTICE } from '../utils/riftbound';

// The notice Riot requires wherever Riftbound content is shown (see
// utils/riftbound). Small and muted, but always present on those views.
export default function RiotNotice({ style }) {
  return (
    <p className="riot-notice" style={{ fontSize: '0.68rem', color: 'var(--text-muted)', lineHeight: 1.4, margin: '0.75rem 0 0', ...style }}>
      {RIOT_NOTICE}
    </p>
  );
}
