import { useState } from 'react';
import { Award, Search, Plus } from 'lucide-react';
import CardImage from './CardImage';
import { useT } from '../utils/i18n';
import { formatPrice, priceText } from '../utils/formatPrice';
import { displayName } from '../utils/languages';

// Add a graded slab by the cert number printed on its label.
//
// Why this is its own flow rather than a checkbox on the normal search: the number
// on the label identifies the slab exactly, so it is the fastest and least
// error-prone way in — type eight digits and the grader tells you what the card is
// and what it scored. Nothing else in the app can do that.
//
// It stops short of picking the printing, and that is deliberate. PSA labels a card
// as year + brand + name + number ('1999 POKEMON GAME CHARIZARD-HOLO 4'), which
// names a card without identifying a printing: Base Set, Base Set 2 and several
// reprints share that name and number, and the label does not distinguish them.
// Choosing one automatically would file the wrong printing silently — right name,
// wrong set, wrong price, and nothing on screen to reveal it. So the server returns
// candidates and the collector picks, which they can do from the slab in their hand.
export default function SlabLookup({ onAddSuccess, showToast }) {
  const { t } = useT();
  const [cert, setCert] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [adding, setAdding] = useState(null);

  const lookup = async (e) => {
    e.preventDefault();
    const digits = cert.replace(/\D/g, '');
    if (!digits) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/collection/cert/${digits}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // The server's message names the actual problem — no token configured, a
        // rejected token, a cert PSA has never issued. All three need different
        // action from the user, so none of them can share one generic string.
        setError(body?.error || t('slab.errLookup'));
        return;
      }
      setResult(body);
    } catch (err) {
      console.error(err);
      setError(t('slab.errLookup'));
    } finally {
      setLoading(false);
    }
  };

  const addCandidate = async (card) => {
    if (!result) return;
    setAdding(card.id);
    try {
      const res = await fetch('/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_id: card.id,
          quantity: 1,
          // A slab's condition is the grade; the column still needs a value, and
          // this one is never shown for a graded row (see CardEntryFields).
          condition: 'Near Mint',
          printing: card.printing || 'Normal',
          language: card.language || 'English',
          game: card.game || result.game,
          grader: result.cert.grader,
          grade: result.cert.grade,
          cert_number: result.cert.cert_number,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        showToast && showToast(body?.error || t('slab.errAdd'));
        return;
      }
      showToast && showToast(t('slab.added', {
        grader: result.cert.grader,
        grade: result.cert.grade ?? '',
        name: card.name,
      }));
      onAddSuccess && onAddSuccess();
      // Cleared so the next slab starts from an empty box. The cert is cached
      // server-side, so re-entering this one costs nothing if they want it back.
      setCert('');
      setResult(null);
    } catch (err) {
      console.error(err);
      showToast && showToast(t('slab.errAdd'));
    } finally {
      setAdding(null);
    }
  };

  const c = result?.cert;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div className="glass-panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.5rem' }}>
          <Award size={20} style={{ color: 'var(--accent-yellow)' }} />
          <h2 style={{ fontSize: '1.15rem', margin: 0, color: 'var(--text-strong)' }}>{t('slab.title')}</h2>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', lineHeight: 1.5, marginBottom: '1rem' }}>
          {t('slab.blurb')}
        </p>
        <form onSubmit={lookup} style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
          <input
            type="text"
            inputMode="numeric"
            className="input-control"
            value={cert}
            onChange={(e) => setCert(e.target.value)}
            placeholder={t('slab.certPlaceholder')}
            style={{ flex: 1, minWidth: '180px' }}
          />
          <button type="submit" className="btn btn-primary" disabled={loading || !cert.trim()} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Search size={16} /> {loading ? t('slab.looking') : t('slab.lookUp')}
          </button>
        </form>
        {error && (
          <div style={{ marginTop: '0.85rem', fontSize: '0.8rem', color: 'var(--accent-red, #ff4747)', lineHeight: 1.45 }}>
            {error}
          </div>
        )}
      </div>

      {c && (
        <div className="glass-panel">
          {/* What the grader says, before any guess about which printing it is. This
              is the part that is certain, so it is shown separately from the
              candidates below, which are not. */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
            <span style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--accent-yellow)' }}>
              {c.grader}{c.grade != null ? ` ${c.grade}` : ''}
            </span>
            <span style={{ fontSize: '0.95rem', color: 'var(--text-strong)', fontWeight: 600 }}>{c.subject}</span>
            {c.grade == null && c.grade_label && (
              // 'AUTHENTIC' is a real PSA label: genuine, encapsulated, ungraded.
              // Showing the words is the only way to say that without implying a 0.
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>({c.grade_label})</span>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.5rem 1rem', fontSize: '0.75rem' }}>
            {[
              [t('slab.fieldCert'), c.cert_number],
              [t('slab.fieldYear'), c.year],
              [t('slab.fieldBrand'), c.brand],
              [t('slab.fieldCardNumber'), c.card_number],
              [t('slab.fieldVariety'), c.variety],
              [t('slab.fieldPopulation'), c.population],
            ].filter(([, v]) => v != null && v !== '').map(([label, v]) => (
              <div key={label}>
                <span style={{ color: 'var(--text-muted)' }}>{label} </span>
                <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {c && (
        <div className="glass-panel">
          <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.35rem', color: 'var(--text-strong)' }}>{t('slab.pickPrinting')}</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', lineHeight: 1.45, marginBottom: '1rem' }}>
            {t('slab.pickPrintingHint')}
          </p>
          {result.candidates?.length ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '0.9rem' }}>
              {result.candidates.map((card) => (
                <div key={card.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <CardImage card={card} alt={displayName(card)} style={{ width: '100%', borderRadius: 'var(--radius-sm)' }} loading="lazy" />
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-strong)', fontWeight: 600, lineHeight: 1.3 }}>{displayName(card)}</div>
                  <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', lineHeight: 1.3 }}>
                    {card.set_name} &middot; #{card.number}
                  </div>
                  {/* The raw price, labelled as such. It is the only price any
                      provider here publishes, and a slab is worth a multiple of it —
                      so it is shown as context for identifying the printing, not as
                      what the slab is worth. */}
                  <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                    {t('slab.rawPrice', { price: priceText(card.price_trend) })}
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={adding === card.id}
                    onClick={() => addCandidate(card)}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', fontSize: '0.72rem', padding: '0.4rem' }}
                  >
                    <Plus size={13} /> {adding === card.id ? t('slab.adding') : t('slab.thisOne')}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            // No candidates is a real outcome, not a failure: PSA grades sports
            // cards and tickets this app does not track, and a Japan-exclusive
            // printing may not be cached yet. The cert facts above still stand, so
            // say what happened rather than showing an empty grid.
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {result.game ? t('slab.noCandidates') : t('slab.unsupportedGame')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
