import { useCallback, useEffect, useState } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import { useT } from '../utils/i18n';
import { GAMES } from '../utils/games';
import SealedCatalogPicker from './SealedCatalogPicker';

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

const keyFor = item => `${item.type}:${item.id}`;

function itemName(item) {
  const snapshot = item.item_snapshot || item;
  return snapshot.name || snapshot.product_name || snapshot.card_id || 'Item';
}

export default function ExternalDealManager({ showToast, onInventoryChange, visible = true }) {
  const { t } = useT();
  const [contacts, setContacts] = useState([]);
  const [cards, setCards] = useState([]);
  const [sealedUnits, setSealedUnits] = useState([]);
  const [contactId, setContactId] = useState('');
  const [newContactName, setNewContactName] = useState('');
  const [transactionType, setTransactionType] = useState('trade');
  const [giftDirection, setGiftDirection] = useState('given');
  const [givenItems, setGivenItems] = useState({});
  const [receivedItems, setReceivedItems] = useState([]);
  const [cardQuery, setCardQuery] = useState('');
  const [cardGame, setCardGame] = useState('pokemon');
  const [cardResults, setCardResults] = useState([]);
  const [sealedGame, setSealedGame] = useState('pokemon');
  const [sealedProduct, setSealedProduct] = useState(null);
  const [sealedQuantity, setSealedQuantity] = useState(1);
  const [originName, setOriginName] = useState('');
  const [originUnitNumber, setOriginUnitNumber] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [contactData, collectionData, sealedData] = await Promise.all([
        requestJson('/api/transfers/external/contacts'),
        requestJson('/api/collection?list_type=collection'),
        requestJson('/api/sealed/units?opened=0')
      ]);
      setContacts(contactData.contacts || []);
      setCards(Array.isArray(collectionData) ? collectionData : []);
      setSealedUnits(sealedData.units || []);
    } catch (err) {
      setError(err.message || t('transfer.external.errLoad'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const addContact = async (event) => {
    event.preventDefault();
    if (!newContactName.trim()) return;
    setSaving(true);
    setError('');
    try {
      const data = await requestJson('/api/transfers/external/contacts', {
        method: 'POST',
        body: JSON.stringify({ name: newContactName })
      });
      setContacts(current => [...current, data.contact].sort((a, b) => a.name.localeCompare(b.name)));
      setContactId(String(data.contact.id));
      setNewContactName('');
    } catch (err) {
      setError(err.message || t('transfer.external.errContact'));
    } finally {
      setSaving(false);
    }
  };

  const deleteContact = async () => {
    if (!contactId) return;
    setSaving(true);
    setError('');
    try {
      await requestJson(`/api/transfers/external/contacts/${contactId}`, { method: 'DELETE' });
      setContacts(current => current.filter(contact => String(contact.id) !== contactId));
      setContactId('');
      await load();
    } catch (err) {
      setError(err.message || t('transfer.external.errContact'));
    } finally {
      setSaving(false);
    }
  };

  const searchCards = async (event) => {
    event?.preventDefault();
    if (!cardQuery.trim()) return;
    setSaving(true);
    setError('');
    try {
      const params = new URLSearchParams({ name: cardQuery.trim(), game: cardGame, scope: 'internet', limit: '20' });
      const results = await requestJson(`/api/search?${params}`);
      setCardResults(Array.isArray(results) ? results.slice(0, 20) : []);
    } catch (err) {
      setError(err.message || t('transfer.external.errSearch'));
    } finally {
      setSaving(false);
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
      language: 'English'
    };
    setReceivedItems(current => {
      const existing = current.find(row => row.type === 'card' && row.card_id === item.card_id);
      if (existing) return current.map(row => row === existing ? { ...row, quantity: Math.min(100, row.quantity + 1) } : row);
      return [...current, item];
    });
  };

  const addReceivedSealed = () => {
    if (!sealedProduct) return;
    setReceivedItems(current => [...current, {
      type: 'sealed',
      product_id: sealedProduct.product_id || null,
      product_name: sealedProduct.name,
      set_name: sealedProduct.group_name || null,
      sealed_type: sealedProduct.sealed_type || null,
      game: sealedGame,
      image_url: sealedProduct.image_url || null,
      quantity: Math.max(1, Number(sealedQuantity) || 1),
      origin_product_name: originName.trim() || null,
      origin_unit_number: originUnitNumber ? Math.max(1, Number(originUnitNumber) || 1) : null
    }]);
    setSealedProduct(null);
    setSealedQuantity(1);
    setOriginName('');
    setOriginUnitNumber('');
  };

  const updateReceivedQuantity = (item, quantity) => {
    setReceivedItems(current => current.map(row => row === item
      ? { ...row, quantity: Math.max(1, Math.min(100, Number(quantity) || 1)) }
      : row));
  };

  const toggleGiven = (item, checked) => {
    const key = keyFor(item);
    setGivenItems(current => {
      const next = { ...current };
      if (checked) next[key] = { type: item.type, id: item.id, quantity: 1 };
      else delete next[key];
      return next;
    });
  };

  const updateGivenQuantity = (item, quantity) => {
    const key = keyFor(item);
    setGivenItems(current => ({
      ...current,
      [key]: { ...current[key], quantity: Math.max(1, Math.min(Number(item.quantity) || 1, Number(quantity) || 1)) }
    }));
  };

  const submit = async (event) => {
    event.preventDefault();
    const giving = Object.values(givenItems);
    const receiving = receivedItems;
    const submittedGiven = transactionType === 'trade' || giftDirection === 'given' ? giving : [];
    const submittedReceived = transactionType === 'trade' || giftDirection === 'received' ? receiving : [];
    if (!contactId || (!submittedGiven.length && !submittedReceived.length)) return;
    if (transactionType === 'trade' && (!submittedGiven.length || !submittedReceived.length)) return;
    setSaving(true);
    setError('');
    try {
      const data = await requestJson('/api/transfers/external', {
        method: 'POST',
        body: JSON.stringify({
          contact_id: Number(contactId),
          transaction_type: transactionType,
          given_items: submittedGiven,
          received_items: submittedReceived,
          message
        })
      });
      showToast?.(t('transfer.external.saved'));
      setNotice(data.warnings?.length ? t('transfer.external.deckWarning') : '');
      setGivenItems({});
      setReceivedItems([]);
      setCardResults([]);
      setCardQuery('');
      setMessage('');
      await load();
      onInventoryChange?.();
    } catch (err) {
      setError(err.message || t('transfer.external.errSave'));
    } finally {
      setSaving(false);
    }
  };

  const ownItems = [
    ...cards.map(item => ({ ...item, type: 'card', id: item.entry_id })),
    ...sealedUnits.map(item => ({ ...item, type: 'sealed', id: item.id }))
  ];
  const giveItems = Object.values(givenItems);
  const receiveItems = receivedItems;
  const showGiven = transactionType === 'trade' || giftDirection === 'given';
  const showReceived = transactionType === 'trade' || giftDirection === 'received';

  const renderGiven = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', maxHeight: '16rem', overflowY: 'auto' }}>
      {ownItems.length === 0 ? <p style={{ color: 'var(--text-secondary)' }}>{t('transfer.noInventory')}</p> : ownItems.map(item => {
        const key = keyFor(item);
        const selected = givenItems[key];
        const label = item.type === 'card' ? item.name || item.printed_name || item.card_id : item.product_name;
        return (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.35rem', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)' }}>
            <input type="checkbox" checked={Boolean(selected)} aria-label={label} onChange={event => toggleGiven(item, event.target.checked)} />
            <span style={{ flex: 1, minWidth: 0, color: 'var(--text-strong)', fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
            {item.type === 'card' && selected && (
              <input type="number" min="1" max={item.quantity || 1} value={selected.quantity}
                aria-label={t('transfer.quantity')} onChange={event => updateGivenQuantity(item, event.target.value)}
                style={{ width: '4rem' }} />
            )}
          </div>
        );
      })}
    </div>
  );

  const renderReceived = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
        <select className="select-control" value={cardGame} onChange={event => setCardGame(event.target.value)} aria-label={t('transfer.external.game')}>
          {GAMES.map(game => <option key={game.value} value={game.value}>{game.short}</option>)}
        </select>
        <input className="input-control" value={cardQuery} onChange={event => setCardQuery(event.target.value)}
          placeholder={t('transfer.external.searchCards')}
          onKeyDown={event => { if (event.key === 'Enter') searchCards(event); }} />
        <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => searchCards()}><Search size={14} /></button>
      </div>
      {cardResults.length > 0 && (
        <div className="glass-panel" style={{ maxHeight: '12rem', overflowY: 'auto', padding: '0.35rem' }}>
          {cardResults.map(card => (
            <button type="button" key={card.id} onClick={() => addReceivedCard(card)}
              style={{ display: 'block', width: '100%', padding: '0.4rem', textAlign: 'left', color: 'var(--text-strong)', background: 'transparent', border: 0, cursor: 'pointer' }}>
              {card.printed_name || card.name} <span style={{ color: 'var(--text-secondary)' }}>{[card.set_name, card.number && `#${card.number}`].filter(Boolean).join(' · ')}</span>
              <Plus size={13} style={{ float: 'right' }} />
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
            <button type="button" className="btn btn-secondary" onClick={addReceivedSealed}><Plus size={14} /> {t('transfer.external.addReceived')}</button>
          </div>
        )}
      </div>
      {receiveItems.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {receiveItems.map((item, index) => (
            <div key={`${item.type}:${item.card_id || item.product_name}:${index}`} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-glass)', padding: '0.3rem 0' }}>
              <span style={{ flex: 1, color: 'var(--text-strong)', fontSize: '0.82rem' }}>{item.name || item.product_name}</span>
              <input type="number" min="1" max="100" value={item.quantity} aria-label={t('transfer.quantity')}
                onChange={event => updateReceivedQuantity(item, event.target.value)} style={{ width: '4rem' }} />
              <button type="button" className="btn btn-secondary" aria-label={t('transfer.external.removeItem')}
                onClick={() => setReceivedItems(current => current.filter(row => row !== item))}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <section className="glass-panel" style={{ padding: '1rem', display: visible ? 'flex' : 'none', flexDirection: 'column', gap: '0.9rem' }}>
      <header>
        <h3 style={{ margin: 0, color: 'var(--text-strong)' }}>{t('transfer.external.title')}</h3>
        <p style={{ color: 'var(--text-secondary)', margin: '0.35rem 0 0', fontSize: '0.82rem' }}>{t('transfer.external.subtitle')}</p>
      </header>
      {error && <div role="alert" style={{ color: 'var(--accent-red)' }}>{error}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.6rem' }}>
          <label style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
            {t('transfer.external.contact')}
            <select className="select-control" value={contactId} onChange={event => setContactId(event.target.value)} required>
              <option value="">{t('transfer.external.chooseContact')}</option>
              {contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.name}</option>)}
            </select>
          </label>
          <label style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
            {t('transfer.type')}
            <select className="select-control" value={transactionType} onChange={event => setTransactionType(event.target.value)}>
              <option value="trade">{t('transfer.trade')}</option>
              <option value="gift">{t('transfer.gift')}</option>
            </select>
          </label>
          {transactionType === 'gift' && (
            <label style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
              {t('transfer.external.giftDirection')}
              <select className="select-control" value={giftDirection} onChange={event => setGiftDirection(event.target.value)}>
                <option value="given">{t('transfer.external.giftGiven')}</option>
                <option value="received">{t('transfer.external.giftReceived')}</option>
              </select>
            </label>
          )}
        </div>
        <form onSubmit={addContact} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
          <input className="input-control" value={newContactName} maxLength="100" onChange={event => setNewContactName(event.target.value)}
            placeholder={t('transfer.external.newContact')} />
          <button type="submit" className="btn btn-secondary" disabled={saving || !newContactName.trim()}><Plus size={14} /> {t('transfer.external.saveContact')}</button>
          {contactId && (
            <button type="button" className="btn btn-secondary" disabled={saving} onClick={deleteContact}>
              <Trash2 size={14} /> {t('transfer.external.deleteContact')}
            </button>
          )}
        </form>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
        {loading ? <p style={{ color: 'var(--text-secondary)' }}>{t('common.loading')}</p> : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1rem' }}>
            {showGiven && (
              <section>
                <h4 style={{ color: 'var(--text-strong)', margin: '0 0 0.5rem' }}>{t('transfer.external.given')}</h4>
                {renderGiven()}
              </section>
            )}
            {showReceived && (
              <section>
                <h4 style={{ color: 'var(--text-strong)', margin: '0 0 0.5rem' }}>{t('transfer.external.received')}</h4>
                {renderReceived()}
              </section>
            )}
          </div>
        )}
        <label style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
          {t('transfer.message')}
          <textarea className="input-control" value={message} maxLength="1000" rows={2} onChange={event => setMessage(event.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary" disabled={saving || loading || !contactId ||
          (transactionType === 'trade' && (!giveItems.length || !receiveItems.length)) ||
          (transactionType === 'gift' && (giftDirection === 'given' ? !giveItems.length : !receiveItems.length))}>
          {saving ? t('transfer.external.saving') : t('transfer.external.save')}
        </button>
        </form>

      {notice && <div role="status" style={{ color: 'var(--accent-yellow)' }}>{notice}</div>}
      </div>
    </section>
  );
}

export function ExternalDealHistory() {
  const { t } = useT();
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    requestJson('/api/transfers/external')
      .then(data => {
        if (active) setTransactions(data.transactions || []);
      })
      .catch(err => {
        if (active) setError(err.message || t('transfer.external.errLoad'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [t]);

  return (
    <section className="glass-panel" style={{ padding: '1rem' }}>
      <h3 style={{ color: 'var(--text-strong)', margin: '0 0 0.5rem' }}>{t('transfer.external.history')}</h3>
      {error && <div role="alert" style={{ color: 'var(--accent-red)' }}>{error}</div>}
      {loading ? <p style={{ color: 'var(--text-secondary)' }}>{t('common.loading')}</p>
        : error ? null
          : transactions.length === 0 ? <p style={{ color: 'var(--text-secondary)' }}>{t('transfer.external.noHistory')}</p> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
            {transactions.map(transaction => (
              <article key={transaction.id} style={{ borderTop: '1px solid var(--border-glass)', paddingTop: '0.55rem' }}>
                <strong style={{ color: 'var(--text-strong)' }}>{transaction.contact_name} · {t(`transfer.${transaction.transaction_type}`)}</strong>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.72rem' }}>{new Date(transaction.completed_at || transaction.created_at).toLocaleString()}</div>
                {transaction.items.map(item => {
                  const cost = item.direction === 'given' ? item.purchase_cost : item.received_cost;
                  return (
                    <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', padding: '0.3rem 0', fontSize: '0.8rem' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>{item.direction === 'given' ? t('transfer.external.given') : t('transfer.external.received')}: {itemName(item)}</span>
                      <span style={{ whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{cost == null ? t('transfer.unknownCost') : `$${Number(cost).toFixed(2)}`}</span>
                    </div>
                  );
                })}
                {transaction.message && <p style={{ margin: '0.25rem 0', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>{transaction.message}</p>}
              </article>
            ))}
          </div>
        )}
    </section>
  );
}
