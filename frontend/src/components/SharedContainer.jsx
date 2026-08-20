import { useState, useEffect, useMemo } from 'react';
import { ShieldAlert } from 'lucide-react';
import Logo from './Logo';
import { isBinderType, binderSpread } from '../utils/cardOptions';
import CompartmentView from './CompartmentView';
import { useT } from '../utils/i18n';

// A single shared container, drawn with the same CompartmentView the owner sees:
// a binder gets its pocket spread, a box its coverflow. Read-only — no callbacks
// are passed, so CompartmentView renders no rename, capacity or lock controls.
function SharedContainer({ shareToken, containerId }) {
  const { t } = useT();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pageIndex, setPageIndex] = useState(0);

  useEffect(() => {
    const urlTheme = new URLSearchParams(window.location.search).get('theme');
    if (urlTheme) document.documentElement.setAttribute('data-theme', urlTheme);
  }, []);

  useEffect(() => {
    const fetchContainer = async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch(`/api/shared/${shareToken}/containers/${containerId}`);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || t('shared.errLoadContainer'));
        }
        setData(await res.json());
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchContainer();
  }, [shareToken, containerId, t]);

  const cardsByCompartment = useMemo(() => {
    const byComp = new Map();
    for (const card of (data?.cards || [])) {
      if (!card.compartment_id) continue;
      if (!byComp.has(card.compartment_id)) byComp.set(card.compartment_id, []);
      byComp.get(card.compartment_id).push(card);
    }
    return byComp;
  }, [data]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '80vh' }}>
        <div className="spinner"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '80vh', padding: '1rem' }}>
        <div className="glass-panel" style={{ textAlign: 'center', maxWidth: '400px', width: '100%', padding: '2.5rem 1.5rem', border: '1px solid rgba(255, 71, 71, 0.2)' }}>
          <ShieldAlert size={48} style={{ color: 'var(--accent-red)', marginBottom: '1rem' }} />
          <h2 style={{ color: 'var(--text-strong)', fontSize: '1.25rem', marginBottom: '0.5rem' }}>{t('shared.unavailable')}</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{error}</p>
          <a href="/" style={{
            display: 'inline-block', marginTop: '1.5rem', padding: '0.5rem 1.5rem',
            backgroundColor: 'var(--accent-red)', color: 'var(--text-strong)',
            textDecoration: 'none', fontWeight: 700, borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-accent)'
          }}>
            {t('shared.goToBindarr')}
          </a>
        </div>
      </div>
    );
  }

  const { location, compartments = [], owner } = data;
  const binder = isBinderType(location.type);
  const pageProps = (compartment) => ({
    compartment,
    cards: cardsByCompartment.get(compartment.id) || [],
    allowStacking: !!location.allow_stacking,
    sortOrder: location.sort_order,
    locationType: location.type,
  });

  // Binders page through a spread at a time; a box shows one row at a time, the
  // same unit the owner's view scrolls through.
  const { leftIdx, rightIdx, spread } = binderSpread(Math.min(pageIndex, compartments.length - 1));
  const left = binder && leftIdx >= 0 ? compartments[leftIdx] : null;
  const right = binder ? compartments[rightIdx] : null;
  const activeRow = compartments[Math.min(pageIndex, compartments.length - 1)];
  const nextIndex = binder ? spread * 2 + 1 : pageIndex + 1;
  const prevIndex = binder ? (spread <= 1 ? 0 : (spread - 1) * 2 - 1) : pageIndex - 1;

  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <Logo size={34} />
        <div>
          <h1 style={{ margin: 0, fontSize: '1.2rem', color: 'var(--text-strong)' }}>{location.name}</h1>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{t('shared.sharedBy')} {owner}</span>
        </div>
      </div>

      {compartments.length === 0 ? (
        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('loc.noCompartments')}</p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '1rem', background: 'rgba(0,0,0,0.1)', padding: '0.4rem', borderRadius: 'var(--radius-sm)' }}>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={pageIndex <= 0}
              onClick={() => setPageIndex(Math.max(0, prevIndex))}
              style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
            >
              {t('loc.prev')}
            </button>
            <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
              {(binder ? (right || left) : activeRow)?.display_label}
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={nextIndex >= compartments.length}
              onClick={() => setPageIndex(nextIndex)}
              style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
            >
              {t('loc.next')}
            </button>
          </div>

          {binder ? (
            <div className="binder-page-container">
              <div className="binder-page-left">
                {left && <CompartmentView {...pageProps(left)} />}
              </div>
              <div className="binder-spine" />
              <div className="binder-page-right">
                {right && <CompartmentView {...pageProps(right)} />}
              </div>
            </div>
          ) : (
            activeRow && <CompartmentView {...pageProps(activeRow)} />
          )}
        </>
      )}
    </div>
  );
}

export default SharedContainer;
