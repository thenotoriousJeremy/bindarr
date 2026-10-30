import { useState } from 'react';
import { useT } from '../utils/i18n';
import SealedCatalogPicker from './SealedCatalogPicker';
import SealedTemplateEditor from './SealedTemplateEditor';

// Add/edit a sealed product purchase: pick (or type) the product, then store,
// date, quantity and unit price. Creating N quantity creates N individually
// trackable sealed units server-side (POST /api/sealed/purchases).
export default function SealedPurchaseForm({ initial, onSaved, onCancel, showToast }) {
  const { t } = useT();
  const editing = !!initial?.id;
  const [game, setGame] = useState(initial?.game || 'pokemon');
  const [product, setProduct] = useState(initial ? {
    product_id: initial.product_id, name: initial.product_name,
    group_name: initial.set_name, sealed_type: initial.sealed_type, image_url: initial.image_url,
  } : null);
  const [store, setStore] = useState(initial?.store || '');
  const [purchaseDate, setPurchaseDate] = useState(initial?.purchase_date || new Date().toISOString().slice(0, 10));
  const [quantity, setQuantity] = useState(initial?.quantity || 1);
  const [unitPrice, setUnitPrice] = useState(initial?.unit_price ?? '');
  const [marketValue, setMarketValue] = useState(initial?.market_value ?? '');
  const [marketValueChanged, setMarketValueChanged] = useState(false);
  const [notes, setNotes] = useState(initial?.notes || '');
  const [expectedCards, setExpectedCards] = useState(initial?.expected_cards ?? '');
  const [contentsNote, setContentsNote] = useState(initial?.contents_note || '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!editing && !product?.name) { showToast?.(t('sealed.errNoProduct')); return; }
    setBusy(true);
    try {
      const body = editing
        ? {
          store, purchase_date: purchaseDate, unit_price: parseFloat(unitPrice) || 0, quantity: parseInt(quantity, 10) || 1, notes,
          market_value: marketValue === '' ? null : parseFloat(marketValue),
          expected_cards: expectedCards === '' ? null : parseInt(expectedCards, 10),
          contents_note: contentsNote,
        }
        : {
          product_id: product.product_id || null, product_name: product.name, set_name: product.group_name,
          sealed_type: product.sealed_type, image_url: product.image_url, game,
          store, purchase_date: purchaseDate, unit_price: parseFloat(unitPrice) || 0,
          quantity: parseInt(quantity, 10) || 1, notes,
          market_value: marketValue === '' ? null : parseFloat(marketValue),
          expected_cards: expectedCards === '' ? null : parseInt(expectedCards, 10),
          contents_note: contentsNote,
        };
      if (editing && !marketValueChanged) delete body.market_value;
      const res = await fetch(editing ? `/api/sealed/purchases/${initial.id}` : '/api/sealed/purchases', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast?.(data.error || t('sealed.errSave')); return; }
      showToast?.(t(editing ? 'sealed.updated' : 'sealed.added'));
      onSaved?.(data.purchase);
    } catch {
      showToast?.(t('sealed.errSave'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass-panel" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {!editing && (
        <SealedCatalogPicker game={game} onGameChange={setGame} onPick={setProduct} />
      )}
      {editing && <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{initial.product_name}</div>}
      {!editing && product && (
        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {t('sealed.selected')}: <strong style={{ color: 'var(--text-strong)' }}>{product.name}</strong>
        </div>
      )}
      {(editing ? initial.product_name : product?.name) && (
        <SealedTemplateEditor
          productId={editing ? initial.product_id : product?.product_id}
          productName={editing ? initial.product_name : product?.name}
          game={game}
          showToast={showToast}
        />
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem' }}>
        <div className="form-group">
          <label>{t('sealed.store')}</label>
          <input className="input-control" value={store} onChange={(e) => setStore(e.target.value)} placeholder={t('sealed.storePlaceholder')} />
        </div>
        <div className="form-group">
          <label>{t('sealed.purchaseDate')}</label>
          <input type="date" className="input-control" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
        </div>
        <div className="form-group">
          <label>{t('sealed.quantity')}</label>
          <input type="number" min="1" className="input-control" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
        <div className="form-group">
          <label>{t('sealed.unitPrice')}</label>
          <input type="number" step="0.01" min="0" className="input-control" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} placeholder="0.00" />
        </div>
        <div className="form-group">
          <label>{t('sealed.marketValuePerUnit')}</label>
          <input type="number" step="0.01" min="0" className="input-control" value={marketValue}
            onChange={(e) => { setMarketValue(e.target.value); setMarketValueChanged(true); }} placeholder="0.00" />
        </div>
        <div className="form-group">
          <label>{t('sealed.expectedCards')}</label>
          <input type="number" min="0" className="input-control" value={expectedCards} onChange={(e) => setExpectedCards(e.target.value)} placeholder={t('sealed.perUnitHint')} />
        </div>
      </div>
      <div className="form-group">
        <label>{t('sealed.contentsNote')}</label>
        <input className="input-control" value={contentsNote} onChange={(e) => setContentsNote(e.target.value)} placeholder={t('sealed.contentsNotePlaceholder')} />
      </div>
      <div className="form-group">
        <label>{t('sealed.notes')}</label>
        <textarea className="input-control" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>
          {t(editing ? 'common.save' : 'sealed.addPurchase')}
        </button>
      </div>
    </div>
  );
}
