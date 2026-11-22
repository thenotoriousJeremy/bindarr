import { memo, useState, useEffect, lazy, Suspense } from 'react';
import { Camera, Search, Award, Plus, ArrowLeftRight, Upload, PackageOpen } from 'lucide-react';
import CameraScanner from './CameraScanner';
import CardSearch from './CardSearch';
import SlabLookup from './SlabLookup';
import { useT } from '../utils/i18n';
import { isDeviceMode } from '../apiBase';
import { lazyWithReload } from '../utils/lazyWithReload';
import { isGameEnabled } from '../utils/games';
import { importFormatFor, readFileText, importCardFile } from '../utils/collectionImport';

// Device mode only, so a server-mode build never loads the download manager.
const DeviceScanSetup = lazy(() => import('./DeviceScanSetup'));
// Its own chunk: most visits to this tab are to add cards.
const TransferManager = lazyWithReload(() => import('./transfers/TransferManager'));
const PreconImportModal = lazyWithReload(() => import('./PreconImportModal'));

// A whole list at once, for someone who came here to add cards and has them
// written down already: the same file import and precon picker Settings has
// (people looked for them here, not there). A card list only; a full backup is
// restored from Settings, since it replaces rather than merges.
function ImportShortcuts({ showToast, onDataChanged }) {
  const { t } = useT();
  const [showPrecons, setShowPrecons] = useState(false);
  const showPrecon = isGameEnabled('mtg');

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    let data;
    try {
      data = await readFileText(file);
    } catch {
      showToast(t('settings.errReadFile'));
      return;
    }
    const format = importFormatFor(file.name);
    if (await importCardFile({ fileName: file.name, format, data, t, showToast }) && onDataChanged) onDataChanged();
  };

  const linkStyle = { display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', padding: '0.3rem 0.65rem', cursor: 'pointer', margin: 0 };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
      {showPrecons && (
        <Suspense fallback={null}>
          <PreconImportModal onClose={() => setShowPrecons(false)} showToast={showToast} onImported={onDataChanged} />
        </Suspense>
      )}
      <span>{t('addCards.haveList')}</span>
      <label className="btn btn-secondary" style={linkStyle} title={t('addCards.importFileHint')}>
        <Upload size={14} />
        <span>{t('addCards.importFile')}</span>
        <input type="file" accept=".csv,.txt" onChange={handleFile} style={{ display: 'none' }} />
      </label>
      {showPrecon && (
        <button type="button" className="btn btn-secondary" style={linkStyle} title={t('precon.hint')} onClick={() => setShowPrecons(true)}>
          <PackageOpen size={14} />
          <span>{t('precon.open')}</span>
        </button>
      )}
    </div>
  );
}

// `active` is false while another tab is showing: the tab stays mounted so the
// chosen mode and search survive, but the scanner is unmounted so the camera
// (and its detection loop) never runs behind a hidden tab. Trades & Gifts (the
// second section) is on a phone in device mode too, for deals recorded with
// people outside Bindarr; trading with members needs a server.
function AddCards({
  active = true,
  user,
  onAddSuccess,
  onDataChanged,
  onUpdateUser,
  showToast,
  setActiveTab,
  initialMode = 'scan',
  transferLaunch,
  transferHistoryFocus,
  onInitialOfferHandled,
  onHistoryFocusHandled
}) {
  const { t } = useT();
  // In device mode a scan needs the models and a catalog downloaded to the phone
  // first, so the tab offers that download until there is something to match
  // against, and the view opens on search.
  const deviceMode = isDeviceMode();
  const [mode, setMode] = useState(deviceMode && initialMode === 'scan' ? 'search' : initialMode);
  const [section, setSection] = useState(() => (
    transferLaunch || transferHistoryFocus ? 'transfers' : 'add'
  ));

  useEffect(() => {
    if (transferLaunch || transferHistoryFocus) setSection('transfers');
  }, [transferLaunch, transferHistoryFocus]);

  // Demo build has no backend: the camera scanner and live card search can't
  // work, so show a notice instead of a broken UI.
  if (import.meta.env.VITE_DEMO) {
    return (
      <div className="glass-panel" style={{ maxWidth: '520px', margin: '2rem auto', padding: '2rem', textAlign: 'center' }}>
        <Camera size={40} style={{ color: 'var(--accent-yellow)', marginBottom: '1rem' }} />
        <h2 style={{ fontSize: '1.2rem', color: 'var(--text-strong)', marginBottom: '0.75rem' }}>{t('demo.unavailableTitle')}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.5 }}>
          {t('demo.unavailableBody')}
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div className="sub-nav-tabs" role="group" aria-label={t('addCards.sectionLabel')} style={{ maxWidth: '520px', margin: '0 auto 1rem' }}>
        <button
          type="button"
          aria-pressed={section === 'add'}
          className={`sub-nav-tab ${section === 'add' ? 'active' : ''}`}
          onClick={() => setSection('add')}
        >
          <Plus size={18} />
          <span>{t('addCards.addTab')}</span>
        </button>
        <button
          type="button"
          aria-pressed={section === 'transfers'}
          className={`sub-nav-tab ${section === 'transfers' ? 'active' : ''}`}
          onClick={() => setSection('transfers')}
        >
          <ArrowLeftRight size={18} />
          <span>{t('addCards.transfersTab')}</span>
        </button>
      </div>

      {section === 'add' ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', gap: '1rem', position: 'relative' }}>
            <div className="sub-nav-tabs" role="group" aria-label={t('addCards.methodsLabel')} style={{ width: '100%', maxWidth: '400px', margin: 0 }}>
              <button
                type="button"
                aria-pressed={mode === 'scan'}
                className={`sub-nav-tab ${mode === 'scan' ? 'active' : ''}`}
                onClick={() => setMode('scan')}
              >
                <Camera size={18} />
                <span>{t('addCards.scan')}</span>
              </button>
              <button
                type="button"
                aria-pressed={mode === 'search'}
                className={`sub-nav-tab ${mode === 'search' ? 'active' : ''}`}
                onClick={() => setMode('search')}
              >
                <Search size={18} />
                <span>{t('addCards.search')}</span>
              </button>
              {/* A slab is a third way in, not a variant of the other two: the camera
                  cannot read a cert number through the plastic, and searching by name
                  cannot tell you the grade. The number on the label does both. */}
              <button
                type="button"
                aria-pressed={mode === 'slab'}
                className={`sub-nav-tab ${mode === 'slab' ? 'active' : ''}`}
                onClick={() => setMode('slab')}
              >
                <Award size={18} />
                <span>{t('addCards.slab')}</span>
              </button>
            </div>
          </div>

          <ImportShortcuts showToast={showToast} onDataChanged={onDataChanged || onAddSuccess} />

          <div>
            {mode === 'scan' && active && (deviceMode ? (
              <Suspense fallback={null}>
                <DeviceScanSetup gate showToast={showToast}>
                  <CameraScanner onAddSuccess={onAddSuccess} showToast={showToast} setActiveTab={setActiveTab} />
                </DeviceScanSetup>
              </Suspense>
            ) : (
              <CameraScanner onAddSuccess={onAddSuccess} showToast={showToast} setActiveTab={setActiveTab} />
            ))}
            {mode === 'search' && <CardSearch onAddSuccess={onAddSuccess} showToast={showToast} setActiveTab={setActiveTab} />}
            {mode === 'slab' && <SlabLookup onAddSuccess={onAddSuccess} showToast={showToast} />}
          </div>
        </>
      ) : (
        <Suspense fallback={null}>
          <TransferManager
            user={user}
            active={active}
            deviceMode={deviceMode}
            showToast={showToast}
            onUpdateUser={onUpdateUser}
            onCollectionChanged={onAddSuccess}
            initialOffer={transferLaunch}
            historyFocus={transferHistoryFocus}
            onInitialOfferHandled={onInitialOfferHandled}
            onHistoryFocusHandled={onHistoryFocusHandled}
          />
        </Suspense>
      )}
    </div>
  );
}

// Memoized: App re-renders on every toast, and its props here are stable.
export default memo(AddCards);
