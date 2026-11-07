import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, X, Plus } from 'lucide-react';
import { LANGUAGE_NAMES } from '../utils/languages';
import { useT } from '../utils/i18n';

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
      <div {...listeners} style={{ cursor: 'grab', display: 'flex', alignItems: 'center', touchAction: 'none' }}>
        <GripVertical size={16} color="var(--text-muted)" />
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        {children}
      </div>
    </div>
  );
}

// Stored sort keys. The dropdown name and the two direction labels are looked up
// per key ("sort.by.price", "sort.dir.price.asc"), because what a direction
// actually does differs per field and nobody should be guessing what "Asc" means
// — cheapest-first, A-Z and common-first are all "ascending".
const SORT_KEYS = ['favorite', 'name', 'price', 'set', 'number', 'printing', 'type', 'color', 'cmc', 'rarity', 'language', 'added_at', 'entry_id'];

export function SortBuilder({ value, onChange }) {
  const { t } = useT();
  const items = Array.isArray(value) ? value : [];
  
  // activationConstraint: touch needs a short press so a tap/scroll on the handle
  // isn't misread as a drag; distance covers mouse. Without it (plus touch-action:
  // none on the handle) touch drags never start on mobile.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
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
      <label style={{ fontSize: '0.75rem', fontWeight: 'bold' }}>{t('sort.title')}</label>
      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{t('sort.hint')}</span>
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
                {SORT_KEYS.map(key => <option key={key} value={key}>{t(`sort.by.${key}`)}</option>)}
              </select>
              {(() => {
                // An unknown stored key (an old container, a hand-edited rule) has
                // no per-field wording, so fall back to plain asc/desc.
                const known = SORT_KEYS.includes(item.by);
                return (
                  <select
                    className="select-control"
                    style={{ width: '130px', padding: '0.2rem' }}
                    value={item.dir}
                    onChange={(e) => updateCriteria(item.id, { dir: e.target.value })}
                  >
                    <option value="asc">{known ? t(`sort.dir.${item.by}.asc`) : t('sort.dir.asc')}</option>
                    <option value="desc">{known ? t(`sort.dir.${item.by}.desc`) : t('sort.dir.desc')}</option>
                  </select>
                );
              })()}
              <label
                title={t('sort.dividerHint')}
                style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.65rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={isDividerOn(item, idx)}
                  onChange={() => toggleDivider(item.id, idx)}
                  style={{ width: '14px', height: '14px', cursor: 'pointer' }}
                />
                {t('sort.divider')}
              </label>
              {isDividerOn(item, idx) && (
                <input 
                  type="color" 
                  value={item.dividerColor || '#6b7280'}
                  onChange={(e) => updateDividerColor(item.id, e.target.value)}
                  title={t('sort.dividerColor')}
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
        <Plus size={14} style={{ marginRight: '4px' }} /> {t('sort.addRule')}
      </button>
    </div>
  );
}

// Stored field names; labels come from "filter.field.<name>".
// Language is a per-copy field (like printing), so a container can be reserved for
// one language — "Japanese only" is the whole point of a JP binder. The filing
// engine reads rule fields generically and storage.js already stamps the entry's
// language onto the metadata it evaluates.
const FILTER_FIELDS = ['name', 'supertype', 'types', 'subtypes', 'color_identity', 'cmc', 'set_name', 'set_id', 'rarity', 'printing', 'language'];

// `value` is what gets stored and evaluated; `key` exists because '>=' cannot be
// part of a translation key.
const FILTER_OPERATORS = [
  { value: 'equals', key: 'equals' },
  { value: 'contains', key: 'contains' },
  { value: '>', key: 'gt' },
  { value: '<', key: 'lt' },
  { value: '>=', key: 'gte' },
  { value: '<=', key: 'lte' },
  { value: 'exists', key: 'exists' }
];

const KNOWN_OPTIONS = {
  supertype: ['Pokémon', 'Trainer', 'Energy', 'Basic', 'Legendary', 'Snow', 'World', 'Vanguard', 'Plane', 'Scheme', 'Phenomenon', 'Ongoing'],
  types: ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Fairy', 'Dragon', 'Colorless', 'White', 'Blue', 'Black', 'Red', 'Green', 'Multicolor', 'Artifact', 'Creature', 'Enchantment', 'Instant', 'Sorcery', 'Planeswalker', 'Land', 'Battle', 'Tribal'],
  printing: ['Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', 'Promo'],
  language: LANGUAGE_NAMES,
  rarity: ['Common', 'Uncommon', 'Rare', 'Mythic', 'Special', 'Bonus', 'Promo', 'Rare Holo', 'Rare Ultra', 'Rare Secret', 'Amazing Rare', 'Radiant Rare', 'Illustration Rare', 'Special Illustration Rare', 'Hyper Rare', 'Classic Collection'],
  color_identity: ['W', 'U', 'B', 'R', 'G', 'Colorless']
};

export function FilterBuilder({ value, onChange, setsList = [], fieldOptions = {} }) {
  const { t } = useT();
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
      <label style={{ fontSize: '0.75rem', fontWeight: 'bold' }}>{t('filter.title')}</label>
      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{t('filter.hint')}</span>

      {rules.length === 0 && (
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontStyle: 'italic', padding: '0.5rem 0' }}>
          {t('filter.noRules')}
        </div>
      )}

      {rules.map((rule) => {
        // Prefer values from the user's actual collection; fall back to the
        // hardcoded list (or the set catalog) when none are owned yet.
        let options = fieldOptions[rule.field] || [];
        if (options.length === 0) {
          options = KNOWN_OPTIONS[rule.field] || [];
          if (rule.field === 'set_name') options = setsList.map(s => s.name);
          // Magic cards carry Scryfall's bare code ("mh3"), where the sets table
          // prefixes the id ("mtg-mh3"): a rule on the prefixed one never matched.
          if (rule.field === 'set_id') options = setsList.map(s => (s.game === 'mtg' ? String(s.id).replace(/^mtg-/, '') : s.id));
        }
        
        return (
          <div key={rule.id} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap', background: 'rgba(0,0,0,0.1)', padding: '0.4rem', borderRadius: '4px', border: '1px solid var(--border-glass)' }}>
            <select
              className="select-control"
              style={{ width: '80px', padding: '0.2rem', color: rule.action === 'exclude' ? 'var(--accent-red)' : 'var(--accent-green)' }}
              value={rule.action}
              onChange={(e) => updateRule(rule.id, { action: e.target.value })}
            >
              <option value="exclude">{t('filter.exclude')}</option>
              <option value="include">{t('filter.require')}</option>
            </select>
            <select
              className="select-control"
              style={{ flex: 1, minWidth: '100px', padding: '0.2rem' }}
              value={rule.field}
              onChange={(e) => updateRule(rule.id, { field: e.target.value })}
            >
              {FILTER_FIELDS.map(f => <option key={f} value={f}>{t(`filter.field.${f}`)}</option>)}
            </select>
            <select
              className="select-control"
              style={{ width: '90px', padding: '0.2rem' }}
              value={rule.operator}
              onChange={(e) => updateRule(rule.id, { operator: e.target.value })}
            >
              {FILTER_OPERATORS.map(o => <option key={o.value} value={o.value}>{t(`filter.op.${o.key}`)}</option>)}
            </select>
            {rule.operator !== 'exists' && (
              // Equals on an enumerable field: real <select> so the choices
              // show on click. datalist only surfaced on typing (looked empty).
              // contains/numeric operators keep free text + datalist suggestions.
              options.length > 0 && rule.operator === 'equals' ? (
                <select
                  className="select-control"
                  style={{ flex: 1, minWidth: '100px', padding: '0.2rem' }}
                  value={rule.value || ''}
                  onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                >
                  <option value="">{t('filter.selectValue')}</option>
                  {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              ) : (
                <>
                  <input
                    className="input-control"
                    style={{ flex: 1, minWidth: '100px', padding: '0.2rem' }}
                    placeholder={t('filter.value')}
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
              )
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
        <Plus size={14} style={{ marginRight: '4px' }} /> {t('filter.addRule')}
      </button>
    </div>
  );
}
