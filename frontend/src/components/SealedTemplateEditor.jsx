import { useState, useEffect } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useT } from '../utils/i18n';
import SealedCatalogPicker from './SealedCatalogPicker';

// A product's "recipe": specific guaranteed cards (an alt-art promo, an
// oversized card — NOT a whole decklist, since quantity multiplies ONE
// card_id) plus sub-products (a 40-card precon deck is its own sealed item,
// opened and linked later, not 40 enumerated cards). Saved once per product
// (GET/POST /api/sealed/templates) and reused automatically by every future
// purchase of the same product.
export default function SealedTemplateEditor({ productId, productName, game, showToast }) {
  const { t } = useT();
  const [components, setComponents] = useState([]);
  const [existingId, setExistingId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cardQuery, setCardQuery] = useState('');
  const [cardSet, setCardSet] = useState('');
  const [cardResults, setCardResults] = useState([]);
  const [cardPage, setCardPage] = useState(1);
  const [cardHasMore, setCardHasMore] = useState(false);
  const [cardSearchBusy, setCardSearchBusy] = useState(false);
  const [showCardSearch, setShowCardSearch] = useState(false);
  const [showProductPicker, setShowProductPicker] = useState(false);
  // Cards-per-pack already entered on this user's other recipes, keyed by product,
  // so a repeated component (e.g. the same booster pack) starts pre-filled.
  const [knownCounts, setKnownCounts] = useState({ byId: {}, byName: {} });

  useEffect(() => {
    if (!productName) { setLoading(false); return; }
    const params = new URLSearchParams({ product_name: productName });
    if (productId) params.set('product_id', productId);
    fetch(`/api/sealed/templates/match?${params}`)
      .then(r => r.json())
      .then(d => {
        if (d.template) {
          setExistingId(d.template.id);
          setComponents(d.template.components.map(c => ({
            ...c,
            label: c.component_type === 'card' ? (c.card_id || '') : c.product_name,
          })));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [productId, productName]);

  const loadKnownCounts = () => {
    fetch('/api/sealed/templates')
      .then(r => r.json())
      .then(d => {
        const byId = {}; const byName = {};
        for (const tpl of d.templates || []) {
          for (const c of tpl.components || []) {
            if (c.component_type !== 'product' || c.expected_cards == null || c.expected_cards === '') continue;
            if (c.product_id) byId[c.product_id] = c.expected_cards;
            if (c.product_name) byName[c.product_name.toLowerCase()] = c.expected_cards;
          }
        }
        setKnownCounts({ byId, byName });
      })
      .catch(() => {});
  };
  useEffect(() => { loadKnownCounts(); }, []);

  const searchCards = async (page = 1) => {
    if (!cardQuery.trim() && !cardSet.trim()) { setCardResults([]); return; }
    setCardSearchBusy(true);
    try {
      const params = new URLSearchParams({ game: game || 'pokemon', scope: 'database', limit: '60', page: String(page) });
      if (cardQuery.trim()) params.set('name', cardQuery.trim());
      if (cardSet.trim()) params.set('set', cardSet.trim());
      const res = await fetch(`/api/search?${params}`);
      const data = await res.json().catch(() => []);
      const results = Array.isArray(data) ? data : [];
      setCardResults(current => page === 1 ? results : [...current, ...results]);
      setCardPage(page);
      setCardHasMore(results.length === 60);
    } finally {
      setCardSearchBusy(false);
    }
  };

  const addCard = (card) => {
    setComponents(c => [...c, { component_type: 'card', quantity: 1, card_id: card.id, label: card.name }]);
    setCardQuery(''); setCardSet(''); setCardResults([]); setShowCardSearch(false);
  };

  // Saved recipes first, then anything already entered in this unsaved recipe.
  const lookupCount = (product) => {
    const lowerName = String(product.name || '').toLowerCase();
    const saved = knownCounts.byId[product.product_id] ?? knownCounts.byName[lowerName];
    if (saved != null) return saved;
    const sibling = components.find(c => c.component_type === 'product' && c.expected_cards !== '' && c.expected_cards != null
      && ((product.product_id && c.product_id === product.product_id) || String(c.product_name || '').toLowerCase() === lowerName));
    return sibling ? sibling.expected_cards : '';
  };

  const addProduct = (product) => {
    setComponents(c => [...c, {
      component_type: 'product', quantity: 1,
      product_id: product.product_id || null, product_name: product.name, sealed_type: product.sealed_type || null, game,
      expected_cards: lookupCount(product),
      label: product.name,
    }]);
    setShowProductPicker(false);
  };

  const updateQuantity = (idx, qty) => setComponents(c => c.map((x, i) => i === idx ? { ...x, quantity: qty === '' ? '' : Math.max(1, parseInt(qty, 10) || 1) } : x));
  const removeComponent = (idx) => setComponents(c => c.filter((_, i) => i !== idx));

  const save = async () => {
    if (components.length === 0) { showToast?.(t('sealed.errNoComponents')); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/sealed/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: productId || null, product_name: productName, game, components: components.map(c => ({ ...c, quantity: Math.max(1, parseInt(c.quantity, 10) || 1) })) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast?.(data.error || t('sealed.errSave')); return; }
      setExistingId(data.template.id);
      showToast?.(t('sealed.recipeSaved'));
      loadKnownCounts();
    } catch {
      showToast?.(t('sealed.errSave'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;

  return (
    <div className="glass-panel" style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-strong)' }}>
        {t(existingId ? 'sealed.recipeExisting' : 'sealed.recipeDefine')}
      </div>
      <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: 0 }}>{t('sealed.recipeHint')}</p>

      {components.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          {components.map((c, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--text-strong)' }}>
              <input type="number" min="1" className="input-control" value={c.quantity} onChange={(e) => updateQuantity(i, e.target.value)} onBlur={() => c.quantity === '' && updateQuantity(i, '1')} style={{ width: '3.5rem', padding: '0.2rem' }} />
              <span style={{ flex: 1 }}>{c.label} <span style={{ color: 'var(--text-secondary)' }}>({t(c.component_type === 'card' ? 'sealed.componentCard' : 'sealed.componentProduct')})</span>
                {c.component_type === 'product' && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', marginLeft: '0.5rem' }}>
                    <label htmlFor={`expected-cards-${i}`} style={{ color: 'var(--text-secondary)', fontSize: '0.72rem' }}>{t('sealed.expectedCardsPerPack')}</label>
                    <input id={`expected-cards-${i}`} aria-label={t('sealed.expectedCardsPerPack')} type="number" min="0" className="input-control"
                      value={c.expected_cards ?? ''} onChange={e => setComponents(rows => rows.map((row, index) => index === i ? { ...row, expected_cards: e.target.value } : row))}
                      placeholder="?" style={{ width: '3.5rem', padding: '0.2rem' }} />
                  </span>
                )}
              </span>
              <button type="button" className="btn btn-secondary btn-icon-only" onClick={() => removeComponent(i)} style={{ color: 'var(--accent-red)', padding: '0.2rem' }}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowCardSearch(s => !s)}>
          <Plus size={12} /> {t('sealed.addCardComponent')}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowProductPicker(s => !s)}>
          <Plus size={12} /> {t('sealed.addProductComponent')}
        </button>
      </div>

      {showCardSearch && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <input className="input-control" value={cardQuery} onChange={(e) => setCardQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); searchCards(1); } }}
              placeholder={t('sealed.cardSearchPlaceholder')} />
            <input className="input-control" value={cardSet} onChange={(e) => setCardSet(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); searchCards(1); } }}
              placeholder={t('sealed.cardSetPlaceholder')} style={{ maxWidth: '8rem' }} />
            <button type="button" className="btn btn-secondary" disabled={cardSearchBusy} onClick={() => searchCards(1)}>{t('common.search') || 'Search'}</button>
          </div>
          {(cardResults.length > 0 || cardHasMore) && (
            <div style={{ maxHeight: 'min(40vh, 320px)', overflowY: 'auto', overscrollBehavior: 'contain', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
              {cardResults.map(card => (
                <button type="button" key={card.id} onClick={() => addCard(card)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '0.45rem 0.55rem', background: 'transparent', border: 'none', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-strong)', fontSize: '0.8rem' }}>
                  {card.name} <span style={{ color: 'var(--text-secondary)' }}>· {card.set_name}</span>
                </button>
              ))}
              {cardHasMore && (
                <button type="button" className="btn btn-secondary btn-sm" disabled={cardSearchBusy} onClick={() => searchCards(cardPage + 1)} style={{ margin: '0.4rem' }}>
                  {cardSearchBusy ? t('common.loading') : t('sealed.loadMoreCards')}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {showProductPicker && (
        <SealedCatalogPicker game={game} onGameChange={() => {}} onPick={addProduct} confirmManual />
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={save}>
          {t('sealed.saveRecipe')}
        </button>
      </div>
    </div>
  );
}
