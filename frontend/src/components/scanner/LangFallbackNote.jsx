import { AlertTriangle } from 'lucide-react';
import { useT } from '../../utils/i18n';

// The right card in the wrong language. Korean, Japanese and Chinese Pokémon sets
// are their own releases rather than localised editions of the English ones, so no
// localised row exists to swap to and the scan answers with the English printing —
// correct card, English art, English name. Said out loud wherever a scanned card
// is shown, because the alternative is passing that off as an English card. The
// copy itself is still filed in the language being scanned.
function LangFallbackNote({ card, style }) {
  const { t } = useT();
  if (!card || !card.langFallback) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '0.3rem', justifyContent: 'center',
      fontSize: '0.65rem', lineHeight: 1.25, color: '#ffc107', marginTop: '0.25rem',
      ...style,
    }}>
      <AlertTriangle size={11} style={{ flexShrink: 0 }} />
      <span>{t('scan.langFallbackArt', { lang: card.langFallback })}</span>
    </div>
  );
}

export default LangFallbackNote;
