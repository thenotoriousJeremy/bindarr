import { useState, useEffect, useSyncExternalStore } from 'react';
import { Camera, Download, Trash2, Check } from 'lucide-react';
import { subscribe, getSnapshot } from '../device/scanAssets';
import { downloadScanData, removeScanData, productMapStatus } from '../device/runtime';
import { GAMES } from '../utils/games';
import { useT } from '../utils/i18n';

// Scan data on the phone, for device mode: download, progress, remove.
//
// gate: the Scan tab. Once any game's data is on the phone it renders its children
// (the scanner) and stays out of the way; before that it is the offer to download.
// Otherwise it is the management panel in Settings → This Device.
//
// Nothing downloads until the owner presses the button: the models are AGPL-3.0
// and Bindarr is MIT, the same reason a server fetches them by hand.
const mb = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;
const label = (game) => (GAMES.find(g => g.value === game) || { label: game }).label;

function DeviceScanSetup({ gate = false, children = null, showToast }) {
  const { t } = useT();
  const state = useSyncExternalStore(subscribe, getSnapshot);
  const [productMap, setProductMap] = useState(null);

  const pokemonReady = !!state?.catalogs.find(c => c.game === 'pokemon' && c.present);
  // The Pokémon catalog names its matches through the product map, which builds in
  // the background after the download; say so while it does.
  useEffect(() => {
    if (!pokemonReady) return undefined;
    let cancelled = false;
    let timer = null;
    const poll = async () => {
      const s = await productMapStatus().catch(() => null);
      if (cancelled) return;
      setProductMap(s);
      if (s && s.progress) timer = setTimeout(poll, 3000);
    };
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pokemonReady, state?.busy]);

  if (!state) {
    return <div className="spinner" style={{ margin: '2rem auto' }} aria-label={t('common.loading')} />;
  }
  const anyReady = state.modelsReady && state.catalogs.some(c => c.present);
  if (gate && anyReady) return children;

  const missingModels = state.models.filter(m => !m.present).reduce((n, m) => n + m.bytes, 0);

  const download = async (game) => {
    try {
      await downloadScanData(game);
    } catch (err) {
      showToast?.(t('deviceScan.errDownload', { error: err.message || String(err) }));
    }
  };
  const remove = async (game) => {
    if (!window.confirm(t('deviceScan.confirmRemove', { game: label(game) }))) return;
    await removeScanData(game).catch(err => showToast?.(err.message));
  };

  const busyName = state.busy && state.busy.name;
  const percent = state.busy && state.busy.fraction != null ? Math.round(state.busy.fraction * 100) : null;

  return (
    <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', minWidth: 0, ...(gate ? { maxWidth: '520px', margin: '1rem auto', padding: '1.5rem' } : {}) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Camera size={gate ? 24 : 20} style={{ color: 'var(--accent-yellow)' }} />
        <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem', margin: 0 }}>{t('deviceScan.title')}</h3>
      </div>
      <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.85rem', lineHeight: 1.5 }}>{t('deviceScan.intro')}</p>

      {state.catalogs.map(c => {
        const ready = c.present && state.modelsReady;
        const size = c.bytes + missingModels;
        return (
          <div key={c.game} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', borderTop: '1px solid var(--border-glass)', paddingTop: '0.75rem' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: 'var(--text-strong)', fontWeight: 600, fontSize: '0.9rem' }}>{label(c.game)}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>{t('deviceScan.snapshot', { date: c.snapshot })}</div>
            </div>
            {ready ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', color: 'var(--accent-yellow)', fontSize: '0.8rem' }}>
                  <Check size={14} /> {t('deviceScan.ready')}
                </span>
                {!gate && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => remove(c.game)} disabled={!!busyName}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem' }}>
                    <Trash2 size={12} /> {t('deviceScan.remove')}
                  </button>
                )}
              </div>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => download(c.game)} disabled={!!busyName}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem' }}>
                <Download size={14} /> {t('deviceScan.download', { size: mb(size) })}
              </button>
            )}
          </div>
        );
      })}

      {busyName && (
        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {t('deviceScan.downloading', { file: busyName, percent: percent == null ? '…' : `${percent}%` })}
          {percent != null && (
            <div style={{ height: '4px', background: 'var(--border-glass)', borderRadius: '2px', marginTop: '0.35rem' }}>
              <div style={{ width: `${percent}%`, height: '100%', background: 'var(--accent-red)', borderRadius: '2px' }} />
            </div>
          )}
        </div>
      )}
      {state.error && !busyName && (
        <div style={{ fontSize: '0.8rem', color: '#f87171' }}>{t('deviceScan.errDownload', { error: state.error })}</div>
      )}
      {pokemonReady && productMap && (productMap.progress || !productMap.rows) && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>{t('deviceScan.productMap')}</div>
      )}

      <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.72rem', lineHeight: 1.45 }}>
        {t('deviceScan.lorcana')} {t('deviceScan.license')}
      </p>
    </div>
  );
}

export default DeviceScanSetup;
