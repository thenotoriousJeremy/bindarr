import { Package, X } from 'lucide-react';
import { conditionLabel, printingLabel } from '../../utils/cardOptions';
import { gameLabel } from '../../utils/games';
import { useT } from '../../utils/i18n';
import { gradeText, itemLabel, provenanceText } from '../../utils/transferView';
import CardImage from '../CardImage';
import Modal from '../Modal';

// A closer look at an item in a picker: its picture and what identifies it.
export default function ItemDetailsModal({ item, onClose }) {
  const { t } = useT();
  const isCard = item.type === 'card';
  const label = itemLabel(item) || t('transfer.unknownItem');
  const game = gameLabel(String(item.game || '').toLowerCase()) || item.game;
  const rows = (isCard ? [
    [t('transfer.detailGame'), game],
    [t('transfer.detailSet'), item.set_name],
    [t('transfer.detailNumber'), item.number],
    [t('transfer.detailRarity'), item.rarity],
    [t('inspector.specSupertype'), item.type_line || item.supertype],
    [t('inspector.specPrinting'), item.printing && printingLabel(t, item.printing, item.game)],
    [t('inspector.specGrade'), gradeText(item)],
    [t('inspector.specCondition'), gradeText(item) || !item.condition ? null : conditionLabel(t, item.condition)],
    [t('inspector.specLanguage'), item.language],
  ] : [
    [t('transfer.detailGame'), game],
    [t('transfer.detailType'), item.sealed_type],
    [t('transfer.detailSet'), item.set_name],
    [t('transfer.detailUnit'), item.unit_number ? t('sealed.unitLabel', { n: item.unit_number }) : null],
    [t('transfer.detailOrigin'), item.origin_product_name && t('transfer.fromProduct', { product: item.origin_product_name })],
    [t('transfer.detailAcquired'), provenanceText(t, item)],
    [t('sealed.expectedCards'), item.expected_cards],
    [t('sealed.expectedPacks'), item.expected_packs],
  ]).filter(([, value]) => value != null && value !== '');

  return (
    <Modal
      onClose={onClose}
      label={t('transfer.itemDetails')}
      className="glass-panel"
      style={{ maxWidth: '720px', width: '100%', maxHeight: '90vh', overflowY: 'auto', padding: '1.25rem', position: 'relative' }}
    >
      <button
        type="button"
        className="btn btn-secondary btn-icon-only"
        onClick={onClose}
        aria-label={t('common.close')}
        style={{ position: 'absolute', top: '0.75rem', right: '0.75rem', borderRadius: '50%' }}
      >
        <X size={16} />
      </button>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap', paddingRight: '2rem' }}>
        <div style={{ width: 'min(180px, 100%)', height: '250px', flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderRadius: 'var(--radius-md)', background: 'var(--surface-2)' }}>
          {isCard ? (
            <CardImage card={item} alt={label} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          ) : item.image_url ? (
            <img src={item.image_url} alt={label} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          ) : (
            <Package size={48} aria-hidden="true" style={{ color: 'var(--text-secondary)' }} />
          )}
        </div>
        <div style={{ minWidth: 0, flex: '1 1 260px' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase' }}>
            {t(isCard ? 'transfer.cardsOnly' : 'transfer.sealedOnly')}
          </div>
          <h2 style={{ color: 'var(--text-strong)', margin: '0.2rem 0 0.8rem', overflowWrap: 'anywhere' }}>{label}</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {rows.map(([name, value]) => (
              <div key={name} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.35rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{name}</span>
                <span style={{ color: 'var(--text-strong)', textAlign: 'right', overflowWrap: 'anywhere' }}>{value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
