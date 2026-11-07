import { useState, useEffect } from 'react';
import { Swords } from 'lucide-react';
import { useT } from '../utils/i18n';

// The inspector's "Used in decks": the user's decks holding this printing, and
// those holding another printing of the same card. Renders nothing when none do.
export default function UsedInDecks({ cardId }) {
  const { t } = useT();
  const [decks, setDecks] = useState([]);

  useEffect(() => {
    if (!cardId) { setDecks([]); return undefined; }
    let cancelled = false;
    fetch(`/api/cards/${encodeURIComponent(cardId)}/decks`)
      .then(r => (r.ok ? r.json() : []))
      .then(rows => { if (!cancelled) setDecks(rows); })
      .catch(() => { if (!cancelled) setDecks([]); });
    return () => { cancelled = true; };
  }, [cardId]);

  if (decks.length === 0) return null;

  return (
    <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-glass)', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: 'var(--text-muted)', fontWeight: 700, marginBottom: '0.35rem' }}>
        <Swords size={13} /> {t('lists.usedInDecks')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
        {decks.map(d => (
          <div key={d.deck_id} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
            <span style={{ color: 'var(--text-strong)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
            <span style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
              {d.exact_qty > 0 && t('lists.deckQtyExact', { count: d.exact_qty })}
              {d.exact_qty > 0 && d.other_printings_qty > 0 && ' · '}
              {d.other_printings_qty > 0 && t('lists.deckQtyOther', { count: d.other_printings_qty })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
