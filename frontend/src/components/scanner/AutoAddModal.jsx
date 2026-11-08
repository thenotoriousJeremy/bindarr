import { memo } from 'react';
import Modal from '../Modal';
import { getCardDisplayName } from '../../utils/langHelper';
import LangFallbackNote from './LangFallbackNote';
import { onActivateKey } from '../../utils/a11y';
import { CONDITIONS, conditionLabel, getPrintings, printingLabel } from '../../utils/cardOptions';
import { useT } from '../../utils/i18n';

// The auto-add confirm: the matched card, a countdown to filing it, and the
// quick picks for when the match was the wrong printing. Moved out of
// CameraScanner unchanged and memoized, so it does not re-render with the
// scanner unless one of its own props changed.
function AutoAddModal({
  cancelAutoAdd, autoAddTargetCard, addLanguage, autoAddEditing, setAutoAddCond,
  setAutoAddPrint, setAutoAddEditing, autoAddCountdown, autoAddCond, autoAddPrint,
  setAutoAddTargetCard, setAutoAddCountdown, autoAddCard, setAutoAddAlternatives, autoAddAlternatives,
  openQuickAdd, setScanMatches, setShowAllMatches,
}) {
  const { t } = useT();
  return (
    <Modal
      onClose={cancelAutoAdd}
      label={getCardDisplayName(autoAddTargetCard.name, addLanguage(autoAddTargetCard), autoAddTargetCard.printed_name)}
      closeOnBackdrop={false}
      overlayClassName="modal-backdrop"
      overlayStyle={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.85)',
        backdropFilter: 'blur(5px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1100,
        padding: '1rem'
      }}
      className="glass-panel animate-fade-in scan-confirm-modal" style={{ maxWidth: '420px', width: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column', gap: '1.25rem', alignItems: 'center', textAlign: 'center', border: '1px solid var(--accent-red)' }}>
        <div>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 800 }}>{t(autoAddEditing ? 'scan.adjustAndAdd' : 'scan.exactMatch')}</span>
          {/* The name AS PRINTED when the provider gave one, so a Japanese
              scan reads as the Japanese card it is. Falls back to English. */}
          <h3 style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--text-strong)', margin: '0.25rem 0 0.35rem 0' }}>{getCardDisplayName(autoAddTargetCard.name, addLanguage(autoAddTargetCard), autoAddTargetCard.printed_name)}</h3>
          <p style={{ color: 'var(--text-primary)', fontSize: '1rem', fontWeight: 700, margin: 0 }}>#{autoAddTargetCard.number}</p>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: 0 }}>{autoAddTargetCard.set_name}</p>
          <LangFallbackNote card={autoAddTargetCard} />
        </div>

        <div
          role={autoAddEditing ? undefined : 'button'}
          tabIndex={autoAddEditing ? undefined : 0}
          onKeyDown={autoAddEditing ? undefined : onActivateKey((e) => e.currentTarget.click())}
          onClick={() => {
            if (autoAddEditing) return;
            // Pause and open the editor with sensible defaults.
            setAutoAddCond('Near Mint');
            setAutoAddPrint((autoAddTargetCard.rarity || '').toLowerCase().includes('holo') ? 'Holofoil' : 'Normal');
            setAutoAddEditing(true);
          }}
          style={{ position: 'relative', width: '115px', aspectRatio: 0.718, margin: '0.5rem 0', cursor: autoAddEditing ? 'default' : 'pointer' }}
          title={autoAddEditing ? undefined : 'Tap to change condition/foil'}
        >
          <img src={autoAddTargetCard.image_url} alt={getCardDisplayName(autoAddTargetCard.name, addLanguage(autoAddTargetCard), autoAddTargetCard.printed_name)} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '6px', boxShadow: 'var(--shadow-glow)' }} />
          {!autoAddEditing && (
            <div style={{
              position: 'absolute',
              top: '-10px',
              right: '-10px',
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              backgroundColor: 'var(--accent-red)',
              border: '2px solid #fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-strong)',
              fontWeight: 900,
              fontSize: '1rem',
              boxShadow: '0 4px 10px rgba(0,0,0,0.5)'
            }}>
              {autoAddCountdown}
            </div>
          )}
        </div>

        {autoAddEditing ? (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'flex', gap: '0.6rem' }}>
              <div className="form-group" style={{ marginBottom: 0, flex: 1, textAlign: 'left' }}>
                <label>{t('card.condition')}</label>
                <select className="select-control" value={autoAddCond} onChange={(e) => setAutoAddCond(e.target.value)}>
                  {CONDITIONS.map(c => <option key={c} value={c}>{conditionLabel(t, c)}</option>)}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0, flex: 1, textAlign: 'left' }}>
                <label>{t('card.printing')}</label>
                <select className="select-control" value={autoAddPrint} onChange={(e) => setAutoAddPrint(e.target.value)}>
                  {getPrintings(autoAddTargetCard.game || autoAddTargetCard.supertype).map(p => <option key={p.value} value={p.value}>{printingLabel(t, p.value, autoAddTargetCard.game || autoAddTargetCard.supertype)}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', width: '100%' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const card = autoAddTargetCard;
                  const overrides = { condition: autoAddCond, printing: autoAddPrint };
                  setAutoAddTargetCard(null);
                  setAutoAddCountdown(null);
                  setAutoAddEditing(false);
                  autoAddCard(card, 1, overrides);
                }}
                style={{ flex: 1.5, fontSize: '0.75rem', padding: '0.45rem 0' }}
              >
                {t('search.addToCollection')}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={cancelAutoAdd}
                style={{ flex: 1, fontSize: '0.75rem', padding: '0.45rem 0' }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('scan.autoAddingIn', { seconds: autoAddCountdown })}</span>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{t('scan.tapToChange')}</span>
            <div style={{ display: 'flex', gap: '0.5rem', width: '100%', marginTop: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const card = autoAddTargetCard;
                  setAutoAddTargetCard(null);
                  setAutoAddCountdown(null);
                  setAutoAddAlternatives([]);
                  autoAddCard(card);
                }}
                style={{ flex: 1.5, fontSize: '0.75rem', padding: '0.45rem 0' }}
              >
                {t('scan.addNow')}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={cancelAutoAdd}
                style={{ flex: 1, fontSize: '0.75rem', padding: '0.45rem 0' }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}

        {/* The rest of the ORB list, in ORB's order.
            Auto-add commits to the strongest match, and within a single set
            — many cards, one frame, near-identical art — that is regularly
            not the card in hand. Showing the runners-up here turns a wrong
            guess into one tap instead of an add-then-undo. Hidden while
            editing condition/foil, where the choice has already been made. */}
        {!autoAddEditing && autoAddAlternatives.length > 0 && (
          <div style={{ width: '100%', borderTop: '1px solid var(--border-glass)', paddingTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}>
              {t('scan.notThisOne')}
            </span>
            <div style={{ display: 'flex', gap: '0.5rem', overflowX: 'auto', paddingBottom: '0.25rem' }}>
              {autoAddAlternatives.map(alt => (
                <button
                  key={alt.id}
                  type="button"
                  onClick={() => {
                    // Cancel the countdown and hand this card to the normal
                    // add flow, so condition/quantity work exactly as usual.
                    setAutoAddTargetCard(null);
                    setAutoAddCountdown(null);
                    setAutoAddAlternatives([]);
                    openQuickAdd(alt);
                  }}
                  title={`${getCardDisplayName(alt.name, addLanguage(alt), alt.printed_name)} · ${alt.set_name} #${alt.number}`}
                  style={{ flex: '0 0 auto', width: '68px', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'center' }}
                >
                  <img
                    src={alt.image_url}
                    alt={getCardDisplayName(alt.name, addLanguage(alt), alt.printed_name)}
                    style={{ width: '100%', aspectRatio: 0.718, objectFit: 'cover', borderRadius: '4px', border: '1px solid var(--border-glass-hover)' }}
                  />
                  <div style={{ fontSize: '0.6rem', color: 'var(--text-secondary)', marginTop: '0.2rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    #{alt.number}
                  </div>
                </button>
              ))}
            </div>
            {/* The strip is a quick pick; this opens the full list in the
                normal picker. Offered even on a confident match, because
                "confident" is a score, not a promise — and when the whole set
                looks alike it is regularly the wrong card. */}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                const all = [autoAddTargetCard, ...autoAddAlternatives];
                setAutoAddTargetCard(null);
                setAutoAddCountdown(null);
                setAutoAddAlternatives([]);
                setScanMatches(all);
                setShowAllMatches(true);
              }}
              style={{ alignSelf: 'center', fontSize: '0.7rem', padding: '0.3rem 0.7rem' }}
            >
              {t('scan.seeAllMatches', { n: autoAddAlternatives.length + 1 })}
            </button>
          </div>
        )}
    </Modal>
  );
}

export default memo(AutoAddModal);
