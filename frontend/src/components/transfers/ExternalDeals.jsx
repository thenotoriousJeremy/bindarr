import { useRef, useState } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import { apiErrorText } from '../../utils/apiError';
import { useT } from '../../utils/i18n';
import { GAMES } from '../../utils/games';
import { LatestRequest, fetchJson, isAbortError } from '../../utils/request';
import { costText, timestampText } from '../../utils/transferView';
import SealedCatalogPicker from '../SealedCatalogPicker';
import LoadMore from './LoadMore';

// Deals recorded with people outside Bindarr: a local record only, nobody is
// sent a proposal. Kept on every device, the phone in device mode included.

function itemName(item, t) {
  const snapshot = item.item_snapshot || item;
  return snapshot.name || snapshot.product_name || snapshot.card_id || t('transfer.unknownItem');
}

// What a contact gave you: cards found by search, sealed products from the
// catalog. `onItemsChange` takes an updater, like a state setter.
export function ExternalReceivedItems({ items, onItemsChange, disabled = false }) {
  const { t } = useT();
  const [cardQuery, setCardQuery] = useState('');
  const [cardGame, setCardGame] = useState('pokemon');
  const [cardResults, setCardResults] = useState([]);
  const [sealedGame, setSealedGame] = useState('pokemon');
  const [sealedProduct, setSealedProduct] = useState(null);
  const [sealedQuantity, setSealedQuantity] = useState(1);
  const [originName, setOriginName] = useState('');
  const [originUnitNumber, setOriginUnitNumber] = useState('');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const searchReq = useRef(null);
  if (!searchReq.current) searchReq.current = new LatestRequest();

  const searchCards = async () => {
    if (!cardQuery.trim()) return;
    const req = searchReq.current.begin();
    setSearching(true);
    setError('');
    try {
      const params = new URLSearchParams({ name: cardQuery.trim(), game: cardGame, scope: 'internet', limit: '20' });
      const { data } = await fetchJson(`/api/search?${params}`, { signal: req.signal });
      if (req.isLatest()) setCardResults(Array.isArray(data) ? data.slice(0, 20) : []);
    } catch (err) {
      if (!isAbortError(err) && req.isLatest()) setError(apiErrorText(t, err?.body, 'transfer.external.errSearch'));
    } finally {
      if (req.isLatest()) setSearching(false);
    }
  };

  const addReceivedCard = (card) => {
    const item = {
      type: 'card',
      card_id: card.id,
      game: card.game || cardGame,
      name: card.printed_name || card.name,
      set_name: card.set_name,
      number: card.number,
      image_url: card.image_url,
      quantity: 1,
      condition: 'Near Mint',
      printing: 'Normal',
      language: 'English',
    };
    onItemsChange((current) => {
      const existing = current.find(row => row.type === 'card' && row.card_id === item.card_id);
      if (existing) return current.map(row => (row === existing ? { ...row, quantity: Math.min(100, row.quantity + 1) } : row));
      return [...current, item];
    });
  };

  const addReceivedSealed = () => {
    if (!sealedProduct) return;
    onItemsChange(current => [...current, {
      type: 'sealed',
      product_id: sealedProduct.product_id || null,
      product_name: sealedProduct.name,
      set_name: sealedProduct.group_name || null,
      sealed_type: sealedProduct.sealed_type || null,
      game: sealedGame,
      image_url: sealedProduct.image_url || null,
      quantity: Math.max(1, Number(sealedQuantity) || 1),
      origin_product_name: originName.trim() || null,
      origin_unit_number: originUnitNumber ? Math.max(1, Number(originUnitNumber) || 1) : null,
    }]);
    setSealedProduct(null);
    setSealedQuantity(1);
    setOriginName('');
    setOriginUnitNumber('');
  };

  const updateReceivedQuantity = (item, quantity) => {
    onItemsChange(current => current.map(row => (row === item
      ? { ...row, quantity: Math.max(1, Math.min(100, Number(quantity) || 1)) }
      : row)));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
        <select className="select-control" value={cardGame} onChange={event => setCardGame(event.target.value)} aria-label={t('transfer.external.game')}>
          {GAMES.map(game => <option key={game.value} value={game.value}>{game.short}</option>)}
        </select>
        <input
          className="input-control"
          value={cardQuery}
          onChange={event => setCardQuery(event.target.value)}
          placeholder={t('transfer.external.searchCards')}
          aria-label={t('transfer.external.searchCards')}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); searchCards(); } }}
        />
        <button type="button" className="btn btn-secondary" disabled={disabled || searching} onClick={searchCards}
          aria-label={t('common.search')} title={t('common.search')}>
          <Search size={14} />
        </button>
      </div>
      {error && <div role="alert" style={{ color: 'var(--accent-red)' }}>{error}</div>}
      {cardResults.length > 0 && (
        <div className="glass-panel" style={{ maxHeight: '12rem', overflowY: 'auto', padding: '0.35rem' }}>
          {cardResults.map(card => (
            <button
              type="button"
              key={card.id}
              disabled={disabled}
              onClick={() => addReceivedCard(card)}
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', width: '100%', padding: '0.4rem', textAlign: 'left', color: 'var(--text-strong)', background: 'transparent', border: 0, cursor: 'pointer' }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                {card.printed_name || card.name}{' '}
                <span style={{ color: 'var(--text-secondary)' }}>{[card.set_name, card.number && `#${card.number}`].filter(Boolean).join(' · ')}</span>
              </span>
              <Plus size={13} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      <div className="glass-panel" style={{ padding: '0.65rem' }}>
        <SealedCatalogPicker game={sealedGame} onGameChange={setSealedGame} onPick={setSealedProduct} confirmManual />
        {sealedProduct && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '0.5rem', marginTop: '0.5rem' }}>
            <label>{t('transfer.quantity')}<input className="input-control" type="number" min="1" max="100" value={sealedQuantity} onChange={event => setSealedQuantity(event.target.value)} /></label>
            <label>{t('transfer.external.originProduct')}<input className="input-control" value={originName} onChange={event => setOriginName(event.target.value)} /></label>
            <label>{t('transfer.external.originUnit')}<input className="input-control" type="number" min="1" value={originUnitNumber} onChange={event => setOriginUnitNumber(event.target.value)} /></label>
            <button type="button" className="btn btn-secondary" disabled={disabled} onClick={addReceivedSealed}>
              <Plus size={14} /> {t('transfer.external.addReceived')}
            </button>
          </div>
        )}
      </div>
      {items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {items.map((item, index) => (
            <div key={`${item.type}:${item.card_id || item.product_name}:${index}`} className="glass-panel" style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', padding: '0.5rem' }}>
              <span style={{ flex: 1, minWidth: 0, color: 'var(--text-strong)', fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name || item.product_name}</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                {t('transfer.quantity')}
                <input
                  type="number"
                  className="input-control"
                  min="1"
                  max="100"
                  value={item.quantity}
                  disabled={disabled}
                  onChange={event => updateReceivedQuantity(item, event.target.value)}
                  style={{ width: '4.5rem', padding: '0.45rem 0.55rem' }}
                />
              </label>
              <button
                type="button"
                className="btn btn-secondary"
                aria-label={t('transfer.external.removeItem')}
                title={t('transfer.external.removeItem')}
                disabled={disabled}
                onClick={() => onItemsChange(current => current.filter(row => row !== item))}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The deals recorded so far, a page at a time (`list` is useTransfers'
// external list). `expandedIds` (strings) are the ones shown open.
export function ExternalDealHistory({ list, expandedIds, onToggle }) {
  const { t, locale } = useT();
  const { items: transactions, loaded, error } = list;
  return (
    <section className="glass-panel" style={{ padding: '1rem' }}>
      <h3 style={{ color: 'var(--text-strong)', margin: '0 0 0.5rem' }}>{t('transfer.external.history')}</h3>
      {error && !loaded && <div role="alert" style={{ color: 'var(--accent-red)' }}>{apiErrorText(t, error.body, 'transfer.external.errLoad')}</div>}
      {!loaded && !error ? <p style={{ color: 'var(--text-secondary)' }}>{t('common.loading')}</p>
        : loaded && transactions.length === 0 ? <p style={{ color: 'var(--text-secondary)' }}>{t('transfer.external.noHistory')}</p> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
            {transactions.map(transaction => (
              <details
                key={transaction.id}
                id={`external-trade-${transaction.id}`}
                className="glass-panel"
                open={expandedIds.has(String(transaction.id))}
                onToggle={event => onToggle(String(transaction.id), event.currentTarget.open)}
                style={{ padding: '0.65rem' }}
              >
                <summary style={{ cursor: 'pointer', color: 'var(--text-strong)' }}>
                  <strong>{transaction.contact_name} · {t(transaction.transaction_type === 'gift' ? 'transfer.gift' : 'transfer.trade')}</strong>
                  <span style={{ display: 'block', color: 'var(--text-secondary)', fontSize: '0.72rem' }}>
                    {timestampText(transaction.completed_at || transaction.created_at, locale)}
                  </span>
                </summary>
                {(transaction.items || []).map((item) => {
                  const given = item.direction === 'given';
                  const cost = given ? item.purchase_cost : item.received_cost;
                  return (
                    <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', padding: '0.3rem 0', fontSize: '0.8rem' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {t(given ? 'transfer.external.givenItem' : 'transfer.external.receivedItem', { item: itemName(item, t) })}
                      </span>
                      <span style={{ whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{costText(cost, locale) ?? t('transfer.unknownCost')}</span>
                    </div>
                  );
                })}
                {transaction.message && <p style={{ margin: '0.25rem 0', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>{transaction.message}</p>}
              </details>
            ))}
            <LoadMore list={list} />
          </div>
        )}
    </section>
  );
}
