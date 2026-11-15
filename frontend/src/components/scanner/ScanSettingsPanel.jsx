import { useT } from '../../utils/i18n';
import { langName, getLanguagesForGame } from '../../utils/languages';
import { gameOptions, showGamePicker } from '../../utils/games';
import { AutoTuningPanel } from './LiveOverlays';
import SetFilter from './SetFilter';
import { SCAN_PROFILES } from './scanConstants';

// Settings panel (toggled by the gear in the action row): set, auto-add,
// scan detail, zoom, exposure, diagnostics. Kept off the camera view so it
// stays clean. Moved out of CameraScanner unchanged.
//
// settings: useScanSettings(). camera: the parts of useCameraStream it
// controls. onScanLanguage(code): the scan language changed (the add drawer's
// language follows it).
export default function ScanSettingsPanel({ settings, camera, onScanLanguage, autoScan, detectStatsStore }) {
  const { t } = useT();
  const {
    autoAdd, setAutoAdd, scanGame, setScanGame, scanLang, scanBuiltLangs,
    showDetectOutline, setShowDetectOutline, showDebug, setShowDebug,
    minFill, setMinFill, minSteady, setMinSteady, scanDetail, setScanDetail, profile,
  } = settings;
  const {
    videoInputs, activeCameraId, switchCamera, cameraLabel, zoomCaps, zoom, changeZoom,
    exposureCaps, exposure, setExposure, changeExposure, stream, updateAdvancedConstraints,
  } = camera;
  return (
    <div className="glass-panel" style={{ width: '100%', padding: '1rem', background: 'rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.25rem', order: 2, position: 'relative' }}>
      {/* Auto-add. Separate from scanning on purpose: scanning is how a card
          is identified, auto-add is whether it is filed without a look. Off,
          every confident match opens the add drawer first. */}
      <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
        <span style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('scan.autoAdd')}</span>
          <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{t('scan.autoAddHint')}</span>
        </span>
        <input
          type="checkbox"
          checked={autoAdd}
          onChange={(e) => setAutoAdd(e.target.checked)}
          style={{ accentColor: 'var(--type-grass)', flexShrink: 0 }}
        />
      </label>


      {/* Card type and language: what is being fed in. Card art is
          language-specific, so the language picks which catalog the scan is
          matched against AND the language each added copy is recorded as.
          Card type is a dropdown, not tabs — the list grows (sports, Yu-Gi-Oh)
          and tabs stop fitting. */}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        {showGamePicker() && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', flex: 1, minWidth: 0 }}>
            <label htmlFor="scan-card-type" style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
              {t('scan.cardType')}
            </label>
            <select
              id="scan-card-type"
              className="select-control"
              value={scanGame}
              onChange={(e) => setScanGame(e.target.value)}
              style={{ fontSize: '0.8rem' }}
            >
              {gameOptions().map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', flex: 1, minWidth: 0 }}>
          <label htmlFor="scan-language" style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
            {t('scan.cardLanguage')}
          </label>
          <select
            id="scan-language"
            className="select-control"
            value={scanLang}
            onChange={(e) => onScanLanguage(e.target.value)}
            style={{ fontSize: '0.8rem' }}
          >
            {/* Marked, not hidden. Scanning a language with no catalog of
                its own still works — the English catalog identifies the
                card by artwork — but for Pokémon it cannot see the sets
                that never released in English, and it files the English
                printing. Offering eleven identical-looking options hid all
                of that until after the scan. */}
            {getLanguagesForGame(scanGame).map(l => (
              <option key={l.code} value={l.code}>
                {l.name}{scanBuiltLangs.length && !scanBuiltLangs.includes(l.name)
                  ? ` — ${t('scan.langNoCatalogTag')}` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>
      {!!scanBuiltLangs.length && !scanBuiltLangs.includes(langName(scanLang)) && (
        <p style={{
          margin: '0.4rem 0 0', fontSize: '0.72rem', lineHeight: 1.4,
          color: scanGame === 'pokemon' ? 'var(--accent-yellow)' : 'var(--text-muted)',
        }}>
          {t(scanGame === 'pokemon' ? 'scan.langNoCatalogPokemon' : 'scan.langNoCatalogMtg',
            { lang: langName(scanLang) })}
        </p>
      )}

      <SetFilter settings={settings} />
      {/* Live outline of what the detector currently sees. On by default:
          it turns aiming into a feedback loop, and it is the only way a bad
          crop is visible BEFORE the shutter rather than inferred from a
          wrong answer afterwards. Off is offered because it costs a small
          request roughly every 650ms. */}
      <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('scan.showDetectOutline')}</span>
        <input
          type="checkbox"
          checked={showDetectOutline}
          onChange={(e) => setShowDetectOutline(e.target.checked)}
          style={{ accentColor: 'var(--type-grass)' }}
        />
      </label>

      {/* Diagnostics: the hashed crop and the ranked candidates behind the
          last scan. Off by default — it is for debugging a wrong match, not
          for watching correct ones. */}
      <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
        <span style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('scan.debugPanel')}</span>
          <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{t('scan.debugPanelHint')}</span>
        </span>
        <input
          type="checkbox"
          checked={showDebug}
          onChange={(e) => setShowDebug(e.target.checked)}
          style={{ accentColor: 'var(--type-grass)', flexShrink: 0 }}
        />
      </label>

      {/* Auto-capture gates + what the detector sees right now.
          These two numbers decide whether auto-scan ever fires, and the
          right values depend on the camera, the lighting and how the user
          holds a card. Shipping them as constants meant "it never scans"
          had no visible cause and no user-side fix. The live row below is
          the point: each gate shows its current reading next to its
          threshold, so a card that will not trigger says why. */}
      {autoScan && (
        <AutoTuningPanel
          store={detectStatsStore}
          minFill={minFill} setMinFill={setMinFill}
          minSteady={minSteady} setMinSteady={setMinSteady}
        />
      )}

      {/* Scan Detail. What it still controls: upload resolution and the
          auto-add confirm window. recallK/orb are inert — every scan is
          CollectorVision now, whose cost is fixed at one 448px embed and one
          cosine sweep per catalog, and the ORB pipeline those two knobs
          tuned no longer exists. Kept rather than hidden because uploadW and
          the countdown are real on every path; the request still carries the
          two dead fields so an older backend keeps working. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('scan.detail')}</span>
          <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--accent-red)' }}>{profile.label}</span>
        </div>
        <input
          type="range"
          min="0"
          max={SCAN_PROFILES.length - 1}
          step="1"
          value={scanDetail}
          onChange={(e) => setScanDetail(parseInt(e.target.value, 10))}
          style={{ width: '100%', accentColor: 'var(--accent-red)' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: 'var(--text-muted)' }}>
          <span>{t('scan.detailQuick')}</span>
          <span>{t('scan.detailSlow')}</span>
        </div>
      </div>

      {/* Lens picker: only with two or more cameras. Multi-lens phones expose
          each lens as its own camera, and the browser's default can be the
          macro or ultra-wide one. The pick is remembered (scan_camera_id). */}
      {videoInputs.length >= 2 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)' }}>
          <label htmlFor="scan-camera" style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('scan.cameraLens')}</label>
          <select
            id="scan-camera"
            className="select-control"
            value={activeCameraId}
            onChange={(e) => switchCamera(e.target.value)}
            style={{ fontSize: '0.8rem' }}
          >
            {/* The live lens can be missing from the list (getSettings
                without deviceId); an empty option keeps the select honest. */}
            {!videoInputs.some(d => d.deviceId === activeCameraId) && <option value={activeCameraId} />}
            {videoInputs.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>{cameraLabel(d, i)}</option>
            ))}
          </select>
        </div>
      )}

      {/* Zoom: only rendered when the camera track supports it. Slider only,
          no pinch — a pinch on the preview already resizes the guide box. */}
      {zoomCaps && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)' }}>
          {/* No "×" readout: the unit is the camera's own. Phones report a
              ratio (1–8), desktop UVC webcams an arbitrary range (0–60). */}
          <label htmlFor="scan-zoom" style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('scan.zoom')}</label>
          <input
            id="scan-zoom"
            type="range"
            min={zoomCaps.min}
            max={zoomCaps.max}
            step={zoomCaps.step}
            value={zoom}
            onChange={(e) => changeZoom(parseFloat(e.target.value))}
            style={{ width: '100%', accentColor: 'var(--accent-red)' }}
          />
        </div>
      )}

      {/* Manual exposure: only rendered when the camera track supports it
          (Android Chrome back cams). Auto-exposure stays default until you
          move this. */}
      {exposureCaps && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('scan.exposure')}</span>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: '0.6rem', padding: '0.15rem 0.4rem' }}
              onClick={() => {
                const track = stream?.getVideoTracks?.()[0];
                if (track) updateAdvancedConstraints(track, { exposureMode: 'continuous', exposureCompensation: null });
                const cur = track?.getSettings?.().exposureCompensation;
                setExposure(typeof cur === 'number' ? cur : 0);
              }}
            >
              {t('scan.auto')}
            </button>
          </div>
          <input
            type="range"
            min={exposureCaps.min}
            max={exposureCaps.max}
            step={exposureCaps.step}
            value={exposure}
            onChange={(e) => changeExposure(parseFloat(e.target.value))}
            style={{ width: '100%', accentColor: 'var(--accent-red)' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: 'var(--text-muted)' }}>
            <span>{t('scan.darker')}</span>
            <span>{t('scan.brighter')}</span>
          </div>
        </div>
      )}
    </div>
  );
}
