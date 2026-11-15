// The gallery/list switch: icon buttons in one themed frame. Each button names
// itself (aria-label, title) and says whether it is the current view
// (aria-pressed). The frame follows the theme's surface colour rather than a
// fixed dark tint, which read as a smudge in the light theme.
//
//   <ViewToggle value={viewMode} onChange={setViewMode} options={[
//     { value: 'gallery', label: t('collection.galleryView'), icon: LayoutGrid },
//     { value: 'list', label: t('collection.listView'), icon: List },
//   ]} />
export default function ViewToggle({ value, onChange, options, iconSize = 14 }) {
  return (
    <div style={{ display: 'flex', background: 'var(--surface-2)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
      {options.map(({ value: option, label, icon: Icon }) => (
        <button
          key={option}
          type="button"
          className={`btn btn-icon-only ${value === option ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => onChange(option)}
          style={{ borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.5rem', width: '32px', height: '32px' }}
          title={label}
          aria-label={label}
          aria-pressed={value === option}
        >
          <Icon size={iconSize} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
