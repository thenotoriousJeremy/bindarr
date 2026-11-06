import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, Check, Gift, RefreshCw, X } from 'lucide-react';
import { getFoilOverlayClass, getPrintingBadgeLabel, getPrintingBadgeStyle } from '../utils/cardPrinting';
import { getCardRarityBorder, getRarityBadgeLabel, getRarityBadgeStyle } from '../utils/cardRarity';
import { sortCardsByOrder } from '../utils/cardSort';
import { useT } from '../utils/i18n';
import { GAMES } from '../utils/games';
import { groupTransferHistory } from '../utils/transferHistory';
import { counterSelections } from '../utils/transferSelection';
import CardImage from './CardImage';
import { ExternalDealHistory, ExternalReceivedItems } from './ExternalDealComponents';
import HistoricalTradeModal from './HistoricalTradeModal';

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

function TransferItem({ item, currentUserId, t, location, showCost = true }) {
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
        {location && item.item_type === 'card' && (
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('transfer.location')}: {cardLocationLabel(location, t)}
          </div>
        )}
      </div>
      {showCost && (
        <span style={{ whiteSpace: 'nowrap', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
          {cost == null ? t('transfer.unknownCost') : `$${Number(cost).toFixed(2)}`}
        </span>
      )}
    </div>
  );
}

export default function TransferManager({
  user,
  showToast,
  initialOffer,
  historyFocus,
  onInitialOfferHandled,
  onHistoryFocusHandled
}) {
  const { t } = useT();
  const [activePage, setActivePage] = useState('new');
  const [users, setUsers] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [historicalTrades, setHistoricalTrades] = useState([]);
  const [historicalModal, setHistoricalModal] = useState(null);
  const [myCards, setMyCards] = useState([]);
  const [mySealed, setMySealed] = useState([]);
  const [setsList, setSetsList] = useState([]);
  const [markedItems, setMarkedItems] = useState({ cards: [], sealed: [] });
  const [recipientSelection, setRecipientSelection] = useState('');
  const [transferType, setTransferType] = useState('gift');
  const [giftDirection, setGiftDirection] = useState('given');
  const [offered, setOffered] = useState({});
  const [requested, setRequested] = useState({});
  const [receivedItems, setReceivedItems] = useState([]);
  const [countering, setCountering] = useState(null);
  const [addingContact, setAddingContact] = useState(false);
  const [newContactName, setNewContactName] = useState('');
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [offerFilters, setOfferFilters] = useState({ query: '', game: '', type: 'all', location: '', sort: 'name-asc' });
  const [requestFilters, setRequestFilters] = useState({ query: '', game: '', type: 'all', sort: 'name-asc' });
  const [expandedHistoryGroupIds, setExpandedHistoryGroupIds] = useState(() => new Set());
  const [historyScrollTargetId, setHistoryScrollTargetId] = useState(null);
  const [historicalScrollTargetId, setHistoricalScrollTargetId] = useState(null);
  const handledOfferRef = useRef(null);
  const handledHistoryFocusRef = useRef(null);

  const [recipientType, recipientValue] = recipientSelection.split(':');
  const isExternalRecipient = recipientType === 'contact';
  const recipientId = recipientType === 'user' ? recipientValue : '';
  const externalContactId = isExternalRecipient ? recipientValue : '';

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [transferData, historyData, userData, collectionData, sealedData, contactData] = await Promise.all([
        requestJson('/api/transfers'),
        requestJson('/api/transfers/history'),
        requestJson('/api/transfers/users'),
        requestJson('/api/collection?list_type=collection'),
        requestJson('/api/sealed/units?opened=0'),
        requestJson('/api/transfers/external/contacts')
      ]);
      setTransfers(transferData.transfers || []);
      setHistoricalTrades(historyData.trades || []);
      setUsers(userData.users || []);
      setMyCards(Array.isArray(collectionData) ? collectionData : []);
      setMySealed(sealedData.units || []);
      setContacts(contactData.contacts || []);
    } catch (err) {
      setError(err.message || t('transfer.errLoad'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!initialOffer || loading || handledOfferRef.current === initialOffer.requestId) return;
    handledOfferRef.current = initialOffer.requestId;
    const card = myCards.find(item => String(item.entry_id) === String(initialOffer.entryId));
    if (!card) {
      showToast?.(t('transfer.cardUnavailable'));
    } else {
      setActivePage('new');
      setRecipientSelection('');
      setTransferType('trade');
      setCountering(null);
      setOffered({
        [`card:${card.entry_id}`]: { type: 'card', id: card.entry_id, quantity: 1 }
      });
      setRequested({});
      setReceivedItems([]);
      setMessage('');
    }
    onInitialOfferHandled?.(initialOffer.requestId);
  }, [initialOffer, loading, myCards, onInitialOfferHandled, showToast, t]);

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

  const myCardsById = useMemo(
    () => new Map(myCards.map(card => [card.entry_id, card])),
    [myCards]
  );
  const ownItemsByKey = useMemo(() => new Map([
    ...myCards.map(card => [`card:${card.entry_id}`, card]),
    ...mySealed.map(unit => [`sealed:${unit.id}`, unit])
  ]), [myCards, mySealed]);

  const explicitItemsFromCounter = useMemo(() => {
    if (!countering) return [];
    const itemsByKey = new Map();
    for (const item of countering.items) {
      if (item.from_user_id !== countering.proposer_id) continue;
      const type = item.item_type;
      const id = type === 'card' ? item.source_collection_id : item.source_sealed_unit_id;
      if (!id) continue;
      const key = itemKey({ type, id });
      const existing = itemsByKey.get(key);
      if (existing) {
        existing.quantity += type === 'card' ? Number(item.quantity) || 1 : 1;
        continue;
      }
      itemsByKey.set(key, {
        type,
        id,
        quantity: type === 'card' ? Number(item.quantity) || 1 : 1,
        name: item.item_snapshot?.name || item.item_snapshot?.product_name,
        printed_name: item.item_snapshot?.printed_name,
        set_name: item.item_snapshot?.set_name,
        number: item.item_snapshot?.number,
        rarity: item.item_snapshot?.rarity,
        image_url: item.item_snapshot?.image_url,
        game: item.item_snapshot?.game,
        printing: item.item_snapshot?.printing,
        condition: item.item_snapshot?.condition,
        language: item.item_snapshot?.language,
        sealed_type: item.item_snapshot?.sealed_type,
        origin_product_name: item.item_snapshot?.origin_product_name,
        explicit: true
      });
    }
    return [...itemsByKey.values()];
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
  const historyGroups = useMemo(() => groupTransferHistory(transfers), [transfers]);

  useEffect(() => {
    if (historyFocus?.type !== 'internal' || loading) return;
    const requestId = historyFocus.requestId ?? `internal:${historyFocus.id}`;
    if (handledHistoryFocusRef.current === requestId) return;
    handledHistoryFocusRef.current = requestId;
    const group = historyGroups.find(item =>
      item.transfers.some(transfer => String(transfer.id) === String(historyFocus.id))
    );
    if (group) {
      const rootId = String(group.root.id);
      setActivePage('history');
      setExpandedHistoryGroupIds(current => new Set([...current, rootId]));
      setHistoryScrollTargetId(rootId);
    } else {
      setError(t('transfer.historyUnavailable'));
    }
    onHistoryFocusHandled?.(requestId);
  }, [historyFocus, historyGroups, loading, onHistoryFocusHandled, t]);

  useEffect(() => {
    if (historyFocus?.type !== 'historical' || loading) return;
    const requestId = historyFocus.requestId ?? `historical:${historyFocus.id}`;
    if (handledHistoryFocusRef.current === requestId) return;
    handledHistoryFocusRef.current = requestId;
    const trade = historicalTrades.find(item => String(item.id) === String(historyFocus.id));
    if (trade) {
      setActivePage('history');
      setHistoricalScrollTargetId(String(trade.id));
    } else {
      setError(t('transfer.historyUnavailable'));
    }
    onHistoryFocusHandled?.(requestId);
  }, [historyFocus, historicalTrades, loading, onHistoryFocusHandled, t]);

  useEffect(() => {
    if (activePage !== 'history' || !historyScrollTargetId) return;
    document.getElementById(`transfer-history-${historyScrollTargetId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHistoryScrollTargetId(null);
  }, [activePage, historyScrollTargetId]);

  useEffect(() => {
    if (activePage !== 'history' || !historicalScrollTargetId) return;
    document.getElementById(`historical-trade-${historicalScrollTargetId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHistoricalScrollTargetId(null);
  }, [activePage, historicalScrollTargetId]);

  useEffect(() => {
    if (historyFocus?.type === 'external') setActivePage('history');
  }, [historyFocus]);

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

  const saveHistoricalAction = async (url, method, body, successMessage) => {
    const result = await requestJson(url, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    await load();
    showToast?.(t(successMessage));
    return result;
  };

  const resetComposer = () => {
    setOffered({});
    setRequested({});
    setReceivedItems([]);
    setMessage('');
    setCountering(null);
    setRecipientSelection('');
    setTransferType('gift');
    setGiftDirection('given');
    setAddingContact(false);
    setNewContactName('');
    setNotice('');
  };

  const addExternalContact = async () => {
    if (!newContactName.trim()) return;
    setSaving(true);
    setError('');
    try {
      const data = await requestJson('/api/transfers/external/contacts', {
        method: 'POST',
        body: JSON.stringify({ name: newContactName.trim() })
      });
      setContacts(current => [...current, data.contact].sort((a, b) => a.name.localeCompare(b.name)));
      setRequested({});
      setReceivedItems([]);
      setRecipientSelection(`contact:${data.contact.id}`);
      setNewContactName('');
      setAddingContact(false);
    } catch (err) {
      setError(err.message || t('transfer.external.errContact'));
    } finally {
      setSaving(false);
    }
  };

  const submitProposal = async (event) => {
    event.preventDefault();
    if (isExternalRecipient) {
      const givenItems = transferType === 'trade' || giftDirection === 'given' ? selectedOfferItems : [];
      const incomingItems = transferType === 'trade' || giftDirection === 'received' ? receivedItems : [];
      if (!externalContactId
        || (transferType === 'trade' && (!givenItems.length || !incomingItems.length))
        || (transferType === 'gift' && (giftDirection === 'given' ? !givenItems.length : !incomingItems.length))) return;
      setSaving(true);
      setError('');
      try {
        const data = await requestJson('/api/transfers/external', {
          method: 'POST',
          body: JSON.stringify({
            contact_id: Number(externalContactId),
            transaction_type: transferType,
            given_items: givenItems,
            received_items: incomingItems,
            message
          })
        });
        const savedNotice = data.warnings?.length ? t('transfer.external.deckWarning') : '';
        showToast?.(t('transfer.external.saved'));
        resetComposer();
        setNotice(savedNotice);
        setActivePage('history');
        await load();
      } catch (err) {
        setError(err.message || t('transfer.external.errSave'));
      } finally {
        setSaving(false);
      }
      return;
    }

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
    setRecipientSelection(`user:${transfer.proposer_id}`);
    setTransferType('trade');
    const selections = counterSelections(transfer, ownItemsByKey);
    setOffered(selections.offered);
    setRequested(selections.requested);
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
    const selectedItems = items.filter(item => selected[itemKey(item)]);
    const updateFilter = (key, value) => setFilters(current => ({ ...current, [key]: value }));
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {selectedItems.length > 0 && (
          <div className="glass-panel" style={{ padding: '0.65rem' }}>
            <div style={{ color: 'var(--text-strong)', fontSize: '0.82rem', fontWeight: 700, marginBottom: '0.45rem' }}>
              {t('transfer.selectedItems')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '0.4rem', maxHeight: '10rem', overflowY: 'auto' }}>
              {selectedItems.map(item => {
                const key = itemKey(item);
                const label = itemLabel(item) || t('transfer.unknownItem');
                const selection = selected[key];
                const details = item.type === 'card'
                  ? [
                    item.set_name,
                    item.number && `#${item.number}`,
                    item.printing && item.printing !== 'Normal' && item.printing,
                    !isRequest && cardLocationLabel(item, t)
                  ].filter(Boolean).join(' · ')
                  : [item.sealed_type, item.origin_product_name].filter(Boolean).join(' · ');
                return (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', minWidth: 0, padding: '0.35rem', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2)' }}>
                    <div style={{ width: '2.5rem', height: '3.5rem', flex: '0 0 auto', overflow: 'hidden', borderRadius: 'var(--radius-sm)', background: 'var(--bg-secondary)' }}>
                      {item.type === 'card'
                        ? <CardImage card={item} alt="" loading="lazy" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : item.image_url
                          ? <img src={item.image_url} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                          : null}
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <strong title={label} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-strong)', fontSize: '0.78rem' }}>
                        {selection.quantity || 1}× {label}
                      </strong>
                      <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)', fontSize: '0.7rem' }}>
                        {details || t('transfer.allItems')}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-icon-only"
                      aria-label={t('transfer.removeSelected', { item: label })}
                      title={t('transfer.removeSelected', { item: label })}
                      onClick={() => setSelection(setter, selected, item, false)}
                      style={{ width: '1.8rem', height: '1.8rem', padding: 0, flex: '0 0 auto' }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
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

  const transferCard = (transfer, incoming, readOnly = false) => {
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
        {incoming && transfer.status === 'pending' && !readOnly ? (
          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
            {!oneSidedTrade && <button type="button" className="btn btn-primary" disabled={saving} onClick={() => actOnTransfer(transfer, 'accept')}><Check size={14} /> {t('transfer.accept')}</button>}
            <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => startCounter(transfer)}><RefreshCw size={14} /> {t('transfer.counter')}</button>
            <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => actOnTransfer(transfer, 'reject')}><X size={14} /> {t('transfer.reject')}</button>
          </div>
        ) : !incoming && transfer.status === 'pending' && !readOnly ? (
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => actOnTransfer(transfer, 'cancel')}>{t('transfer.cancel')}</button>
        ) : null}
      </div>
      {readOnly && transfer.status === 'pending' && (
        <p role="note" style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0.6rem 0 0' }}>
          {t('transfer.pendingInOffers')}
        </p>
      )}
      {incoming && transfer.status === 'pending' && oneSidedTrade && !readOnly && (
        <p role="note" style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0.6rem 0 0' }}>
          {t('transfer.counterRequired')}
        </p>
      )}
      {transfer.message && <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', margin: '0.5rem 0' }}>{transfer.message}</p>}
      <div style={{ marginTop: '0.5rem' }}>
        {transfer.items.map(item => (
          <TransferItem
            key={item.id}
            item={item}
            currentUserId={user.id}
            t={t}
            location={transfer.status === 'pending' ? currentCardLocation(item) : null}
          />
        ))}
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
  const currentCardLocation = item => (
    item.item_type === 'card' && item.from_user_id === user.id
      ? myCardsById.get(item.source_collection_id) || null
      : null
  );
  const originalOfferedItems = countering?.items.filter(item => item.from_user_id === countering.proposer_id) || [];
  const originalRequestedItems = countering?.items.filter(item => item.from_user_id === countering.recipient_id) || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1rem' }}>
      <header>
        <h2 style={{ color: 'var(--text-strong)', margin: 0 }}>{t('transfer.title')}</h2>
        <p style={{ color: 'var(--text-secondary)', margin: '0.35rem 0 0' }}>{t('transfer.subtitle')}</p>
      </header>

      {error && <div role="alert" className="glass-panel" style={{ padding: '0.75rem', color: 'var(--accent-red)' }}>{error}</div>}

      <nav role="tablist" aria-label={t('transfer.title')} onKeyDown={handleTabKeyDown} style={{ display: 'flex', gap: '0.45rem', overflowX: 'auto', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.65rem' }}>
        {[
          { id: 'new', label: t('transfer.newTab') },
          { id: 'offers', label: t('transfer.offersTab'), count: pendingIncoming.length + pendingOutgoing.length },
          { id: 'history', label: t('transfer.historyTab'), count: historyGroups.length + historicalTrades.length }
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
      {!countering && (
        <div className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', padding: '0.85rem 1rem' }}>
          <div>
            <strong style={{ color: 'var(--text-strong)' }}>{t('historical.shortcutTitle')}</strong>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.84rem' }}>{t('historical.shortcutHint')}</div>
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => setHistoricalModal({ mode: 'create' })}>{t('historical.openForm')}</button>
        </div>
      )}
      <form
        className="glass-panel"
        onSubmit={submitProposal}
        style={{
          padding: '1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.9rem'
        }}
      >
        <h3 style={{ margin: 0, color: 'var(--text-strong)' }}>
          {countering
            ? t('transfer.countering', { user: countering.proposer_username })
            : isExternalRecipient ? t('transfer.external.title') : t('transfer.newProposal')}
        </h3>
        {countering && (
          <section className="glass-panel" aria-label={t('transfer.originalProposal')} style={{ padding: '0.75rem' }}>
            <h4 style={{ color: 'var(--text-strong)', margin: '0 0 0.6rem' }}>{t('transfer.originalProposal')}</h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '1rem' }}>
              <div>
                <strong style={{ color: 'var(--text-strong)' }}>{t('transfer.originallyOffered')}</strong>
                {originalOfferedItems.map(item => (
                  <TransferItem
                    key={`original-offer-${item.id}`}
                    item={item}
                    currentUserId={user.id}
                    t={t}
                    location={currentCardLocation(item)}
                    showCost={false}
                  />
                ))}
              </div>
              <div>
                <strong style={{ color: 'var(--text-strong)' }}>{t('transfer.originallyRequested')}</strong>
                {originalRequestedItems.length ? originalRequestedItems.map(item => (
                  <TransferItem
                    key={`original-request-${item.id}`}
                    item={item}
                    currentUserId={user.id}
                    t={t}
                    location={currentCardLocation(item)}
                    showCost={false}
                  />
                )) : <p style={{ color: 'var(--text-secondary)', margin: '0.45rem 0 0' }}>{t('transfer.noOriginalRequest')}</p>}
              </div>
            </div>
          </section>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.65rem' }}>
          <TransferField id="transfer-recipient" label={t('transfer.recipient')}>
            <select
              id="transfer-recipient"
              className="select-control"
              value={recipientSelection}
              disabled={Boolean(countering)}
              onChange={event => {
                if (event.target.value === '__add_external_contact__') {
                  setAddingContact(true);
                  return;
                }
                if (event.target.value !== recipientSelection) {
                  setRequested({});
                  setReceivedItems([]);
                }
                setRecipientSelection(event.target.value);
                setAddingContact(false);
              }}
              required
            >
              <option value="">{t('transfer.chooseUser')}</option>
              <optgroup label={t('transfer.bindarrUsers')}>
                {users.map(other => <option key={other.id} value={`user:${other.id}`}>{other.username}</option>)}
              </optgroup>
              <optgroup label={t('transfer.externalContacts')}>
                {contacts.map(contact => <option key={contact.id} value={`contact:${contact.id}`}>{contact.name}</option>)}
                <option value="__add_external_contact__">{t('transfer.addExternalContact')}</option>
              </optgroup>
            </select>
          </TransferField>
          {addingContact && (
            <div style={{ display: 'flex', alignItems: 'end', gap: '0.4rem' }}>
              <input
                className="input-control"
                value={newContactName}
                maxLength={100}
                placeholder={t('transfer.external.newContact')}
                aria-label={t('transfer.external.newContact')}
                onChange={event => setNewContactName(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addExternalContact();
                  }
                }}
              />
              <button type="button" className="btn btn-secondary" disabled={saving || !newContactName.trim()} onClick={addExternalContact}>
                {t('transfer.external.saveContact')}
              </button>
            </div>
          )}
          {!countering && (
            <TransferField id="transfer-type" label={t('transfer.type')}>
              <select id="transfer-type" className="select-control" value={transferType} onChange={event => setTransferType(event.target.value)}>
                <option value="gift">{t('transfer.gift')}</option>
                <option value="trade">{t('transfer.trade')}</option>
              </select>
            </TransferField>
          )}
          {isExternalRecipient && !countering && transferType === 'gift' && (
            <TransferField id="transfer-gift-direction" label={t('transfer.external.giftDirection')}>
              <select id="transfer-gift-direction" className="select-control" value={giftDirection} onChange={event => setGiftDirection(event.target.value)}>
                <option value="given">{t('transfer.external.giftGiven')}</option>
                <option value="received">{t('transfer.external.giftReceived')}</option>
              </select>
            </TransferField>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1rem' }}>
          {(!isExternalRecipient || transferType === 'trade' || giftDirection === 'given') && (
            <section>
              <h4 style={{ color: 'var(--text-strong)', margin: '0 0 0.25rem' }}>
                {isExternalRecipient ? t('transfer.external.given') : t('transfer.offer')}
              </h4>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0 0 0.5rem' }}>{t('transfer.offerHint')}</p>
              {renderChoices(ownOfferItems, offered, setOffered, offerFilters, setOfferFilters)}
            </section>
          )}
          {!isExternalRecipient && (countering || transferType === 'trade') && (
            <section>
              <h4 style={{ color: 'var(--text-strong)', margin: '0 0 0.25rem' }}>{t('transfer.request')}</h4>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0 0 0.5rem' }}>
                {t(countering ? 'transfer.requestHint' : 'transfer.requestHintInitial')}
              </p>
              {renderChoices(requestedOptions, requested, setRequested, requestFilters, setRequestFilters, true)}
            </section>
          )}
          {isExternalRecipient && (transferType === 'trade' || giftDirection === 'received') && (
            <section>
              <h4 style={{ color: 'var(--text-strong)', margin: '0 0 0.25rem' }}>{t('transfer.external.received')}</h4>
              <ExternalReceivedItems
                items={receivedItems}
                onItemsChange={setReceivedItems}
                disabled={saving || loading}
              />
            </section>
          )}
        </div>

        <TransferField id="transfer-message" label={t('transfer.message')}>
          <textarea id="transfer-message" className="input-control" value={message} maxLength={1000} rows={2} onChange={event => setMessage(event.target.value)} placeholder={t('transfer.messagePlaceholder')} />
        </TransferField>
        {notice && <div role="status" style={{ color: 'var(--accent-yellow)' }}>{notice}</div>}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || loading || !recipientSelection || (isExternalRecipient
              ? transferType === 'trade'
                ? !selectedOfferItems.length || !receivedItems.length
                : giftDirection === 'given' ? !selectedOfferItems.length : !receivedItems.length
              : !selectedOfferItems.length || (countering && !selectedRequestItems.length))}
          >
            {saving && <RefreshCw size={15} className="spin" />}
            {!saving && (countering ? <RefreshCw size={15} /> : transferType === 'gift' ? <Gift size={15} /> : <ArrowLeftRight size={15} />)}
            {isExternalRecipient
              ? saving ? t('transfer.external.saving') : t('transfer.external.save')
              : countering ? t('transfer.sendCounter') : t('transfer.sendProposal')}
          </button>
          {countering && <button type="button" className="btn btn-secondary" onClick={resetComposer}>{t('common.cancel')}</button>}
        </div>
      </form>
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.65rem', flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, color: 'var(--text-strong)' }}>{t('transfer.history')}</h3>
          <button type="button" className="btn btn-primary" onClick={() => setHistoricalModal({ mode: 'create' })}>{t('historical.openForm')}</button>
        </div>
        {loading ? <p style={{ color: 'var(--text-secondary)' }}>{t('common.loading')}</p>
          : historyGroups.length ? historyGroups.map(group => {
            const otherUser = group.root.proposer_id === user.id
              ? group.root.recipient_username
              : group.root.proposer_username;
            const outcome = group.transfers.find(item =>
              ['accepted', 'rejected', 'cancelled'].includes(item.status)
            ) || group.transfers[0];
            const outcomeItems = outcome.items.map(item => {
              const snapshot = item.item_snapshot || item;
              const name = snapshot.name || snapshot.product_name || snapshot.card_id || t('transfer.unknownItem');
              return item.from_user_id === user.id
                ? t('transfer.youOfferedItem', { item: name })
                : t('transfer.theyOfferedItem', { item: name });
            });
            return (
              <details
                key={group.root.id}
                id={`transfer-history-${group.root.id}`}
                className="glass-panel"
                open={expandedHistoryGroupIds.has(String(group.root.id))}
                onToggle={event => {
                  const rootId = String(group.root.id);
                  const isOpen = event.currentTarget.open;
                  setExpandedHistoryGroupIds(current => {
                    const next = new Set(current);
                    if (isOpen) next.add(rootId);
                    else next.delete(rootId);
                    return next;
                  });
                }}
                style={{ padding: '0.75rem' }}
              >
                <summary style={{ cursor: 'pointer', color: 'var(--text-strong)' }}>
                  <strong>{t('transfer.negotiationWith', { user: otherUser })}</strong>
                  <span style={{ marginLeft: '0.5rem', color: 'var(--text-secondary)' }}>
                    {t(`transfer.status.${outcome.status}`)}
                  </span>
                  <span style={{ display: 'block', marginTop: '0.3rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                    {outcomeItems.join(' · ')}
                  </span>
                </summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', marginTop: '0.75rem' }}>
                  {group.transfers.map(item => transferCard(item, item.proposer_id !== user.id, true))}
                </div>
              </details>
            );
          })
            : null}
        {!loading && historicalTrades.map(trade => {
          const isCreator = String(trade.creator_id) === String(user.id);
          const partner = isCreator ? trade.recipient_username : trade.creator_username;
          return (
            <article key={`past-${trade.id}`} id={`historical-trade-${trade.id}`} className="glass-panel" style={{ padding: '0.85rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.65rem', flexWrap: 'wrap' }}>
                <div>
                  <strong style={{ color: 'var(--text-strong)' }}>{t('historical.tradeWith', { user: partner })}</strong>
                  <span style={{ marginLeft: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.84rem' }}>
                    {t(`historical.status.${trade.status}`)} · {new Date(`${trade.completed_at}T00:00:00`).toLocaleDateString()}
                  </span>
                </div>
                {trade.status === 'pending_confirmation' && !isCreator && (
                  <button type="button" className="btn btn-primary" onClick={() => setHistoricalModal({ mode: 'review', trade })}>{t('historical.review')}</button>
                )}
                {trade.status === 'pending_confirmation' && isCreator && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={saving}
                    onClick={async () => {
                      try {
                        await saveHistoricalAction(`/api/transfers/history/${trade.id}`, 'DELETE', null, 'historical.cancelled');
                      } catch (err) {
                        setError(err.message || t('historical.errCancel'));
                      }
                    }}
                  >
                    {t('transfer.cancel')}
                  </button>
                )}
              </div>
              {trade.message && <p style={{ color: 'var(--text-secondary)', margin: '0.45rem 0' }}>{trade.message}</p>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.35rem 1rem', marginTop: '0.45rem' }}>
                {trade.items.map(item => {
                  const wasGivenByYou = String(item.from_user_id) === String(user.id);
                  return (
                    <div key={item.id} style={{ color: 'var(--text-secondary)', fontSize: '0.84rem' }}>
                      {item.quantity > 1 ? `${item.quantity}× ` : ''}{item.item_snapshot.name}
                      <span style={{ marginLeft: '0.35rem', color: 'var(--text-muted)' }}>
                        {t(wasGivenByYou ? 'historical.youGave' : 'historical.theyGave')}
                      </span>
                      <div style={{ fontSize: '0.78rem' }}>{[item.item_snapshot.set_name, item.item_snapshot.number && `#${item.item_snapshot.number}`].filter(Boolean).join(' · ')}</div>
                    </div>
                  );
                })}
              </div>
            </article>
          );
        })}
        {!loading && !historyGroups.length && !historicalTrades.length && (
          <p style={{ color: 'var(--text-secondary)' }}>{t('transfer.noHistory')}</p>
        )}
      </section>

      <ExternalDealHistory
        focus={historyFocus}
        onFocusHandled={onHistoryFocusHandled}
        onFocusMissing={() => setError(t('transfer.historyUnavailable'))}
      />
      </>}
      </div>
      {historicalModal && (
        <HistoricalTradeModal
          mode={historicalModal.mode}
          trade={historicalModal.trade}
          user={user}
          users={users}
          cards={myCards}
          onClose={() => setHistoricalModal(null)}
          onCreate={payload => saveHistoricalAction('/api/transfers/history', 'POST', payload, 'historical.submitted')}
          onConfirm={(tradeId, items) => saveHistoricalAction(
            `/api/transfers/history/${tradeId}/confirm`,
            'PUT',
            { items },
            'historical.confirmed'
          )}
          onReject={tradeId => saveHistoricalAction(
            `/api/transfers/history/${tradeId}/reject`,
            'PUT',
            {},
            'historical.rejected'
          )}
        />
      )}
    </div>
  );
}
