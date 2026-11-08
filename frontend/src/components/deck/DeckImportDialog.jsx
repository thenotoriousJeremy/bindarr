import { X } from 'lucide-react';
import Modal from '../Modal';
import { parseDeckLine, pickDeckLineCard } from '../../utils/deckText';
import { useT } from '../../utils/i18n';

// The import dialog: a pasted decklist, compared against the collection, then the
// owned cards added to the open deck. The text and comparison live in DeckBuilder,
// so closing the dialog keeps what was pasted.
export default function DeckImportDialog({
  activeDeck, importText, setImportText, importComparison, setImportComparison,
  comparingImport, setComparingImport, setShowImportModal, showToast, loadDeckDetails,
}) {
  const { t } = useT();

  const handleCompareImport = async () => {
    if (!importText.trim() || !activeDeck) return;
    setComparingImport(true);
    const lines = importText.split('\n').map(l => l.trim()).filter(Boolean);
    const results = [];

    for (const line of lines) {
      const parsed = parseDeckLine(line);
      if (!parsed || parsed.qty < 1) continue;
      const { qty, name: rawName } = parsed;

      try {
        const res = await fetch(`/api/search?name=${encodeURIComponent(rawName)}&scope=collection&game=${activeDeck.game || 'pokemon'}`);
        if (res.ok) {
          const cards = await res.json();
          if (cards.length > 0) {
            const card = pickDeckLineCard(cards, parsed);
            const owned = card.owned_qty || 0;
            const inDeck = activeDeck.cards.find(c => c.id === card.id)?.quantity || 0;
            results.push({
              rawName,
              requestedQty: qty,
              ownedQty: owned,
              inDeckQty: inDeck,
              card: card,
              status: owned >= qty ? 'full' : owned > 0 ? 'partial' : 'missing'
            });
          } else {
            results.push({
              rawName,
              requestedQty: qty,
              ownedQty: 0,
              inDeckQty: 0,
              card: null,
              status: 'missing'
            });
          }
        }
      } catch (err) {
        console.error(err);
      }
    }
    setImportComparison(results);
    setComparingImport(false);
  };

  const handleImportDeck = async () => {
    if (!activeDeck) return;
    const itemsToImport = importComparison
      ? importComparison.filter(item => item.card && item.ownedQty > 0)
      : [];

    if (itemsToImport.length === 0 && !importText.trim()) return;

    let addedCount = 0;
    
    if (importComparison) {
      for (const item of itemsToImport) {
        try {
          const addQty = Math.min(item.requestedQty, item.ownedQty);
          await fetch(`/api/decks/${activeDeck.id}/cards`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ card_id: item.card.id, quantity: addQty })
          });
          addedCount++;
        } catch (err) {
          console.error(err);
        }
      }
    } else {
      const lines = importText.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const parsed = parseDeckLine(line);
        if (!parsed || parsed.qty < 1) continue;
        const { qty, name: rawName } = parsed;

        try {
          const res = await fetch(`/api/search?name=${encodeURIComponent(rawName)}&scope=collection&game=${activeDeck.game || 'pokemon'}`);
          if (res.ok) {
            const cards = await res.json();
            if (cards.length > 0) {
              await fetch(`/api/decks/${activeDeck.id}/cards`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ card_id: pickDeckLineCard(cards, parsed).id, quantity: qty })
              });
              addedCount++;
            }
          }
        } catch (err) {
          console.error(err);
        }
      }
    }

    if (addedCount > 0) {
      showToast(t('deck.imported', { count: addedCount }));
      await loadDeckDetails(activeDeck.id);
      setImportText('');
      setImportComparison(null);
      setShowImportModal(false);
    } else {
      showToast(t('deck.errNoMatches'));
    }
  };

  return (
    <Modal onClose={() => { setShowImportModal(false); setImportComparison(null); }} label={t('deck.importTitle')} dirty={!!importText.trim()} closeOnBackdrop={false}
      overlayStyle={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}
      className="glass-panel" style={{ maxWidth: '600px', width: '100%', padding: '1.75rem', position: 'relative', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <button className="btn btn-secondary btn-icon-only" onClick={() => { setShowImportModal(false); setImportComparison(null); }} aria-label={t('common.close')} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
          <X size={16} />
        </button>
        <h3 style={{ fontSize: '1.2rem', color: 'var(--text-strong)', marginBottom: '0.5rem' }}>{t('deck.importTitle')}</h3>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>{t('deck.pasteDecklistHint')}</p>
        
        <textarea
          className="input-control"
          style={{ width: '100%', minHeight: '120px', maxHeight: '180px', fontFamily: 'monospace', fontSize: '0.8rem', resize: 'vertical' }}
          placeholder={`4 Pikachu\n2 Ultra Ball\n1 Boss's Orders`}
          value={importText}
          onChange={e => { setImportText(e.target.value); setImportComparison(null); }}
        />

        {/* Comparison results table */}
        {comparingImport ? (
          <div style={{ padding: '1.5rem', textAlign: 'center' }}>
            <div className="spinner" style={{ margin: '0 auto 0.5rem auto' }}></div>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('deck.comparing')}</span>
          </div>
        ) : importComparison && (
          <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1, overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              <span>{t('deck.availabilityBreakdown')}</span>
              <span style={{ color: 'var(--accent-yellow)', fontWeight: 700 }}>
                {t('deck.fullyOwnedSpecies', { owned: importComparison.filter(i => i.status === 'full').length, total: importComparison.length })}
              </span>
            </div>
            <div style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '180px', overflowY: 'auto' }}>
              {importComparison.map((item, idx) => (
                <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem', padding: '0.25rem 0.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                  <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{item.rawName}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{t('deck.reqQuantity', { count: item.requestedQty })}</span>
                    <span style={{
                      padding: '2px 6px',
                      borderRadius: '10px',
                      fontWeight: 700,
                      fontSize: '0.65rem',
                      background: item.status === 'full' ? 'rgba(74, 222, 128, 0.15)' : item.status === 'partial' ? 'rgba(234, 179, 8, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                      color: item.status === 'full' ? 'var(--type-grass)' : item.status === 'partial' ? 'var(--accent-yellow)' : 'var(--accent-red)',
                      border: item.status === 'full' ? '1px solid rgba(74, 222, 128, 0.3)' : item.status === 'partial' ? '1px solid rgba(234, 179, 8, 0.3)' : '1px solid rgba(239, 68, 68, 0.3)'
                    }}>
                      {item.status === 'full' ? `Owned (${item.ownedQty})` : item.status === 'partial' ? `Partial (${item.ownedQty}/${item.requestedQty})` : `Missing (0)`}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => { setShowImportModal(false); setImportComparison(null); }}>{t('common.cancel')}</button>
          {!importComparison ? (
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleCompareImport} disabled={!importText.trim()}>{t('deck.compare')}</button>
          ) : (
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleImportDeck}>{t('deck.importMatched')}</button>
          )}
        </div>
    </Modal>
  );
}
