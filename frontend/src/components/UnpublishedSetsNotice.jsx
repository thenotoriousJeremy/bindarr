import { useEffect, useState } from 'react';
import { useT } from '../utils/i18n';

// "TCGplayer lists N sets that TCGdex hasn't published yet" (#170), on the Browse
// view's set list. TCGplayer sells a new Pokémon release days or weeks before the
// card provider publishes it, and until then a search for its cards just comes
// back empty — this says why, and names the sets. English only: TCGplayer's
// Pokémon catalogue is the Western releases. The server reads its local TCGCSV
// copy (GET /api/sets/tcgplayer-unpublished), so this costs no provider request.
export default function UnpublishedSetsNotice({ game, lang }) {
  const { t } = useT();
  const [info, setInfo] = useState(null);

  useEffect(() => {
    setInfo(null);
    if (game !== 'pokemon' || (lang && lang !== 'en')) return undefined;
    let cancelled = false;
    fetch('/api/sets/tcgplayer-unpublished?game=pokemon')
      .then(r => (r.ok ? r.json() : null))
      .then(data => { if (!cancelled && data && data.count > 0) setInfo(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [game, lang]);

  if (!info) return null;
  return (
    <p role="status" style={{ margin: '0 0 1rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
      {t('sets.unpublished', { count: info.count, provider: info.provider || 'TCGdex' })}{' '}
      <span style={{ color: 'var(--text-muted)' }}>{info.groups.map(g => g.name).join(', ')}</span>
    </p>
  );
}
