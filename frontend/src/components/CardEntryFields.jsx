import { CONDITIONS, PRINTINGS, LANGUAGES } from '../utils/cardOptions';

// Shared quantity / purchase-price / condition / printing / language inputs for
// the add-card and edit-card flows. Presentational only: the parent owns the
// state and the submit/API logic, so the same fields serve create (POST) and
// edit (PUT) callers without this component knowing which.
//   variant 'grid'    - 2-col (qty/price) + 3-col (cond/print/lang); used in the
//                       CardSearch and CardInspector modals.
//   variant 'stacked' - single column for the scanner drawer's quick-add layout.
export default function CardEntryFields({
  quantity, purchasePrice, condition, printing, language,
  onQuantity, onPurchasePrice, onCondition, onPrinting, onLanguage,
  variant = 'grid',
}) {
  const stacked = variant === 'stacked';
  const groupStyle = stacked ? { marginBottom: 0 } : undefined;

  const stepQty = (delta) => onQuantity(String(Math.max(1, (parseInt(quantity, 10) || 1) + delta)));
  const Quantity = stacked ? (
    // Scanner quick-add: quantity is the most-changed field, so give it big
    // tap targets instead of a bare number input.
    <div className="form-group quick-add-full-width" style={groupStyle}>
      <label>Quantity</label>
      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'stretch' }}>
        <button type="button" className="btn btn-secondary" onClick={() => stepQty(-1)} aria-label="Decrease quantity" style={{ padding: '0 1.1rem', fontSize: '1.3rem', flexShrink: 0 }}>&minus;</button>
        <input type="number" className="input-control" min="1" value={quantity} onChange={(e) => onQuantity(e.target.value)} required style={{ flex: 1, minWidth: 0, textAlign: 'center', fontWeight: 700 }} />
        <button type="button" className="btn btn-secondary" onClick={() => stepQty(1)} aria-label="Increase quantity" style={{ padding: '0 1.1rem', fontSize: '1.3rem', flexShrink: 0 }}>+</button>
      </div>
    </div>
  ) : (
    <div className="form-group" style={groupStyle}>
      <label>Quantity</label>
      <input type="number" className="input-control" min="1" value={quantity} onChange={(e) => onQuantity(e.target.value)} required />
    </div>
  );
  const Price = (
    <div className="form-group" style={groupStyle}>
      <label>Purchase Price ($)</label>
      <input type="number" step="0.01" className="input-control" value={purchasePrice} onChange={(e) => onPurchasePrice(e.target.value)} placeholder="0.00" />
    </div>
  );
  const Condition = (
    <div className="form-group" style={groupStyle}>
      <label>Condition</label>
      <select className="select-control" value={condition} onChange={(e) => onCondition(e.target.value)}>
        {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
    </div>
  );
  const Printing = (
    <div className="form-group" style={groupStyle}>
      <label>Printing</label>
      <select className="select-control" value={printing} onChange={(e) => onPrinting(e.target.value)}>
        {PRINTINGS.map(p => <option key={p} value={p}>{p}</option>)}
      </select>
    </div>
  );
  const Language = (
    <div className={stacked ? 'form-group quick-add-full-width' : 'form-group'} style={groupStyle}>
      <label>Language</label>
      <select className="select-control" value={language} onChange={(e) => onLanguage(e.target.value)}>
        {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
      </select>
    </div>
  );

  if (stacked) {
    // Language omitted here: scanner defaults to English and it's rarely changed
    // on a quick add. Still editable later in the card inspector.
    return (
      <div className="quick-add-fields-group">
        {Quantity}{Price}{Condition}{Printing}
      </div>
    );
  }
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem' }}>{Quantity}{Price}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem' }}>{Condition}{Printing}{Language}</div>
    </>
  );
}
