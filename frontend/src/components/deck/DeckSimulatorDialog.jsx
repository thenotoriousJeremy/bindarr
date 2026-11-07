import { X } from 'lucide-react';
import Modal from '../Modal';
import CardImage from '../CardImage';
import { onActivateKey } from '../../utils/a11y';
import { useT } from '../../utils/i18n';

// The draw simulator: an opening hand (and prizes for Pokémon) from the shuffled
// deck. The shuffle, mulligan and draw logic is DeckBuilder's.
export default function DeckSimulatorDialog({
  hand, prizeCards, mulliganCount, simulatorDeck,
  setShowSimulator, startSimulator, handleMulligan, handleDrawCard, setPreviewCard,
}) {
  const { t } = useT();

  return (
    <Modal onClose={() => setShowSimulator(false)} label={t('deck.handSimulator')} closeOnBackdrop={false}
      overlayStyle={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}
      className="glass-panel" style={{ maxWidth: '1000px', width: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem', position: 'relative' }}>
        <button className="btn btn-secondary btn-icon-only" onClick={() => setShowSimulator(false)} aria-label={t('common.close')} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
          <X size={16} />
        </button>

        <div>
          <h3 style={{ fontSize: '1.25rem', color: 'var(--text-strong)', margin: 0 }}>{t('deck.handSimulator')}</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.2rem' }}>
            {t('deck.mulliganCountText', { mulligans: mulliganCount, handSize: hand.length })}
          </p>
        </div>

        {/* Hand Area */}
        <div style={{ 
          background: 'rgba(0,0,0,0.4)', 
          minHeight: '220px', 
          borderRadius: 'var(--radius-md)', 
          border: '1px solid var(--border-glass)', 
          display: 'flex', 
          flexWrap: 'wrap', 
          justifyContent: 'center', 
          alignItems: 'center', 
          gap: '1rem', 
          padding: '1.5rem' 
        }}>
          {hand.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{t('deck.noCardsDrawn')}</div>
          ) : (
            hand.map((card, idx) => (
              <div key={idx} style={{ 
                width: '130px', 
                aspectRatio: 0.718, 
                borderRadius: '8px', 
                overflow: 'hidden', 
                boxShadow: '0 4px 10px rgba(0,0,0,0.5)',
                animation: 'draw-card-anim 0.3s ease-out forwards',
                border: '1px solid var(--border-glass)',
                position: 'relative',
                cursor: 'pointer'
              }} role="button" tabIndex={0} onClick={() => setPreviewCard(card)} onKeyDown={onActivateKey(() => setPreviewCard(card))}>
                <CardImage card={card} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </div>
            ))
          )}
        </div>

        {/* Prize Cards Area (Pokémon decks) */}
        {prizeCards.length > 0 && (
          <div>
            <h4 style={{ fontSize: '0.85rem', color: 'var(--accent-yellow)', margin: '0 0 0.5rem 0' }}>{t('deck.prizeCardsPokemon')}</h4>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {prizeCards.map((pCard, pIdx) => (
                <div key={pIdx} style={{ width: '70px', height: '98px', borderRadius: '4px', background: 'linear-gradient(135deg, #1e293b, #0f172a)', border: '1px dashed var(--accent-yellow)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem', color: 'var(--accent-yellow)', fontWeight: 700 }}>
                  {t('deck.prizeSlot', { n: pIdx + 1 })}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Control buttons */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={startSimulator} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            {t('deck.reshuffle')}
          </button>
          <button 
            className="btn btn-secondary" 
            onClick={handleMulligan} 
            style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
            disabled={hand.length === 0}
          >
            {t('deck.mulliganDraw', { count: Math.max(1, 7 - (mulliganCount + 1)) })}
          </button>
          <button 
            className="btn btn-primary" 
            onClick={handleDrawCard} 
            style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
            disabled={hand.length >= simulatorDeck.length}
          >
            {t('deck.drawOne')}
          </button>
        </div>

        <style>{`
          @keyframes draw-card-anim {
            from { transform: translateY(30px) scale(0.85); opacity: 0; }
            to { transform: translateY(0) scale(1); opacity: 1; }
          }
          @keyframes shimmer-gold {
            0% { background-position: 0% center; }
            100% { background-position: 200% center; }
          }
        `}</style>
    </Modal>
  );
}
