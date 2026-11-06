import { useState } from 'react';
import { Check, Plus, Search, Trash2, X } from 'lucide-react';
import { GAMES } from '../utils/games';
import { useT } from '../utils/i18n';

async function requestJson(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function cardName(card) {
  return card.printed_name || card.name || card.card_id;
}

function CardItemEditor({ cards, items, onChange, direction, disabled }) {
  const { t } = useT();
  const [query, setQuery] = useState('');
  const [game, setGame] = useState('pokemon');
  const [remoteCards, setRemoteCards] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const localCards = cards.filter(card => {
    if (game && String(card.game || '').toLowerCase() !== game) return false;
    const text = `${cardName(card)} ${card.set_name || ''} ${card.number || ''}`.toLowerCase();
    return query.trim() && text.includes(query.trim().toLowerCase());
  }).slice(0, 10);
  const results = [
    ...localCards,
    ...remoteCards.filter(card => String(card.game || game).toLowerCase() === game && !localCards.some(local => local.card_id === card.id))
  ];

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError('');
    try {
      const params = new URLSearchParams({ name: query.trim(), game, scope: 'internet', limit: '20' });
      const result = await requestJson(`/api/search?${params}`);
      setRemoteCards(Array.isArray(result) ? result.slice(0, 20) : []);
    } catch (err) {
      setError(err.message || t('historical.errSearch'));
    } finally {
      setSearching(false);
    }
  };

  const addCard = card => {
    const localCopy = card.entry_id != null ? card : null;
    const newItem = {
      card_id: localCopy?.card_id || card.id,
      name: cardName(card),
      set_name: card.set_name || '',
      number: card.number || '',
      image_url: card.image_url || null,
      game: card.game || game,
      quantity: 1,
      collection_entry_id: localCopy?.entry_id != null
        && (direction === 'given' || Number(localCopy.quantity) === 1)
        ? localCopy.entry_id
        : null
    };
    onChange(current => {
      if (!localCopy) return [...current, newItem];
      const existing = current.find(item => String(item.collection_entry_id) === String(localCopy.entry_id));
      if (!existing) return [...current, newItem];
      if (direction !== 'given') return current;
      return current.map(item => item === existing
        ? { ...item, quantity: Math.min(Number(localCopy.quantity) || 1, item.quantity + 1) }
        : item);
    });
  };

  const updateItem = (index, changes) => {
    onChange(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
        <select className="select-control" value={game} onChange={event => { setGame(event.target.value); setRemoteCards([]); }} aria-label={t('transfer.external.game')} disabled={disabled}>
          {GAMES.map(option => <option key={option.value} value={option.value}>{option.short}</option>)}
        </select>
        <input
          className="input-control"
          value={query}
          onChange={event => { setQuery(event.target.value); setRemoteCards([]); }}
          placeholder={t('historical.searchCards')}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); search(); } }}
          disabled={disabled}
        />
        <button type="button" className="btn btn-secondary" disabled={disabled || searching || !query.trim()} onClick={search}>
          <Search size={14} /> {searching ? t('common.loading') : t('historical.search')}
        </button>
      </div>
      {error && <div role="alert" style={{ color: 'var(--accent-red)' }}>{error}</div>}
      {results.length > 0 && (
        <div className="glass-panel" style={{ maxHeight: '10rem', overflowY: 'auto', padding: '0.35rem' }}>
          {results.map((card, index) => (
            <button
              type="button"
              key={`${card.id || card.card_id}:${card.entry_id || index}`}
              disabled={disabled}
              onClick={() => addCard(card)}
              style={{ display: 'block', width: '100%', padding: '0.4rem', textAlign: 'left', color: 'var(--text-strong)', background: 'transparent', border: 0, cursor: 'pointer' }}
            >
              {cardName(card)}
              <span style={{ color: 'var(--text-secondary)' }}>{[card.set_name, card.number && `#${card.number}`, card.entry_id != null && `×${card.quantity}`].filter(Boolean).join(' · ')}</span>
              <Plus size={13} style={{ float: 'right' }} />
            </button>
          ))}
        </div>
      )}
      {items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {items.map((item, index) => {
            const matchingCopies = cards.filter(card => card.card_id === item.card_id);
            const linkedCopy = matchingCopies.find(card => String(card.entry_id) === String(item.collection_entry_id));
            const quantityLimit = linkedCopy ? Number(linkedCopy.quantity) || 1 : 100;
            return (
              <div key={`${item.card_id}:${index}`} className="glass-panel" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '0.4rem', padding: '0.55rem' }}>
                <div style={{ minWidth: 0, color: 'var(--text-strong)', fontSize: '0.84rem' }}>
                  <strong>{item.name}</strong>
                  <div style={{ color: 'var(--text-secondary)' }}>{[item.set_name, item.number && `#${item.number}`].filter(Boolean).join(' · ')}</div>
                  <select
                    className="select-control"
                    value={item.collection_entry_id || ''}
                    aria-label={t('historical.linkCopy')}
                    disabled={disabled}
                    onChange={event => {
                      const copy = matchingCopies.find(card => String(card.entry_id) === event.target.value);
                      updateItem(index, {
                        collection_entry_id: copy?.entry_id || null,
                        ...(copy && direction === 'given' ? { quantity: Math.min(item.quantity, Number(copy.quantity) || 1) } : {})
                      });
                    }}
                    style={{ marginTop: '0.35rem', width: '100%' }}
                  >
                    <option value="">{t('historical.historyOnly')}</option>
                    {matchingCopies.map(copy => (
                      <option
                        key={copy.entry_id}
                        value={copy.entry_id}
                        disabled={(direction === 'given'
                          ? Number(copy.quantity) < item.quantity
                          : Number(copy.quantity) !== item.quantity)
                          || items.some((other, otherIndex) => otherIndex !== index
                            && String(other.collection_entry_id) === String(copy.entry_id))}
                      >
                        {t('historical.collectionCopy', {
                          quantity: copy.quantity,
                          condition: copy.condition || t('historical.unknownCondition'),
                          location: copy.location_name || t('transfer.unsortedLocation')
                        })}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <label style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                    {t('transfer.quantity')}
                    <input
                      type="number"
                      className="input-control"
                      min="1"
                      max={quantityLimit}
                      value={item.quantity}
                      disabled={disabled || (direction === 'received' && Boolean(linkedCopy))}
                      onChange={event => updateItem(index, { quantity: Math.max(1, Math.min(quantityLimit, Number(event.target.value) || 1)) })}
                      style={{ width: '4.3rem', padding: '0.4rem' }}
                    />
                  </label>
                  <button type="button" className="btn btn-secondary" aria-label={t('historical.removeCard')} disabled={disabled} onClick={() => onChange(current => current.filter((_, itemIndex) => itemIndex !== index))}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {!items.length && <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', margin: 0 }}>{t('historical.noCards')}</p>}
    </div>
  );
}

export default function HistoricalTradeModal({
  mode,
  user,
  users,
  cards,
  trade,
  onClose,
  onCreate,
  onConfirm,
  onReject
}) {
  const { t } = useT();
  const [recipientId, setRecipientId] = useState('');
  const [completedAt, setCompletedAt] = useState(new Date().toISOString().slice(0, 10));
  const [message, setMessage] = useState('');
  const [givenItems, setGivenItems] = useState([]);
  const [receivedItems, setReceivedItems] = useState([]);
  const [mappings, setMappings] = useState(() => Object.fromEntries(
    (trade?.items || []).map(item => [item.id, null])
  ));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const reviewing = mode === 'review';

  const submitCreate = async event => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await onCreate({
        recipient_id: Number(recipientId),
        completed_at: completedAt,
        message: message.trim() || null,
        items: [
          ...givenItems.map(item => ({
            direction: 'given',
            card_id: item.card_id,
            quantity: item.quantity,
            collection_entry_id: item.collection_entry_id
          })),
          ...receivedItems.map(item => ({
            direction: 'received',
            card_id: item.card_id,
            quantity: item.quantity,
            collection_entry_id: item.collection_entry_id
          }))
        ]
      });
      onClose();
    } catch (err) {
      setError(err.message || t('historical.errSave'));
    } finally {
      setSaving(false);
    }
  };

  const submitConfirm = async () => {
    setSaving(true);
    setError('');
    try {
      await onConfirm(trade.id, trade.items.map(item => ({
        id: item.id,
        collection_entry_id: mappings[item.id]
      })));
      onClose();
    } catch (err) {
      setError(err.message || t('historical.errConfirm'));
    } finally {
      setSaving(false);
    }
  };

  const reject = async () => {
    setSaving(true);
    setError('');
    try {
      await onReject(trade.id);
      onClose();
    } catch (err) {
      setError(err.message || t('historical.errReject'));
    } finally {
      setSaving(false);
    }
  };

  const setMapping = (item, value) => {
    const copy = cards.find(card => String(card.entry_id) === value);
    setMappings(current => ({ ...current, [item.id]: copy?.entry_id || null }));
  };

  return (
    <div
      className="modal-overlay"
      style={{ position: 'fixed', inset: 0, zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'rgba(0,0,0,0.75)' }}
      onClick={event => { if (event.target === event.currentTarget && !saving) onClose(); }}
    >
      <div className="glass-panel" role="dialog" aria-modal="true" aria-labelledby="historical-trade-title" style={{ width: 'min(900px, 100%)', maxHeight: '90vh', overflowY: 'auto', padding: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}>
          <h3 id="historical-trade-title" style={{ margin: 0, color: 'var(--text-strong)' }}>
            {reviewing ? t('historical.reviewTitle', { user: trade.creator_id === user.id ? trade.recipient_username : trade.creator_username }) : t('historical.createTitle')}
          </h3>
          <button type="button" className="btn btn-secondary" aria-label={t('common.close')} disabled={saving} onClick={onClose}><X size={16} /></button>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.86rem' }}>
          {reviewing ? t('historical.reviewHint') : t('historical.createHint')}
        </p>
        {reviewing && (
          <div className="glass-panel" style={{ padding: '0.65rem', marginBottom: '0.65rem' }}>
            <strong style={{ color: 'var(--text-strong)', fontSize: '0.85rem' }}>
              {t('historical.completedDate')}: {new Date(`${trade.completed_at}T00:00:00`).toLocaleDateString()}
            </strong>
            {trade.message && <p style={{ color: 'var(--text-secondary)', margin: '0.35rem 0 0' }}>{trade.message}</p>}
          </div>
        )}
        {error && <div role="alert" style={{ color: 'var(--accent-red)', marginBottom: '0.6rem' }}>{error}</div>}

        {reviewing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '0.6rem' }}>
              {trade.items.map(item => {
                const isOutgoing = String(item.from_user_id) === String(user.id);
                const matchingCopies = cards.filter(card => card.card_id === item.card_id);
                return (
                  <div key={item.id} className="glass-panel" style={{ padding: '0.65rem' }}>
                    <strong style={{ color: 'var(--text-strong)' }}>{item.quantity > 1 ? `${item.quantity}× ` : ''}{item.item_snapshot.name}</strong>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                      {[item.item_snapshot.set_name, item.item_snapshot.number && `#${item.item_snapshot.number}`, t(isOutgoing ? 'historical.youGave' : 'historical.youReceived')].filter(Boolean).join(' · ')}
                    </div>
                    <select className="select-control" value={mappings[item.id] || ''} onChange={event => setMapping(item, event.target.value)} disabled={saving} style={{ width: '100%', marginTop: '0.45rem' }}>
                      <option value="">{t('historical.historyOnly')}</option>
                      {matchingCopies.map(copy => (
                        <option
                          key={copy.entry_id}
                          value={copy.entry_id}
                          disabled={(isOutgoing ? Number(copy.quantity) < item.quantity : Number(copy.quantity) !== item.quantity)
                            || trade.items.some(other => other.id !== item.id && String(mappings[other.id]) === String(copy.entry_id))}
                        >
                          {t('historical.collectionCopy', {
                            quantity: copy.quantity,
                            condition: copy.condition || t('historical.unknownCondition'),
                            location: copy.location_name || t('transfer.unsortedLocation')
                          })}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-secondary" disabled={saving} onClick={reject}>{t('historical.reject')}</button>
              <button type="button" className="btn btn-primary" disabled={saving} onClick={submitConfirm}>
                <Check size={15} /> {saving ? t('historical.saving') : t('historical.confirm')}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={submitCreate} style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.6rem' }}>
              <label className="form-group" style={{ margin: 0 }}>
                {t('transfer.recipient')}
                <select className="select-control" value={recipientId} onChange={event => setRecipientId(event.target.value)} required>
                  <option value="">{t('transfer.chooseUser')}</option>
                  {users.map(other => <option key={other.id} value={other.id}>{other.username}</option>)}
                </select>
              </label>
              <label className="form-group" style={{ margin: 0 }}>
                {t('historical.completedDate')}
                <input className="input-control" type="date" max={new Date().toISOString().slice(0, 10)} value={completedAt} onChange={event => setCompletedAt(event.target.value)} required />
              </label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0.8rem' }}>
              <section className="glass-panel" style={{ padding: '0.7rem' }}>
                <h4 style={{ color: 'var(--text-strong)', margin: '0 0 0.55rem' }}>{t('historical.youGave')}</h4>
                <CardItemEditor cards={cards} items={givenItems} onChange={setGivenItems} direction="given" disabled={saving} />
              </section>
              <section className="glass-panel" style={{ padding: '0.7rem' }}>
                <h4 style={{ color: 'var(--text-strong)', margin: '0 0 0.55rem' }}>{t('historical.youReceived')}</h4>
                <CardItemEditor cards={cards} items={receivedItems} onChange={setReceivedItems} direction="received" disabled={saving} />
              </section>
            </div>
            <label className="form-group" style={{ margin: 0 }}>
              {t('transfer.message')}
              <textarea className="input-control" rows={2} maxLength={1000} value={message} onChange={event => setMessage(event.target.value)} />
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving || !recipientId || !givenItems.length || !receivedItems.length}>
                {saving ? t('historical.saving') : t('historical.submit')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
