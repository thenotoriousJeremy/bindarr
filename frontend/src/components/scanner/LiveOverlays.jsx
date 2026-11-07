import { memo } from 'react';
import { useT } from '../../utils/i18n';
import { useLiveValue } from './useLiveValue';
import { CROP_PAD, STEADY_DRIFT } from './scanConstants';

// The three things on the scanner that change on every detection, each
// subscribed to its own live value from useScanPipeline. They are the only
// components a detection tick renders; the JSX is what CameraScanner drew
// inline, unchanged.

// The live detection outline (see the comment where CameraScanner places it).
export const DetectOutline = memo(function DetectOutline({ store }) {
  const detectQuad = useLiveValue(store);
  if (!(detectQuad?.detected && detectQuad.quad)) return null;
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{
        position: 'absolute',
        left: `${-CROP_PAD * 100}%`,
        top: `${-CROP_PAD * 100}%`,
        width: `${(1 + 2 * CROP_PAD) * 100}%`,
        height: `${(1 + 2 * CROP_PAD) * 100}%`,
        pointerEvents: 'none',
        overflow: 'visible',
      }}
    >
      <polygon
        points={detectQuad.quad.map(p => `${p.x * 100},${p.y * 100}`).join(' ')}
        fill="rgba(74,222,128,0.15)"
        stroke="rgb(74,222,128)"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
});

// The auto-scan state pill. `onRearm` is the "Next card" tap.
export const AutoStatePill = memo(function AutoStatePill({ store, onRearm }) {
  const { t } = useT();
  const autoState = useLiveValue(store);
  if (!autoState) return null;
  return (
    <div
      role={autoState.status === 'lift' ? 'button' : undefined}
      tabIndex={autoState.status === 'lift' ? 0 : undefined}
      title={autoState.status === 'lift' ? t('scan.autoRearm') : undefined}
      aria-label={autoState.status === 'lift' ? t('scan.autoRearm') : undefined}
      onClick={autoState.status === 'lift' ? onRearm : undefined}
      onKeyDown={autoState.status === 'lift' ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); }
      } : undefined}
      style={{ position: 'absolute', top: '1rem', left: '1rem', zIndex: 20, display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.3rem 0.6rem', borderRadius: 999, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)', filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.6))', cursor: autoState.status === 'lift' ? 'pointer' : undefined }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: autoState.color, flexShrink: 0 }} />
      <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#fff', whiteSpace: 'nowrap' }}>{autoState.label}</span>
    </div>
  );
});

// Auto-capture gates and the live reading against each.
export const AutoTuningPanel = memo(function AutoTuningPanel({ store, minFill, setMinFill, minSteady, setMinSteady }) {
  const { t } = useT();
  const detectStats = useLiveValue(store);
  return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('scan.autoTuning')}</span>
      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
        {detectStats?.engine || '—'}{detectStats?.ms != null ? ` · ${detectStats.ms}ms` : ''}{detectStats?.runMs != null ? ` (run ${detectStats.runMs})` : ''}{detectStats?.armed === false ? ' · held' : ''}
      </span>
    </div>

    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem' }}>
      <span style={{ color: 'var(--text-muted)' }}>{t('scan.autoFillGate')}</span>
      <span style={{ fontWeight: 700, color: detectStats && !detectStats.none && detectStats.fill >= minFill ? 'var(--type-grass)' : 'var(--accent-red)' }}>
        {detectStats && !detectStats.none ? detectStats.fill.toFixed(2) : '—'} / {minFill.toFixed(2)}
      </span>
    </div>
    <input
      type="range" min="0.2" max="0.9" step="0.01" value={minFill}
      onChange={(e) => { const v = parseFloat(e.target.value); setMinFill(v); localStorage.setItem('scan_min_fill', String(v)); }}
      style={{ width: '100%', accentColor: 'var(--accent-red)' }}
    />

    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem' }}>
      <span style={{ color: 'var(--text-muted)' }}>{t('scan.autoSteadyGate')}</span>
      <span style={{ fontWeight: 700, color: detectStats && detectStats.steady >= minSteady ? 'var(--type-grass)' : 'var(--accent-red)' }}>
        {detectStats ? detectStats.steady : '—'} / {minSteady}
      </span>
    </div>
    <input
      type="range" min="1" max="10" step="1" value={minSteady}
      onChange={(e) => { const v = parseInt(e.target.value, 10); setMinSteady(v); localStorage.setItem('scan_min_steady', String(v)); }}
      style={{ width: '100%', accentColor: 'var(--accent-red)' }}
    />

    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: 'var(--text-muted)' }}>
      <span>{t('scan.autoDrift')}: {detectStats?.drift != null ? detectStats.drift.toFixed(3) : '—'} / {STEADY_DRIFT}</span>
      <span>{t('scan.autoCorners')}: {detectStats?.corners != null ? detectStats.corners.toFixed(3) : '—'}</span>
    </div>
                  </div>
  );
});
