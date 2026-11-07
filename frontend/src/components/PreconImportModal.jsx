import { useState, useEffect } from 'react';
import { X, Search, ArrowLeft, PackageOpen } from 'lucide-react';
import { useBackGuard } from '../utils/useBackGuard';
import { useT } from '../utils/i18n';

// Import a preconstructed Magic deck or a Secret Lair drop, by name, from
// MTGJSON's deck lists (routes/precons.js): pick one, check what is in it, then
// add the cards to the collection (optionally filed into a container), build a
// deck from it, or both. Cards Scryfall cannot place are listed at the end rather
// than silently left out.
const MODES = ['collection', 'deck', 'both'];

export default function PreconImportModal({ onClose, showToast }) {
  const { t } = useT();
  useBackGuard(true, onClose);

  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [setCode, setSetCode] = useState('');
  const [results, setResults] = useState({ decks: [], total: 0, types: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [deck, setDeck] = useState(null);
  const [mode, setMode] = useState('collection');
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [deckName, setDeckName] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);

  // Search as you type, a moment after the typing stops.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ q, type, set: setCode, limit: '100' });
        const res = await fetch(`/api/precons?${params}`);
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) throw new Error(body.error || t('precon.errList'));
        setResults(body);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err.message || t('precon.errList'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [q, type, setCode, t]);

  // Containers that take Magic cards. A Pokémon-only binder would refuse every
  // card, so it is not offered.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/locations')
      .then(r => (r.ok ? r.json() : []))
      .then(rows => { if (!cancelled) setLocations((Array.isArray(rows) ? rows : []).filter(l => !l.game || l.game === 'any' || l.game === 'mtg')); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selected) { setDeck(null); return undefined; }
    let cancelled = false;
    setDeck(null);
    fetch(`/api/precons/deck?file=${encodeURIComponent(selected)}`)
      .then(async r => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || t('precon.errDeck'));
        return body;
      })
      .then(body => { if (!cancelled) { setDeck(body); setDeckName(body.name); setError(null); } })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [selected, t]);

  const back = () => { setSelected(null); setResult(null); setError(null); };

  const runImport = async () => {
    setImporting(true);
    try {
      const res = await fetch('/api/precons/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: selected,
          mode,
          location_id: mode !== 'deck' && locationId ? Number(locationId) : null,
          deck_name: mode !== 'collection' ? deckName : undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || t('precon.errImport'));
        if (body.unresolved) setResult({ added: 0, unplaced: 0, deck: null, unresolved: body.unresolved, failed: true });
        return;
      }
      setResult(body);
      showToast(t('precon.imported', { name: deck ? deck.name : selected }));
    } catch (err) {
      setError(err.message || t('precon.errImport'));
    } finally {
      setImporting(false);
    }
  };

  const typeLabel = (value) => (value === 'secret-lair' ? t('precon.secretLair') : value);
  const boardLabel = (board) => t(`precon.board.${board}`);
  const muted = { fontSize: '0.75rem', color: 'var(--text-muted)' };

  return (
    <div className="modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div className="glass-panel" style={{ width: '620px', maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {selected && (
            <button type="button" className="btn btn-secondary btn-icon-only" onClick={back} aria-label={t('common.back')} title={t('common.back')} style={{ width: '28px', height: '28px', padding: 0 }}>
              <ArrowLeft size={15} />
            </button>
          )}
          <h3 style={{ margin: 0, flex: 1 }}>{t('precon.title')}</h3>
          <button type="button" className="btn btn-secondary btn-icon-only" onClick={onClose} aria-label={t('common.close')} style={{ width: '28px', height: '28px', padding: 0 }}><X size={15} /></button>
        </div>

        {error && <div style={{ fontSize: '0.8rem', color: 'var(--accent-red)' }}>{error}</div>}

        {!selected && (
          <>
            <p style={{ ...muted, margin: 0 }}>{t('precon.hint')}</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1.4fr) minmax(70px, 0.6fr)', gap: '0.5rem' }}>
              <div style={{ position: 'relative' }}>
                <input type="text" className="input-control" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('precon.searchPlaceholder')}
                  aria-label={t('precon.searchPlaceholder')} style={{ width: '100%', paddingLeft: '2.2rem' }} autoFocus />
                <Search size={15} style={{ position: 'absolute', left: '0.8rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              </div>
              <select className="select-control" value={type} onChange={(e) => setType(e.target.value)} aria-label={t('precon.type')}>
                <option value="">{t('precon.allTypes')}</option>
                {(results.types || []).map(o => <option key={o.type} value={o.type}>{typeLabel(o.type)} ({o.count})</option>)}
              </select>
              <input type="text" className="input-control" value={setCode} onChange={(e) => setSetCode(e.target.value)} placeholder={t('precon.setPlaceholder')}
                aria-label={t('precon.setPlaceholder')} maxLength={8} style={{ textTransform: 'uppercase' }} />
            </div>
            <div style={muted}>{loading ? t('common.loading') : t('precon.matches', { count: results.total || 0 })}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', maxHeight: '50vh', overflowY: 'auto' }}>
              {(results.decks || []).map(d => (
                <button key={d.fileName} type="button" onClick={() => { setSelected(d.fileName); setResult(null); setError(null); }}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', textAlign: 'left', padding: '0.55rem 0.75rem', background: 'var(--surface-1)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', cursor: 'pointer' }}>
                  <PackageOpen size={16} style={{ color: 'var(--accent-yellow)', flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 700, fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                    <span style={muted}>{d.type} · {d.code}{d.releaseDate ? ` · ${d.releaseDate}` : ''}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {selected && !deck && !error && <div className="spinner"></div>}

        {selected && deck && !result && (
          <>
            <div>
              <div style={{ fontWeight: 800, color: 'var(--text-strong)' }}>{deck.name}</div>
              <div style={muted}>{deck.type} · {deck.code}{deck.releaseDate ? ` · ${deck.releaseDate}` : ''} · {t('precon.cardCount', { count: deck.copies })}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '30vh', overflowY: 'auto', fontSize: '0.8rem' }}>
              {['commander', 'mainBoard', 'sideBoard'].filter(b => (deck.boards[b] || []).length).map(b => (
                <div key={b}>
                  <div style={{ fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '0.2rem' }}>{boardLabel(b)}</div>
                  {deck.boards[b].map((c, i) => (
                    <div key={`${b}-${i}`} style={{ display: 'flex', gap: '0.4rem', color: 'var(--text-primary)' }}>
                      <span style={{ width: '1.8rem', textAlign: 'right', color: 'var(--text-muted)' }}>{c.count}</span>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                      {(c.isFoil || c.isEtched) && <span style={{ fontSize: '0.65rem', color: 'var(--accent-yellow)' }}>{t('precon.foil')}</span>}
                      <code style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{c.setCode} {c.number}</code>
                    </div>
                  ))}
                </div>
              ))}
            </div>

            <div className="sub-nav-tabs" style={{ margin: 0 }} role="radiogroup" aria-label={t('precon.modeLabel')}>
              {MODES.map(m => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} className={`sub-nav-tab ${mode === m ? 'active' : ''}`}
                  style={{ padding: '0.35rem 0.85rem', fontSize: '0.75rem' }} onClick={() => setMode(m)}>
                  {t(`precon.mode.${m}`)}
                </button>
              ))}
            </div>
            {mode !== 'deck' && (
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="precon-location">{t('precon.location')}</label>
                <select id="precon-location" className="select-control" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">{t('precon.unfiled')}</option>
                  {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
            )}
            {mode !== 'collection' && (
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="precon-deck-name">{t('precon.deckName')}</label>
                <input id="precon-deck-name" type="text" className="input-control" value={deckName} maxLength={100} onChange={(e) => setDeckName(e.target.value)} />
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={back}>{t('common.back')}</button>
              <button type="button" className="btn btn-primary" onClick={runImport} disabled={importing}>
                {importing ? t('precon.importing') : t('precon.confirm', { count: deck.copies })}
              </button>
            </div>
          </>
        )}

        {result && (
          <>
            {!result.failed && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', fontSize: '0.85rem' }}>
                {result.added > 0 && <div>{t('precon.resultAdded', { count: result.added })}</div>}
                {result.unplaced > 0 && <div style={{ color: 'var(--accent-yellow)' }}>{t('precon.resultUnplaced', { count: result.unplaced })}</div>}
                {result.deck && <div>{t('precon.resultDeck', { name: result.deck.name })}</div>}
              </div>
            )}
            {result.unresolved && result.unresolved.length > 0 && (
              <div style={{ fontSize: '0.8rem' }}>
                <div style={{ color: 'var(--accent-yellow)', marginBottom: '0.25rem' }}>{t('precon.resultUnresolved', { count: result.unresolved.length })}</div>
                <div style={{ maxHeight: '25vh', overflowY: 'auto' }}>
                  {result.unresolved.map((u, i) => (
                    <div key={i} style={{ color: 'var(--text-secondary)' }}>{u.count} {u.name} <code style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{u.set} {u.number}</code></div>
                  ))}
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={back}>{t('precon.another')}</button>
              <button type="button" className="btn btn-primary" onClick={onClose}>{t('common.close')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
