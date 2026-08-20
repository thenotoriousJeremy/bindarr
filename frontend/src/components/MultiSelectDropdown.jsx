import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check } from 'lucide-react';

// A reusable checklist dropdown, standing in for a native <select> wherever
// a filter should allow choosing several values at once instead of one.
// `value` is always an array; an empty array means "no filter applied" (same
// meaning as '' on the single-select version it replaces).
export default function MultiSelectDropdown({ label, options, value, onChange, allLabel }) {
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
      : `${value.length} selected`;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="select-control"
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', textAlign: 'left' }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
        <ChevronDown size={14} style={{ flexShrink: 0, marginLeft: '0.4rem' }} />
      </button>

      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 20,
            minWidth: '100%', maxHeight: '260px', overflowY: 'auto',
            background: 'var(--bg-elevated, #1c1c1e)', border: '1px solid var(--border-glass)',
            borderRadius: '8px', padding: '0.35rem', boxShadow: '0 8px 24px rgba(0,0,0,0.35)'
          }}
        >
          {value.length > 0 && (
            <button
              type="button"
              className="btn btn-secondary"
              style={{ width: '100%', fontSize: '0.72rem', padding: '0.3rem', marginBottom: '0.3rem' }}
              onClick={() => onChange([])}
            >
              Clear ({value.length})
            </button>
          )}
          {options.map(opt => {
            const checked = value.includes(opt.value);
            return (
              <label
                key={opt.value}
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.35rem 0.4rem', borderRadius: '5px', cursor: 'pointer', fontSize: '0.82rem' }}
              >
                <span style={{
                  width: '16px', height: '16px', borderRadius: '4px', flexShrink: 0,
                  border: '1px solid var(--border-glass)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: checked ? 'var(--accent-red)' : 'transparent'
                }}>
                  {checked && <Check size={12} color="white" />}
                </span>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(opt.value)}
                  style={{ display: 'none' }}
                />
                {opt.label}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}