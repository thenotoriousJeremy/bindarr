import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, Check, Gift, RefreshCw, X } from 'lucide-react';
import { useT } from '../utils/i18n';
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

function TransferItem({ item, currentUserId, t }) {
  const snapshot = item.item_snapshot || item;
  const sentByYou = item.from_user_id === currentUserId;
  const cost = sentByYou ? item.purchase_cost : item.received_cost;
  const name = snapshot.name || snapshot.product_name || t('transfer.unknownItem');
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem', padding: '0.45rem 0', borderBottom: '1px solid var(--border-glass)' }}>
      <div style={{ minWidth: 0 }}>
        <strong style={{ color: 'var(--text-strong)' }}>{item.quantity > 1 ? `${item.quantity}× ` : ''}{name}</strong>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
          {item.item_type === 'card'
            ? [snapshot.set_name, snapshot.number && `#${snapshot.number}`, snapshot.condition].filter(Boolean).join(' · ')
            : [snapshot.sealed_type, snapshot.origin_product_name && t('transfer.fromProduct', { product: snapshot.origin_product_name })].filter(Boolean).join(' · ')}
        </div>
      </div>
      <span style={{ whiteSpace: 'nowrap', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
        {cost == null ? t('transfer.unknownCost') : `$${Number(cost).toFixed(2)}`}
      </span>
    </div>
  );
}

export default function TransferManager({ user, showToast }) {
  const { t } = useT();
  const [users, setUsers] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [myCards, setMyCards] = useState([]);
  const [mySealed, setMySealed] = useState([]);
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
        set_name: item.item_snapshot?.set_name,
        number: item.item_snapshot?.number,
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
    if (!countering && transferType === 'trade' && selectedRequestItems.length === 0) return;
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

  const renderChoices = (items, selected, setter, isRequest = false) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', maxHeight: '18rem', overflowY: 'auto' }}>
      {items.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', padding: '0.5rem 0' }}>
          {isRequest ? t('transfer.noMarkedItems') : t('transfer.noInventory')}
        </div>
      ) : items.map(item => {
        const key = itemKey(item);
        const checked = Boolean(selected[key]);
        const label = itemLabel(item);
        return (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', padding: '0.4rem 0.5rem', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)' }}>
            <input
              type="checkbox"
              checked={checked}
              aria-label={label}
              onChange={event => setSelection(setter, selected, item, event.target.checked)}
            />
            <span style={{ flex: 1, minWidth: 0, color: 'var(--text-strong)', fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {label}
              <span style={{ color: 'var(--text-secondary)', marginLeft: '0.35rem' }}>
                {item.type === 'card' ? [item.set_name, item.number && `#${item.number}`].filter(Boolean).join(' · ') : item.origin_product_name ? t('transfer.fromProduct', { product: item.origin_product_name }) : item.sealed_type}
              </span>
            </span>
            {item.type === 'card' && checked && (
              <input
                type="number"
                min="1"
                max={item.quantity || 1}
                value={selected[key].quantity}
                aria-label={t('transfer.quantity')}
                onChange={event => updateQuantity(setter, selected, item, event.target.value)}
                style={{ width: '4.3rem' }}
              />
            )}
            {!isRequest && item.type === 'sealed' && (
              <button type="button" className="btn btn-secondary" style={{ padding: '0.25rem 0.45rem', fontSize: '0.7rem' }}
                onClick={() => toggleSealedTrade(item)}>
                {item.is_trade ? t('transfer.unmarkTrade') : t('transfer.markTrade')}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );

  const transferCard = (transfer, incoming) => (
    <article key={transfer.id} className="glass-panel" style={{ padding: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {transfer.transfer_type === 'gift' ? <Gift size={16} /> : <ArrowLeftRight size={16} />}
          <strong style={{ color: 'var(--text-strong)' }}>
            {incoming
              ? t('transfer.fromUser', { user: transfer.proposer_username })
              : t('transfer.toUser', { user: transfer.recipient_username })}
          </strong>
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{t(`transfer.status.${transfer.status}`)}</span>
        </div>
        {incoming && transfer.status === 'pending' ? (
          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => actOnTransfer(transfer, 'accept')}><Check size={14} /> {t('transfer.accept')}</button>
            <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => startCounter(transfer)}><RefreshCw size={14} /> {t('transfer.counter')}</button>
            <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => actOnTransfer(transfer, 'reject')}><X size={14} /> {t('transfer.reject')}</button>
          </div>
        ) : !incoming && transfer.status === 'pending' ? (
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => actOnTransfer(transfer, 'cancel')}>{t('transfer.cancel')}</button>
        ) : null}
      </div>
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

  const ownOfferItems = [
    ...myCards.map(item => ({ ...item, type: 'card', id: item.entry_id })),
    ...mySealed.map(item => ({ ...item, type: 'sealed', id: item.id }))
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1rem' }}>
      <header>
        <h2 style={{ color: 'var(--text-strong)', margin: 0 }}>{t('transfer.title')}</h2>
        <p style={{ color: 'var(--text-secondary)', margin: '0.35rem 0 0' }}>{t('transfer.subtitle')}</p>
      </header>

      {error && <div role="alert" className="glass-panel" style={{ padding: '0.75rem', color: 'var(--accent-red)' }}>{error}</div>}

      <form className="glass-panel" onSubmit={submitProposal} style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
        <h3 style={{ margin: 0, color: 'var(--text-strong)' }}>
          {countering ? t('transfer.countering', { user: countering.proposer_username }) : t('transfer.newProposal')}
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.65rem' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
            {t('transfer.recipient')}
            <select className="select-control" value={recipientId} disabled={Boolean(countering)} onChange={event => setRecipientId(event.target.value)} required>
              <option value="">{t('transfer.chooseUser')}</option>
              {users.map(other => <option key={other.id} value={other.id}>{other.username}</option>)}
            </select>
          </label>
          {!countering && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
              {t('transfer.type')}
              <select className="select-control" value={transferType} onChange={event => setTransferType(event.target.value)}>
                <option value="gift">{t('transfer.gift')}</option>
                <option value="trade">{t('transfer.trade')}</option>
              </select>
            </label>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1rem' }}>
          <section>
            <h4 style={{ color: 'var(--text-strong)', margin: '0 0 0.25rem' }}>{t('transfer.offer')}</h4>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', margin: '0 0 0.5rem' }}>{t('transfer.offerHint')}</p>
            {renderChoices(ownOfferItems, offered, setOffered)}
          </section>
          {(countering || transferType === 'trade') && (
            <section>
              <h4 style={{ color: 'var(--text-strong)', margin: '0 0 0.25rem' }}>{t('transfer.request')}</h4>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', margin: '0 0 0.5rem' }}>{t('transfer.requestHint')}</p>
              {renderChoices(requestedOptions, requested, setRequested, true)}
            </section>
          )}
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
          {t('transfer.message')}
          <textarea value={message} maxLength={1000} rows={2} onChange={event => setMessage(event.target.value)} placeholder={t('transfer.messagePlaceholder')} />
        </label>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="submit" className="btn btn-primary" disabled={saving || loading || !recipientId || !selectedOfferItems.length || ((countering || transferType === 'trade') && !selectedRequestItems.length)}>
            {countering ? <RefreshCw size={15} /> : transferType === 'gift' ? <Gift size={15} /> : <ArrowLeftRight size={15} />}
            {countering ? t('transfer.sendCounter') : t('transfer.sendProposal')}
          </button>
          {countering && <button type="button" className="btn btn-secondary" onClick={resetComposer}>{t('common.cancel')}</button>}
        </div>
      </form>

      <section style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
        <h3 style={{ margin: 0, color: 'var(--text-strong)' }}>{t('transfer.pendingIncoming')}</h3>
        {pendingIncoming.length ? pendingIncoming.map(item => transferCard(item, true)) : <p style={{ color: 'var(--text-secondary)' }}>{t('transfer.noneIncoming')}</p>}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
        <h3 style={{ margin: 0, color: 'var(--text-strong)' }}>{t('transfer.pendingOutgoing')}</h3>
        {pendingOutgoing.length ? pendingOutgoing.map(item => transferCard(item, false)) : <p style={{ color: 'var(--text-secondary)' }}>{t('transfer.noneOutgoing')}</p>}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
        <h3 style={{ margin: 0, color: 'var(--text-strong)' }}>{t('transfer.history')}</h3>
        {loading ? <p style={{ color: 'var(--text-secondary)' }}>{t('common.loading')}</p>
          : history.length ? history.map(item => transferCard(item, item.proposer_id !== user.id))
            : <p style={{ color: 'var(--text-secondary)' }}>{t('transfer.noHistory')}</p>}
      </section>

      <ExternalDealManager showToast={showToast} onInventoryChange={load} />
    </div>
  );
}
