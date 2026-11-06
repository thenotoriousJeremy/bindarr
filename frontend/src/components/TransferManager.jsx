import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, Check, Gift, RefreshCw, X } from 'lucide-react';
import { getFoilOverlayClass, getPrintingBadgeLabel, getPrintingBadgeStyle } from '../utils/cardPrinting';
import { getCardRarityBorder, getRarityBadgeLabel, getRarityBadgeStyle } from '../utils/cardRarity';
import { sortCardsByOrder } from '../utils/cardSort';
import { useT } from '../utils/i18n';
import { GAMES } from '../utils/games';
import CardImage from './CardImage';
import ExternalDealManager from './ExternalDealManager';

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

const itemKey = item => `${item.type}:${item.id}`;
const itemLabel = item => item.type === 'card'
  ? item.name || item.printed_name || item.card_id
  : item.product_name;
const transferPages = ['new', 'offers', 'history'];
const locationFilterKey = item => item.location_id == null
  ? 'unsorted'
  : String(item.location_id);
const itemCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function cardLocationLabel(item, t) {
  if (item.location_id == null) return t('transfer.unsortedLocation');
  return item.location_name || t('transfer.unknownLocation');
}

function matchesItemFilters(item, filters) {
  if (filters.type !== 'all' && item.type !== filters.type) return false;
  if (filters.game && String(item.game || '').toLowerCase() !== filters.game) return false;
  if (filters.location && (item.type !== 'card' || locationFilterKey(item) !== filters.location)) return false;
  const query = filters.query.trim().toLowerCase();
  if (!query) return true;
  const haystack = [
    item.name,
    item.printed_name,
    item.product_name,
    item.set_name,
    item.number,
    item.sealed_type,
    item.origin_product_name
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(query);
}

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
  const criteria = {
    'name-asc': [{ by: 'name', dir: 'asc' }],
    'name-desc': [{ by: 'name', dir: 'desc' }],
    'set-asc': [{ by: 'set', dir: 'asc' }, { by: 'number', dir: 'asc' }],
    'number-asc': [{ by: 'number', dir: 'asc' }, { by: 'name', dir: 'asc' }]
  };
  return sortCardsByOrder(normalized, criteria[sort] || criteria['name-asc'], undefined, setsList);
}

function TransferField({ id, label, children }) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

function TransferItem({ item, currentUserId, t }) {
  const snapshot = item.item_snapshot || item;
  const sentByYou = item.from_user_id === currentUserId;
  const cost = sentByYou ? item.purchase_cost : item.received_cost;
  const name = snapshot.name || snapshot.product_name || t('transfer.unknownItem');
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem', padding: '0.45rem 0', borderBottom: '1px solid var(--border-glass)' }}>
      <div style={{ minWidth: 0 }}>
        <strong style={{ color: 'var(--text-strong)' }}>{item.quantity > 1 ? `${item.quantity}× ` : ''}{name}</strong>
        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          {item.item_type === 'card'
            ? [
              snapshot.set_name,
              snapshot.number && `#${snapshot.number}`,
              snapshot.printing && `${t('transfer.printing')}: ${snapshot.printing}`,
              snapshot.condition,
              snapshot.language
            ].filter(Boolean).join(' · ')
            : [snapshot.sealed_type, snapshot.origin_product_name && t('transfer.fromProduct', { product: snapshot.origin_product_name })].filter(Boolean).join(' · ')}
        </div>
      </div>
      <span style={{ whiteSpace: 'nowrap', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
        {cost == null ? t('transfer.unknownCost') : `$${Number(cost).toFixed(2)}`}
      </span>
    </div>
  );
}

export default function TransferManager({ user, showToast }) {
  const { t } = useT();
  const [activePage, setActivePage] = useState('new');
  const [users, setUsers] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [myCards, setMyCards] = useState([]);
  const [mySealed, setMySealed] = useState([]);
  const [setsList, setSetsList] = useState([]);
  const [markedItems, setMarkedItems] = useState({ cards: [], sealed: [] });
  const [recipientId, setRecipientId] = useState('');
  const [transferType, setTransferType] = useState('gift');
  const [offered, setOffered] = useState({});
  const [requested, setRequested] = useState({});
  const [countering, setCountering] = useState(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [offerFilters, setOfferFilters] = useState({ query: '', game: '', type: 'all', location: '', sort: 'name-asc' });
  const [requestFilters, setRequestFilters] = useState({ query: '', game: '', type: 'all', sort: 'name-asc' });

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [transferData, userData, collectionData, sealedData] = await Promise.all([
        requestJson('/api/transfers'),
        requestJson('/api/transfers/users'),
        requestJson('/api/collection?list_type=collection'),
        requestJson('/api/sealed/units?opened=0')
      ]);
      setTransfers(transferData.transfers || []);
      setUsers(userData.users || []);
      setMyCards(Array.isArray(collectionData) ? collectionData : []);
      setMySealed(sealedData.units || []);
    } catch (err) {
      setError(err.message || t('transfer.errLoad'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch('/api/sets')
      .then(response => {
        if (!response.ok) throw new Error(`Request failed (${response.status})`);
        return response.json();
      })
      .then(setSetsList)
      .catch(err => console.error('Error fetching sets for transfer sorting:', err));
  }, []);

  useEffect(() => {
    let active = true;
    if (!recipientId) {
      setMarkedItems({ cards: [], sealed: [] });
      return () => { active = false; };
    }
    requestJson(`/api/transfers/marked/${recipientId}`)
      .then(data => { if (active) setMarkedItems(data); })
      .catch(err => { if (active) setError(err.message || t('transfer.errLoad')); });
    return () => { active = false; };
  }, [recipientId, t]);

  const explicitItemsFromCounter = useMemo(() => {
    if (!countering) return [];
    return countering.items
      .filter(item => item.from_user_id === countering.proposer_id)
      .map(item => ({
        type: item.item_type,
        id: item.item_type === 'card' ? item.source_collection_id : item.source_sealed_unit_id,
        quantity: 1,
        name: item.item_snapshot?.name || item.item_snapshot?.product_name,
        printed_name: item.item_snapshot?.printed_name,
        set_name: item.item_snapshot?.set_name,
        number: item.item_snapshot?.number,
        rarity: item.item_snapshot?.rarity,
        image_url: item.item_snapshot?.image_url,
        game: item.item_snapshot?.game,
        sealed_type: item.item_snapshot?.sealed_type,
        origin_product_name: item.item_snapshot?.origin_product_name,
        explicit: true
      }))
      .filter(item => item.id);
  }, [countering]);

  const requestedOptions = useMemo(() => {
    const marked = [
      ...(markedItems.cards || []).map(item => ({ ...item, type: 'card', id: item.entry_id })),
      ...(markedItems.sealed || []).map(item => ({ ...item, type: 'sealed', id: item.unit_id }))
    ];
    const combined = [...marked, ...explicitItemsFromCounter];
    return combined.filter((item, index) => combined.findIndex(other => itemKey(other) === itemKey(item)) === index);
  }, [markedItems, explicitItemsFromCounter]);

  const selectedOfferItems = Object.values(offered);
  const selectedRequestItems = Object.values(requested);
  const pendingIncoming = transfers.filter(item => item.status === 'pending' && item.recipient_id === user.id);
  const pendingOutgoing = transfers.filter(item => item.status === 'pending' && item.proposer_id === user.id);
  const history = transfers.filter(item => item.status !== 'pending');

  const setSelection = (setter, selected, item, isSelected) => {
    const key = itemKey(item);
    setter(current => {
      const next = { ...current };
      if (isSelected) next[key] = { type: item.type, id: item.id, quantity: item.type === 'card' ? (selected[key]?.quantity || 1) : 1 };
      else delete next[key];
      return next;
    });
  };

  const updateQuantity = (setter, selected, item, quantity) => {
    const value = Math.max(1, Math.min(Number(item.quantity) || 1, Number(quantity) || 1));
    setter(current => ({ ...current, [itemKey(item)]: { ...current[itemKey(item)], quantity: value } }));
  };

  const resetComposer = () => {
    setOffered({});
    setRequested({});
    setMessage('');
    setCountering(null);
    setRecipientId('');
    setTransferType('gift');
  };

  const submitProposal = async (event) => {
    event.preventDefault();
    if (!recipientId || selectedOfferItems.length === 0) return;
    if (countering && selectedRequestItems.length === 0) return;
    setSaving(true);
    setError('');
    try {
      const body = {
        recipient_id: Number(recipientId),
        transfer_type: countering ? 'trade' : transferType,
        offered_items: selectedOfferItems,
        requested_items: countering || transferType === 'trade' ? selectedRequestItems : [],
        message
      };
      await requestJson(countering ? `/api/transfers/${countering.id}/counter` : '/api/transfers', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      showToast?.(countering ? t('transfer.counterSent') : t('transfer.proposalSent'));
      resetComposer();
      setActivePage('offers');
      await load();
    } catch (err) {
      setError(err.message || t('transfer.errSave'));
    } finally {
      setSaving(false);
    }
  };

  const actOnTransfer = async (transfer, action) => {
    setSaving(true);
    setError('');
    try {
      await requestJson(`/api/transfers/${transfer.id}/${action}`, { method: 'PUT' });
      if (action === 'accept') showToast?.(t('transfer.accepted'));
      if (action === 'reject') showToast?.(t('transfer.rejected'));
      if (action === 'cancel') showToast?.(t('transfer.cancelled'));
      await load();
    } catch (err) {
      setError(err.message || t('transfer.errAction'));
    } finally {
      setSaving(false);
    }
  };

  const startCounter = (transfer) => {
    setCountering(transfer);
    setActivePage('new');
    setRecipientId(String(transfer.proposer_id));
    setTransferType('trade');
    setOffered({});
    setRequested({});
    setMessage('');
  };

  const toggleSealedTrade = async (unit) => {
    try {
      await requestJson(`/api/transfers/sealed/${unit.id}/trade`, {
        method: 'PUT',
        body: JSON.stringify({ is_trade: !unit.is_trade })
      });
      await load();
    } catch (err) {
      setError(err.message || t('transfer.errAction'));
    }
  };

  const handleTabKeyDown = (event) => {
    const currentIndex = transferPages.indexOf(activePage);
    let nextIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % transferPages.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex + transferPages.length - 1) % transferPages.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = transferPages.length - 1;
    else return;
    event.preventDefault();
    const nextPage = transferPages[nextIndex];
    setActivePage(nextPage);
    document.getElementById(`transfer-tab-${nextPage}`)?.focus();
  };

  const renderChoices = (items, selected, setter, filters, setFilters, isRequest = false) => {
    const fieldPrefix = isRequest ? 'transfer-request' : 'transfer-offer';
    const filteredItems = sortItems(
      items.filter(item => matchesItemFilters(item, filters)),
      filters.sort,
      t,
      setsList
    );
    const updateFilter = (key, value) => setFilters(current => ({ ...current, [key]: value }));
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.65rem' }}>
          <TransferField id={`${fieldPrefix}-search`} label={t('transfer.searchItems')}>
            <input
              id={`${fieldPrefix}-search`}
              className="input-control"
              type="search"
              value={filters.query}
              placeholder={t('transfer.searchItems')}
              onChange={event => updateFilter('query', event.target.value)}
            />
          </TransferField>
          <TransferField id={`${fieldPrefix}-game`} label={t('transfer.filterGame')}>
            <select
              id={`${fieldPrefix}-game`}
              className="select-control"
              value={filters.game}
              onChange={event => updateFilter('game', event.target.value)}
            >
              <option value="">{t('transfer.allGames')}</option>
              {GAMES.map(game => <option key={game.value} value={game.value}>{game.label}</option>)}
            </select>
          </TransferField>
          <TransferField id={`${fieldPrefix}-type`} label={t('transfer.filterType')}>
            <select
              id={`${fieldPrefix}-type`}
              className="select-control"
              value={filters.type}
              onChange={event => updateFilter('type', event.target.value)}
            >
              <option value="all">{t('transfer.allItems')}</option>
              <option value="card">{t('transfer.cardsOnly')}</option>
              <option value="sealed">{t('transfer.sealedOnly')}</option>
            </select>
          </TransferField>
          {!isRequest && (
            <TransferField id={`${fieldPrefix}-location`} label={t('transfer.filterLocation')}>
              <select
                id={`${fieldPrefix}-location`}
                className="select-control"
                value={filters.location}
                onChange={event => updateFilter('location', event.target.value)}
              >
                <option value="">{t('transfer.anyLocation')}</option>
                {locationOptions.map(location => (
                  <option key={location.key} value={location.key}>{location.label}</option>
                ))}
              </select>
            </TransferField>
          )}
          <TransferField id={`${fieldPrefix}-sort`} label={t('collection.sortBy')}>
            <select
              id={`${fieldPrefix}-sort`}
              className="select-control"
              value={filters.sort}
              onChange={event => updateFilter('sort', event.target.value)}
            >
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
            {items.length === 0
              ? (isRequest ? t('transfer.noMarkedItems') : t('transfer.noInventory'))
              : t('transfer.noFilterResults')}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '0.65rem', maxHeight: '24rem', overflowY: 'auto', padding: '0.1rem' }}>
            {filteredItems.map(item => {
              const key = itemKey(item);
              const checked = Boolean(selected[key]);
              const label = itemLabel(item);
              return (
              <article key={key} className="glass-panel" style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', padding: '0.6rem', minWidth: 0 }}>
                <input
                  type="checkbox"
                  checked={checked}
                  aria-label={label}
                  onChange={event => setSelection(setter, selected, item, event.target.checked)}
                />
                <div
                  style={{
                    position: 'relative',
                    width: '3.75rem',
                    height: '5.2rem',
                    flex: '0 0 auto',
                    overflow: 'hidden',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--surface-2)',
                    ...(item.type === 'card' ? getCardRarityBorder(item.rarity) : {})
                  }}
                >
                  {item.type === 'card' ? (
                    <CardImage
                      card={item}
                      alt=""
                      loading="lazy"
                      draggable={false}
                      style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'var(--radius-sm)' }}
                    />
                  ) : item.image_url ? (
                    <img src={item.image_url} alt="" loading="lazy" onError={event => { event.currentTarget.style.visibility = 'hidden'; }} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                  ) : null}
                  {item.type === 'card' && getFoilOverlayClass(item.printing) && (
                    <div className={getFoilOverlayClass(item.printing)} style={{ borderRadius: 'var(--radius-sm)' }} />
                  )}
                  {item.type === 'card' && (
                    <span style={{
                      position: 'absolute',
                      top: '3px',
                      left: '3px',
                      zIndex: 2,
                      fontSize: '0.55rem',
                      fontWeight: 900,
                      padding: '2px 3px',
                      borderRadius: '3px',
                      textTransform: 'uppercase',
                      ...getRarityBadgeStyle(item.rarity)
                    }}>
                      {getRarityBadgeLabel(item.rarity)}
                    </span>
                  )}
                  {item.type === 'card' && item.printing !== 'Normal' && getPrintingBadgeLabel(item.printing) && (
                    <span style={{
                      position: 'absolute',
                      right: '3px',
                      bottom: '3px',
                      zIndex: 2,
                      fontSize: '0.55rem',
                      fontWeight: 800,
                      padding: '2px 3px',
                      borderRadius: '3px',
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      ...getPrintingBadgeStyle(item.printing)
                    }}>
                      {getPrintingBadgeLabel(item.printing)}
                    </span>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  <strong title={label} style={{ color: 'var(--text-strong)', fontSize: '0.95rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</strong>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.type === 'card'
                      ? [item.set_name, item.number && `#${item.number}`].filter(Boolean).join(' · ')
                      : [item.sealed_type, item.origin_product_name && t('transfer.fromProduct', { product: item.origin_product_name })].filter(Boolean).join(' · ')}
                  </span>
                  {item.type === 'card' && (
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {[
                        item.printing && `${t('transfer.printing')}: ${item.printing}`,
                        item.condition,
                        item.language
                      ].filter(Boolean).join(' · ')}
                    </span>
                  )}
                  {item.type === 'card' && !isRequest && (
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t('transfer.location')}: {cardLocationLabel(item, t)}
                    </span>
                  )}
                  {item.type === 'card' && (
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                      {t('transfer.availableQuantity', { count: item.quantity || 1 })}
                    </span>
                  )}
                  {item.type === 'card' && checked && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                      {t('transfer.quantity')}
                      <input
                        type="number"
                        className="input-control"
                        min="1"
                        max={item.quantity || 1}
                        value={selected[key].quantity}
                        aria-label={t('transfer.quantity')}
                        onChange={event => updateQuantity(setter, selected, item, event.target.value)}
                        style={{ width: '4.5rem', padding: '0.45rem 0.55rem' }}
                      />
                    </label>
                  )}
                  {!isRequest && item.type === 'sealed' && (
                    <button type="button" className="btn btn-secondary" style={{ alignSelf: 'flex-start', padding: '0.35rem 0.55rem', fontSize: '0.8rem' }}
                      onClick={() => toggleSealedTrade(item)}>
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
  };

  const transferCard = (transfer, incoming) => {
    const oneSidedTrade = transfer.transfer_type === 'trade'
      && !transfer.items.some(item => item.from_user_id === transfer.recipient_id);
    return (
      <article key={transfer.id} className="glass-panel" style={{ padding: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {transfer.transfer_type === 'gift' ? <Gift size={16} /> : <ArrowLeftRight size={16} />}
          <strong style={{ color: 'var(--text-strong)' }}>
            {incoming
              ? t('transfer.fromUser', { user: transfer.proposer_username })
              : t('transfer.toUser', { user: transfer.recipient_username })}
          </strong>
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>{t(`transfer.status.${transfer.status}`)}</span>
        </div>
        {incoming && transfer.status === 'pending' ? (
          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
            {!oneSidedTrade && <button type="button" className="btn btn-primary" disabled={saving} onClick={() => actOnTransfer(transfer, 'accept')}><Check size={14} /> {t('transfer.accept')}</button>}
            <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => startCounter(transfer)}><RefreshCw size={14} /> {t('transfer.counter')}</button>
            <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => actOnTransfer(transfer, 'reject')}><X size={14} /> {t('transfer.reject')}</button>
          </div>
        ) : !incoming && transfer.status === 'pending' ? (
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => actOnTransfer(transfer, 'cancel')}>{t('transfer.cancel')}</button>
        ) : null}
      </div>
      {incoming && transfer.status === 'pending' && oneSidedTrade && (
        <p role="note" style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0.6rem 0 0' }}>
          {t('transfer.counterRequired')}
        </p>
      )}
      {transfer.message && <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', margin: '0.5rem 0' }}>{transfer.message}</p>}
      <div style={{ marginTop: '0.5rem' }}>
        {transfer.items.map(item => <TransferItem key={item.id} item={item} currentUserId={user.id} t={t} />)}
      </div>
      {transfer.deck_warnings?.map(warning => (
        <div key={`${warning.card_id}-${warning.user_id}`} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--accent-yellow)', fontSize: '0.78rem', marginTop: '0.5rem' }}>
          <AlertTriangle size={14} /> {warning.message}
        </div>
      ))}
      </article>
    );
  };

  const ownOfferItems = [
    ...myCards.map(item => ({ ...item, type: 'card', id: item.entry_id })),
    ...mySealed.map(item => ({ ...item, type: 'sealed', id: item.id }))
  ];
  const locationOptions = useMemo(() => {
    const options = new Map();
    for (const card of myCards) {
      const key = locationFilterKey(card);
      options.set(key, { key, label: cardLocationLabel(card, t) });
    }
    return [...options.values()].sort((a, b) => itemCollator.compare(a.label, b.label));
  }, [myCards, t]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1rem' }}>
      <header>
        <h2 style={{ color: 'var(--text-strong)', margin: 0 }}>{t('transfer.title')}</h2>
        <p style={{ color: 'var(--text-secondary)', margin: '0.35rem 0 0' }}>{t('transfer.subtitle')}</p>
      </header>

      {error && <div role="alert" className="glass-panel" style={{ padding: '0.75rem', color: 'var(--accent-red)' }}>{error}</div>}

      <nav role="tablist" aria-label={t('transfer.title')} onKeyDown={handleTabKeyDown} style={{ display: 'flex', gap: '0.45rem', overflowX: 'auto', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.65rem' }}>
        {[
          { id: 'new', label: t('transfer.newProposal') },
          { id: 'offers', label: t('transfer.offersTab'), count: pendingIncoming.length + pendingOutgoing.length },
          { id: 'history', label: t('transfer.historyTab'), count: history.length }
        ].map(page => (
          <button
            key={page.id}
            type="button"
            role="tab"
            id={`transfer-tab-${page.id}`}
            aria-selected={activePage === page.id}
            aria-controls={`transfer-panel-${page.id}`}
            tabIndex={activePage === page.id ? 0 : -1}
            className={`btn ${activePage === page.id ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActivePage(page.id)}
            style={{ whiteSpace: 'nowrap' }}
          >
            {page.label}
            {page.count > 0 && <span style={{ marginLeft: '0.4rem', opacity: 0.8 }}>{page.count}</span>}
          </button>
        ))}
      </nav>

      <div id="transfer-panel-new" role="tabpanel" aria-labelledby="transfer-tab-new" tabIndex={0} hidden={activePage !== 'new'}>
      {activePage === 'new' && <form className="glass-panel" onSubmit={submitProposal} style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
        <h3 style={{ margin: 0, color: 'var(--text-strong)' }}>
          {countering ? t('transfer.countering', { user: countering.proposer_username }) : t('transfer.newProposal')}
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.65rem' }}>
          <TransferField id="transfer-recipient" label={t('transfer.recipient')}>
            <select id="transfer-recipient" className="select-control" value={recipientId} disabled={Boolean(countering)} onChange={event => setRecipientId(event.target.value)} required>
              <option value="">{t('transfer.chooseUser')}</option>
              {users.map(other => <option key={other.id} value={other.id}>{other.username}</option>)}
            </select>
          </TransferField>
          {!countering && (
            <TransferField id="transfer-type" label={t('transfer.type')}>
              <select id="transfer-type" className="select-control" value={transferType} onChange={event => setTransferType(event.target.value)}>
                <option value="gift">{t('transfer.gift')}</option>
                <option value="trade">{t('transfer.trade')}</option>
              </select>
            </TransferField>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1rem' }}>
          <section>
            <h4 style={{ color: 'var(--text-strong)', margin: '0 0 0.25rem' }}>{t('transfer.offer')}</h4>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0 0 0.5rem' }}>{t('transfer.offerHint')}</p>
            {renderChoices(ownOfferItems, offered, setOffered, offerFilters, setOfferFilters)}
          </section>
          {(countering || transferType === 'trade') && (
            <section>
              <h4 style={{ color: 'var(--text-strong)', margin: '0 0 0.25rem' }}>{t('transfer.request')}</h4>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0 0 0.5rem' }}>
                {t(countering ? 'transfer.requestHint' : 'transfer.requestHintInitial')}
              </p>
              {renderChoices(requestedOptions, requested, setRequested, requestFilters, setRequestFilters, true)}
            </section>
          )}
        </div>

        <TransferField id="transfer-message" label={t('transfer.message')}>
          <textarea id="transfer-message" className="input-control" value={message} maxLength={1000} rows={2} onChange={event => setMessage(event.target.value)} placeholder={t('transfer.messagePlaceholder')} />
        </TransferField>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="submit" className="btn btn-primary" disabled={saving || loading || !recipientId || !selectedOfferItems.length || (countering && !selectedRequestItems.length)}>
            {countering ? <RefreshCw size={15} /> : transferType === 'gift' ? <Gift size={15} /> : <ArrowLeftRight size={15} />}
            {countering ? t('transfer.sendCounter') : t('transfer.sendProposal')}
          </button>
          {countering && <button type="button" className="btn btn-secondary" onClick={resetComposer}>{t('common.cancel')}</button>}
        </div>
      </form>}
      </div>

      <div id="transfer-panel-offers" role="tabpanel" aria-labelledby="transfer-tab-offers" tabIndex={0} hidden={activePage !== 'offers'} style={{ display: activePage === 'offers' ? 'flex' : 'none', flexDirection: 'column', gap: '1rem' }}>
      {activePage === 'offers' && <>
      <section style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
        <h3 style={{ margin: 0, color: 'var(--text-strong)' }}>{t('transfer.pendingIncoming')}</h3>
        {pendingIncoming.length ? pendingIncoming.map(item => transferCard(item, true)) : <p style={{ color: 'var(--text-secondary)' }}>{t('transfer.noneIncoming')}</p>}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
        <h3 style={{ margin: 0, color: 'var(--text-strong)' }}>{t('transfer.pendingOutgoing')}</h3>
        {pendingOutgoing.length ? pendingOutgoing.map(item => transferCard(item, false)) : <p style={{ color: 'var(--text-secondary)' }}>{t('transfer.noneOutgoing')}</p>}
      </section>
      </>}
      </div>

      <div id="transfer-panel-history" role="tabpanel" aria-labelledby="transfer-tab-history" tabIndex={0} hidden={activePage !== 'history'} style={{ display: activePage === 'history' ? 'flex' : 'none', flexDirection: 'column', gap: '1rem' }}>
      {activePage === 'history' && <>
      <section style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
        <h3 style={{ margin: 0, color: 'var(--text-strong)' }}>{t('transfer.history')}</h3>
        {loading ? <p style={{ color: 'var(--text-secondary)' }}>{t('common.loading')}</p>
          : history.length ? history.map(item => transferCard(item, item.proposer_id !== user.id))
            : <p style={{ color: 'var(--text-secondary)' }}>{t('transfer.noHistory')}</p>}
      </section>

      <ExternalDealManager showToast={showToast} onInventoryChange={load} />
      </>}
      </div>
    </div>
  );
}
