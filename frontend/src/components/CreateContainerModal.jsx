import { useState } from 'react';
import { X, BookOpen, Box, Package, Award, LayoutGrid, Layers, Archive, HelpCircle, ArrowLeft, ArrowRight } from 'lucide-react';
import { SortBuilder, FilterBuilder } from './SortFilterBuilder';
import PageColumnsSelect from './PageColumnsSelect';
import { isBinderType, containerTypeKey } from '../utils/cardOptions';
import Modal from './Modal';
import { gameOptions, showGamePicker } from '../utils/games';
import { useT } from '../utils/i18n';

// Container types and their default layout. Counts kept modest; the user adjusts
// them on step 2. Mirrors defaultCompartmentPlan in
// backend/src/routes/collection.js.
//
// `type` is the value stored in the database and must stay English; its label and
// blurb are looked up under containerTypeKey(type).
const TYPE_META = [
  { type: 'Binder', icon: BookOpen, plan: { count: 10, capacity: 9 } },
  { type: 'Toploader Binder', icon: LayoutGrid, plan: { count: 8, capacity: 4 } },
  { type: 'Box', icon: Box, plan: { count: 2, capacity: 400 } },
  { type: 'Toploader Box', icon: Package, plan: { count: 1, capacity: 100 } },
  { type: 'Graded Slab Box', icon: Award, plan: { count: 1, capacity: 40 } },
  { type: 'Display Shelf / Stand', icon: Layers, plan: { count: 1, capacity: 10 } },
  { type: 'Deck Box', icon: Archive, plan: { count: 1, capacity: 60 } },
  { type: 'Tin / Case', icon: Archive, plan: { count: 1, capacity: 200 } },
  { type: 'Other', icon: HelpCircle, plan: { count: 1, capacity: 500 } },
];

// Binders hold pages, everything else holds rows. Returns the key half so the
// label, the "cards per ..." label and the summary sentence all stay one phrase
// per language instead of an English noun glued into a translated sentence.
const compartmentKind = (type) => (isBinderType(type) ? 'page' : 'row');

const STEPS = ['type', 'layout', 'sort', 'filing'];

export default function CreateContainerModal({ onClose, onCreate, setsList = [], filterFieldOptions = {} }) {
  const { t } = useT();
  const [step, setStep] = useState(0);
  const [type, setType] = useState('Binder');
  const [name, setName] = useState('');
  const [game, setGame] = useState('any');
  const [count, setCount] = useState(TYPE_META[0].plan.count);
  const [capacity, setCapacity] = useState(TYPE_META[0].plan.capacity);
  // Binder page width: '' = automatic from the capacity.
  const [columns, setColumns] = useState('');
  const [sortDraft, setSortDraft] = useState([]);
  const [filterDraft, setFilterDraft] = useState([]);
  const [submitting, setSubmitting] = useState(false);


  const pickType = (next) => {
    setType(next);
    const meta = TYPE_META.find(m => m.type === next);
    if (meta) { setCount(meta.plan.count); setCapacity(meta.plan.capacity); setColumns(''); }
  };

  const kind = compartmentKind(type);
  const typeLabel = (meta) => t(`container.type.${containerTypeKey(meta.type)}`);

  const canNext = step === 0 ? !!type : step === 1 ? name.trim().length > 0 : true;

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    const payload = {
      name: name.trim(),
      type,
      game,
      compartmentPlan: { count: Math.max(1, parseInt(count, 10) || 1), capacity: Math.max(1, parseInt(capacity, 10) || 1) },
      sort_order: sortDraft.length > 0 ? JSON.stringify(sortDraft) : 'custom',
      rule_type: filterDraft.length > 0 ? 'compound' : 'any',
      rule_config: filterDraft.length > 0 ? JSON.stringify({ rules: filterDraft }) : null,
      page_columns: isBinderType(type) && columns !== '' ? parseInt(columns, 10) : null,
    };
    await onCreate(payload);
    setSubmitting(false);
  };

  return (
    <Modal onClose={onClose} label={t('container.newTitle')} closeOnBackdrop={false}
      overlayStyle={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      className="glass-panel" style={{ width: '560px', maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Header + step indicator */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>{t('container.newTitle')}</h3>
          <button className="btn btn-secondary btn-icon-only" onClick={onClose} aria-label={t('common.close')} style={{ width: '28px', height: '28px', padding: 0 }}><X size={15} /></button>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          {STEPS.map((s, i) => (
            <div key={s} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <div style={{ height: '4px', borderRadius: '2px', background: i <= step ? 'var(--accent-red)' : 'var(--border-glass)' }} />
              <span style={{ fontSize: '0.6rem', color: i === step ? '#fff' : 'var(--text-muted)', fontWeight: i === step ? 800 : 600 }}>{i + 1}. {t(`container.step.${s}`)}</span>
            </div>
          ))}
        </div>

        {/* Step 1: Type */}
        {step === 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.6rem' }}>
            {TYPE_META.map((meta) => (
              <button
                key={meta.type}
                type="button"
                onClick={() => pickType(meta.type)}
                title={t(`container.blurb.${containerTypeKey(meta.type)}`)}
                style={{
                  textAlign: 'left', cursor: 'pointer', padding: '0.7rem', borderRadius: 'var(--radius-sm)',
                  background: type === meta.type ? 'rgba(255,71,71,0.12)' : 'rgba(0,0,0,0.2)',
                  border: `1px solid ${type === meta.type ? 'var(--accent-red)' : 'var(--border-glass)'}`,
                  color: 'inherit', display: 'flex', flexDirection: 'column', gap: '0.35rem'
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 800, fontSize: '0.8rem' }}>
                  <meta.icon size={16} /> {typeLabel(meta)}
                </span>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', lineHeight: 1.3 }}>{t(`container.blurb.${containerTypeKey(meta.type)}`)}</span>
              </button>
            ))}
          </div>
        )}

        {/* Step 2: Layout */}
        {step === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label style={{ fontSize: '0.72rem' }}>{t('container.name')}</label>
              <input className="input-control" autoFocus placeholder={t('container.namePlaceholder', { type: typeLabel(TYPE_META.find(m => m.type === type) || TYPE_META[0]) })} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            {/* With one game shown, "any game" and "that game only" file
                identically — the choice is noise. */}
            {showGamePicker() && (
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ fontSize: '0.72rem' }}>{t('container.acceptedGame')}</label>
                <select className="select-control" value={game} onChange={(e) => setGame(e.target.value)}>
                  <option value="any">{t('container.anyGame')}</option>
                  {gameOptions().map(g => <option key={g.value} value={g.value}>{t('container.gameOnly', { game: g.short })}</option>)}
                </select>
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.9rem', flexWrap: 'wrap' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ fontSize: '0.72rem' }}>{t(`container.${kind}.label`)}</label>
                <input type="number" min="1" className="input-control" value={count} onChange={(e) => setCount(e.target.value)} style={{ width: '110px' }} />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ fontSize: '0.72rem' }}>{t(`container.${kind}.perLabel`)}</label>
                <input type="number" min="1" className="input-control" value={capacity} onChange={(e) => setCapacity(e.target.value)} style={{ width: '110px' }} />
              </div>
              {isBinderType(type) && (
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label htmlFor="newContainerColumns" style={{ fontSize: '0.72rem' }}>{t('loc.pageColumns')}</label>
                  <PageColumnsSelect id="newContainerColumns" value={columns} onChange={setColumns} capacity={capacity} style={{ width: '140px' }} />
                </div>
              )}
            </div>
            <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', margin: 0 }}>
              {t(`container.${kind}.summary`, {
                count: parseInt(count, 10) || 0,
                capacity: parseInt(capacity, 10) || 0,
                total: (parseInt(count, 10) || 0) * (parseInt(capacity, 10) || 0),
              })}
            </p>
          </div>
        )}

        {/* Step 3: Sort */}
        {step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', margin: 0 }}>
              {t('container.sortHint')}
            </p>
            <SortBuilder value={sortDraft} onChange={setSortDraft} />
          </div>
        )}

        {/* Step 4: Filing rules */}
        {step === 3 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', margin: 0 }}>
              {t('container.filingHint')}
            </p>
            <FilterBuilder value={filterDraft} onChange={setFilterDraft} setsList={setsList} fieldOptions={filterFieldOptions} />
          </div>
        )}

        {/* Footer nav */}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', marginTop: '0.25rem' }}>
          <button className="btn btn-secondary" onClick={() => (step === 0 ? onClose() : setStep(step - 1))} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
            {step === 0 ? t('common.cancel') : (<><ArrowLeft size={14} /> {t('common.back')}</>)}
          </button>
          {step < STEPS.length - 1 ? (
            <button className="btn btn-primary" disabled={!canNext} onClick={() => setStep(step + 1)} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
              {t('common.next')} <ArrowRight size={14} />
            </button>
          ) : (
            <button className="btn btn-primary" disabled={submitting || !name.trim()} onClick={submit}>
              {t(submitting ? 'container.creating' : 'container.create')}
            </button>
          )}
        </div>
    </Modal>
  );
}
