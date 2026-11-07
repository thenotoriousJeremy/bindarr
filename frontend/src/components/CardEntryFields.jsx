import { CONDITIONS, getPrintings, getLanguageNamesForGame, GRADERS, GRADES, conditionLabel, printingLabel } from '../utils/cardOptions';
import { useT } from '../utils/i18n';

// The most copies one add or edit may ask for. Mirrors the server's bound
// (backend/src/utils/requestBounds.js), which refuses anything past it.
const MAX_QUANTITY = 9999;

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
  variant = 'grid', game,
  grader = 'Raw', grade = '', certNumber = '',
  onGrader, onGrade, onCertNumber,
}) {
  const { t } = useT();
  const stacked = variant === 'stacked';
  const printings = getPrintings(game);
  const gameLanguages = getLanguageNamesForGame(game);
  const groupStyle = stacked ? { marginBottom: 0 } : undefined;
  // Grading is opt-in per caller: the scanner's quick-add has no room for it and a
  // scan cannot read a cert number off a slab anyway. Absent handlers means the
  // caller does not do grading, so the fields are simply not rendered.
  const grading = !!onGrader;
  const graded = grading && grader !== 'Raw';

  const stepQty = (delta) => onQuantity(String(Math.min(MAX_QUANTITY, Math.max(1, (parseInt(quantity, 10) || 1) + delta))));
  const Quantity = stacked ? (
    // Scanner quick-add: quantity is the most-changed field, so give it big
    // tap targets instead of a bare number input.
    <div className="form-group quick-add-full-width" style={groupStyle}>
      <label>{t('card.quantity')}</label>
      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'stretch', width: '100%', boxSizing: 'border-box' }}>
        <button type="button" className="btn btn-secondary" onClick={() => stepQty(-1)} aria-label={t('card.quantityDown')} style={{ width: '44px', height: '44px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem', fontWeight: 800, flexShrink: 0 }}>&minus;</button>
        <input type="number" className="input-control" min="1" max={MAX_QUANTITY} value={quantity} onChange={(e) => onQuantity(e.target.value)} required style={{ flex: 1, minWidth: 0, textAlign: 'center', fontWeight: 700, height: '44px' }} />
        <button type="button" className="btn btn-secondary" onClick={() => stepQty(1)} aria-label={t('card.quantityUp')} style={{ width: '44px', height: '44px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem', fontWeight: 800, flexShrink: 0 }}>+</button>
      </div>
    </div>
  ) : (
    <div className="form-group" style={groupStyle}>
      <label>{t('card.quantity')}</label>
      <input type="number" className="input-control" min="1" max={MAX_QUANTITY} value={quantity} onChange={(e) => onQuantity(e.target.value)} required />
    </div>
  );
  const Price = (
    <div className="form-group" style={groupStyle}>
      <label>{t('card.purchasePrice')}</label>
      <input type="number" step="0.01" className="input-control" value={purchasePrice} onChange={(e) => onPurchasePrice(e.target.value)} placeholder="0.00" />
    </div>
  );
  const Condition = (
    <div className="form-group" style={groupStyle}>
      <label>{t('card.condition')}</label>
      {/* A slab's grade IS its condition, assigned by the grader and not open to
          the owner's opinion — so the picker is disabled rather than hidden, which
          would leave the reader wondering where it went. The stored value is left
          untouched: cracking a slab restores whatever it said before. */}
      <select className="select-control" value={graded ? 'Near Mint' : condition} disabled={graded}
        title={graded ? t('card.conditionGradedHint') : undefined}
        onChange={(e) => onCondition(e.target.value)}>
        {CONDITIONS.map(c => <option key={c} value={c}>{conditionLabel(t, c)}</option>)}
      </select>
    </div>
  );
  const Printing = (
    <div className="form-group" style={groupStyle}>
      <label>{t('card.printing')}</label>
      <select className="select-control" value={printing} onChange={(e) => onPrinting(e.target.value)}>
        {printings.map(p => <option key={p.value} value={p.value}>{printingLabel(t, p.value, game)}</option>)}
      </select>
    </div>
  );
  const Language = (
    <div className={stacked ? 'form-group quick-add-full-width' : 'form-group'} style={groupStyle}>
      {/* The language the card was printed in — not the app's language. */}
      <label>{t('card.language')}</label>
      <select className="select-control" value={language} onChange={(e) => onLanguage(e.target.value)}>
        {gameLanguages.map(l => <option key={l} value={l}>{l}</option>)}
      </select>
    </div>
  );

  // Grader, grade and cert on one row. Grade and cert only mean anything once a
  // grader is chosen, so they stay disabled until one is — an empty cert box next
  // to grader 'Raw' invites typing a number that the backend then discards.
  const Grading = grading && (
    <div className="card-entry-fields-row-3" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '0.75rem' }}>
      <div className="form-group" style={groupStyle}>
        <label>{t('card.grader')}</label>
        <select className="select-control" value={grader} onChange={(e) => {
          const next = e.target.value;
          onGrader(next);
          // Switching back to Raw clears the grade and cert here as well as on the
          // server, so the form cannot show a grade for a card it is about to save
          // as ungraded.
          if (next === 'Raw') { onGrade(''); onCertNumber(''); }
        }}>
          {GRADERS.map(g => <option key={g} value={g}>{g === 'Raw' ? t('card.graderRaw') : g}</option>)}
        </select>
      </div>
      <div className="form-group" style={groupStyle}>
        <label>{t('card.grade')}</label>
        <select className="select-control" value={grade ?? ''} disabled={!graded} onChange={(e) => onGrade(e.target.value)}>
          <option value="">{t('card.gradeNone')}</option>
          {GRADES.map(g => <option key={g} value={g}>{g}</option>)}
        </select>
      </div>
      <div className="form-group" style={groupStyle}>
        <label>{t('card.certNumber')}</label>
        <input type="text" inputMode="numeric" className="input-control" value={certNumber ?? ''} disabled={!graded}
          onChange={(e) => onCertNumber(e.target.value)} placeholder={graded ? t('card.certPlaceholder') : ''} />
      </div>
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '0.75rem' }}>{Quantity}{Price}</div>
      <div className="card-entry-fields-row-3" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '0.75rem' }}>{Condition}{Printing}{Language}</div>
      {Grading}
    </>
  );
}
