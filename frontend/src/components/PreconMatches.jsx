import { useState, useEffect, Suspense } from 'react';
import { PackageOpen, ChevronRight } from 'lucide-react';
import { useT } from '../utils/i18n';
import { fetchJson, isAbortError } from '../utils/request';
import { hasFeature } from '../utils/games';
import { lazyWithReload } from '../utils/lazyWithReload';

const PreconImportModal = lazyWithReload(() => import('./PreconImportModal'));

// How many decks the strip names before "See all" takes over.
const SHOWN = 4;

// Search & Add's precon results: the preconstructed products (routes/precons.js)
// whose name or set matches the search just run, above the card results, so
// someone searching "Blame Game" or set "C21" finds the whole deck as well as its
// cards. Only for games whose registry entry has the `precons` feature; renders
// nothing until a search matches something. `search` is { q, set }, or null
// before the first search.
export default function PreconMatches({ game, search, showToast, onImported }) {
  const { t } = useT();
  const [found, setFound] = useState({ decks: [], total: 0 });
  const [open, setOpen] = useState(null);
  const enabled = hasFeature(game, 'precons');

  useEffect(() => {
    setFound({ decks: [], total: 0 });
    if (!enabled || !search || (!search.q && !search.set)) return undefined;
    const controller = new AbortController();
    const params = new URLSearchParams({ q: search.q || '', set: search.set || '', limit: String(SHOWN) });
    fetchJson(`/api/precons?${params}`, { signal: controller.signal })
      .then(({ data }) => setFound({ decks: data?.decks || [], total: data?.total || 0 }))
      // The card search is what was asked for; a precon list that cannot be read
      // (MTGJSON unreachable) just leaves the strip out.
      .catch((err) => { if (!isAbortError(err)) setFound({ decks: [], total: 0 }); });
    return () => controller.abort();
  }, [enabled, search]);

  if (!enabled || (found.total === 0 && !open)) return null;

  const row = { display: 'flex', alignItems: 'center', gap: '0.5rem', textAlign: 'left', padding: '0.45rem 0.65rem', background: 'var(--surface-1)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', cursor: 'pointer', minWidth: 0 };
  return (
    <div className="glass-panel" style={{ marginBottom: '1.5rem', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      {open && (
        <Suspense fallback={null}>
          <PreconImportModal
            onClose={() => setOpen(null)}
            showToast={showToast}
            onImported={onImported}
            initialQuery={search?.q || ''}
            initialSet={search?.set || ''}
            initialFile={open.file || null}
          />
        </Suspense>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <PackageOpen size={18} style={{ color: 'var(--accent-yellow)' }} />
        <strong style={{ color: 'var(--text-strong)', fontSize: '0.9rem', flex: 1 }}>{t('search.preconMatches', { count: found.total })}</strong>
        {found.total > found.decks.length && (
          <button type="button" className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '0.3rem 0.7rem' }} onClick={() => setOpen({})}>
            {t('search.preconSeeAll', { count: found.total })}
          </button>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0.4rem' }}>
        {found.decks.map(d => (
          <button key={d.fileName} type="button" style={row} onClick={() => setOpen({ file: d.fileName })} title={t('precon.hint')}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 700, fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{d.type} · {d.code}{d.releaseDate ? ` · ${d.releaseDate.slice(0, 4)}` : ''}</span>
            </span>
            <ChevronRight size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          </button>
        ))}
      </div>
    </div>
  );
}
