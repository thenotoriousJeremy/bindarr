import { X, ListFilter, RefreshCw, Layers } from 'lucide-react';
import { useT } from '../../utils/i18n';
import { getCardDisplayName } from '../../utils/langHelper';
import { resolveCardPrice } from '../../utils/resolveCardPrice';
import Price from '../Price';
import CardEntryFields from '../CardEntryFields';
import LangFallbackNote from './LangFallbackNote';

// The add drawer for a scanned card: condition, printing, quantity and language
// before it is saved. Moved out of CameraScanner unchanged; `flow` is
// useAddFlow(), and onBackToMatches reopens the picker on the last scan's list.
export default function QuickAddDrawer({ flow, onBackToMatches }) {
  const { t } = useT();
  const {
    isDrawerOpen, selectedCard, closeDrawer, handleSubmit, language, printing, quantity, condition,
    purchasePrice, setQuantity, setPurchasePrice, setCondition, setPrinting, handleLanguageChange,
    lastMatches, findOtherPrintings, findingPrintings,
  } = flow;
  return (
    <>
      {/* Drawer Overlay for Selected Card */}
      {/* Pointer-only dismissal; Esc is the keyboard twin (useEscape in CameraScanner). */}
      <div role="presentation" className={`drawer-backdrop ${isDrawerOpen ? 'open' : ''}`} onClick={closeDrawer}></div>
      <div className={`quick-add-drawer ${isDrawerOpen ? 'open' : ''}`}>
        {selectedCard && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', width: '100%', maxWidth: '100%', boxSizing: 'border-box', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem', gap: '0.75rem', width: '100%', maxWidth: '100%', boxSizing: 'border-box' }}>
              {/* The name and number ARE the identification — the title above them
                  is boilerplate. So they get the size, and the set name (which the
                  number already implies) drops to the small line. */}
              <div style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                <h3 style={{ color: 'var(--text-muted)', fontSize: '0.7rem', margin: 0, textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 800 }}>{t('scan.addScannedTitle')}</h3>
                <p style={{ color: 'var(--text-strong)', fontSize: '1.25rem', fontWeight: 800, margin: '0.1rem 0 0 0', lineHeight: 1.2, wordBreak: 'break-word' }}>
                  {getCardDisplayName(selectedCard.name, language, selectedCard.printed_name)} <span style={{ color: 'var(--text-primary)' }}>#{selectedCard.number}</span>
                </p>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0, wordBreak: 'break-word' }}>{selectedCard.set_name}</p>
                <LangFallbackNote card={selectedCard} style={{ justifyContent: 'flex-start' }} />
              </div>
              <button type="button" className="btn btn-secondary btn-icon-only" onClick={closeDrawer} aria-label={t('common.close')} style={{ borderRadius: '50%', flexShrink: 0 }}>
                <X size={18} />
              </button>
            </div>

            {/* Three Column Layout (No vertical scroll) */}
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: '100%', maxWidth: '100%', boxSizing: 'border-box' }}>
              <div className="quick-add-grid">

                {/* Column 1: Card Preview (Smaller card: width 150px) */}
                <div className="quick-add-preview">
                  <img
                    src={selectedCard.image_url}
                    alt={getCardDisplayName(selectedCard.name, language, selectedCard.printed_name)}
                    className="quick-add-preview-img"
                  />
                  <div className="quick-add-preview-info">
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>TCG Market ({printing})</div>
                    <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--accent-yellow)', margin: '0.1rem 0' }}>
                      <Price value={resolveCardPrice(selectedCard, printing)} currency={selectedCard.price_currency} />
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                      Rarity: <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{selectedCard.rarity || 'Common'}</span>
                    </div>
                  </div>
                </div>

                {/* Column 2: Card Properties Form */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  <div className="quick-add-section-title">{t('scan.cardProperties')}</div>

                  <CardEntryFields
                    variant="stacked"
                    game={selectedCard.game || selectedCard.supertype}
                    quantity={quantity} purchasePrice={purchasePrice} condition={condition} printing={printing} language={language}
                    onQuantity={setQuantity} onPurchasePrice={setPurchasePrice} onCondition={setCondition} onPrinting={setPrinting} onLanguage={handleLanguageChange}
                  />
                </div>
              </div>

              {/* Submit Buttons.
                  "Other matches" goes back to what the scanner saw (alternative visual guesses).
                  "Right name, wrong printing" lists all printings of this card name across sets. */}
              <div className="quick-add-footer">
                <div className="quick-add-footer-tools">
                  {lastMatches.length > 1 && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={onBackToMatches}
                      style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                    >
                      <ListFilter size={14} /> {t('scan.backToMatches', { n: lastMatches.length })}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={findOtherPrintings}
                    disabled={findingPrintings}
                    title={t('scan.otherPrintingsHint')}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                  >
                    {findingPrintings ? <RefreshCw size={14} className="spin" /> : <Layers size={14} />}
                    <span>{findingPrintings ? t('scan.fetchingCandidates') : (t('scan.changePrinting') || t('scan.otherPrintings') || t('scan.rightNameWrongPrinting'))}</span>
                  </button>
                </div>
                <div className="quick-add-footer-actions">
                  <button type="button" className="btn btn-secondary" onClick={closeDrawer}>{t('common.cancel')}</button>
                  <button type="submit" className="btn btn-primary">{t('search.addToCollection')}</button>
                </div>
              </div>
            </form>
          </div>
        )}
      </div>
    </>
  );
}
