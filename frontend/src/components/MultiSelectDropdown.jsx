import { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { useT } from '../utils/i18n';

// A reusable checklist dropdown, standing in for a native <select> wherever
// a filter should allow choosing several values at once instead of one.
// `value` is always an array; an empty array means "no filter applied" (same
// meaning as '' on the single-select version it replaces).
export default function MultiSelectDropdown({ label, options, value, onChange, allLabel }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggle = (optValue) => {
    onChange(
      value.includes(optValue)
        ? value.filter(v => v !== optValue)
        : [...value, optValue]
    );
  };

  const summary = value.length === 0
    ? allLabel
    : value.length === 1
      ? (options.find(o => o.value === value[0])?.label ?? value[0])
      : t('bulk.selected', { count: value.length });

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="select-control"
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', textAlign: 'left' }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
        <ChevronDown size={14} style={{ flexShrink: 0, marginLeft: '0.4rem' }} />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 20,
            minWidth: '100%', maxHeight: '260px', overflowY: 'auto',
            background: 'var(--bg-secondary)', border: '1px solid var(--border-glass)',
            borderRadius: 'var(--radius-sm)', padding: '0.35rem', boxShadow: 'var(--shadow-glow)'
          }}
        >
          {value.length > 0 && (
            <button
              type="button"
              className="btn btn-secondary"
              style={{ width: '100%', fontSize: '0.72rem', padding: '0.3rem', marginBottom: '0.3rem' }}
              onClick={() => onChange([])}
            >
              {t('bulk.clear')}
            </button>
          )}
          {/* Native checkboxes rather than a styled div: keyboard reachable and
              announced without a roving-tabindex listbox of our own. */}
          {options.map(opt => (
            <label
              key={opt.value}
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.35rem 0.4rem', borderRadius: '5px', cursor: 'pointer', fontSize: '0.82rem' }}
            >
              <input
                type="checkbox"
                checked={value.includes(opt.value)}
                onChange={() => toggle(opt.value)}
                style={{ width: '14px', height: '14px', flexShrink: 0, cursor: 'pointer', accentColor: 'var(--accent-red)' }}
              />
              {opt.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
