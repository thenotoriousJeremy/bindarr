import { useT } from '../../utils/i18n';
import SetTree from '../SetTree';

// Filter by set. A scan scoped to the sets in front of you is measurably
// more accurate (91% vs 81% exact printing on MTG), so this is a filter
// over the catalog, not an index to build — nothing to wait for.
// Organised as the release family, because that is how the cards
// physically arrive: ticking Foundations takes its tokens, art cards and
// promos with it, and expanding it lets you drop the parts you are not
// feeding in. Each subset is its own set code in the catalog, so an
// unexpanded parent tick genuinely could not see a token.
//
// Moved out of CameraScanner's settings panel unchanged; `settings` is
// useScanSettings().
export default function SetFilter({ settings }) {
  const { t } = useT();
  const {
    scanGame, scanSetCodes, persistSets, setInput, setSetInput, selectedSetCount, scanSets,
    onlyBuiltSets, setOnlyBuiltSets, treeSets, setScanCode, toggleCode, toggleSetFamily,
  } = settings;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
        <label htmlFor="scan-set-filter" style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
          {t('scan.filterBySet')}
        </label>
        {scanSetCodes.length > 0 && (
          <button type="button" className="btn btn-secondary" style={{ fontSize: '0.6rem', padding: '0.2rem 0.5rem' }} onClick={() => { persistSets([]); setSetInput(''); }}>
            {t('bulk.clear')}
          </button>
        )}
      </div>
      <p style={{ fontSize: '0.7rem', color: scanSetCodes.length ? 'var(--type-grass)' : 'var(--text-secondary)', margin: 0 }}>
        {scanSetCodes.length
          ? t('scan.setsFiltered', { count: selectedSetCount, codes: scanSetCodes.length })
          : t('scan.setsAllHint')}
      </p>
      <input
        id="scan-set-filter"
        type="text"
        value={setInput}
        onChange={(e) => setSetInput(e.target.value)}
        placeholder={t(scanGame === 'mtg' ? 'scan.setSearchMtg' : 'scan.setSearchPokemon')}
        style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem', background: 'rgba(255,255,255,0.06)', border: `1px solid ${scanSetCodes.length ? 'var(--type-grass)' : 'var(--border-glass)'}`, borderRadius: 'var(--radius-sm)', color: 'var(--text-strong)' }}
      />
      {/* Scoping to a set the catalog does not hold is worse than not
          scoping at all: cvScan fails open and scans everything, so the
          filter appears to work and silently did nothing. */}
      {scanSets?.local && (
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.68rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={onlyBuiltSets}
            onChange={(e) => setOnlyBuiltSets(e.target.checked)}
            style={{ accentColor: 'var(--type-grass)', flexShrink: 0 }}
          />
          {t('scan.onlyBuiltSets')}
        </label>
      )}
      {scanSets?.published && (
        <p style={{ fontSize: '0.66rem', color: 'var(--text-muted)', margin: 0 }}>{t('scan.publishedCatalogNote')}</p>
      )}
      {/* Shared with the catalog build picker and the first-run wizard:
          one implementation of "which sets?", three things done with the answer. */}
      <SetTree
        sets={treeSets}
        codeOf={setScanCode}
        selected={scanSetCodes}
        onToggleCode={toggleCode}
        onToggleFamily={toggleSetFamily}
        counts={scanSets?.sets}
        showCounts={!!scanSets?.local}
        query={setInput}
        onlyWithCounts={onlyBuiltSets && !!scanSets?.local}
      />
    </div>
  );
}
