import { useState } from 'react';
import { X, BookOpen, Box, Package, Award, LayoutGrid, Layers, Archive, HelpCircle, ArrowLeft, ArrowRight } from 'lucide-react';
import { SortBuilder, FilterBuilder } from './SortFilterBuilder';

// Container types with a friendly blurb + default layout. Counts kept modest;
// the user adjusts them on step 2. Mirrors defaultCompartmentPlan in
// backend/src/routes/collection.js.
const TYPE_META = [
  { type: 'Binder', icon: BookOpen, plan: { count: 10, capacity: 9 }, blurb: 'Pages of pockets (3x3). Flip-through storage for organized sets.' },
  { type: 'Toploader Binder', icon: LayoutGrid, plan: { count: 8, capacity: 4 }, blurb: 'Pages of toploader slots — fewer per page, for thicker protected cards.' },
  { type: 'Box', icon: Box, plan: { count: 2, capacity: 400 }, blurb: 'Long rows holding many cards. Best for bulk.' },
  { type: 'Toploader Box', icon: Package, plan: { count: 1, capacity: 100 }, blurb: 'A box of toploadered cards.' },
  { type: 'Graded Slab Box', icon: Award, plan: { count: 1, capacity: 40 }, blurb: 'Holds graded slabs.' },
  { type: 'Display Shelf / Stand', icon: Layers, plan: { count: 1, capacity: 10 }, blurb: 'Shows off a few display pieces.' },
  { type: 'Deck Box', icon: Archive, plan: { count: 1, capacity: 60 }, blurb: 'Holds a single deck.' },
  { type: 'Tin / Case', icon: Archive, plan: { count: 1, capacity: 200 }, blurb: 'General tin or case storage.' },
  { type: 'Other', icon: HelpCircle, plan: { count: 1, capacity: 500 }, blurb: 'Custom container — set your own layout.' },
];

function compartmentNoun(type, plural = true) {
  const isBinder = type === 'Binder' || type === 'Toploader Binder';
  const noun = isBinder ? 'Page' : 'Row';
  return plural ? `${noun}s` : noun;
}

const STEPS = ['Type', 'Layout', 'Sort', 'Filing'];

export default function CreateContainerModal({ onClose, onCreate, setsList = [], filterFieldOptions = {} }) {
  const [step, setStep] = useState(0);
  const [type, setType] = useState('Binder');
  const [name, setName] = useState('');
  const [game, setGame] = useState('any');
  const [count, setCount] = useState(TYPE_META[0].plan.count);
  const [capacity, setCapacity] = useState(TYPE_META[0].plan.capacity);
  const [sortDraft, setSortDraft] = useState([]);
  const [filterDraft, setFilterDraft] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  const pickType = (t) => {
    setType(t);
    const meta = TYPE_META.find(m => m.type === t);
    if (meta) { setCount(meta.plan.count); setCapacity(meta.plan.capacity); }
  };

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
    };
    await onCreate(payload);
    setSubmitting(false);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }} onClick={onClose}>
      <div className="glass-panel" style={{ width: '560px', maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }} onClick={(e) => e.stopPropagation()}>
        {/* Header + step indicator */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>New Storage Container</h3>
          <button className="btn btn-secondary btn-icon-only" onClick={onClose} style={{ width: '28px', height: '28px', padding: 0 }}><X size={15} /></button>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          {STEPS.map((s, i) => (
            <div key={s} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <div style={{ height: '4px', borderRadius: '2px', background: i <= step ? 'var(--accent-red)' : 'var(--border-glass)' }} />
              <span style={{ fontSize: '0.6rem', color: i === step ? '#fff' : 'var(--text-muted)', fontWeight: i === step ? 800 : 600 }}>{i + 1}. {s}</span>
            </div>
          ))}
        </div>

        {/* Step 1: Type */}
        {step === 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.6rem' }}>
            {TYPE_META.map(({ type: t, icon: Icon, blurb }) => (
              <button
                key={t}
                type="button"
                onClick={() => pickType(t)}
                title={blurb}
                style={{
                  textAlign: 'left', cursor: 'pointer', padding: '0.7rem', borderRadius: 'var(--radius-sm)',
                  background: type === t ? 'rgba(255,71,71,0.12)' : 'rgba(0,0,0,0.2)',
                  border: `1px solid ${type === t ? 'var(--accent-red)' : 'var(--border-glass)'}`,
                  color: 'inherit', display: 'flex', flexDirection: 'column', gap: '0.35rem'
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 800, fontSize: '0.8rem' }}>
                  <Icon size={16} /> {t}
                </span>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', lineHeight: 1.3 }}>{blurb}</span>
              </button>
            ))}
          </div>
        )}

        {/* Step 2: Layout */}
        {step === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label style={{ fontSize: '0.72rem' }}>Name</label>
              <input className="input-control" autoFocus placeholder={`e.g. My ${type}`} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label style={{ fontSize: '0.72rem' }}>Accepted game</label>
              <select className="select-control" value={game} onChange={(e) => setGame(e.target.value)}>
                <option value="any">Any game</option>
                <option value="pokemon">Pokémon only</option>
                <option value="mtg">MTG only</option>
              </select>
            </div>
            <div style={{ display: 'flex', gap: '0.9rem', flexWrap: 'wrap' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ fontSize: '0.72rem' }}>{compartmentNoun(type)}</label>
                <input type="number" min="1" className="input-control" value={count} onChange={(e) => setCount(e.target.value)} style={{ width: '110px' }} />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ fontSize: '0.72rem' }}>Cards per {compartmentNoun(type, false).toLowerCase()}</label>
                <input type="number" min="1" className="input-control" value={capacity} onChange={(e) => setCapacity(e.target.value)} style={{ width: '110px' }} />
              </div>
            </div>
            <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', margin: 0 }}>
              {count} {compartmentNoun(type).toLowerCase()} × {capacity} = up to {(parseInt(count, 10) || 0) * (parseInt(capacity, 10) || 0)} cards. You can add or resize {compartmentNoun(type).toLowerCase()} later.
            </p>
          </div>
        )}

        {/* Step 3: Sort */}
        {step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', margin: 0 }}>
              How cards order inside this container. Leave empty for manual (custom) order. Toggle the Divider box on a rule to show labeled group breaks.
            </p>
            <SortBuilder value={sortDraft} onChange={setSortDraft} />
          </div>
        )}

        {/* Step 4: Filing rules */}
        {step === 3 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', margin: 0 }}>
              Container-level filing rules — which cards this whole container accepts. You can set per-row rules later from the container view.
            </p>
            <FilterBuilder value={filterDraft} onChange={setFilterDraft} setsList={setsList} fieldOptions={filterFieldOptions} />
          </div>
        )}

        {/* Footer nav */}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', marginTop: '0.25rem' }}>
          <button className="btn btn-secondary" onClick={() => (step === 0 ? onClose() : setStep(step - 1))} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
            {step === 0 ? 'Cancel' : (<><ArrowLeft size={14} /> Back</>)}
          </button>
          {step < STEPS.length - 1 ? (
            <button className="btn btn-primary" disabled={!canNext} onClick={() => setStep(step + 1)} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
              Next <ArrowRight size={14} />
            </button>
          ) : (
            <button className="btn btn-primary" disabled={submitting || !name.trim()} onClick={submit}>
              {submitting ? 'Creating…' : 'Create Container'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
