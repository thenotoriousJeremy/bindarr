import { AlertTriangle, X } from 'lucide-react';
import { getFoilOverlayClass, getPrintingBadgeLabel, getPrintingBadgeStyle } from '../../utils/cardPrinting';
import { conditionLabel, printingLabel } from '../../utils/cardOptions';
import { getCardRarityBorder, getRarityBadgeLabel, getRarityBadgeStyle } from '../../utils/cardRarity';
import { sortCardsByOrder } from '../../utils/cardSort';
import { GAMES } from '../../utils/games';
import { useT } from '../../utils/i18n';
import { cardLocationLabel, itemCollator, itemKey, itemLabel, matchesItemFilters } from '../../utils/transferView';
import CardImage from '../CardImage';
import TransferField from './TransferField';

const SORT_CRITERIA = {
  'name-asc': [{ by: 'name', dir: 'asc' }],
  'name-desc': [{ by: 'name', dir: 'desc' }],
  'set-asc': [{ by: 'set', dir: 'asc' }, { by: 'number', dir: 'asc' }],
  'number-asc': [{ by: 'number', dir: 'asc' }, { by: 'name', dir: 'asc' }],
};

function sortItems(items, sort, t, setsList) {
  const normalized = items.map(item => ({ ...item, name: itemLabel(item) || '' }));
  if (sort === 'location-asc') {
    return normalized.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'card' ? -1 : 1;
      const byLocation = itemCollator.compare(cardLocationLabel(a, t), cardLocationLabel(b, t));
      return byLocation || itemCollator.compare(a.name, b.name);
    });
  }
  if (sort === 'qty-desc') {
    return normalized.sort((a, b) => (Number(b.quantity) || 1) - (Number(a.quantity) || 1));
  }
  return sortCardsByOrder(normalized, SORT_CRITERIA[sort] || SORT_CRITERIA['name-asc'], undefined, setsList);
}

const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const detailLine = { color: 'var(--text-secondary)', fontSize: '0.8rem', ...ellipsis };
const plainButton = { border: 0, padding: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left' };

function ItemThumb({ item }) {
  const { t } = useT();
  const isCard = item.type === 'card';
  const foil = isCard ? getFoilOverlayClass(item.printing) : null;
  const printingBadge = isCard && item.printing !== 'Normal' ? getPrintingBadgeLabel(item.printing, t) : null;
  return (
    <>
      {isCard ? (
        <CardImage card={item} alt="" loading="lazy" draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'var(--radius-sm)' }} />
      ) : item.image_url ? (
        <img src={item.image_url} alt="" loading="lazy" onError={event => { event.currentTarget.style.visibility = 'hidden'; }}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      ) : null}
      {foil && <div className={foil} style={{ borderRadius: 'var(--radius-sm)' }} />}
      {isCard && (
        <span style={{
          position: 'absolute', top: '3px', left: '3px', zIndex: 2, fontSize: '0.55rem', fontWeight: 900,
          padding: '2px 3px', borderRadius: '3px', textTransform: 'uppercase', ...getRarityBadgeStyle(item.rarity),
        }}>
          {getRarityBadgeLabel(item.rarity)}
        </span>
      )}
      {printingBadge && (
        <span style={{
          position: 'absolute', right: '3px', bottom: '3px', zIndex: 2, fontSize: '0.55rem', fontWeight: 800,
          padding: '2px 3px', borderRadius: '3px', border: '1px solid rgba(255, 255, 255, 0.2)', ...getPrintingBadgeStyle(item.printing),
        }}>
          {printingBadge}
        </span>
      )}
    </>
  );
}

function SelectedStrip({ items, selected, isRequest, onPick, onShowDetails }) {
  const { t } = useT();
  return (
    <div className="glass-panel" style={{ padding: '0.65rem' }}>
      <div style={{ color: 'var(--text-strong)', fontSize: '0.82rem', fontWeight: 700, marginBottom: '0.45rem' }}>
        {t('transfer.selectedItems')}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '0.4rem', maxHeight: '10rem', overflowY: 'auto' }}>
        {items.map((item) => {
          const key = itemKey(item);
          const label = itemLabel(item) || t('transfer.unknownItem');
          const details = item.type === 'card'
            ? [
              item.set_name,
              item.number && `#${item.number}`,
              item.printing && item.printing !== 'Normal' && printingLabel(t, item.printing, item.game),
              !isRequest && cardLocationLabel(item, t),
            ].filter(Boolean).join(' · ')
            : [item.sealed_type, item.origin_product_name].filter(Boolean).join(' · ');
          return (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', minWidth: 0, padding: '0.35rem', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2)' }}>
              <button
                type="button"
                aria-label={t('transfer.viewDetails', { item: label })}
                onClick={() => onShowDetails(item)}
                style={{ ...plainButton, position: 'relative', width: '2.5rem', height: '3.5rem', flex: '0 0 auto', overflow: 'hidden', borderRadius: 'var(--radius-sm)', background: 'var(--bg-secondary)' }}
              >
                {item.type === 'card'
                  ? <CardImage card={item} alt="" loading="lazy" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : item.image_url
                    ? <img src={item.image_url} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                    : null}
              </button>
              <div style={{ minWidth: 0, flex: 1 }}>
                <button
                  type="button"
                  aria-label={t('transfer.viewDetails', { item: label })}
                  onClick={() => onShowDetails(item)}
                  style={{ ...plainButton, ...ellipsis, display: 'block', width: '100%', color: 'var(--text-strong)', fontSize: '0.78rem', fontWeight: 700 }}
                >
                  {t('transfer.quantityTimes', { count: selected[key]?.quantity || 1, item: label })}
                </button>
                <span style={{ ...ellipsis, display: 'block', color: 'var(--text-secondary)', fontSize: '0.7rem' }}>
                  {details || t('transfer.allItems')}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-icon-only"
                aria-label={t('transfer.removeSelected', { item: label })}
                title={t('transfer.removeSelected', { item: label })}
                onClick={() => onPick(item, false)}
                style={{ width: '1.8rem', height: '1.8rem', padding: 0, flex: '0 0 auto' }}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// One side of a proposal: your own items to offer, or (isRequest) the other
// member's items to ask for. Filters belong to the caller, so they survive a
// switch between the composer's pages.
export default function ItemPicker({
  idPrefix,
  items,
  selected,
  onPick,
  onQuantity,
  filters,
  onFiltersChange,
  isRequest = false,
  locationOptions = [],
  setsList = [],
  emptyText,
  onShowDetails,
  onToggleSealedTrade,
  sealedTradeBusy = false,
}) {
  const { t } = useT();
  const filteredItems = sortItems(items.filter(item => matchesItemFilters(item, filters)), filters.sort, t, setsList);
  const selectedItems = items.filter(item => selected[itemKey(item)]);
  const updateFilter = (key, value) => onFiltersChange(current => ({ ...current, [key]: value }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {selectedItems.length > 0 && (
        <SelectedStrip items={selectedItems} selected={selected} isRequest={isRequest} onPick={onPick} onShowDetails={onShowDetails} />
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.65rem' }}>
        <TransferField id={`${idPrefix}-search`} label={t('transfer.searchItems')}>
          <input
            id={`${idPrefix}-search`}
            className="input-control"
            type="search"
            value={filters.query}
            placeholder={t('transfer.searchItems')}
            onChange={event => updateFilter('query', event.target.value)}
          />
        </TransferField>
        <TransferField id={`${idPrefix}-game`} label={t('transfer.filterGame')}>
          <select id={`${idPrefix}-game`} className="select-control" value={filters.game} onChange={event => updateFilter('game', event.target.value)}>
            <option value="">{t('transfer.allGames')}</option>
            {GAMES.map(game => <option key={game.value} value={game.value}>{game.label}</option>)}
          </select>
        </TransferField>
        <TransferField id={`${idPrefix}-type`} label={t('transfer.filterType')}>
          <select id={`${idPrefix}-type`} className="select-control" value={filters.type} onChange={event => updateFilter('type', event.target.value)}>
            <option value="all">{t('transfer.allItems')}</option>
            <option value="card">{t('transfer.cardsOnly')}</option>
            <option value="sealed">{t('transfer.sealedOnly')}</option>
          </select>
        </TransferField>
        {!isRequest && (
          <TransferField id={`${idPrefix}-location`} label={t('transfer.filterLocation')}>
            <select id={`${idPrefix}-location`} className="select-control" value={filters.location} onChange={event => updateFilter('location', event.target.value)}>
              <option value="">{t('transfer.anyLocation')}</option>
              {locationOptions.map(location => <option key={location.key} value={location.key}>{location.label}</option>)}
            </select>
          </TransferField>
        )}
        <TransferField id={`${idPrefix}-sort`} label={t('collection.sortBy')}>
          <select id={`${idPrefix}-sort`} className="select-control" value={filters.sort} onChange={event => updateFilter('sort', event.target.value)}>
            <option value="name-asc">{t('collection.sort.name-asc')}</option>
            <option value="name-desc">{t('collection.sort.name-desc')}</option>
            <option value="qty-desc">{t('collection.sort.qty-desc')}</option>
            <option value="set-asc">{t('collection.sort.set-asc')}</option>
            <option value="number-asc">{t('collection.sort.number-asc')}</option>
            {!isRequest && <option value="location-asc">{t('transfer.sortLocation')}</option>}
          </select>
        </TransferField>
      </div>
      <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
        {t('transfer.selectedCount', { count: Object.keys(selected).length })}
      </div>
      {filteredItems.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', padding: '0.5rem 0' }}>
          {items.length === 0 ? emptyText : t('transfer.noFilterResults')}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '0.65rem', maxHeight: '24rem', overflowY: 'auto', padding: '0.1rem' }}>
          {filteredItems.map((item) => {
            const key = itemKey(item);
            const checked = Boolean(selected[key]);
            const label = itemLabel(item);
            const isCard = item.type === 'card';
            const heldByDeck = isCard ? Number(item.checked_out_qty) || 0 : 0;
            return (
              <article key={key} className="glass-panel" style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', padding: '0.6rem', minWidth: 0 }}>
                <input type="checkbox" checked={checked} aria-label={label} onChange={event => onPick(item, event.target.checked)} />
                <button
                  type="button"
                  aria-label={t('transfer.viewDetails', { item: label })}
                  onClick={() => onShowDetails(item)}
                  style={{
                    ...plainButton,
                    position: 'relative',
                    width: '3.75rem',
                    height: '5.2rem',
                    flex: '0 0 auto',
                    overflow: 'hidden',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--surface-2)',
                    ...(isCard ? getCardRarityBorder(item.rarity) : {}),
                  }}
                >
                  <ItemThumb item={item} />
                </button>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  <button
                    type="button"
                    aria-label={t('transfer.viewDetails', { item: label })}
                    onClick={() => onShowDetails(item)}
                    style={{ ...plainButton, ...ellipsis, color: 'var(--text-strong)', fontSize: '0.95rem', fontWeight: 700 }}
                  >
                    {label}
                  </button>
                  <span style={detailLine}>
                    {isCard
                      ? [item.set_name, item.number && `#${item.number}`].filter(Boolean).join(' · ')
                      : [item.sealed_type, item.origin_product_name && t('transfer.fromProduct', { product: item.origin_product_name })].filter(Boolean).join(' · ')}
                  </span>
                  {isCard && (
                    <span style={detailLine}>
                      {[
                        item.printing && `${t('transfer.printing')}: ${printingLabel(t, item.printing, item.game)}`,
                        item.condition && conditionLabel(t, item.condition),
                        item.language,
                      ].filter(Boolean).join(' · ')}
                    </span>
                  )}
                  {isCard && !isRequest && (
                    <span style={detailLine}>{t('transfer.location')}: {cardLocationLabel(item, t)}</span>
                  )}
                  {isCard && (
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                      {t('transfer.availableQuantity', { count: Number(item.quantity) || 1 })}
                    </span>
                  )}
                  {heldByDeck > 0 && !isRequest && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', color: 'var(--accent-yellow)', fontSize: '0.78rem' }}>
                      <AlertTriangle size={12} aria-hidden="true" /> {t('transfer.heldByDeck', { count: heldByDeck })}
                    </span>
                  )}
                  {isCard && checked && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                      {t('transfer.quantity')}
                      <input
                        type="number"
                        className="input-control"
                        min="1"
                        max={Number(item.quantity) || 1}
                        value={selected[key].quantity}
                        onChange={event => onQuantity(item, event.target.value)}
                        style={{ width: '4.5rem', padding: '0.45rem 0.55rem' }}
                      />
                    </label>
                  )}
                  {onToggleSealedTrade && item.type === 'sealed' && (
                    <button type="button" className="btn btn-secondary" disabled={sealedTradeBusy}
                      style={{ alignSelf: 'flex-start', padding: '0.35rem 0.55rem', fontSize: '0.8rem' }}
                      onClick={() => onToggleSealedTrade(item)}>
                      {item.is_trade ? t('transfer.unmarkTrade') : t('transfer.markTrade')}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
