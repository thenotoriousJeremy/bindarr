import { CheckCircle, AlertTriangle } from 'lucide-react';
import { isBasicEnergyOrLand, deckWarnings, ruleWarningText } from '../../utils/deckRules';
import RiotNotice from '../RiotNotice';
import { useT } from '../../utils/i18n';

// Deck Health: size, unique cards, basics, and everything the deck's format rules
// say about it.
export default function DeckHealth({ activeDeck, deckGame, deckRules, totalDeckCardsCount, targetDeckCardsCount }) {
  const { t } = useT();
  // Everything the deck currently breaks under the rules its format holds it to
  // (the same table the server enforces).
  const ruleWarnings = activeDeck ? deckWarnings({ game: deckGame, format: activeDeck.format, cards: activeDeck.cards }) : [];

  return (
    <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <h3 style={{ fontSize: '0.95rem', color: 'var(--text-strong)', margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
        {totalDeckCardsCount === targetDeckCardsCount && ruleWarnings.length === 0 ? (
          <CheckCircle size={15} style={{ color: 'var(--type-grass)' }} />
        ) : (
          <AlertTriangle size={15} style={{ color: 'var(--accent-yellow)' }} />
        )}
        {t('deck.healthTitle')}
      </h3>

      {deckGame === 'riftbound' && <RiotNotice style={{ marginTop: 0 }} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', fontSize: '0.8rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
          <span>{t('deck.targetDeckSize')}</span>
          <strong style={{ color: totalDeckCardsCount === targetDeckCardsCount ? 'var(--type-grass)' : 'var(--text-strong)' }}>{totalDeckCardsCount}/{targetDeckCardsCount} {t('deck.cardCapacity')}</strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
          <span>{t('deck.uniqueCards')}</span>
          <strong style={{ color: 'var(--text-strong)' }}>{activeDeck.cards.length} {deckGame === 'mtg' ? t('deck.titlesCount', { count: activeDeck.cards.length }) : t('deck.speciesCount', { count: activeDeck.cards.length })}</strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
          <span>{t(deckGame === 'mtg' ? 'deck.basicLands' : 'deck.basicEnergy')}</span>
          <strong style={{ color: 'var(--accent-yellow)' }}>
            {activeDeck.cards.filter(c => isBasicEnergyOrLand(c, deckGame)).reduce((s, c) => s + c.quantity, 0)} {deckGame === 'mtg' ? t('deck.basicLandsCount', { count: activeDeck.cards.filter(c => isBasicEnergyOrLand(c, deckGame)).reduce((s, c) => s + c.quantity, 0) }) : t('deck.basicEnergyCount', { count: activeDeck.cards.filter(c => isBasicEnergyOrLand(c, deckGame)).reduce((s, c) => s + c.quantity, 0) })}
          </strong>
        </div>
      </div>

      {/* What the format says about the deck. Warnings, never refusals:
          an unfinished deck is what a deck being built looks like. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', fontSize: '0.75rem', borderTop: '1px solid var(--border-glass)', paddingTop: '0.6rem' }}>
        <span style={{ fontWeight: 700, color: 'var(--text-secondary)' }}>{t('deck.formatRulesTitle', { format: deckRules.format })}</span>
        {ruleWarnings.length === 0 ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: 'var(--type-grass)' }}>
            <CheckCircle size={13} style={{ flexShrink: 0 }} /> {t('deck.rulesMet', { format: deckRules.format })}
          </span>
        ) : ruleWarnings.map((warning, index) => (
          <span key={`${warning.code}-${index}`} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.35rem', color: 'var(--accent-yellow)', overflowWrap: 'anywhere' }}>
            <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: '1px' }} />
            <span>{ruleWarningText(t, warning, deckRules.format)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
