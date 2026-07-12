import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, X, Plus } from 'lucide-react';

// Sortable item wrapper
function SortableItem({ id, children }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    background: 'rgba(255, 255, 255, 0.05)',
    padding: '0.5rem',
    borderRadius: '4px',
    marginBottom: '4px',
    border: '1px solid rgba(255, 255, 255, 0.1)'
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <div {...listeners} style={{ cursor: 'grab', display: 'flex', alignItems: 'center' }}>
        <GripVertical size={16} color="var(--text-muted)" />
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        {children}
      </div>
    </div>
  );
}

// label = dropdown name. asc/desc = what each direction actually does for that
// field, so the user isn't guessing what "Asc" means (e.g. cheapest-first vs
// A-Z vs common-first).
const SORT_OPTIONS = [
  { value: 'name', label: 'Alphabetical (Name)', asc: 'A → Z', desc: 'Z → A' },
  { value: 'price', label: 'Price / Value', asc: 'Cheapest first', desc: 'Priciest first' },
  { value: 'set', label: 'Set', asc: 'Oldest set first', desc: 'Newest set first' },
  { value: 'number', label: 'Card Number', asc: 'Low → high', desc: 'High → low' },
  { value: 'printing', label: 'Foil / Printing', asc: 'Non-foil first', desc: 'Foil first' },
  { value: 'type', label: 'Type', asc: 'Standard order', desc: 'Reversed' },
  { value: 'color', label: 'Color Identity', asc: 'W → U → B → R → G', desc: 'G → R → B → U → W' },
  { value: 'cmc', label: 'Mana Value (CMC)', asc: 'Low → high', desc: 'High → low' },
  { value: 'rarity', label: 'Rarity', asc: 'Common first', desc: 'Rarest first' },
  { value: 'language', label: 'Language', asc: 'English first', desc: 'English last' },
  { value: 'added_at', label: 'Date Added', asc: 'Oldest first', desc: 'Newest first' },
  { value: 'entry_id', label: 'Entry Order', asc: 'Oldest first', desc: 'Newest first' }
];

export function SortBuilder({ value, onChange }) {
  const items = Array.isArray(value) ? value : [];
  
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = items.findIndex((i) => i.id === active.id);
      const newIndex = items.findIndex((i) => i.id === over.id);
      onChange(arrayMove(items, oldIndex, newIndex));
    }
  };

  const addCriteria = () => {
    onChange([...items, { id: Date.now().toString(), by: 'name', dir: 'asc', divider: false }]);
  };

  const updateCriteria = (id, updates) => {
    onChange(items.map(i => i.id === id ? { ...i, ...updates } : i));
  };

  const removeCriteria = (id) => {
    onChange(items.filter(i => i.id !== id));
  };

  // Legacy rules with no flag at all default to the primary (first) rule so old containers still
  // show their dividers. Toggling a rule's checkbox now allows multiple dividers.
  const anyExplicit = items.some(i => i.divider === true || i.divider === false);
  const isDividerOn = (item, idx) => item.divider === true || (!anyExplicit && idx === 0);
  
  const toggleDivider = (id, idx) => {
    const nextState = !isDividerOn(items[idx], idx);
    onChange(items.map((i, iIdx) => {
      if (i.id === id) {
        return { ...i, divider: nextState, dividerColor: i.dividerColor || '#6b7280' };
      }
      if (!anyExplicit) {
        return { ...i, divider: iIdx === 0 && iIdx !== idx };
      }
      return i;
    }));
  };

  const updateDividerColor = (id, color) => {
    onChange(items.map(i => i.id === id ? { ...i, dividerColor: color } : i));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <label style={{ fontSize: '0.75rem', fontWeight: 'bold' }}>Sort Priority List</label>
      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Top rule applies first, falling back to subsequent rules on ties. Check Divider to group items by this field.</span>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map(i => i.id)} strategy={verticalListSortingStrategy}>
          {items.map((item, idx) => (
            <SortableItem key={item.id} id={item.id}>
              <select
                className="select-control"
                style={{ flex: 1, padding: '0.2rem' }}
                value={item.by}
                onChange={(e) => updateCriteria(item.id, { by: e.target.value })}
              >
                {SORT_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
              {(() => {
                const opt = SORT_OPTIONS.find(o => o.value === item.by) || {};
                return (
                  <select
                    className="select-control"
                    style={{ width: '130px', padding: '0.2rem' }}
                    value={item.dir}
                    onChange={(e) => updateCriteria(item.id, { dir: e.target.value })}
                  >
                    <option value="asc">{opt.asc || 'Asc'}</option>
                    <option value="desc">{opt.desc || 'Desc'}</option>
                  </select>
                );
              })()}
              <label
                title="Divide the groups on this field."
                style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.65rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={isDividerOn(item, idx)}
                  onChange={() => toggleDivider(item.id, idx)}
                  style={{ width: '14px', height: '14px', cursor: 'pointer' }}
                />
                Divider
              </label>
              {isDividerOn(item, idx) && (
                <input 
                  type="color" 
                  value={item.dividerColor || '#6b7280'}
                  onChange={(e) => updateDividerColor(item.id, e.target.value)}
                  title="Divider Color"
                  style={{ width: '24px', height: '24px', padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
                />
              )}
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: '0.2rem', minWidth: 'auto' }}
                onClick={() => removeCriteria(item.id)}
              >
                <X size={14} />
              </button>
            </SortableItem>
          ))}
        </SortableContext>
      </DndContext>
      <button type="button" className="btn btn-secondary" style={{ alignSelf: 'flex-start', padding: '0.3rem 0.6rem', fontSize: '0.7rem' }} onClick={addCriteria}>
        <Plus size={14} style={{ marginRight: '4px' }} /> Add Sort Rule
      </button>
    </div>
  );
}

const FILTER_FIELDS = [
  { value: 'name', label: 'Name' },
  { value: 'supertype', label: 'Supertype' },
  { value: 'types', label: 'Types' },
  { value: 'subtypes', label: 'Subtypes' },
  { value: 'color_identity', label: 'Color Identity' },
  { value: 'cmc', label: 'Mana Value (CMC)' },
  { value: 'set_name', label: 'Set Name' },
  { value: 'set_id', label: 'Set Code' },
  { value: 'rarity', label: 'Rarity' },
  { value: 'printing', label: 'Printing' }
];

const FILTER_OPERATORS = [
  { value: 'equals', label: 'Equals' },
  { value: 'contains', label: 'Contains' },
  { value: '>', label: 'Greater Than' },
  { value: '<', label: 'Less Than' },
  { value: '>=', label: 'Greater/Eq' },
  { value: '<=', label: 'Less/Eq' },
  { value: 'exists', label: 'Exists' }
];

const KNOWN_OPTIONS = {
  supertype: ['Pokémon', 'Trainer', 'Energy', 'Basic', 'Legendary', 'Snow', 'World', 'Vanguard', 'Plane', 'Scheme', 'Phenomenon', 'Ongoing'],
  types: ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Fairy', 'Dragon', 'Colorless', 'White', 'Blue', 'Black', 'Red', 'Green', 'Multicolor', 'Artifact', 'Creature', 'Enchantment', 'Instant', 'Sorcery', 'Planeswalker', 'Land', 'Battle', 'Tribal'],
  printing: ['Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', 'Promo'],
  rarity: ['Common', 'Uncommon', 'Rare', 'Mythic', 'Special', 'Bonus', 'Promo', 'Rare Holo', 'Rare Ultra', 'Rare Secret', 'Amazing Rare', 'Radiant Rare', 'Illustration Rare', 'Special Illustration Rare', 'Hyper Rare', 'Classic Collection'],
  color_identity: ['W', 'U', 'B', 'R', 'G', 'Colorless']
};

export function FilterBuilder({ value, onChange, setsList = [], fieldOptions = {} }) {
  const rules = Array.isArray(value) ? value : [];

  const addRule = () => {
    onChange([...rules, { id: Date.now().toString(), action: 'exclude', field: 'types', operator: 'equals', value: '' }]);
  };

  const updateRule = (id, updates) => {
    onChange(rules.map(r => r.id === id ? { ...r, ...updates } : r));
  };

  const removeRule = (id) => {
    onChange(rules.filter(r => r.id !== id));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border-glass)', paddingTop: '1rem' }}>
      <label style={{ fontSize: '0.75rem', fontWeight: 'bold' }}>Filing Rules (Allow/Deny List)</label>
      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Defines which cards are allowed in this container.</span>
      
      {rules.length === 0 && (
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontStyle: 'italic', padding: '0.5rem 0' }}>
          No rules set. Any matching game card is allowed.
        </div>
      )}

      {rules.map((rule) => {
        // Prefer values from the user's actual collection; fall back to the
        // hardcoded list (or the set catalog) when none are owned yet.
        let options = fieldOptions[rule.field] || [];
        if (options.length === 0) {
          options = KNOWN_OPTIONS[rule.field] || [];
          if (rule.field === 'set_name') options = setsList.map(s => s.name);
          if (rule.field === 'set_id') options = setsList.map(s => s.id);
        }
        
        return (
          <div key={rule.id} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap', background: 'rgba(0,0,0,0.1)', padding: '0.4rem', borderRadius: '4px', border: '1px solid var(--border-glass)' }}>
            <select
              className="select-control"
              style={{ width: '80px', padding: '0.2rem', color: rule.action === 'exclude' ? 'var(--accent-red)' : 'var(--accent-green)' }}
              value={rule.action}
              onChange={(e) => updateRule(rule.id, { action: e.target.value })}
            >
              <option value="exclude">Exclude</option>
              <option value="include">Require</option>
            </select>
            <select
              className="select-control"
              style={{ flex: 1, minWidth: '100px', padding: '0.2rem' }}
              value={rule.field}
              onChange={(e) => updateRule(rule.id, { field: e.target.value })}
            >
              {FILTER_FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            <select
              className="select-control"
              style={{ width: '90px', padding: '0.2rem' }}
              value={rule.operator}
              onChange={(e) => updateRule(rule.id, { operator: e.target.value })}
            >
              {FILTER_OPERATORS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {rule.operator !== 'exists' && (
              <>
                <input
                  className="input-control"
                  style={{ flex: 1, minWidth: '100px', padding: '0.2rem' }}
                  placeholder="Value"
                  list={`opts-${rule.id}`}
                  value={rule.value || ''}
                  onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                />
                {options.length > 0 && (
                  <datalist id={`opts-${rule.id}`}>
                    {options.map(opt => <option key={opt} value={opt} />)}
                  </datalist>
                )}
              </>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              style={{ padding: '0.2rem', minWidth: 'auto' }}
              onClick={() => removeRule(rule.id)}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
      <button type="button" className="btn btn-secondary" style={{ alignSelf: 'flex-start', padding: '0.3rem 0.6rem', fontSize: '0.7rem' }} onClick={addRule}>
        <Plus size={14} style={{ marginRight: '4px' }} /> Add Rule
      </button>
    </div>
  );
}
