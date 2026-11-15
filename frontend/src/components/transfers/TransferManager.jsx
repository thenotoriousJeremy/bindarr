import { useEffect, useMemo, useRef, useState } from 'react';
import { isDeviceMode } from '../../apiBase';
import { apiErrorText } from '../../utils/apiError';
import { useT } from '../../utils/i18n';
import { isAbortError, sendJson } from '../../utils/request';
import { transferPages } from '../../utils/tradeAccess';
import { locationOptions as listLocations, ownOfferItems, parseRecipient, pendingTransfers, sameUser } from '../../utils/transferView';
import { useStableCallback } from '../../utils/useStableCallback';
import HistoricalTradeModal from './HistoricalTradeModal';
import ItemDetailsModal from './ItemDetailsModal';
import PendingOffers from './PendingOffers';
import TradesOptIn from './TradesOptIn';
import TransferComposer from './TransferComposer';
import TransferHistory from './TransferHistory';
import { useComposer } from './useComposer';
import { useTransfers } from './useTransfers';

const RESPONSE_TOASTS = { accept: 'transfer.accepted', reject: 'transfer.rejected', cancel: 'transfer.cancelled' };
const TAB_LABELS = { new: 'transfer.newTab', offers: 'transfer.offersTab', history: 'transfer.historyTab' };

// Trades & Gifts, under Add/Remove Cards: offers and gifts between members,
// deals recorded with people outside Bindarr, and the history of both. Data and
// writes live in useTransfers, the form's state in useComposer; the pages are
// TransferComposer, PendingOffers and TransferHistory.
//
// On a phone in device mode only the external deals exist (utils/tradeAccess).
// On a server, trading with members is opt-in: until the member turns it on
// their lists stay readable and the page explains how to.
//
// initialOffer ({ requestId, entryId } or { requestId, type: 'sealed', unitId })
// comes from a card's or sealed unit's "Propose trade"; historyFocus
// ({ requestId, type: 'internal' | 'historical' | 'external', id }) from a
// card's provenance link. Each is acknowledged through its callback.
export default function TransferManager({
  user,
  active = true,
  deviceMode = isDeviceMode(),
  showToast,
  onUpdateUser,
  onCollectionChanged,
  initialOffer,
  historyFocus,
  onInitialOfferHandled,
  onHistoryFocusHandled,
}) {
  const { t } = useT();
  const data = useTransfers({ user, active, deviceMode });
  const { access, me } = data;
  const composer = useComposer();
  const pages = transferPages(access);
  const [activePage, setActivePage] = useState('new');
  const shownPage = pages.includes(activePage) ? activePage : 'new';
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [detailItem, setDetailItem] = useState(null);
  const [pastTradeModal, setPastTradeModal] = useState(null);
  const [historyTarget, setHistoryTarget] = useState(null);

  const ownItems = useMemo(() => ownOfferItems(data.cards, data.sealed), [data.cards, data.sealed]);
  const ownItemsByKey = useMemo(() => new Map(ownItems.map(item => [`${item.type}:${item.id}`, item])), [ownItems]);
  const cardsById = useMemo(() => new Map(data.cards.map(card => [card.entry_id, card])), [data.cards]);
  const locations = useMemo(() => listLocations(data.cards, t), [data.cards, t]);
  const pending = useMemo(() => pendingTransfers(data.transfers.items, me), [data.transfers.items, me]);
  // Where a copy of yours offered on an open proposal sits now.
  const locateCard = (item) => (item.item_type === 'card' && sameUser(item.from_user_id, me)
    ? cardsById.get(item.source_collection_id) || null
    : null);

  const showError = (err, fallbackKey) => {
    if (isAbortError(err)) return;
    if (err?.body?.code === 'trades_disabled') data.markTradesOff();
    setError(apiErrorText(t, err?.body, fallbackKey));
  };

  // One write at a time, its refusal shown above the pages. Resolves to the
  // work's result, or null when it failed.
  const run = async (fallbackKey, work) => {
    setSaving(true);
    setError('');
    try {
      return await work();
    } catch (err) {
      showError(err, fallbackKey);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const enableTrades = async () => {
    setEnabling(true);
    setError('');
    try {
      const { data: body } = await sendJson('/api/auth/settings', 'PUT', { trades_enabled: true });
      if (body?.user) onUpdateUser?.(body.user);
      showToast?.(t('settings.tradesOn'));
    } catch (err) {
      showError(err, 'settings.errTrades');
    } finally {
      setEnabling(false);
    }
  };

  const submit = () => {
    const { state } = composer;
    const recipient = parseRecipient(state.recipient);
    if (recipient.kind === 'contact') {
      const both = state.type === 'trade';
      return run('transfer.external.errSave', async () => {
        const result = await data.saveExternalDeal({
          contact_id: Number(recipient.id),
          transaction_type: state.type,
          given_items: both || state.giftDirection === 'given' ? Object.values(state.offered) : [],
          received_items: both || state.giftDirection === 'received' ? state.received : [],
          message: state.message,
        });
        showToast?.(t('transfer.external.saved'));
        composer.reset();
        if (result?.warnings?.length) composer.patch({ notice: t('transfer.external.deckWarning') });
        setActivePage('history');
        onCollectionChanged?.();
      });
    }
    const countering = state.countering;
    return run('transfer.errSave', async () => {
      const body = {
        recipient_id: Number(recipient.id),
        transfer_type: countering ? 'trade' : state.type,
        offered_items: Object.values(state.offered),
        requested_items: countering || state.type === 'trade' ? Object.values(state.requested) : [],
        message: state.message,
      };
      if (countering) await data.counter(countering, body);
      else await data.propose(body);
      showToast?.(t(countering ? 'transfer.counterSent' : 'transfer.proposalSent'));
      composer.reset();
      setActivePage('offers');
    });
  };

  const respond = (transfer, action) => run('transfer.errAction', async () => {
    await data.respond(transfer, action);
    showToast?.(t(RESPONSE_TOASTS[action]));
    if (action === 'accept') onCollectionChanged?.();
  });

  const startCounter = (transfer) => {
    composer.startCounter(transfer, ownItemsByKey);
    setError('');
    setActivePage('new');
  };

  // The past-trade dialog shows its own refusals. One saying trading is off
  // closes it (the opt-in takes its place), so that one is shown here too.
  const inDialog = work => async (...args) => {
    try {
      return await work(...args);
    } catch (err) {
      if (err?.body?.code === 'trades_disabled') showError(err, 'transfer.errAction');
      throw err;
    }
  };

  const cancelPastTrade = trade => run('historical.errCancel', async () => {
    await data.cancelPastTrade(trade.id);
    showToast?.(t('historical.cancelled'));
  });

  // A card's or sealed unit's "Propose trade". The inventory may be older than
  // the copy (added on another tab since), so a miss reloads it before the
  // copy is called gone.
  const handledOffer = useRef(null);
  const takeOffer = useStableCallback(async (request) => {
    const type = request.type === 'sealed' ? 'sealed' : 'card';
    const id = type === 'sealed' ? request.unitId : request.entryId;
    const find = (cards, sealed) => (type === 'sealed'
      ? sealed.find(unit => String(unit.id) === String(id))
      : cards.find(card => String(card.entry_id) === String(id)));
    let item = find(data.cards, data.sealed);
    if (!item) {
      const fresh = await data.reloadInventory();
      item = find(fresh.cards || [], fresh.sealed || []);
    }
    if (handledOffer.current !== request.requestId) return;
    if (item) {
      composer.startOffer(type, type === 'sealed' ? item.id : item.entry_id);
      setError('');
      setActivePage('new');
    } else {
      showToast?.(t(type === 'sealed' ? 'transfer.sealedUnavailable' : 'transfer.cardUnavailable'));
    }
    onInitialOfferHandled?.(request.requestId);
  });
  const inventoryLoading = data.inventoryLoading;
  useEffect(() => {
    if (!initialOffer || inventoryLoading || handledOffer.current === initialOffer.requestId) return;
    handledOffer.current = initialOffer.requestId;
    takeOffer(initialOffer);
  }, [initialOffer, inventoryLoading, takeOffer]);

  // A card's provenance link: find the record, loading older pages of its list
  // until it turns up, then show it on the History page.
  const handledFocus = useRef(null);
  const takeFocus = useStableCallback(async (focus) => {
    setActivePage('history');
    const matches = item => String(item.id) === String(focus.id);
    const list = { internal: data.transfers, historical: data.historical, external: data.external }[focus.type];
    const found = list && (focus.type === 'external' || access.members) ? await list.find(matches) : null;
    if (handledFocus.current !== focus.requestId) return;
    if (found) setHistoryTarget({ kind: focus.type, id: found.id, nonce: focus.requestId });
    else setError(t('transfer.historyUnavailable'));
    onHistoryFocusHandled?.(focus.requestId);
  });
  useEffect(() => {
    if (!historyFocus) return;
    const requestId = historyFocus.requestId ?? `${historyFocus.type}:${historyFocus.id}`;
    if (handledFocus.current === requestId) return;
    handledFocus.current = requestId;
    takeFocus({ ...historyFocus, requestId });
  }, [historyFocus, takeFocus]);

  // The page's own lists show their failures where they are drawn; these two
  // feed the composer. A refusal because trading is off is the opt-in's to explain.
  const usersError = access.canTrade && data.usersError?.body?.code !== 'trades_disabled' ? data.usersError : null;
  const loadError = data.inventoryError || usersError;

  const handleTabKeyDown = (event) => {
    const currentIndex = pages.indexOf(shownPage);
    let nextIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % pages.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex + pages.length - 1) % pages.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = pages.length - 1;
    else return;
    event.preventDefault();
    const nextPage = pages[nextIndex];
    setActivePage(nextPage);
    document.getElementById(`transfer-tab-${nextPage}`)?.focus();
  };

  const counts = { offers: pending.incoming.length + pending.outgoing.length };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1rem' }}>
      <header>
        <h2 style={{ color: 'var(--text-strong)', margin: 0 }}>{t('transfer.title')}</h2>
        <p style={{ color: 'var(--text-secondary)', margin: '0.35rem 0 0' }}>{t(access.members ? 'transfer.subtitle' : 'transfer.subtitleDevice')}</p>
      </header>

      {access.needsOptIn && <TradesOptIn onEnable={enableTrades} busy={enabling} />}

      {error && <div role="alert" className="glass-panel" style={{ padding: '0.75rem', color: 'var(--accent-red)' }}>{error}</div>}
      {!error && loadError && (
        <div role="alert" className="glass-panel" style={{ padding: '0.75rem', color: 'var(--accent-red)' }}>
          {apiErrorText(t, loadError.body, 'transfer.errLoad')}
        </div>
      )}

      <div role="tablist" aria-label={t('transfer.title')} tabIndex={0} onKeyDown={handleTabKeyDown}
        style={{ display: 'flex', gap: '0.45rem', overflowX: 'auto', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.65rem' }}>
        {pages.map(page => (
          <button
            key={page}
            type="button"
            role="tab"
            id={`transfer-tab-${page}`}
            aria-selected={shownPage === page}
            aria-controls={`transfer-panel-${page}`}
            tabIndex={shownPage === page ? 0 : -1}
            className={`btn ${shownPage === page ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActivePage(page)}
            style={{ whiteSpace: 'nowrap' }}
          >
            {t(TAB_LABELS[page])}
            {counts[page] > 0 && <span style={{ marginLeft: '0.4rem', opacity: 0.8 }}>{counts[page]}</span>}
          </button>
        ))}
      </div>

      <div id="transfer-panel-new" role="tabpanel" aria-labelledby="transfer-tab-new" tabIndex={0} hidden={shownPage !== 'new'}
        style={{ display: shownPage === 'new' ? 'flex' : 'none', flexDirection: 'column', gap: '1rem' }}>
        {access.canTrade && !composer.state.countering && (
          <div className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', padding: '0.85rem 1rem' }}>
            <div>
              <strong style={{ color: 'var(--text-strong)' }}>{t('historical.shortcutTitle')}</strong>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.84rem' }}>{t('historical.shortcutHint')}</div>
            </div>
            <button type="button" className="btn btn-secondary" onClick={() => setPastTradeModal({ mode: 'create' })}>{t('historical.openForm')}</button>
          </div>
        )}
        <TransferComposer
          composer={composer}
          access={access}
          me={me}
          users={data.users}
          contacts={data.contacts}
          ownItems={ownItems}
          locationOptions={locations}
          setsList={data.sets}
          loading={data.inventoryLoading}
          saving={saving}
          onSubmit={submit}
          onAddContact={name => run('transfer.external.errContact', () => data.addContact(name))}
          onToggleSealedTrade={unit => run('transfer.errAction', () => data.toggleSealedTrade(unit))}
          onShowDetails={setDetailItem}
          locateCard={locateCard}
        />
      </div>

      {pages.includes('offers') && (
        <div id="transfer-panel-offers" role="tabpanel" aria-labelledby="transfer-tab-offers" tabIndex={0} hidden={shownPage !== 'offers'}
          style={{ display: shownPage === 'offers' ? 'flex' : 'none', flexDirection: 'column', gap: '1rem' }}>
          {shownPage === 'offers' && (
            <PendingOffers
              list={data.transfers}
              incoming={pending.incoming}
              outgoing={pending.outgoing}
              me={me}
              canRespond={access.canTrade}
              busy={saving}
              onRespond={respond}
              onCounter={startCounter}
              locateCard={locateCard}
            />
          )}
        </div>
      )}

      <div id="transfer-panel-history" role="tabpanel" aria-labelledby="transfer-tab-history" tabIndex={0} hidden={shownPage !== 'history'}
        style={{ display: shownPage === 'history' ? 'flex' : 'none', flexDirection: 'column', gap: '1rem' }}>
        {shownPage === 'history' && (
          <TransferHistory
            me={me}
            access={access}
            transfers={data.transfers}
            historical={data.historical}
            external={data.external}
            busy={saving}
            target={historyTarget}
            onRecordPastTrade={() => setPastTradeModal({ mode: 'create' })}
            onReviewPastTrade={trade => setPastTradeModal({ mode: 'review', trade })}
            onCancelPastTrade={cancelPastTrade}
          />
        )}
      </div>

      {pastTradeModal && access.canTrade && (
        <HistoricalTradeModal
          mode={pastTradeModal.mode}
          trade={pastTradeModal.trade}
          user={user}
          users={data.users}
          cards={data.cards}
          onClose={() => setPastTradeModal(null)}
          onCreate={inDialog(async (payload) => {
            await data.recordPastTrade(payload);
            showToast?.(t('historical.submitted'));
          })}
          onConfirm={inDialog(async (tradeId, items) => {
            await data.confirmPastTrade(tradeId, items);
            showToast?.(t('historical.confirmed'));
            onCollectionChanged?.();
          })}
          onReject={inDialog(async (tradeId) => {
            await data.rejectPastTrade(tradeId);
            showToast?.(t('historical.rejected'));
          })}
        />
      )}
      {detailItem && <ItemDetailsModal item={detailItem} onClose={() => setDetailItem(null)} />}
    </div>
  );
}
