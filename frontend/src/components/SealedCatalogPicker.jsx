import { useState } from 'react';
import { Search } from 'lucide-react';
import { useT } from '../utils/i18n';
import { GAMES } from '../utils/games';

// Search the TCGplayer/TCGCSV sealed-product catalog (GET /api/sealed/catalog/search)
// for the "pick from catalog" step of adding a purchase. Falls back to a free-text
// name when nothing in the catalog matches — the product map may not be built yet,
// or the product may simply not be in TCGplayer's catalogue.
export default function SealedCatalogPicker({ game, onGameChange, onPick, confirmManual = false }) {
  const { t } = useT();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState(false);
  const [manualName, setManualName] = useState('');

  const search = async () => {
    if (!query.trim()) { setResults([]); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams({ q: query.trim(), game });
      const res = await fetch(`/api/sealed/catalog/search?${params}`);
      const data = await res.json().catch(() => ({ products: [] }));
      setResults(Array.isArray(data.products) ? data.products : []);
    } finally {
      setLoading(false);
    }
  };

  if (manual) {
    return (
      <div className="form-group">
        <label>{t('sealed.productName')}</label>
        <input
          className="input-control" value={manualName}
          onChange={(e) => { setManualName(e.target.value); if (!confirmManual) onPick({ product_id: null, name: e.target.value }); }}
          onKeyDown={confirmManual ? (e) => { if (e.key === 'Enter') { e.preventDefault(); if (manualName.trim()) onPick({ product_id: null, name: manualName.trim() }); } } : undefined}
          placeholder={t('sealed.productNamePlaceholder')}
        />
        {confirmManual && (
          <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: '0.4rem', marginRight: '0.4rem' }}
            disabled={!manualName.trim()} onClick={() => onPick({ product_id: null, name: manualName.trim() })}>
            {t('common.add') || 'Add'}
          </button>
        )}
        <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: '0.4rem' }}
          onClick={() => setManual(false)}>
          {t('sealed.backToCatalog')}
        </button>
      </div>
    );
  }

  return (
    <div className="form-group">
      <label>{t('sealed.findProduct')}</label>
      <div style={{ display: 'flex', gap: '0.4rem' }}>
        <select className="select-control" value={game} onChange={(e) => onGameChange(e.target.value)} style={{ maxWidth: '140px' }}>
          {GAMES.map(g => <option key={g.value} value={g.value}>{g.short}</option>)}
        </select>
        <input
          className="input-control" value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } }}
          placeholder={t('sealed.searchPlaceholder')}
        />
        <button type="button" className="btn btn-secondary" onClick={search} disabled={loading}>
          <Search size={14} />
        </button>
      </div>
      {results.length > 0 && (
        <div className="glass-panel" style={{ marginTop: '0.5rem', maxHeight: '220px', overflowY: 'auto', padding: '0.4rem' }}>
          {results.map(p => (
            <button type="button" key={p.product_id}
              onClick={() => onPick(p)}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%',
                textAlign: 'left', padding: '0.4rem', background: 'transparent', border: 'none',
                borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer', color: 'var(--text-strong)',
              }}>
              {p.image_url && <img src={p.image_url} alt="" style={{ width: '28px', height: '38px', objectFit: 'contain' }} />}
              <span style={{ flex: 1, fontSize: '0.85rem' }}>
                {p.name}
                <span style={{ color: 'var(--text-secondary)' }}> · {p.group_name}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: '0.4rem' }}
        onClick={() => setManual(true)}>
        {t('sealed.cantFindIt')}
      </button>
    </div>
  );
}
