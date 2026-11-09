import { useState, useEffect, lazy, Suspense } from 'react';
import { Camera, Search, Award, Plus, ArrowLeftRight } from 'lucide-react';
import CameraScanner from './CameraScanner';
import CardSearch from './CardSearch';
import SlabLookup from './SlabLookup';
import { useT } from '../utils/i18n';
import { isDeviceMode } from '../apiBase';

// Device mode only, so a server-mode build never loads the download manager.
const DeviceScanSetup = lazy(() => import('./DeviceScanSetup'));
const TransferManager = lazy(() => import('./TransferManager'));

// `active` is false while another tab is showing: the tab stays mounted so the
// chosen mode and search survive, but the scanner is unmounted so the camera
// (and its detection loop) never runs behind a hidden tab.
function AddCards({
  active = true,
  user,
  onAddSuccess,
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
            showToast={showToast}
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

export default AddCards;
