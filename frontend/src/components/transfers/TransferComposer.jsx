import { useMemo, useState } from 'react';
import { ArrowLeftRight, Gift, RefreshCw } from 'lucide-react';
import { apiErrorText } from '../../utils/apiError';
import { useT } from '../../utils/i18n';
import { fetchJson } from '../../utils/request';
import { useApi } from '../../utils/useApi';
import {
  DEFAULT_PICKER_FILTERS, composerReady, counterOfferedItems, otherParty, parseRecipient, requestOptions, sameUser,
} from '../../utils/transferView';
import { ExternalReceivedItems } from './ExternalDeals';
import ItemPicker from './ItemPicker';
import TransferField from './TransferField';
import { TransferItemRow } from './TransferCard';

const ADD_CONTACT = '__add_external_contact__';
const hint = { color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0 0 0.5rem' };

// The "New" page: an offer or counter to a member, or a deal recorded with a
// contact outside Bindarr. Its state is `composer` (useComposer), owned above
// it; this draws it and keeps only the pickers' filters.
export default function TransferComposer({
  composer,
  access,
  me,
  users,
  contacts,
  ownItems,
  locationOptions,
  setsList,
  loading,
  saving,
  onSubmit,
  onAddContact,
  onToggleSealedTrade,
  onShowDetails,
  locateCard,
}) {
  const { t } = useT();
  const { state } = composer;
  const [offerFilters, setOfferFilters] = useState(DEFAULT_PICKER_FILTERS);
  const [requestFilters, setRequestFilters] = useState(DEFAULT_PICKER_FILTERS);
  const recipient = parseRecipient(state.recipient);
  const isExternal = recipient.kind === 'contact';
  const memberId = recipient.kind === 'user' && access.canTrade ? recipient.id : null;
  const countering = state.countering;
  const asksForItems = !isExternal && (countering || state.type === 'trade');

  // What the chosen member marked for trade: the request side's choices. The
  // answer carries whose it is: useApi keeps the last member's answer on screen
  // while the next one's loads, and those are not this member's to ask for.
  const markedUrl = memberId ? `/api/transfers/marked/${encodeURIComponent(memberId)}` : null;
  const markedQuery = useApi(markedUrl, async ({ signal }) => ({ ...(await fetchJson(markedUrl, { signal })).data, memberId }));
  const marked = memberId && markedQuery.data?.memberId === memberId ? markedQuery.data : null;
  const markedLoading = Boolean(memberId) && !marked && !markedQuery.error;
  const options = useMemo(
    () => requestOptions(marked, counterOfferedItems(countering, me)),
    [marked, countering, me]
  );

  const offered = Object.values(state.offered);
  const requested = Object.values(state.requested);
  const ready = composerReady({
    recipient: state.recipient,
    type: state.type,
    giftDirection: state.giftDirection,
    offered: offered.length,
    requested: requested.length,
    received: state.received.length,
    countering: Boolean(countering),
  });
  const showsGiven = !isExternal || state.type === 'trade' || state.giftDirection === 'given';
  const showsReceived = isExternal && (state.type === 'trade' || state.giftDirection === 'received');
  const originalOffered = countering ? countering.items.filter(item => !sameUser(item.from_user_id, me)) : [];
  const originalRequested = countering ? countering.items.filter(item => sameUser(item.from_user_id, me)) : [];
  const counterParty = countering ? otherParty(countering, me).name : null;

  const addContact = async () => {
    const name = state.newContactName.trim();
    if (!name) return;
    const contact = await onAddContact(name);
    if (contact) composer.patch({ recipient: `contact:${contact.id}`, requested: {}, received: [], newContactName: '', addingContact: false });
  };

  const title = countering
    ? t('transfer.countering', { user: counterParty || t('transfer.unknownUser') })
    : isExternal || !access.canTrade ? t('transfer.external.title') : t('transfer.newProposal');

  return (
    <form
      className="glass-panel"
      onSubmit={(event) => { event.preventDefault(); if (ready) onSubmit(); }}
      style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}
    >
      <div>
        <h3 style={{ margin: 0, color: 'var(--text-strong)' }}>{title}</h3>
        {(isExternal || !access.canTrade) && !countering && (
          <p style={{ ...hint, margin: '0.35rem 0 0' }}>{t('transfer.external.subtitle')}</p>
        )}
      </div>
      {countering && (
        <section className="glass-panel" aria-label={t('transfer.originalProposal')} style={{ padding: '0.75rem' }}>
          <h4 style={{ color: 'var(--text-strong)', margin: '0 0 0.6rem' }}>{t('transfer.originalProposal')}</h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '1rem' }}>
            <div>
              <strong style={{ color: 'var(--text-strong)' }}>{t('transfer.originallyOffered')}</strong>
              {originalOffered.map(item => (
                <TransferItemRow key={`original-offer-${item.id}`} item={item} me={me} location={locateCard(item)} showCost={false} />
              ))}
            </div>
            <div>
              <strong style={{ color: 'var(--text-strong)' }}>{t('transfer.originallyRequested')}</strong>
              {originalRequested.length ? originalRequested.map(item => (
                <TransferItemRow key={`original-request-${item.id}`} item={item} me={me} location={locateCard(item)} showCost={false} />
              )) : <p style={{ color: 'var(--text-secondary)', margin: '0.45rem 0 0' }}>{t('transfer.noOriginalRequest')}</p>}
            </div>
          </div>
        </section>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.65rem' }}>
        <TransferField id="transfer-recipient" label={t(access.canTrade ? 'transfer.recipient' : 'transfer.external.contact')}>
          <select
            id="transfer-recipient"
            className="select-control"
            value={state.recipient}
            disabled={Boolean(countering)}
            onChange={(event) => {
              if (event.target.value === ADD_CONTACT) composer.patch({ addingContact: true });
              else composer.setRecipient(event.target.value);
            }}
            required
          >
            <option value="">{t(access.canTrade ? 'transfer.chooseUser' : 'transfer.external.chooseContact')}</option>
            {access.canTrade && (
              <optgroup label={t('transfer.bindarrUsers')}>
                {users.map(other => <option key={other.id} value={`user:${other.id}`}>{other.username}</option>)}
              </optgroup>
            )}
            {/* A counter's recipient is the member who made the offer, who may
                have stopped trading since and so be missing from the list. */}
            {countering && !users.some(other => `user:${other.id}` === state.recipient) && (
              <option value={state.recipient}>{counterParty || t('transfer.unknownUser')}</option>
            )}
            <optgroup label={t('transfer.externalContacts')}>
              {contacts.map(contact => <option key={contact.id} value={`contact:${contact.id}`}>{contact.name}</option>)}
              <option value={ADD_CONTACT}>{t('transfer.addExternalContact')}</option>
            </optgroup>
          </select>
        </TransferField>
        {state.addingContact && (
          <div style={{ display: 'flex', alignItems: 'end', gap: '0.4rem' }}>
            <input
              className="input-control"
              value={state.newContactName}
              maxLength={100}
              placeholder={t('transfer.external.newContact')}
              aria-label={t('transfer.external.newContact')}
              onChange={event => composer.patch({ newContactName: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addContact();
                }
              }}
            />
            <button type="button" className="btn btn-secondary" disabled={saving || !state.newContactName.trim()} onClick={addContact}>
              {t('transfer.external.saveContact')}
            </button>
          </div>
        )}
        {!countering && (
          <TransferField id="transfer-type" label={t('transfer.type')}>
            <select id="transfer-type" className="select-control" value={state.type} onChange={event => composer.patch({ type: event.target.value })}>
              <option value="gift">{t('transfer.gift')}</option>
              <option value="trade">{t('transfer.trade')}</option>
            </select>
          </TransferField>
        )}
        {isExternal && !countering && state.type === 'gift' && (
          <TransferField id="transfer-gift-direction" label={t('transfer.external.giftDirection')}>
            <select id="transfer-gift-direction" className="select-control" value={state.giftDirection} onChange={event => composer.patch({ giftDirection: event.target.value })}>
              <option value="given">{t('transfer.external.giftGiven')}</option>
              <option value="received">{t('transfer.external.giftReceived')}</option>
            </select>
          </TransferField>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1rem' }}>
        {showsGiven && (
          <section>
            <h4 style={{ color: 'var(--text-strong)', margin: '0 0 0.25rem' }}>
              {isExternal ? t('transfer.external.given') : t('transfer.offer')}
            </h4>
            <p style={hint}>{t('transfer.offerHint')}</p>
            <ItemPicker
              idPrefix="transfer-offer"
              items={ownItems}
              selected={state.offered}
              onPick={composer.pickOffered}
              onQuantity={composer.setOfferedQuantity}
              filters={offerFilters}
              onFiltersChange={setOfferFilters}
              locationOptions={locationOptions}
              setsList={setsList}
              emptyText={loading ? t('common.loading') : t('transfer.noInventory')}
              onShowDetails={onShowDetails}
              onToggleSealedTrade={access.canTrade ? onToggleSealedTrade : null}
              sealedTradeBusy={saving}
            />
          </section>
        )}
        {asksForItems && (
          <section>
            <h4 style={{ color: 'var(--text-strong)', margin: '0 0 0.25rem' }}>{t('transfer.request')}</h4>
            <p style={hint}>{t(countering ? 'transfer.requestHint' : 'transfer.requestHintInitial')}</p>
            {memberId && !marked && markedQuery.error && (
              <div role="alert" style={{ color: 'var(--accent-red)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                {apiErrorText(t, markedQuery.error.body, 'transfer.errLoad')}
              </div>
            )}
            <ItemPicker
              idPrefix="transfer-request"
              items={options}
              selected={state.requested}
              onPick={composer.pickRequested}
              onQuantity={composer.setRequestedQuantity}
              filters={requestFilters}
              onFiltersChange={setRequestFilters}
              isRequest
              setsList={setsList}
              emptyText={markedLoading ? t('common.loading') : t('transfer.noMarkedItems')}
              onShowDetails={onShowDetails}
            />
          </section>
        )}
        {showsReceived && (
          <section>
            <h4 style={{ color: 'var(--text-strong)', margin: '0 0 0.25rem' }}>{t('transfer.external.received')}</h4>
            <ExternalReceivedItems items={state.received} onItemsChange={composer.setReceived} disabled={saving || loading} />
          </section>
        )}
      </div>

      <TransferField id="transfer-message" label={t('transfer.message')}>
        <textarea id="transfer-message" className="input-control" value={state.message} maxLength={1000} rows={2}
          onChange={event => composer.patch({ message: event.target.value })} placeholder={t('transfer.messagePlaceholder')} />
      </TransferField>
      {state.notice && <div role="status" style={{ color: 'var(--accent-yellow)' }}>{state.notice}</div>}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="submit" className="btn btn-primary" disabled={saving || loading || !ready}>
          {saving && <RefreshCw size={15} className="spin-animation" />}
          {!saving && (countering ? <RefreshCw size={15} /> : state.type === 'gift' ? <Gift size={15} /> : <ArrowLeftRight size={15} />)}
          {isExternal
            ? saving ? t('transfer.external.saving') : t('transfer.external.save')
            : countering ? t('transfer.sendCounter') : t('transfer.sendProposal')}
        </button>
        {countering && <button type="button" className="btn btn-secondary" onClick={composer.reset}>{t('common.cancel')}</button>}
      </div>
    </form>
  );
}
