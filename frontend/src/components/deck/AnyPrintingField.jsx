// The "accept any printing" switch, in both the create and the edit form. Offered
// only for games where printings can stand in for each other (not Pokémon).
export default function AnyPrintingField({ t, checked, onChange }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', margin: 0, cursor: 'pointer', fontSize: '0.8rem', color: 'var(--text-strong)' }}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} style={{ marginTop: '2px' }} />
      <span>
        <span style={{ fontWeight: 700 }}>{t('deck.anyPrinting')}</span>
        <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>{t('deck.anyPrintingHint')}</span>
      </span>
    </label>
  );
}
