import { X } from 'lucide-react';
import Modal from '../Modal';
import { buildDeckExport } from '../../utils/deckText';
import { buildMassEntry, massEntryPage } from '../../utils/tcgMassEntryUrl';
import { useT } from '../../utils/i18n';

// The export dialog: the open deck as text in a chosen format, to copy, or as a
// TCGplayer buylist. The chosen format lives in DeckBuilder so it is kept
// between openings.
export default function DeckExportDialog({ activeDeck, exportFormat, setExportFormat, setShowExportModal, showToast }) {
  const { t } = useT();

  // --- EXPORT LOGIC ---
  const effectiveExportFormat = exportFormat || ((activeDeck?.game === 'mtg') ? 'mtga' : 'ptcgl');

  const handleExportDeckText = () => {
    if (!activeDeck) return '';
    return buildDeckExport(activeDeck.cards, effectiveExportFormat);
  };

  const handleCopyExportText = () => {
    const text = handleExportDeckText();
    navigator.clipboard.writeText(text)
      .then(() => showToast(t('deck.copied')))
      .catch(() => showToast(t('deck.errCopy')));
  };

  // Open TCGplayer Mass Entry with the buylist already filled in (its `c` link
  // parameter, see utils/tcgMassEntryUrl). Names only: a deck wants the card, not
  // one printing of it. Still copied, for a list too long to fit in a link.
  const handleOpenMassEntry = () => {
    const text = buildDeckExport(activeDeck?.cards, 'buylist');
    if (!text) { showToast(t('deck.nothingToBuy')); return; }
    const game = activeDeck?.game || 'pokemon';
    const need = (activeDeck?.cards || []).map(c => ({ quantity: (c.quantity || 0) - (c.owned_qty || 0), name: c.name }));
    const { url } = buildMassEntry(need.filter(i => i.quantity > 0), { game });
    navigator.clipboard.writeText(text).catch(() => {});
    window.open(url || massEntryPage(game), '_blank', 'noopener');
    showToast(t(url ? 'deck.buylistOpened' : 'deck.buylistCopied'));
  };

  return (
    <Modal onClose={() => setShowExportModal(false)} label={t('deck.exportTitle')} closeOnBackdrop={false}
      overlayStyle={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}
      className="glass-panel" style={{ maxWidth: '500px', width: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '1.75rem', position: 'relative' }}>
        <button className="btn btn-secondary btn-icon-only" onClick={() => setShowExportModal(false)} aria-label={t('common.close')} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
          <X size={16} />
        </button>
        <h3 style={{ fontSize: '1.2rem', color: 'var(--text-strong)', marginBottom: '0.5rem' }}>{t('deck.exportTitle')}</h3>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>{t('deck.exportHintBody')}</p>
        <select
          className="input-control"
          style={{ width: '100%', marginBottom: '1rem', fontSize: '0.85rem' }}
          value={effectiveExportFormat}
          onChange={e => setExportFormat(e.target.value)}
        >
          <option value="ptcgl">{t('deck.formatPtcgl')}</option>
          <option value="mtga">{t('deck.formatMtga')}</option>
          <option value="plain">{t('deck.formatPlain')}</option>
          <option value="buylist">{t('deck.formatBuylist')}</option>
        </select>
        {effectiveExportFormat === 'buylist' && (
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '-0.5rem', marginBottom: '1rem' }}>
            {t('deck.buylistHint')}
          </p>
        )}
        <textarea
          readOnly
          className="input-control"
          style={{ width: '100%', height: '220px', fontFamily: 'monospace', fontSize: '0.8rem', resize: 'vertical' }}
          value={handleExportDeckText()}
        />
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowExportModal(false)}>{t('common.close')}</button>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleCopyExportText}>{t('deck.copyClipboard')}</button>
          {effectiveExportFormat === 'buylist' && (
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleOpenMassEntry}>{t('deck.copyOpenTcg')}</button>
          )}
        </div>
    </Modal>
  );
}
